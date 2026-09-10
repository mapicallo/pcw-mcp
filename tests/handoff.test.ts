import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/client/stdio";
import { unzipSync } from "fflate";

const execFileAsync = promisify(execFile);
const zipPath = process.env.PCW_HANDOFF_ZIP;
const expectedVersion = process.env.PCW_HANDOFF_VERSION;

if (!zipPath || !expectedVersion) {
  throw new Error("PCW_HANDOFF_ZIP and PCW_HANDOFF_VERSION are required");
}

const expectedTools = [
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

async function runNpm(args: readonly string[], cwd: string): Promise<void> {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("npm_execpath is required for handoff verification");
  }
  await execFileAsync(process.execPath, [npmCli, ...args], {
    cwd,
    maxBuffer: 8 * 1024 * 1024
  });
}

function cleanEnvironment(): Record<string, string> {
  const environment = { ...getDefaultEnvironment() };
  delete environment.PCW_CONTEXT_ROOT;
  return environment;
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ data: T; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find(
    (item): item is { type: "text"; text: string } => item.type === "text"
  );
  assert.ok(text, `${name} returned text content`);
  return {
    data: JSON.parse(text.text) as T,
    isError: result.isError === true
  };
}

async function extractZip(archivePath: string, destination: string) {
  const entries = unzipSync(new Uint8Array(await readFile(archivePath)));
  const names = Object.keys(entries);

  for (const [name, content] of Object.entries(entries)) {
    const target = resolve(destination, ...name.split("/"));
    const escaped = relative(destination, target);
    assert.equal(escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), false);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  return names;
}

async function withInstalledServer<T>(
  serverEntry: string,
  contextRoot: string,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, "--context-root", contextRoot],
    cwd: dirname(serverEntry),
    env: cleanEnvironment(),
    stderr: "pipe"
  });
  const client = new Client({ name: "pcw-handoff-verifier", version: "1.0.0" });

  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close();
  }
}

test("extracted private-beta ZIP installs and operates independently", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-handoff-verify-"));

  try {
    const zipContent = await readFile(zipPath);
    const externalChecksum = await readFile(`${zipPath}.sha256`, "utf8");
    const zipHash = createHash("sha256").update(zipContent).digest("hex");
    assert.equal(externalChecksum.split(/\s+/)[0], zipHash);

    const extractionRoot = join(temporaryRoot, "extracted");
    await mkdir(extractionRoot, { recursive: true });
    const archiveEntries = await extractZip(zipPath, extractionRoot);
    const bundleName = `PCW-MCP-${expectedVersion}-PRIVATE-BETA`;
    const bundleRoot = join(extractionRoot, bundleName);
    const tarballName = `pcw-mcp-${expectedVersion}.tgz`;
    const tarballPath = join(bundleRoot, "package", tarballName);

    for (const required of [
      `${bundleName}/START-HERE.md`,
      `${bundleName}/PRIVATE-BETA-TERMS.md`,
      `${bundleName}/SHA256SUMS.txt`,
      `${bundleName}/package/${tarballName}`,
      `${bundleName}/sample-context/pcw.yml`,
      `${bundleName}/docs/private-beta.md`,
      `${bundleName}/docs/runtime.md`,
      `${bundleName}/docs/pcw-yml.md`,
      `${bundleName}/docs/mcp-tools.md`
    ]) {
      assert.ok(archiveEntries.includes(required), `ZIP contains ${required}`);
    }

    const forbiddenPaths = [
      /(^|\/)src\//i,
      /(^|\/)tests?\//i,
      /(^|\/)node_modules\//i,
      /(^|\/)\.git(?:\/|$)/i,
      /(^|\/)\.github(?:\/|$)/i,
      /(^|\/)CONTINUITY\.md$/i
    ];
    for (const entry of archiveEntries) {
      for (const pattern of forbiddenPaths) {
        assert.doesNotMatch(entry, pattern);
      }
    }

    const textEntries = archiveEntries.filter((entry) => !entry.endsWith(".tgz"));
    const forbiddenContent = [
      /C:\\rmms-context/i,
      /C:\\code\\pcw-mcp/i,
      /\bRMMS\b/i,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /github_pat_[A-Za-z0-9_]+/,
      /ghp_[A-Za-z0-9]+/
    ];
    for (const entry of textEntries) {
      const content = await readFile(resolve(extractionRoot, ...entry.split("/")), "utf8");
      for (const pattern of forbiddenContent) {
        assert.doesNotMatch(content, pattern, `forbidden content in ${entry}`);
      }
    }

    const sums = await readFile(join(bundleRoot, "SHA256SUMS.txt"), "utf8");
    const tarballHash = createHash("sha256")
      .update(await readFile(tarballPath))
      .digest("hex");
    assert.match(sums, new RegExp(`^${tarballHash}  package/${tarballName}$`, "m"));

    const installationRoot = join(temporaryRoot, "installation");
    await mkdir(installationRoot, { recursive: true });
    await writeFile(join(installationRoot, "package.json"), '{"private":true}', "utf8");
    await runNpm([
      "install",
      tarballPath,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund"
    ], installationRoot);

    const installedRoot = join(installationRoot, "node_modules", "pcw-mcp");
    const serverEntry = join(installedRoot, "dist", "server.js");
    await access(serverEntry);
    await access(join(installedRoot, "PRIVATE-BETA-TERMS.md"));
    await assert.rejects(access(join(installedRoot, "src")));
    await assert.rejects(access(join(installedRoot, "tests")));

    const version = spawnSync(process.execPath, [serverEntry, "--version"], {
      cwd: installationRoot,
      env: cleanEnvironment(),
      encoding: "utf8"
    });
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), expectedVersion);

    const help = spawnSync(process.execPath, [serverEntry, "--help"], {
      cwd: installationRoot,
      env: cleanEnvironment(),
      encoding: "utf8"
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--context-root <path>/);

    const contextRoot = join(temporaryRoot, "working-context");
    await cp(join(bundleRoot, "sample-context"), contextRoot, { recursive: true });

    await withInstalledServer(serverEntry, contextRoot, async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      assert.deepEqual([...names].sort(), [...expectedTools].sort());
      assert.equal(new Set(names).size, 12);

      const project = await callTool<{ project: { id: string } }>(client, "get_project_info");
      const workstreams = await callTool<Array<{ name: string }>>(client, "list_workstreams");
      const operations = await callTool<{
        context: { configured: boolean };
        continuity: { configured: boolean };
      }>(client, "get_workstream_info", { name: "OPERATIONS" });
      const inventory = await callTool<{ matchCount: number }>(
        client,
        "search_inventory",
        { query: "request validation" }
      );
      const listing = await callTool<{ sourceCount: number }>(
        client,
        "list_sources",
        { scope: "workstream", name: "BACKEND" }
      );
      const source = await callTool<{ text: string }>(
        client,
        "read_text_source",
        { scope: "workstream", name: "BACKEND", source: "backend-api.md" }
      );
      const before = await callTool<{ sha256: string }>(
        client,
        "get_continuity",
        { name: "BACKEND" }
      );

      assert.equal(project.data.project.id, "example-taskboard");
      assert.deepEqual(workstreams.data.map(({ name }) => name), ["BACKEND", "OPERATIONS"]);
      assert.equal(operations.data.context.configured, false);
      assert.equal(operations.data.continuity.configured, true);
      assert.equal(inventory.data.matchCount, 1);
      assert.ok(listing.data.sourceCount > 0);
      assert.match(source.data.text, /do not reach persistence/);

      const replacement = "# BACKEND\n\n## Current state\n\nExtracted handoff verification wins.\n";
      const update = await callTool<{
        updated: boolean;
        newSha256: string;
        backupPath: string;
      }>(client, "update_continuity", {
        name: "BACKEND",
        content: replacement,
        expectedSha256: before.data.sha256
      });
      assert.equal(update.isError, false);
      assert.equal(update.data.updated, true);
      await access(update.data.backupPath);

      const stale = await callTool<{
        code: string;
        currentSha256: string;
      }>(client, "update_continuity", {
        name: "BACKEND",
        content: "# BACKEND\n\nStale replacement.\n",
        expectedSha256: before.data.sha256
      });
      const after = await callTool<{ continuity: string; sha256: string }>(
        client,
        "get_continuity",
        { name: "BACKEND" }
      );

      assert.equal(stale.isError, true);
      assert.equal(stale.data.code, "PCW_CONTINUITY_STALE");
      assert.equal(stale.data.currentSha256, update.data.newSha256);
      assert.equal(after.data.continuity, replacement);
      assert.equal(after.data.sha256, update.data.newSha256);
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
