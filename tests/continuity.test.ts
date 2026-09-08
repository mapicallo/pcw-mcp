import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { platform } from "node:process";
import test from "node:test";

import {
  ContinuityNotConfiguredError,
  ContinuityNotMarkdownError,
  ContinuityReadError,
  ContinuityStaleWriteError,
  ContinuityUpdateError,
  ContinuityWorkstreamNotFoundError,
  getContinuitySnapshot,
  updateContinuity
} from "../src/continuity/continuity-service.js";
import type { PcwConfig } from "../src/domain/pcw-types.js";
import { sha256Text } from "../src/filesystem/hashing.js";
import { PcwPathError } from "../src/filesystem/paths.js";

const initialContent = "# BACKEND Continuity\n\nSynthetic initial state.\n";

async function withContinuityFilesystem<T>(
  run: (fixture: {
    contextRoot: string;
    continuityPath: string;
    outsideRoot: string;
    config: PcwConfig;
  }) => Promise<T>
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-continuity-test-"));
  const contextRoot = join(temporaryRoot, "context");
  const stateDirectory = join(contextRoot, "state");
  const continuityPath = join(stateDirectory, "BACKEND.md");
  const outsideRoot = join(temporaryRoot, "outside");
  const config: PcwConfig = {
    workstreams: {
      BACKEND: { continuity: { path: "state/BACKEND.md" } },
      OPERATIONS: {}
    }
  };

  try {
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(continuityPath, initialContent, "utf8");
    return await run({ contextRoot, continuityPath, outsideRoot, config });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("continuity snapshot returns canonical workstream, content, and SHA", async () => {
  await withContinuityFilesystem(async ({ contextRoot, config }) => {
    const first = await getContinuitySnapshot(contextRoot, config, "backend");
    const second = await getContinuitySnapshot(contextRoot, config, "BackEnd");

    assert.equal(first.workstream, "BACKEND");
    assert.equal(first.configuredPath, "state/BACKEND.md");
    assert.equal(first.content, initialContent);
    assert.equal(first.sha256, sha256Text(initialContent));
    assert.equal(second.sha256, first.sha256);
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
  });
});

test("workstream without continuity is rejected", async () => {
  await withContinuityFilesystem(async ({ contextRoot, config }) => {
    await assert.rejects(
      getContinuitySnapshot(contextRoot, config, "operations"),
      (error) =>
        error instanceof ContinuityNotConfiguredError &&
        error.workstream === "OPERATIONS"
    );
  });
});

test("unknown continuity workstream is rejected with available names", async () => {
  await withContinuityFilesystem(async ({ contextRoot, config }) => {
    await assert.rejects(
      getContinuitySnapshot(contextRoot, config, "MISSING"),
      (error) =>
        error instanceof ContinuityWorkstreamNotFoundError &&
        error.requestedWorkstream === "MISSING" &&
        error.availableWorkstreams.join(",") === "BACKEND,OPERATIONS"
    );
  });
});

test("continuity path outside the context root is rejected", async () => {
  await withContinuityFilesystem(async ({ contextRoot }) => {
    const config: PcwConfig = {
      workstreams: {
        ESCAPE: { continuity: { path: "../outside/continuity.md" } }
      }
    };

    await assert.rejects(
      getContinuitySnapshot(contextRoot, config, "ESCAPE"),
      (error) =>
        error instanceof ContinuityReadError &&
        error.cause instanceof PcwPathError
    );
  });
});

test("continuity symlink or junction outside the root is rejected", async (t) => {
  await withContinuityFilesystem(
    async ({ contextRoot, outsideRoot }) => {
      await writeFile(
        join(outsideRoot, "continuity.md"),
        "outside sentinel",
        "utf8"
      );
      const linkPath = join(contextRoot, "linked");

      try {
        await symlink(
          outsideRoot,
          linkPath,
          platform === "win32" ? "junction" : "dir"
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
          t.skip(`Symlink creation is unavailable: ${code}`);
          return;
        }
        throw error;
      }

      const config: PcwConfig = {
        workstreams: {
          LINKED: { continuity: { path: "linked/continuity.md" } }
        }
      };
      await assert.rejects(
        getContinuitySnapshot(contextRoot, config, "LINKED"),
        (error) =>
          error instanceof ContinuityReadError &&
          error.cause instanceof PcwPathError
      );
    }
  );
});

test("continuity update rejects a directory target", async () => {
  await withContinuityFilesystem(async ({ contextRoot }) => {
    const config: PcwConfig = {
      workstreams: {
        DIRECTORY: { continuity: { path: "state/directory.md" } }
      }
    };
    await mkdir(join(contextRoot, "state", "directory.md"));

    await assert.rejects(
      updateContinuity(contextRoot, config, {
        requestedWorkstream: "DIRECTORY",
        content: "replacement",
        expectedSha256: sha256Text("")
      }),
      (error) =>
        error instanceof ContinuityUpdateError &&
        error.details === "Configured continuity path is not a file"
    );
  });
});

test("continuity update rejects non-Markdown configured paths", async () => {
  await withContinuityFilesystem(async ({ contextRoot }) => {
    const config: PcwConfig = {
      workstreams: {
        TEXT: { continuity: { path: "state/continuity.txt" } }
      }
    };

    await assert.rejects(
      updateContinuity(contextRoot, config, {
        requestedWorkstream: "TEXT",
        content: "replacement",
        expectedSha256: sha256Text("")
      }),
      (error) =>
        error instanceof ContinuityNotMarkdownError &&
        error.configuredPath === "state/continuity.txt"
    );
  });
});

test("successful update returns both SHAs and persists new content", async () => {
  await withContinuityFilesystem(
    async ({ contextRoot, continuityPath, config }) => {
      const replacement = "# BACKEND Continuity\n\nSynthetic replacement.\n";
      const result = await updateContinuity(contextRoot, config, {
        requestedWorkstream: "backend",
        content: replacement,
        expectedSha256: sha256Text(initialContent)
      });

      assert.equal(result.workstream, "BACKEND");
      assert.equal(result.configuredPath, "state/BACKEND.md");
      assert.equal(result.absolutePath, continuityPath);
      assert.equal(result.previousSha256, sha256Text(initialContent));
      assert.equal(result.newSha256, sha256Text(replacement));
      assert.equal(result.updated, true);
      assert.equal(await readFile(continuityPath, "utf8"), replacement);
    }
  );
});

test("successful update backs up the exact previous content", async () => {
  await withContinuityFilesystem(async ({ contextRoot, config }) => {
    const result = await updateContinuity(contextRoot, config, {
      requestedWorkstream: "BACKEND",
      content: "# BACKEND Continuity\n\nNew checkpoint.\n",
      expectedSha256: sha256Text(initialContent)
    });
    const historyDirectory = join(
      contextRoot,
      ".pcw",
      "history",
      "BACKEND"
    );

    assert.equal(await readFile(result.backupPath, "utf8"), initialContent);
    assert.equal(relative(historyDirectory, result.backupPath).startsWith(".."), false);
    assert.match(result.backupPath, /-[a-f0-9]{12}\.md$/);
  });
});

test("stale update creates no history and cannot overwrite continuity", async () => {
  await withContinuityFilesystem(
    async ({ contextRoot, continuityPath, config }) => {
      await assert.rejects(
        updateContinuity(contextRoot, config, {
          requestedWorkstream: "BACKEND",
          content: "stale replacement",
          expectedSha256: sha256Text("older version")
        }),
        (error) =>
          error instanceof ContinuityStaleWriteError &&
          error.currentSha256 === sha256Text(initialContent)
      );

      assert.equal(await readFile(continuityPath, "utf8"), initialContent);
      await assert.rejects(readdir(join(contextRoot, ".pcw", "history")));
    }
  );
});

test("two clients preserve the winning update and reject the stale client", async () => {
  await withContinuityFilesystem(async ({ contextRoot, config }) => {
    const clientA = await getContinuitySnapshot(contextRoot, config, "BACKEND");
    const clientB = await getContinuitySnapshot(contextRoot, config, "backend");
    const clientBContent = "# BACKEND Continuity\n\nClient B wins.\n";

    const winner = await updateContinuity(contextRoot, config, {
      requestedWorkstream: "BACKEND",
      content: clientBContent,
      expectedSha256: clientB.sha256
    });
    await assert.rejects(
      updateContinuity(contextRoot, config, {
        requestedWorkstream: "BACKEND",
        content: "# BACKEND Continuity\n\nStale client A.\n",
        expectedSha256: clientA.sha256
      }),
      (error) =>
        error instanceof ContinuityStaleWriteError &&
        error.currentSha256 === winner.newSha256
    );

    const finalSnapshot = await getContinuitySnapshot(
      contextRoot,
      config,
      "BACKEND"
    );
    const history = await readdir(
      join(contextRoot, ".pcw", "history", "BACKEND")
    );
    assert.equal(finalSnapshot.content, clientBContent);
    assert.equal(finalSnapshot.sha256, winner.newSha256);
    assert.equal(history.length, 1);
  });
});

test("two valid updates create distinct history artifacts", async () => {
  await withContinuityFilesystem(async ({ contextRoot, config }) => {
    const firstContent = "# BACKEND Continuity\n\nFirst update.\n";
    const first = await updateContinuity(contextRoot, config, {
      requestedWorkstream: "BACKEND",
      content: firstContent,
      expectedSha256: sha256Text(initialContent)
    });
    const second = await updateContinuity(contextRoot, config, {
      requestedWorkstream: "BACKEND",
      content: "# BACKEND Continuity\n\nSecond update.\n",
      expectedSha256: first.newSha256
    });
    const history = await readdir(
      join(contextRoot, ".pcw", "history", "BACKEND")
    );

    assert.equal(history.length, 2);
    assert.notEqual(first.backupPath, second.backupPath);
    assert.equal(await readFile(second.backupPath, "utf8"), firstContent);
  });
});

test("history artifacts remain inside the PCW root", async () => {
  await withContinuityFilesystem(async ({ contextRoot, config }) => {
    const result = await updateContinuity(contextRoot, config, {
      requestedWorkstream: "BACKEND",
      content: "# BACKEND Continuity\n\nBoundary test.\n",
      expectedSha256: sha256Text(initialContent)
    });
    const relativePath = relative(contextRoot, result.backupPath);

    assert.equal(isAbsolute(relativePath), false);
    assert.equal(relativePath.startsWith(".."), false);
    assert.match(relativePath, /^\.pcw[\\/]history[\\/]BACKEND[\\/]/);
  });
});

test("unsafe canonical workstream name cannot influence history paths", async () => {
  await withContinuityFilesystem(
    async ({ contextRoot, continuityPath }) => {
      const config: PcwConfig = {
        workstreams: {
          "../ESCAPE": { continuity: { path: "state/BACKEND.md" } }
        }
      };

      await assert.rejects(
        updateContinuity(contextRoot, config, {
          requestedWorkstream: "../escape",
          content: "unsafe replacement",
          expectedSha256: sha256Text(initialContent)
        }),
        (error) =>
          error instanceof ContinuityUpdateError &&
          /safe continuity history directory/.test(error.details)
      );

      assert.equal(await readFile(continuityPath, "utf8"), initialContent);
      await assert.rejects(readdir(join(contextRoot, ".pcw")));
    }
  );
});

test("history junction outside the root is rejected before creating a backup", async (t) => {
  await withContinuityFilesystem(
    async ({ contextRoot, continuityPath, outsideRoot, config }) => {
      const metadataDirectory = join(contextRoot, ".pcw");
      await mkdir(metadataDirectory);
      const historyRoot = join(metadataDirectory, "history");

      try {
        await symlink(
          outsideRoot,
          historyRoot,
          platform === "win32" ? "junction" : "dir"
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
          t.skip(`Symlink creation is unavailable: ${code}`);
          return;
        }
        throw error;
      }

      await assert.rejects(
        updateContinuity(contextRoot, config, {
          requestedWorkstream: "BACKEND",
          content: "blocked replacement",
          expectedSha256: sha256Text(initialContent)
        }),
        (error) => error instanceof ContinuityUpdateError
      );

      assert.equal(await readFile(continuityPath, "utf8"), initialContent);
      assert.deepEqual(await readdir(outsideRoot), []);
    }
  );
});

test("history creation failure prevents continuity replacement", async () => {
  await withContinuityFilesystem(
    async ({ contextRoot, continuityPath, config }) => {
      await writeFile(join(contextRoot, ".pcw"), "history blocker", "utf8");

      await assert.rejects(
        updateContinuity(contextRoot, config, {
          requestedWorkstream: "BACKEND",
          content: "must not be written",
          expectedSha256: sha256Text(initialContent)
        }),
        (error) => error instanceof ContinuityUpdateError
      );

      assert.equal(await readFile(continuityPath, "utf8"), initialContent);
    }
  );
});

test("missing continuity target is rejected for reads and updates", async () => {
  await withContinuityFilesystem(async ({ contextRoot }) => {
    const config: PcwConfig = {
      workstreams: {
        MISSING: { continuity: { path: "state/missing.md" } }
      }
    };

    await assert.rejects(
      getContinuitySnapshot(contextRoot, config, "MISSING"),
      (error) => error instanceof ContinuityReadError
    );
    await assert.rejects(
      updateContinuity(contextRoot, config, {
        requestedWorkstream: "MISSING",
        content: "replacement",
        expectedSha256: sha256Text("")
      }),
      (error) => error instanceof ContinuityUpdateError
    );
  });
});

test("Markdown extension matching remains case-insensitive", async () => {
  await withContinuityFilesystem(async ({ contextRoot }) => {
    const upperPath = join(contextRoot, "state", "UPPER.MD");
    await writeFile(upperPath, initialContent, "utf8");
    const config: PcwConfig = {
      workstreams: {
        UPPER: { continuity: { path: "state/UPPER.MD" } }
      }
    };

    const result = await updateContinuity(contextRoot, config, {
      requestedWorkstream: "upper",
      content: "# UPPER Continuity\n\nUpdated.\n",
      expectedSha256: sha256Text(initialContent)
    });
    assert.equal(result.updated, true);
  });
});
