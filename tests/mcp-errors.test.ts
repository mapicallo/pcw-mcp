import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  callTool,
  fixtureRoot,
  withServer,
  withTemporaryContext
} from "./mcp-test-client.js";

test("unknown shared context preserves the current MCP error payload", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{
      error: string;
      available: string[];
    }>(client, "list_sources", { scope: "shared", name: "MISSING" });

    assert.equal(response.isError, true);
    assert.equal((response.data as { code: string }).code, "PCW_CONTEXT_NOT_CONFIGURED");
    assert.equal(response.data.error, "Shared context 'MISSING' is not defined");
    assert.deepEqual(response.data.available, ["general", "organization"]);
  });
});

test("missing source preserves its tool-specific MCP error", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{ error: string; details: string }>(
      client,
      "read_text_source",
      { scope: "shared", name: "general", source: "missing.md" }
    );

    assert.equal(response.isError, true);
    assert.equal((response.data as { code: string }).code, "PCW_SOURCE_ERROR");
    assert.equal(response.data.error, "Could not read source 'missing.md'");
    assert.equal(typeof response.data.details, "string");
  });
});

test("unsupported text extension preserves source diagnostics", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{ error: string; source: string }>(
      client,
      "read_text_source",
      { scope: "shared", name: "general", source: "document.pdf" }
    );

    assert.equal(response.isError, true);
    assert.equal((response.data as { code: string }).code, "PCW_SOURCE_ERROR");
    assert.equal(
      response.data.error,
      "This tool only supports Markdown (.md) and plain-text (.txt) sources"
    );
    assert.equal(response.data.source, "document.pdf");
  });
});

test("missing inventory configuration preserves its MCP error", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(/inventory:\r?\n  path: catalog\/inventory\.md\r?\n\r?\n/, ""),
      "utf8"
    );

    await withServer(contextRoot, async (client) => {
      const response = await callTool<{ error: string }>(client, "get_inventory");

      assert.equal(response.isError, true);
      assert.equal((response.data as { code: string }).code, "PCW_INVENTORY_ERROR");
      assert.equal(
        response.data.error,
        "No inventory document is configured in pcw.yml"
      );
    });
  });
});

test("workstream without continuity preserves its MCP error", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, `${config}  EMPTY: {}\n`, "utf8");

    await withServer(contextRoot, async (client) => {
      const response = await callTool<{ error: string }>(
        client,
        "get_continuity",
        { name: "EMPTY" }
      );

      assert.equal(response.isError, true);
      assert.equal((response.data as { code: string }).code, "PCW_CONTINUITY_NOT_CONFIGURED");
      assert.equal(
        response.data.error,
        "Workstream 'EMPTY' has no continuity document configured"
      );
    });
  });
});

test("non-Markdown continuity preserves path diagnostics", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("path: state/BACKEND.md", "path: state/BACKEND.txt"),
      "utf8"
    );

    await withServer(contextRoot, async (client) => {
      const response = await callTool<{ error: string; path: string }>(
        client,
        "update_continuity",
        {
          name: "BACKEND",
          content: "synthetic replacement",
          expectedSha256: "0".repeat(64)
        }
      );

      assert.equal(response.isError, true);
      assert.equal((response.data as { code: string }).code, "PCW_CONTINUITY_INVALID");
      assert.equal(
        response.data.error,
        "Continuity documents must be Markdown (.md)"
      );
      assert.equal(response.data.path, "state/BACKEND.txt");
    });
  });
});

test("unsafe history workstream preserves the controlled MCP error", async () => {
  await withTemporaryContext(async (contextRoot) => {
    const configPath = join(contextRoot, "pcw.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${config}  "../ESCAPE":\n    continuity:\n      path: state/BACKEND.md\n`,
      "utf8"
    );

    await withServer(contextRoot, async (client) => {
      const before = await callTool<{ sha256: string }>(
        client,
        "get_continuity",
        { name: "../ESCAPE" }
      );
      const response = await callTool<{ error: string; details: string }>(
        client,
        "update_continuity",
        {
          name: "../ESCAPE",
          content: "synthetic replacement",
          expectedSha256: before.data.sha256
        }
      );

      assert.equal(response.isError, true);
      assert.equal((response.data as { code: string }).code, "PCW_CONTINUITY_INVALID");
      assert.equal(
        response.data.error,
        "Could not update continuity for '../ESCAPE'"
      );
      assert.match(response.data.details, /safe continuity history directory/);
    });
  });
});
