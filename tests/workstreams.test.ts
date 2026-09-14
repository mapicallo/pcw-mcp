import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { isMap, parseDocument } from "yaml";

import { loadPcwConfig } from "../src/config/pcw-config.js";
import { sha256Text } from "../src/filesystem/hashing.js";
import { PcwPathError } from "../src/filesystem/paths.js";
import {
  PcwConfigStaleError,
  WorkstreamAlreadyExistsError,
  WorkstreamCreateConflictError,
  WorkstreamNameInvalidError,
  createWorkstream
} from "../src/workstreams/workstream-service.js";
import { fixtureRoot } from "./mcp-test-client.js";

async function withContext<T>(
  run: (contextRoot: string) => Promise<T>
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-workstream-test-"));
  const contextRoot = join(temporaryRoot, "context");

  try {
    await cp(fixtureRoot, contextRoot, { recursive: true });
    return await run(contextRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

test("creates a continuity-only workstream without changing existing durable data", async () => {
  await withContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    const inventoryPath = join(contextRoot, "catalog", "inventory.md");
    const backendPath = join(contextRoot, "state", "BACKEND.md");
    const originalConfig = `# preserve this project comment
${await readFile(configPath, "utf8")}`;
    await writeFile(configPath, originalConfig, "utf8");
    const originalInventory = await readFile(inventoryPath, "utf8");
    const originalBackend = await readFile(backendPath, "utf8");
    const before = (await loadPcwConfig(contextRoot)).config;

    const result = await createWorkstream(contextRoot, {
      name: "LAB_CORE",
      initialObjective: "Establish a synthetic durable objective."
    });

    assert.deepEqual(result, {
      workstream: "LAB_CORE",
      mode: "continuity-only",
      continuityPath: "continuity/LAB_CORE.md",
      contextPath: null,
      configBackupPath: result.configBackupPath,
      created: true,
      initialContinuitySha256: result.initialContinuitySha256
    });
    assert.match(
      result.configBackupPath,
      /^\.pcw\/history\/config\/.*-[a-f0-9]{12}\.yml$/
    );

    const continuity = await readFile(
      join(contextRoot, result.continuityPath),
      "utf8"
    );
    const backup = await readFile(
      join(contextRoot, result.configBackupPath),
      "utf8"
    );
    const updatedRaw = await readFile(configPath, "utf8");
    const after = (await loadPcwConfig(contextRoot)).config;

    assert.equal(result.initialContinuitySha256, sha256Text(continuity));
    assert.match(continuity, /^# LAB_CORE$/m);
    assert.match(continuity, /Establish a synthetic durable objective/);
    assert.match(continuity, /## Next action/);
    assert.equal(backup, originalConfig);
    assert.match(updatedRaw, /^# preserve this project comment/m);
    assert.deepEqual(after.workstreams?.BACKEND, before.workstreams?.BACKEND);
    assert.deepEqual(after.shared_context, before.shared_context);
    assert.deepEqual(after.inventory, before.inventory);
    assert.deepEqual(after.workstreams?.LAB_CORE, {
      continuity: { path: "continuity/LAB_CORE.md" }
    });
    assert.equal(await readFile(inventoryPath, "utf8"), originalInventory);
    assert.equal(await readFile(backendPath, "utf8"), originalBackend);
    await assertMissing(join(contextRoot, "workstreams", "LAB_CORE"));
  });
});

test("creates specialized context only in with-context mode", async () => {
  await withContext(async (contextRoot) => {
    const result = await createWorkstream(contextRoot, {
      name: "LAB-API",
      mode: "with-context"
    });
    const config = (await loadPcwConfig(contextRoot)).config;

    assert.equal(result.contextPath, "workstreams/LAB-API");
    assert.deepEqual(config.workstreams?.["LAB-API"], {
      context: { path: "workstreams/LAB-API" },
      continuity: { path: "continuity/LAB-API.md" }
    });
    await access(join(contextRoot, "workstreams", "LAB-API"));
    assert.match(
      await readFile(join(contextRoot, "continuity", "LAB-API.md"), "utf8"),
      /Define the first durable objective/
    );
  });
});

test("converts an empty workstreams flow map to readable block style", async () => {
  await withContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    const originalConfig = `# project identity
project: { id: synthetic, name: Synthetic Project } # keep project flow style
inventory:
  path: catalog/inventory.md
shared_context:
  general:
    path: shared/general
# durable work follows
workstreams: {}
`;
    await writeFile(configPath, originalConfig, "utf8");
    const before = (await loadPcwConfig(contextRoot)).config;

    await createWorkstream(contextRoot, {
      name: "FIRST-LAB",
      mode: "with-context"
    });

    const updated = await readFile(configPath, "utf8");
    const parsed = parseDocument(updated);
    const workstreams = parsed.get("workstreams", true);
    const created = parsed.getIn(["workstreams", "FIRST-LAB"], true);
    const context = parsed.getIn(["workstreams", "FIRST-LAB", "context"], true);
    const continuity = parsed.getIn(
      ["workstreams", "FIRST-LAB", "continuity"],
      true
    );
    const after = (await loadPcwConfig(contextRoot)).config;

    assert.ok(isMap(workstreams));
    assert.ok(isMap(created));
    assert.ok(isMap(context));
    assert.ok(isMap(continuity));
    assert.notEqual(workstreams.flow, true);
    assert.notEqual(created.flow, true);
    assert.notEqual(context.flow, true);
    assert.notEqual(continuity.flow, true);
    assert.match(updated, /^workstreams:\n  FIRST-LAB:\n/m);
    assert.match(
      updated,
      /^project: \{ id: synthetic, name: Synthetic Project \} # keep project flow style$/m
    );
    assert.match(updated, /^# project identity$/m);
    assert.match(updated, /^# durable work follows$/m);
    assert.ok(updated.indexOf("project:") < updated.indexOf("inventory:"));
    assert.ok(updated.indexOf("inventory:") < updated.indexOf("shared_context:"));
    assert.ok(updated.indexOf("shared_context:") < updated.indexOf("workstreams:"));
    assert.deepEqual(after.project, before.project);
    assert.deepEqual(after.inventory, before.inventory);
    assert.deepEqual(after.shared_context, before.shared_context);
    assert.deepEqual(after.workstreams?.["FIRST-LAB"], {
      context: { path: "workstreams/FIRST-LAB" },
      continuity: { path: "continuity/FIRST-LAB.md" }
    });
  });
});

test("keeps a second generated workstream in block style", async () => {
  await withContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    await writeFile(
      configPath,
      "# configured workstreams\nworkstreams: {}\n",
      "utf8"
    );

    await createWorkstream(contextRoot, {
      name: "FIRST-LAB",
      mode: "with-context"
    });
    await createWorkstream(contextRoot, { name: "SECOND-LAB" });

    const updated = await readFile(configPath, "utf8");
    const parsed = parseDocument(updated);
    const second = parsed.getIn(["workstreams", "SECOND-LAB"], true);
    const config = (await loadPcwConfig(contextRoot)).config;

    assert.ok(isMap(second));
    assert.notEqual(second.flow, true);
    assert.match(updated, /^  FIRST-LAB:\n/m);
    assert.match(updated, /^  SECOND-LAB:\n    continuity:\n/m);
    assert.match(updated, /^# configured workstreams$/m);
    assert.deepEqual(config.workstreams?.["SECOND-LAB"], {
      continuity: { path: "continuity/SECOND-LAB.md" }
    });
  });
});

test("rejects exact and case-insensitive duplicate names", async () => {
  await withContext(async (contextRoot) => {
    for (const name of ["BACKEND", "backend", "BackEnd"]) {
      await assert.rejects(
        createWorkstream(contextRoot, { name }),
        (error) =>
          error instanceof WorkstreamAlreadyExistsError &&
          error.existingWorkstream === "BACKEND"
      );
    }
  });
});

test("rejects unsafe or excessively long automatic names", async () => {
  const invalidNames = [
    "",
    " ",
    ".",
    "..",
    "../OTHER",
    "A/B",
    "A\\B",
    "C:\\TEMP",
    "\0",
    "-PREFIX",
    "A".repeat(65)
  ];

  await withContext(async (contextRoot) => {
    for (const name of invalidNames) {
      await assert.rejects(
        createWorkstream(contextRoot, { name }),
        (error) => error instanceof WorkstreamNameInvalidError
      );
    }
  });
});

test("never overwrites preexisting continuity or context targets", async () => {
  await withContext(async (contextRoot) => {
    const continuityPath = join(contextRoot, "continuity", "COLLISION.md");
    await mkdir(dirname(continuityPath), { recursive: true });
    await writeFile(continuityPath, "user-owned content", "utf8");

    await assert.rejects(
      createWorkstream(contextRoot, { name: "COLLISION" }),
      (error) =>
        error instanceof WorkstreamCreateConflictError &&
        error.path === "continuity/COLLISION.md"
    );
    assert.equal(await readFile(continuityPath, "utf8"), "user-owned content");
  });

  await withContext(async (contextRoot) => {
    const contextPath = join(contextRoot, "workstreams", "COLLISION");
    await mkdir(contextPath, { recursive: true });

    await assert.rejects(
      createWorkstream(contextRoot, {
        name: "COLLISION",
        mode: "with-context"
      }),
      (error) =>
        error instanceof WorkstreamCreateConflictError &&
        error.path === "workstreams/COLLISION"
    );
    await assertMissing(join(contextRoot, "continuity", "COLLISION.md"));
  });
});

test("rejects an automatic path routed through an external symlink or junction", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-workstream-link-"));
  const contextRoot = join(temporaryRoot, "context");
  const outsideRoot = join(temporaryRoot, "outside");

  try {
    await mkdir(contextRoot);
    await mkdir(outsideRoot);
    await writeFile(
      join(contextRoot, "pcw.yml"),
      "project:\n  id: synthetic\nworkstreams: {}\n",
      "utf8"
    );

    try {
      await symlink(
        outsideRoot,
        join(contextRoot, "continuity"),
        platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      t.skip(`symlink/junction creation unavailable: ${String(error)}`);
      return;
    }

    await assert.rejects(
      createWorkstream(contextRoot, { name: "SAFE-NAME" }),
      (error) => error instanceof PcwPathError
    );
    assert.deepEqual(await readdir(outsideRoot), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("does not create lock descendants through an external metadata link", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-workstream-lock-link-"));
  const contextRoot = join(temporaryRoot, "context");
  const externalRoot = join(temporaryRoot, "outside");

  try {
    await cp(fixtureRoot, contextRoot, { recursive: true });
    await mkdir(externalRoot);
    try {
      await symlink(
        externalRoot,
        join(contextRoot, ".pcw"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      if (isWindowsPrivilegeError(error)) {
        t.skip("Creating a Windows junction/symlink is not permitted");
        return;
      }
      throw error;
    }

    await assert.rejects(
      createWorkstream(contextRoot, { name: "SAFE-LAB" }),
      (error) => error instanceof PcwPathError
    );
    await assertMissing(join(externalRoot, "locks"));
    await assertMissing(join(contextRoot, "continuity", "SAFE-LAB.md"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("detects external pcw.yml changes and rolls back generated artifacts", async () => {
  await withContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");

    await assert.rejects(
      createWorkstream(
        contextRoot,
        { name: "STALE-LAB", mode: "with-context" },
        {
          beforeConfigCommit: async () => {
            await writeFile(
              configPath,
              `${await readFile(configPath, "utf8")}\n# external edit\n`,
              "utf8"
            );
          }
        }
      ),
      (error) => error instanceof PcwConfigStaleError
    );

    await assertMissing(join(contextRoot, "continuity", "STALE-LAB.md"));
    await assertMissing(join(contextRoot, "workstreams", "STALE-LAB"));
    const config = (await loadPcwConfig(contextRoot)).config;
    assert.equal(config.workstreams?.["STALE-LAB"], undefined);
    assert.match(await readFile(configPath, "utf8"), /# external edit/);
  });
});

test("write failures preserve the original config and roll back created targets", async (t) => {
  await t.test("continuity creation failure", async () => {
    await withContext(async (contextRoot) => {
      const configPath = join(contextRoot, "pcw.yml");
      const original = await readFile(configPath, "utf8");

      await assert.rejects(
        createWorkstream(
          contextRoot,
          { name: "FAIL-CONTINUITY" },
          {
            writeContinuityFile: async () => {
              throw new Error("synthetic continuity failure");
            }
          }
        ),
        (error) => error instanceof WorkstreamCreateConflictError
      );

      assert.equal(await readFile(configPath, "utf8"), original);
      await assertMissing(
        join(contextRoot, "continuity", "FAIL-CONTINUITY.md")
      );
    });
  });

  await t.test("config backup failure", async () => {
    await withContext(async (contextRoot) => {
      const configPath = join(contextRoot, "pcw.yml");
      const original = await readFile(configPath, "utf8");

      await assert.rejects(
        createWorkstream(
          contextRoot,
          { name: "FAIL-BACKUP", mode: "with-context" },
          {
            writeConfigBackup: async () => {
              throw new Error("synthetic backup failure");
            }
          }
        ),
        (error) => error instanceof WorkstreamCreateConflictError
      );

      assert.equal(await readFile(configPath, "utf8"), original);
      await assertMissing(join(contextRoot, "continuity", "FAIL-BACKUP.md"));
      await assertMissing(join(contextRoot, "workstreams", "FAIL-BACKUP"));
    });
  });

  await t.test("config atomic-write failure", async () => {
    await withContext(async (contextRoot) => {
      const configPath = join(contextRoot, "pcw.yml");
      const original = await readFile(configPath, "utf8");

      await assert.rejects(
        createWorkstream(
          contextRoot,
          { name: "FAIL-CONFIG", mode: "with-context" },
          {
            writeConfigAtomic: async () => {
              throw new Error("synthetic config failure");
            }
          }
        ),
        (error) => error instanceof WorkstreamCreateConflictError
      );

      assert.equal(await readFile(configPath, "utf8"), original);
      await assertMissing(join(contextRoot, "continuity", "FAIL-CONFIG.md"));
      await assertMissing(join(contextRoot, "workstreams", "FAIL-CONFIG"));
      assert.deepEqual(
        await readdir(join(contextRoot, ".pcw", "history", "config")),
        []
      );
    });
  });
});

test("incomplete rollback is reported explicitly", async () => {
  await withContext(async (contextRoot) => {
    await assert.rejects(
      createWorkstream(
        contextRoot,
        { name: "ROLLBACK-LAB", mode: "with-context" },
        {
          createContextDirectory: async (path) => {
            await mkdir(path);
            await writeFile(join(path, "blocker.txt"), "synthetic", "utf8");
          },
          writeConfigAtomic: async () => {
            throw new Error("synthetic config failure");
          }
        }
      ),
      (error) =>
        error instanceof WorkstreamCreateConflictError &&
        error.rollbackFailures.length >= 1
    );

    assert.equal(
      (await loadPcwConfig(contextRoot)).config.workstreams?.["ROLLBACK-LAB"],
      undefined
    );
  });
});

test("exclusive config lock prevents concurrent PCW creates from overwriting", async () => {
  await withContext(async (contextRoot) => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = createWorkstream(
      contextRoot,
      { name: "CLIENT-A" },
      {
        beforeConfigCommit: async () => {
          markStarted();
          await gate;
        }
      }
    );
    await started;

    await assert.rejects(
      createWorkstream(contextRoot, { name: "CLIENT-B" }),
      (error) => error instanceof WorkstreamCreateConflictError
    );

    releaseFirst();
    await first;

    const config = (await loadPcwConfig(contextRoot)).config;
    assert.ok(config.workstreams?.["CLIENT-A"]);
    assert.equal(config.workstreams?.["CLIENT-B"], undefined);
  });
});
