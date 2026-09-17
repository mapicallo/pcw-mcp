import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { acquirePcwConfigMutationLock } from "../src/config/config-mutation.js";
import { pcwConfigSchema } from "../src/config/pcw-schema.js";
import {
  ContextCreateConflictError,
  ContextWorkstreamNotFoundError,
  createSharedContext,
  enableWorkstreamContext,
  SharedContextAlreadyExistsError,
  SharedContextNameInvalidError,
  WorkstreamContextAlreadyConfiguredError
} from "../src/contexts/context-service.js";
import {
  createWorkstream,
  WorkstreamCreateConflictError
} from "../src/workstreams/workstream-service.js";
import {
  callTool,
  withServer,
  withTemporaryContext
} from "./mcp-test-client.js";

test("create_shared_context preserves config and writes readable block YAML", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(configPath, `# preserved comment\n${original}`, "utf8");

    const result = await createSharedContext(contextRoot, {
      name: "consolidated"
    });
    const updated = await readFile(configPath, "utf8");
    const parsed = pcwConfigSchema.parse(parse(updated));

    assert.deepEqual(result, {
      name: "consolidated",
      path: "shared/consolidated",
      configBackupPath: result.configBackupPath,
      created: true
    });
    await access(join(contextRoot, "shared", "consolidated"));
    assert.equal(parsed.shared_context?.consolidated?.path, "shared/consolidated");
    assert.equal(parsed.project?.id, "sample-pcw");
    assert.match(updated, /^# preserved comment/m);
    assert.match(
      updated,
      /shared_context:\r?\n(?:.|\r?\n)*  consolidated:\r?\n    path: shared\/consolidated/
    );
    assert.equal(
      await readFile(join(contextRoot, result.configBackupPath), "utf8"),
      `# preserved comment\n${original}`
    );
  });
});

test("create_shared_context rejects duplicates, unsafe names, and collisions", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await assert.rejects(
      createSharedContext(contextRoot, { name: "general" }),
      SharedContextAlreadyExistsError
    );
    await assert.rejects(
      createSharedContext(contextRoot, { name: "GENERAL" }),
      SharedContextAlreadyExistsError
    );
    await assert.rejects(
      createSharedContext(contextRoot, { name: "../outside" }),
      SharedContextNameInvalidError
    );

    await mkdir(join(contextRoot, "shared", "occupied"), { recursive: true });
    await assert.rejects(
      createSharedContext(contextRoot, { name: "occupied" }),
      ContextCreateConflictError
    );
  });
});

test("create_shared_context rolls back its generated directory on config failure", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    const before = await readFile(configPath, "utf8");

    await assert.rejects(
      createSharedContext(
        contextRoot,
        { name: "rollback-shared" },
        {
          writeConfigAtomic: async () => {
            throw new Error("synthetic config failure");
          }
        }
      ),
      ContextCreateConflictError
    );

    assert.equal(await readFile(configPath, "utf8"), before);
    await assert.rejects(access(join(contextRoot, "shared", "rollback-shared")));
  });
});

test("enable_workstream_context preserves continuity and configures canonical name", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const continuityPath = join(contextRoot, "state", "OPERATIONS.md");
    const continuityBefore = await readFile(continuityPath, "utf8");
    const result = await enableWorkstreamContext(contextRoot, {
      name: "operations"
    });
    const parsed = pcwConfigSchema.parse(
      parse(await readFile(join(contextRoot, "pcw.yml"), "utf8"))
    );

    assert.equal(result.workstream, "OPERATIONS");
    assert.equal(result.contextPath, "workstreams/OPERATIONS");
    assert.equal(result.created, true);
    assert.equal(
      parsed.workstreams?.OPERATIONS?.context?.path,
      "workstreams/OPERATIONS"
    );
    assert.equal(
      parsed.workstreams?.OPERATIONS?.continuity?.path,
      "state/OPERATIONS.md"
    );
    assert.equal(await readFile(continuityPath, "utf8"), continuityBefore);
    await access(join(contextRoot, "workstreams", "OPERATIONS"));
    await access(join(contextRoot, result.configBackupPath));
  });
});

test("enable_workstream_context rejects configured, unknown, and collided targets", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await assert.rejects(
      enableWorkstreamContext(contextRoot, { name: "backend" }),
      WorkstreamContextAlreadyConfiguredError
    );
    await assert.rejects(
      enableWorkstreamContext(contextRoot, { name: "missing" }),
      ContextWorkstreamNotFoundError
    );
    await mkdir(join(contextRoot, "workstreams", "OPERATIONS"), {
      recursive: true
    });
    await assert.rejects(
      enableWorkstreamContext(contextRoot, { name: "OPERATIONS" }),
      ContextCreateConflictError
    );
  });
});

test("enable_workstream_context rolls back on config failure", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    const before = await readFile(configPath, "utf8");
    await assert.rejects(
      enableWorkstreamContext(
        contextRoot,
        { name: "OPERATIONS" },
        {
          writeConfigAtomic: async () => {
            throw new Error("synthetic config failure");
          }
        }
      ),
      ContextCreateConflictError
    );
    assert.equal(await readFile(configPath, "utf8"), before);
    await assert.rejects(access(join(contextRoot, "workstreams", "OPERATIONS")));
  });
});

test("all structural writers coordinate through the same config lock", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const release = await acquirePcwConfigMutationLock(contextRoot);
    try {
      await assert.rejects(
        createSharedContext(contextRoot, { name: "locked-shared" }),
        ContextCreateConflictError
      );
      await assert.rejects(
        enableWorkstreamContext(contextRoot, { name: "OPERATIONS" }),
        ContextCreateConflictError
      );
      await assert.rejects(
        createWorkstream(contextRoot, { name: "LOCKED-WORKSTREAM" }),
        WorkstreamCreateConflictError
      );
    } finally {
      await release();
    }
  });
});

test("context onboarding returns additive machine-readable MCP errors", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await withServer(contextRoot, async (client) => {
      const duplicate = await callTool<{ code: string; existingContext: string }>(
        client,
        "create_shared_context",
        { name: "GENERAL" }
      );
      const invalid = await callTool<{ code: string }>(
        client,
        "create_shared_context",
        { name: "../unsafe" }
      );
      const configured = await callTool<{ code: string; workstream: string }>(
        client,
        "enable_workstream_context",
        { name: "backend" }
      );
      const unknown = await callTool<{ code: string }>(
        client,
        "enable_workstream_context",
        { name: "missing" }
      );

      assert.equal(duplicate.data.code, "PCW_SHARED_CONTEXT_ALREADY_EXISTS");
      assert.equal(duplicate.data.existingContext, "general");
      assert.equal(invalid.data.code, "PCW_SHARED_CONTEXT_NAME_INVALID");
      assert.equal(
        configured.data.code,
        "PCW_WORKSTREAM_CONTEXT_ALREADY_CONFIGURED"
      );
      assert.equal(configured.data.workstream, "BACKEND");
      assert.equal(unknown.data.code, "PCW_WORKSTREAM_NOT_FOUND");
    });
  });
});

test("new context and inventory capabilities are immediately usable through MCP", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await withServer(contextRoot, async (client) => {
      const shared = await callTool<{
        name: string;
        path: string;
        created: boolean;
      }>(client, "create_shared_context", { name: "reference" });
      const enabled = await callTool<{
        workstream: string;
        contextPath: string;
        created: boolean;
      }>(client, "enable_workstream_context", { name: "operations" });

      assert.equal(shared.isError, false);
      assert.equal(shared.data.path, "shared/reference");
      assert.equal(enabled.data.workstream, "OPERATIONS");
      await writeFile(
        join(contextRoot, shared.data.path, "approved.md"),
        "# Approved synthetic source\n",
        "utf8"
      );

      const sections = await callTool<Array<{ name: string }>>(
        client,
        "list_shared_context"
      );
      const info = await callTool<{
        context: { configured: boolean; exists: boolean };
      }>(client, "get_workstream_info", { name: "OPERATIONS" });
      const sources = await callTool<{ sources: Array<{ name: string }> }>(
        client,
        "list_sources",
        { scope: "shared", name: "reference" }
      );
      const source = await callTool<{ text: string }>(
        client,
        "read_text_source",
        { scope: "shared", name: "reference", source: "approved.md" }
      );
      const before = await callTool<{ sha256: string }>(client, "get_inventory");
      const replacement = "### Approved reference\nSynthetic searchable marker.\n";
      const update = await callTool<{
        newSha256: string;
        updated: boolean;
      }>(client, "update_inventory", {
        content: replacement,
        expectedSha256: before.data.sha256
      });
      const search = await callTool<{ matchCount: number }>(
        client,
        "search_inventory",
        { query: "searchable marker" }
      );
      const stale = await callTool<{ code: string }>(
        client,
        "update_inventory",
        { content: "stale", expectedSha256: before.data.sha256 }
      );

      assert.ok(sections.data.some(({ name }) => name === "reference"));
      assert.equal(info.data.context.configured, true);
      assert.equal(info.data.context.exists, true);
      assert.ok(sources.data.sources.some(({ name }) => name === "approved.md"));
      assert.match(source.data.text, /Approved synthetic source/);
      assert.equal(update.data.updated, true);
      assert.match(update.data.newSha256, /^[a-f0-9]{64}$/);
      assert.equal(search.data.matchCount, 1);
      assert.equal(stale.isError, true);
      assert.equal(stale.data.code, "PCW_INVENTORY_STALE");
    });
  });
});
