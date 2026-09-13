import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPcwConfig } from "../src/config/pcw-config.js";
import { callTool, withServer } from "./mcp-test-client.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = join(repositoryRoot, "examples", "sample-context");
const templatesRoot = join(repositoryRoot, "templates");

test("minimal template creates a valid continuity-only PCW context", async () => {
  const contextRoot = await mkdtemp(join(tmpdir(), "pcw-minimal-template-"));

  try {
    await cp(join(templatesRoot, "pcw-minimal.yml"), join(contextRoot, "pcw.yml"));
    await cp(join(templatesRoot, "inventory.md"), join(contextRoot, "inventory.md"));
    await mkdir(join(contextRoot, "continuity"));
    await cp(
      join(templatesRoot, "continuity.md"),
      join(contextRoot, "continuity", "WORKSTREAM.md")
    );

    const { config } = await loadPcwConfig(contextRoot);
    assert.equal(config.workstreams?.WORKSTREAM?.context, undefined);
    assert.equal(
      config.workstreams?.WORKSTREAM?.continuity?.path,
      "continuity/WORKSTREAM.md"
    );

    await withServer(contextRoot, async (client) => {
      const info = await callTool<{
        context: { configured: boolean };
        continuity: { configured: boolean };
      }>(client, "get_workstream_info", { name: "WORKSTREAM" });
      const continuity = await callTool<{ continuity: string }>(
        client,
        "get_continuity",
        { name: "WORKSTREAM" }
      );
      const inventory = await callTool<{ matchCount: number }>(
        client,
        "search_inventory",
        { query: "Search terms" }
      );

      assert.equal(info.data.context.configured, false);
      assert.equal(info.data.continuity.configured, true);
      assert.match(continuity.data.continuity, /## Current objective/);
      assert.equal(inventory.data.matchCount, 1);
    });
  } finally {
    await rm(contextRoot, { recursive: true, force: true });
  }
});

test("public templates describe durable checkpoints and inventory sections", async () => {
  const continuity = await readFile(join(templatesRoot, "continuity.md"), "utf8");
  const inventory = await readFile(join(templatesRoot, "inventory.md"), "utf8");
  const combined = `${continuity}\n${inventory}`;

  assert.match(continuity, /## Current objective/);
  assert.match(continuity, /## Decisions/);
  assert.match(continuity, /## Next action/);
  assert.match(inventory, /^###\s+.+$/m);
  assert.doesNotMatch(combined, /\bRMMS\b|\bIndra\b|C:\\Users\\|C:\\code\\/i);
});

test("public sample context follows the current PCW configuration contract", async () => {
  const { config } = await loadPcwConfig(exampleRoot);

  assert.deepEqual(config.project, {
    id: "example-taskboard",
    name: "Example Taskboard"
  });
  assert.deepEqual(Object.keys(config.shared_context ?? {}), [
    "general",
    "organization"
  ]);
  assert.equal(config.workstreams?.BACKEND?.context?.path, "delivery/api");
  assert.equal(config.workstreams?.BACKEND?.continuity?.path, "continuity/BACKEND.md");
  assert.equal(config.workstreams?.OPERATIONS?.context, undefined);
  assert.equal(
    config.workstreams?.OPERATIONS?.continuity?.path,
    "continuity/OPERATIONS.md"
  );
});

test("public sample context supports selective read-only onboarding flow", async () => {
  await withServer(exampleRoot, async (client) => {
    const project = await callTool<{
      project: { id: string; name: string };
    }>(client, "get_project_info");
    const workstreams = await callTool<Array<{
      name: string;
      contextPath: string | null;
    }>>(client, "list_workstreams");
    const inventory = await callTool<{
      matchCount: number;
      matches: Array<{ title: string }>;
    }>(client, "search_inventory", { query: "REQUEST VALIDATION" });
    const source = await callTool<{ text: string }>(
      client,
      "read_text_source",
      { scope: "workstream", name: "BACKEND", source: "backend-api.md" }
    );
    const continuity = await callTool<{
      workstream: string;
      continuity: string;
    }>(client, "get_continuity", { name: "operations" });

    assert.deepEqual(project.data.project, {
      id: "example-taskboard",
      name: "Example Taskboard"
    });
    assert.deepEqual(
      workstreams.data.map(({ name, contextPath }) => ({ name, contextPath })),
      [
        { name: "BACKEND", contextPath: "delivery/api" },
        { name: "OPERATIONS", contextPath: null }
      ]
    );
    assert.equal(inventory.data.matchCount, 1);
    assert.equal(inventory.data.matches[0].title, "Backend API Notes");
    assert.match(source.data.text, /Invalid titles return/);
    assert.equal(continuity.data.workstream, "OPERATIONS");
    assert.match(continuity.data.continuity, /no specialized context directory/);
  });
});
