import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  callTool,
  fixtureRoot,
  withServer,
  withTemporaryContext
} from "./mcp-test-client.js";

type WorkstreamStatus = {
  path: string | null;
  configured: boolean;
  exists: boolean;
  absolutePath: string | null;
  type: string | null;
};

type Continuity = {
  workstream: string;
  path: string;
  sha256: string;
  continuity: string;
};

const digest = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

test("get_project_info returns the configured synthetic project", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{
      version: number;
      project: { id: string; name: string };
      inventory: string;
    }>(client, "get_project_info");

    assert.equal(response.isError, false);
    assert.deepEqual(response.data.project, {
      id: "sample-pcw",
      name: "Sample Persistent Context Workspace"
    });
    assert.equal(response.data.version, 1);
    assert.equal(response.data.inventory, "catalog/inventory.md");
  });
});

test("list_workstreams reflects the pcw.yml definitions", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<Array<{
      name: string;
      contextPath: string | null;
      continuityPath: string | null;
    }>>(client, "list_workstreams");

    assert.deepEqual(response.data, [
      {
        name: "BACKEND",
        contextPath: "engineering/backend-material",
        continuityPath: "state/BACKEND.md"
      },
      {
        name: "OPERATIONS",
        contextPath: null,
        continuityPath: "state/OPERATIONS.md"
      }
    ]);
  });
});

test("get_workstream_info distinguishes configured and absent specialized context", async () => {
  await withServer(fixtureRoot, async (client) => {
    const backend = await callTool<{
      name: string;
      context: WorkstreamStatus;
      continuity: WorkstreamStatus;
    }>(client, "get_workstream_info", { name: "backend" });
    const operations = await callTool<{
      name: string;
      context: WorkstreamStatus;
      continuity: WorkstreamStatus;
    }>(client, "get_workstream_info", { name: "OPERATIONS" });

    assert.equal(backend.data.name, "BACKEND");
    assert.deepEqual(
      {
        configured: backend.data.context.configured,
        exists: backend.data.context.exists,
        type: backend.data.context.type
      },
      { configured: true, exists: true, type: "directory" }
    );
    assert.deepEqual(
      {
        configured: backend.data.continuity.configured,
        exists: backend.data.continuity.exists,
        type: backend.data.continuity.type
      },
      { configured: true, exists: true, type: "file" }
    );
    assert.equal(operations.data.name, "OPERATIONS");
    assert.deepEqual(operations.data.context, {
      path: null,
      configured: false,
      exists: false,
      absolutePath: null,
      type: null
    });
    assert.deepEqual(
      {
        configured: operations.data.continuity.configured,
        exists: operations.data.continuity.exists,
        type: operations.data.continuity.type
      },
      { configured: true, exists: true, type: "file" }
    );
  });
});

test("list_shared_context returns configured logical sections", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<Array<{
      name: string;
      path: string;
      configured: boolean;
      exists: boolean;
      type: string;
    }>>(client, "list_shared_context");

    assert.deepEqual(
      response.data.map(({ name, path, configured, exists, type }) => ({
        name,
        path,
        configured,
        exists,
        type
      })),
      [
        {
          name: "general",
          path: "knowledge/base",
          configured: true,
          exists: true,
          type: "directory"
        },
        {
          name: "organization",
          path: "company/handbook",
          configured: true,
          exists: true,
          type: "directory"
        }
      ]
    );
  });
});

test("list_sources discovers metadata without loading source content", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{
      sourceCount: number;
      sources: Array<Record<string, unknown>>;
    }>(client, "list_sources", { scope: "shared", name: "general" });

    assert.equal(response.data.sourceCount, 2);
    assert.deepEqual(
      response.data.sources.map((source) => source.name),
      ["architecture.md", "glossary.txt"]
    );
    assert.ok(response.data.sources.every((source) => !("text" in source)));
  });
});

test("get_inventory returns the complete synthetic inventory", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{
      path: string;
      absolutePath: string;
      sizeBytes: number;
      modifiedAt: string;
      inventory: string;
    }>(client, "get_inventory");

    assert.equal(response.data.path, "catalog/inventory.md");
    assert.match(response.data.absolutePath, /catalog[\\/]inventory\.md$/);
    assert.ok(response.data.sizeBytes > 0);
    assert.equal(
      new Date(response.data.modifiedAt).toISOString(),
      response.data.modifiedAt
    );
    assert.match(response.data.inventory, /Sample Context Inventory/);
    assert.match(response.data.inventory, /OPERATIONS/);
  });
});

test("search_inventory matches sections case-insensitively", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{
      query: string;
      matchCount: number;
      matches: Array<{ title: string; content: string }>;
    }>(client, "search_inventory", { query: "QUEUE TOPOLOGY" });

    assert.equal(response.data.query, "QUEUE TOPOLOGY");
    assert.equal(response.data.inventory, "catalog/inventory.md");
    assert.equal(response.data.matchCount, 1);
    assert.equal(response.data.matches[0].title, "Backend service notes");
    assert.match(response.data.matches[0].content, /queue topology/);
  });
});

test("read_text_source selectively reads Markdown and TXT sources", async () => {
  await withServer(fixtureRoot, async (client) => {
    const markdown = await callTool<{ source: string; text: string }>(
      client,
      "read_text_source",
      { scope: "workstream", name: "BACKEND", source: "backend-notes.md" }
    );
    const text = await callTool<{ source: string; text: string }>(
      client,
      "read_text_source",
      { scope: "shared", name: "general", source: "glossary.txt" }
    );

    assert.match(markdown.data.text, /bounded retries/);
    assert.match(text.data.text, /fictional entry point/);
  });
});

test("get_continuity returns content, path, workstream, and lowercase SHA-256", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<Continuity>(client, "get_continuity", {
      name: "backend"
    });

    assert.equal(response.data.workstream, "BACKEND");
    assert.equal(response.data.path, "state/BACKEND.md");
    assert.match(response.data.continuity, /BACKEND Continuity/);
    assert.match(response.data.sha256, /^[a-f0-9]{64}$/);
    assert.equal(response.data.sha256, digest(response.data.continuity));
  });
});

test("update_continuity replaces content when the expected SHA is current", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await withServer(contextRoot, async (client) => {
      const before = await callTool<Continuity>(client, "get_continuity", {
        name: "BACKEND"
      });
      const newContent = "# BACKEND Continuity\n\nTemporary successful update.\n";
      const update = await callTool<{
        updated: boolean;
        previousSha256: string;
        newSha256: string;
      }>(client, "update_continuity", {
        name: "BACKEND",
        content: newContent,
        expectedSha256: before.data.sha256
      });
      const after = await callTool<Continuity>(client, "get_continuity", {
        name: "BACKEND"
      });

      assert.equal(update.isError, false);
      assert.equal(update.data.updated, true);
      assert.equal(update.data.previousSha256, before.data.sha256);
      assert.notEqual(update.data.newSha256, before.data.sha256);
      assert.equal(after.data.continuity, newContent);
      assert.equal(after.data.sha256, update.data.newSha256);
    });
  });
});

test("update_continuity backs up the previous content in .pcw history", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await withServer(contextRoot, async (client) => {
      const before = await callTool<Continuity>(client, "get_continuity", {
        name: "BACKEND"
      });
      const update = await callTool<{ backupPath: string }>(
        client,
        "update_continuity",
        {
          name: "BACKEND",
          content: "# BACKEND Continuity\n\nBackup characterization update.\n",
          expectedSha256: before.data.sha256
        }
      );
      const historyDirectory = join(
        contextRoot,
        ".pcw",
        "history",
        "BACKEND"
      );
      const historyFiles = await readdir(historyDirectory);

      assert.equal(historyFiles.length, 1);
      assert.equal(update.data.backupPath, join(historyDirectory, historyFiles[0]));
      assert.equal(
        await readFile(join(historyDirectory, historyFiles[0]), "utf8"),
        before.data.continuity
      );
    });
  });
});

test("update_continuity rejects stale writes without overwriting newer state", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await withServer(contextRoot, async (client) => {
      const sessionA = await callTool<Continuity>(client, "get_continuity", {
        name: "BACKEND"
      });
      const sessionBContent = "# BACKEND Continuity\n\nSession B wins.\n";
      await callTool(client, "update_continuity", {
        name: "BACKEND",
        content: sessionBContent,
        expectedSha256: sessionA.data.sha256
      });
      const stale = await callTool<{
        error: string;
        expectedSha256: string;
        currentSha256: string;
      }>(client, "update_continuity", {
        name: "BACKEND",
        content: "# BACKEND Continuity\n\nStale Session A content.\n",
        expectedSha256: sessionA.data.sha256
      });
      const current = await callTool<Continuity>(client, "get_continuity", {
        name: "BACKEND"
      });

      assert.equal(stale.isError, true);
      assert.equal(stale.data.error, "Continuity has changed since it was read");
      assert.equal(stale.data.expectedSha256, sessionA.data.sha256);
      assert.notEqual(stale.data.currentSha256, sessionA.data.sha256);
      assert.equal(current.data.continuity, sessionBContent);
      assert.equal(current.data.sha256, stale.data.currentSha256);
    });
  });
});

test("read_text_source rejects traversal outside its configured context", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const controlledOutsideFile = join(contextRoot, "knowledge", "outside.txt");
    await writeFile(controlledOutsideFile, "controlled traversal sentinel", "utf8");

    await withServer(contextRoot, async (client) => {
      const response = await callTool<{ error: string; details: string }>(
        client,
        "read_text_source",
        { scope: "shared", name: "general", source: "../outside.txt" }
      );

      assert.equal(response.isError, true);
      assert.equal(response.data.error, "Could not read source '../outside.txt'");
      assert.match(response.data.details, /escapes the configured PCW context root/);
      assert.doesNotMatch(JSON.stringify(response.data), /controlled traversal sentinel/);
    });
  });
});

test("get_workstream_info reports the current unknown-workstream error", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{
      error: string;
      availableWorkstreams: string[];
    }>(client, "get_workstream_info", { name: "MISSING" });

    assert.equal(response.isError, true);
    assert.equal(response.data.error, "Workstream 'MISSING' is not defined");
    assert.deepEqual(response.data.availableWorkstreams, [
      "BACKEND",
      "OPERATIONS"
    ]);
  });
});
