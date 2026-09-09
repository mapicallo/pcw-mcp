import assert from "node:assert/strict";
import test from "node:test";

import { fixtureRoot, withServer } from "./mcp-test-client.js";

const expectedToolNames = [
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

test("MCP exposes exactly the established tool set without duplicates", async () => {
  await withServer(fixtureRoot, async (client) => {
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);

    assert.deepEqual([...names].sort(), [...expectedToolNames].sort());
    assert.equal(new Set(names).size, expectedToolNames.length);
  });
});

test("important tool descriptions and input-schema constraints are preserved", async () => {
  await withServer(fixtureRoot, async (client) => {
    const result = await client.listTools();
    const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
    const listSources = tools.get("list_sources");
    const searchInventory = tools.get("search_inventory");
    const updateContinuity = tools.get("update_continuity");

    assert.equal(
      listSources?.description,
      "Lists the files and directories available in a shared context section or workstream-specific context without reading their contents"
    );
    assert.deepEqual(listSources?.inputSchema.required, ["scope", "name"]);
    assert.deepEqual(
      listSources?.inputSchema.properties?.scope,
      {
        type: "string",
        enum: ["shared", "workstream"],
        description: "Context scope: shared or workstream"
      }
    );

    assert.deepEqual(searchInventory?.inputSchema.required, ["query"]);
    assert.deepEqual(
      searchInventory?.inputSchema.properties?.limit,
      {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of matching sections to return"
      }
    );

    assert.deepEqual(
      updateContinuity?.inputSchema.required,
      ["name", "content", "expectedSha256"]
    );
    assert.equal(
      updateContinuity?.inputSchema.properties?.content.maxLength,
      200_000
    );
    assert.equal(
      updateContinuity?.inputSchema.properties?.expectedSha256.minLength,
      64
    );
    assert.equal(
      updateContinuity?.inputSchema.properties?.expectedSha256.maxLength,
      64
    );
  });
});
