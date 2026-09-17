import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  callTool,
  withServer,
  withTemporaryContext
} from "./mcp-test-client.js";

test("create_workstream is discoverable with its additive public schema", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await withServer(contextRoot, async (client) => {
      const tools = await client.listTools();
      const tool = tools.tools.find(({ name }) => name === "create_workstream");

      assert.equal(tools.tools.length, 16);
      assert.ok(tool);
      assert.deepEqual(tool.inputSchema.required, ["name"]);
      assert.deepEqual(tool.inputSchema.properties?.mode, {
        type: "string",
        enum: ["continuity-only", "with-context"],
        default: "continuity-only",
        description:
          "Whether to create only continuity or also specialized context"
      });
      assert.equal(
        tool.inputSchema.properties?.initialObjective.maxLength,
        2_000
      );
    });
  });
});
test("create_workstream is immediately usable through MCP without restart", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const originalInventory = await readFile(
      join(contextRoot, "catalog", "inventory.md"),
      "utf8"
    );

    await withServer(contextRoot, async (client) => {
      const created = await callTool<{
        workstream: string;
        mode: string;
        continuityPath: string;
        contextPath: string;
        configBackupPath: string;
        created: boolean;
        initialContinuitySha256: string;
      }>(client, "create_workstream", {
        name: "MCP-LAB",
        mode: "with-context",
        initialObjective: "Validate synthetic MCP creation."
      });
      assert.equal(created.isError, false);
      assert.deepEqual(
        {
          workstream: created.data.workstream,
          mode: created.data.mode,
          continuityPath: created.data.continuityPath,
          contextPath: created.data.contextPath,
          created: created.data.created
        },
        {
          workstream: "MCP-LAB",
          mode: "with-context",
          continuityPath: "continuity/MCP-LAB.md",
          contextPath: "workstreams/MCP-LAB",
          created: true
        }
      );
      assert.match(created.data.configBackupPath, /^\.pcw\/history\/config\//);
      assert.match(created.data.initialContinuitySha256, /^[a-f0-9]{64}$/);

      const workstreams = await callTool<Array<{ name: string }>>(
        client,
        "list_workstreams"
      );
      const info = await callTool<{
        name: string;
        context: { configured: boolean; exists: boolean };
        continuity: { configured: boolean; exists: boolean };
      }>(client, "get_workstream_info", { name: "mcp-lab" });
      const continuity = await callTool<{
        workstream: string;
        sha256: string;
        continuity: string;
      }>(client, "get_continuity", { name: "Mcp-Lab" });

      assert.ok(workstreams.data.some(({ name }) => name === "MCP-LAB"));
      assert.equal(info.data.name, "MCP-LAB");
      assert.equal(info.data.context.configured, true);
      assert.equal(info.data.context.exists, true);
      assert.equal(info.data.continuity.configured, true);
      assert.equal(info.data.continuity.exists, true);
      assert.equal(continuity.data.workstream, "MCP-LAB");
      assert.equal(
        continuity.data.sha256,
        created.data.initialContinuitySha256
      );
      assert.match(continuity.data.continuity, /Validate synthetic MCP creation/);
      await access(join(contextRoot, "workstreams", "MCP-LAB"));
    });

    assert.equal(
      await readFile(join(contextRoot, "catalog", "inventory.md"), "utf8"),
      originalInventory
    );
  });
});

test("create_workstream returns machine-readable duplicate and name errors", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await withServer(contextRoot, async (client) => {
      const duplicate = await callTool<{
        code: string;
        existingWorkstream: string;
      }>(client, "create_workstream", { name: "backend" });
      const invalid = await callTool<{
        code: string;
        rule: string;
      }>(client, "create_workstream", { name: "../unsafe" });

      assert.equal(duplicate.isError, true);
      assert.equal(duplicate.data.code, "PCW_WORKSTREAM_ALREADY_EXISTS");
      assert.equal(duplicate.data.existingWorkstream, "BACKEND");
      assert.equal(invalid.isError, true);
      assert.equal(invalid.data.code, "PCW_WORKSTREAM_NAME_INVALID");
      assert.match(invalid.data.rule, /1 to 64 ASCII/);
    });
  });
});
