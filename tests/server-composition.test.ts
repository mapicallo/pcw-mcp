import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  McpServer
} from "@modelcontextprotocol/server";

import { createPcwMcpServer } from "../src/mcp/create-server.js";
import {
  DEFAULT_PCW_CONTEXT_ROOT,
  resolveRuntimeContextRoot
} from "../src/runtime/context-root.js";
import {
  callTool,
  fixtureRoot,
  withServer,
  withTemporaryContext
} from "./mcp-test-client.js";

const expectedToolNames = [
  "hello",
  "get_project_info",
  "list_workstreams",
  "get_workstream_info",
  "get_continuity",
  "list_shared_context",
  "list_sources",
  "get_inventory",
  "search_inventory",
  "read_text_source",
  "read_docx_source",
  "read_pdf_source",
  "update_continuity"
];

type ProjectInfo = {
  contextRoot: string;
  project: {
    id: string | null;
    name: string | null;
  };
};

async function connectInMemory(contextRoot: string) {
  const server = createPcwMcpServer({ contextRoot });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "pcw-composition-tests",
    version: "1.0.0"
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    async close(): Promise<void> {
      await client.close();
      await server.close();
    }
  };
}

async function setProjectIdentity(
  contextRoot: string,
  id: string,
  name: string
): Promise<void> {
  const configPath = join(contextRoot, "pcw.yml");
  const original = await readFile(configPath, "utf8");
  const updated = original
    .replace("id: sample-pcw", `id: ${id}`)
    .replace("name: Sample Persistent Context Workspace", `name: ${name}`);

  await writeFile(configPath, updated, "utf8");
}

test("server factory returns an unconnected McpServer without mutating process state", async () => {
  const originalEnvironment = { ...process.env };
  const server = createPcwMcpServer({ contextRoot: fixtureRoot });

  assert.ok(server instanceof McpServer);
  assert.deepEqual({ ...process.env }, originalEnvironment);

  await server.close();
});

test("server factory exposes the established tools and metadata in memory", async () => {
  const connection = await connectInMemory(fixtureRoot);

  try {
    const result = await connection.client.listTools();
    const names = result.tools.map((tool) => tool.name);

    assert.deepEqual([...names].sort(), [...expectedToolNames].sort());
    assert.equal(new Set(names).size, expectedToolNames.length);
    assert.deepEqual(connection.client.getServerVersion(), {
      name: "pcw-mcp",
      version: "0.1.0"
    });
  } finally {
    await connection.close();
  }
});

test("explicit context root is independent from process environment", async () => {
  const previousRoot = process.env.PCW_CONTEXT_ROOT;
  process.env.PCW_CONTEXT_ROOT = join(fixtureRoot, "ignored-environment-root");
  const connection = await connectInMemory(fixtureRoot);

  try {
    const response = await callTool<ProjectInfo>(
      connection.client,
      "get_project_info"
    );

    assert.equal(response.data.contextRoot, fixtureRoot);
    assert.equal(response.data.project.id, "sample-pcw");
  } finally {
    await connection.close();
    if (previousRoot === undefined) {
      delete process.env.PCW_CONTEXT_ROOT;
    } else {
      process.env.PCW_CONTEXT_ROOT = previousRoot;
    }
  }
});

test("two server instances retain independent synthetic contexts", async () => {
  await withTemporaryContext(async (contextA) => {
    await withTemporaryContext(async (contextB) => {
      await setProjectIdentity(contextA, "project-a", "Synthetic Project A");
      await setProjectIdentity(contextB, "project-b", "Synthetic Project B");

      const connectionA = await connectInMemory(contextA);
      const connectionB = await connectInMemory(contextB);

      try {
        const [responseA, responseB] = await Promise.all([
          callTool<ProjectInfo>(connectionA.client, "get_project_info"),
          callTool<ProjectInfo>(connectionB.client, "get_project_info")
        ]);

        assert.equal(responseA.data.contextRoot, contextA);
        assert.equal(responseA.data.project.id, "project-a");
        assert.equal(responseA.data.project.name, "Synthetic Project A");
        assert.equal(responseB.data.contextRoot, contextB);
        assert.equal(responseB.data.project.id, "project-b");
        assert.equal(responseB.data.project.name, "Synthetic Project B");
      } finally {
        await connectionA.close();
        await connectionB.close();
      }
    });
  });
});

test("runtime context root preserves environment override and fallback semantics", () => {
  assert.equal(
    resolveRuntimeContextRoot({ PCW_CONTEXT_ROOT: "synthetic-root" }),
    "synthetic-root"
  );
  assert.equal(resolveRuntimeContextRoot({}), DEFAULT_PCW_CONTEXT_ROOT);
  assert.equal(resolveRuntimeContextRoot({ PCW_CONTEXT_ROOT: "" }), "");
});

test("compiled stdio entrypoint remains operational", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<ProjectInfo>(client, "get_project_info");

    assert.equal(response.data.contextRoot, fixtureRoot);
    assert.equal(response.data.project.id, "sample-pcw");
  });
});
