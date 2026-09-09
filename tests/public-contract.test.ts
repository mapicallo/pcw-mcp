import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PCW_ERROR_CODES } from "../src/mcp/error-codes.js";
import { PCW_SOFTWARE_VERSION } from "../src/version.js";
import {
  fixtureRoot,
  withServer,
  withTemporaryContext
} from "./mcp-test-client.js";

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type PackageMetadata = {
  name?: unknown;
  version?: unknown;
};

async function callRawError(contextRoot: string): Promise<Record<string, unknown>> {
  return withServer(contextRoot, async (client) => {
    const result = await client.callTool({
      name: "get_project_info",
      arguments: {}
    });
    const text = result.content.find((item) => item.type === "text");

    assert.equal(result.isError, true);
    assert.equal(text?.type, "text");
    return JSON.parse(text?.text ?? "") as Record<string, unknown>;
  });
}

test("package version is valid SemVer and is the runtime software version", async () => {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const parsed: unknown = JSON.parse(await readFile(packagePath, "utf8"));

  assert.ok(typeof parsed === "object" && parsed !== null);
  const metadata = parsed as PackageMetadata;
  assert.equal(metadata.name, "pcw-mcp");
  assert.equal(metadata.version, "0.2.0-beta.1");
  assert.ok(typeof metadata.version === "string");
  assert.match(metadata.version, semverPattern);
  assert.equal(PCW_SOFTWARE_VERSION, metadata.version);
});

test("MCP server identity advertises the package software version", async () => {
  await withServer(fixtureRoot, async (client) => {
    assert.deepEqual(client.getServerVersion(), {
      name: "pcw-mcp",
      version: PCW_SOFTWARE_VERSION
    });
  });
});

test("invalid YAML is a concise coded MCP configuration error", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await writeFile(join(contextRoot, "pcw.yml"), "project: [invalid", "utf8");
    const payload = await callRawError(contextRoot);
    const serialized = JSON.stringify(payload);

    assert.equal(payload.code, PCW_ERROR_CODES.CONFIG_INVALID);
    assert.match(String(payload.error), /^Could not parse PCW configuration at /);
    assert.doesNotMatch(serialized, /\n\s*at\s/);
    assert.doesNotMatch(serialized, /project: \[invalid/);
  });
});

test("structurally invalid pcw.yml exposes bounded coded validation details", async () => {
  await withTemporaryContext(async (contextRoot) => {
    await writeFile(join(contextRoot, "pcw.yml"), "workstreams: []\n", "utf8");
    const payload = await callRawError(contextRoot);
    const serialized = JSON.stringify(payload);

    assert.equal(payload.code, PCW_ERROR_CODES.CONFIG_INVALID);
    assert.match(String(payload.error), /^Invalid PCW configuration at /);
    assert.match(String(payload.error), /workstreams:/);
    assert.doesNotMatch(serialized, /ZodError|\n\s*at\s/);
  });
});
