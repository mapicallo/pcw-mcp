import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/client/stdio";

import { PCW_SOFTWARE_VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicExampleRoot = join(repositoryRoot, "examples", "sample-context");

const expectedToolNames = [
  "create_workstream",
  "create_shared_context",
  "enable_workstream_context",
  "get_project_info",
  "list_workstreams",
  "get_workstream_info",
  "get_continuity",
  "list_shared_context",
  "list_sources",
  "get_inventory",
  "search_inventory",
  "update_inventory",
  "read_text_source",
  "read_docx_source",
  "read_pdf_source",
  "update_continuity"
];

type PackResult = {
  filename: string;
  size: number;
};

type InstalledManifest = {
  main?: string;
  license?: string;
  private?: boolean;
  version?: string;
  dependencies?: Record<string, string>;
};

type ToolResponse<T> = {
  data: T;
  isError: boolean;
};

async function runNpm(args: readonly string[], cwd: string): Promise<string> {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("npm_execpath is required for the package installation test");
  }

  const { stdout } = await execFileAsync(process.execPath, [npmCli, ...args], {
    cwd,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout;
}

async function snapshotDirectory(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else {
        const content = await readFile(absolutePath);
        snapshot.set(
          relativePath,
          createHash("sha256").update(content).digest("hex")
        );
      }
    }
  }

  await visit(root, "");
  return snapshot;
}

function cleanEnvironment(): Record<string, string> {
  const environment = { ...getDefaultEnvironment() };
  delete environment.PCW_CONTEXT_ROOT;
  return environment;
}

function runInstalledEntrypoint(serverEntry: string, args: readonly string[]) {
  return spawnSync(process.execPath, [serverEntry, ...args], {
    cwd: dirname(serverEntry),
    env: cleanEnvironment(),
    encoding: "utf8",
    timeout: 10_000
  });
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResponse<T>> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find(
    (item): item is { type: "text"; text: string } => item.type === "text"
  );

  if (!text) {
    throw new Error(`Packaged tool '${name}' returned no text content`);
  }

  return {
    data: JSON.parse(text.text) as T,
    isError: result.isError === true
  };
}

async function withInstalledServer<T>(
  serverEntry: string,
  contextRoot: string,
  selection: "environment" | "cli",
  run: (client: Client) => Promise<T>
): Promise<T> {
  const environment = cleanEnvironment();
  const args = [serverEntry];
  if (selection === "environment") {
    environment.PCW_CONTEXT_ROOT = contextRoot;
  } else {
    args.push("--context-root", contextRoot);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: dirname(serverEntry),
    env: environment,
    stderr: "pipe"
  });
  const client = new Client({
    name: "pcw-packaged-install-test",
    version: "1.0.0"
  });

  let serverErrors = "";
  transport.stderr?.on("data", (chunk) => {
    serverErrors += chunk.toString();
  });

  try {
    await client.connect(transport);
    return await run(client);
  } catch (error) {
    throw new Error(
      `${String(error)}${serverErrors ? `\nPackaged server stderr:\n${serverErrors}` : ""}`
    );
  } finally {
    await client.close();
  }
}

test("packed PCW installs and operates independently from repository sources", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-package-install-"));
  const artifactDirectory = join(temporaryRoot, "artifact");
  const installationRoot = join(temporaryRoot, "installation");
  const contextRoot = join(temporaryRoot, "sample-context");
  const originalExample = await snapshotDirectory(publicExampleRoot);

  try {
    await mkdir(artifactDirectory, { recursive: true });
    await mkdir(installationRoot, { recursive: true });
    await cp(publicExampleRoot, contextRoot, { recursive: true });
    await writeFile(
      join(installationRoot, "package.json"),
      '{"name":"pcw-package-smoke","private":true}',
      "utf8"
    );

    const packOutput = await runNpm(
      ["pack", "--json", "--pack-destination", artifactDirectory],
      repositoryRoot
    );
    const [packResult] = JSON.parse(packOutput) as PackResult[];
    const artifactPath = join(artifactDirectory, packResult.filename);
    t.diagnostic(`artifact=${packResult.filename} size=${packResult.size}`);

    await runNpm(
      [
        "install",
        artifactPath,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund"
      ],
      installationRoot
    );

    const installedPackageRoot = join(
      installationRoot,
      "node_modules",
      "pcw-mcp"
    );
    const serverEntry = join(installedPackageRoot, "dist", "server.js");
    const installedManifest = JSON.parse(
      await readFile(join(installedPackageRoot, "package.json"), "utf8")
    ) as InstalledManifest;
    assert.equal(installedManifest.main, "dist/server.js");
    assert.equal(installedManifest.license, "UNLICENSED");
    assert.equal(installedManifest.private, true);
    assert.equal(installedManifest.version, PCW_SOFTWARE_VERSION);
    assert.equal(installedManifest.dependencies?.tsx, undefined);
    await access(serverEntry);
    await access(join(installedPackageRoot, "PRIVATE-BETA-TERMS.md"));
    await access(join(installedPackageRoot, "PRIVATE-BETA-TERMS-ES.md"));
    await access(join(installedPackageRoot, "templates", "pcw-minimal.yml"));
    await assert.rejects(access(join(installedPackageRoot, "src")));
    await assert.rejects(access(join(installedPackageRoot, "tests")));
    await assert.rejects(access(join(installationRoot, "node_modules", "tsx")));
    await assert.rejects(
      access(join(installationRoot, "node_modules", "typescript"))
    );

    const installedFiles = await snapshotDirectory(installedPackageRoot);
    const installedPaths = [...installedFiles.keys()];
    assert.equal(installedPaths.some((path) => path.startsWith("src/")), false);
    assert.equal(installedPaths.some((path) => path.startsWith("tests/")), false);
    assert.equal(installedPaths.includes("CONTINUITY.md"), false);
    assert.equal(installedPaths.some((path) => path.startsWith(".git/")), false);

    const forbiddenContent = [
      /C:\\rmms-context/i,
      /C:\\code\\pcw-mcp/i,
      /\bRMMS\b/i,
      /\bIndra\b/i,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /github_pat_[A-Za-z0-9_]+/,
      /ghp_[A-Za-z0-9]+/
    ];
    for (const relativePath of installedPaths) {
      const content = await readFile(join(installedPackageRoot, relativePath), "utf8");
      for (const pattern of forbiddenContent) {
        assert.doesNotMatch(content, pattern, `forbidden content in ${relativePath}`);
      }
    }

    const help = runInstalledEntrypoint(serverEntry, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--context-root <path>/);
    assert.equal(help.stderr, "");

    const version = runInstalledEntrypoint(serverEntry, ["--version"]);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), PCW_SOFTWARE_VERSION);
    assert.equal(version.stderr, "");

    const missingRoot = runInstalledEntrypoint(serverEntry, []);
    assert.equal(missingRoot.status, 1);
    assert.equal(missingRoot.stdout, "");
    assert.match(missingRoot.stderr, /PCW context root is not configured/);

    await withInstalledServer(
      serverEntry,
      contextRoot,
      "environment",
      async (client) => {
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        assert.deepEqual([...names].sort(), [...expectedToolNames].sort());
        assert.equal(new Set(names).size, expectedToolNames.length);

        const project = await callTool<{
          project: { id: string; name: string };
        }>(client, "get_project_info");
        const workstreams = await callTool<Array<{ name: string }>>(
          client,
          "list_workstreams"
        );
        const inventory = await callTool<{
          matchCount: number;
          matches: Array<{ title: string }>;
        }>(client, "search_inventory", { query: "request validation" });
        const source = await callTool<{ text: string }>(
          client,
          "read_text_source",
          { scope: "workstream", name: "BACKEND", source: "backend-api.md" }
        );
        const before = await callTool<{
          sha256: string;
          continuity: string;
        }>(client, "get_continuity", { name: "BACKEND" });

        assert.deepEqual(project.data.project, {
          id: "example-taskboard",
          name: "Example Taskboard"
        });
        assert.deepEqual(
          workstreams.data.map((workstream) => workstream.name),
          ["BACKEND", "OPERATIONS"]
        );
        assert.equal(inventory.data.matchCount, 1);
        assert.equal(inventory.data.matches[0].title, "Backend API Notes");
        assert.match(source.data.text, /do not reach persistence/);
        assert.match(before.data.continuity, /Define pagination/);

        const shared = await callTool<{
          name: string;
          path: string;
          configBackupPath: string;
          created: boolean;
        }>(client, "create_shared_context", { name: "package-reference" });
        assert.equal(shared.isError, false);
        assert.equal(shared.data.path, "shared/package-reference");
        await access(join(contextRoot, shared.data.path));
        await access(join(contextRoot, shared.data.configBackupPath));

        const enabled = await callTool<{
          workstream: string;
          contextPath: string;
          configBackupPath: string;
          created: boolean;
        }>(client, "enable_workstream_context", { name: "operations" });
        assert.equal(enabled.isError, false);
        assert.equal(enabled.data.workstream, "OPERATIONS");
        assert.equal(enabled.data.contextPath, "workstreams/OPERATIONS");
        await access(join(contextRoot, enabled.data.contextPath));
        await access(join(contextRoot, enabled.data.configBackupPath));

        await writeFile(
          join(contextRoot, shared.data.path, "approved-source.md"),
          "# Approved package source\n\nSynthetic authorized content.\n",
          "utf8"
        );
        const discovered = await callTool<{
          sources: Array<{ name: string }>;
        }>(client, "list_sources", {
          scope: "shared",
          name: "package-reference"
        });
        const approvedSource = await callTool<{ text: string }>(
          client,
          "read_text_source",
          {
            scope: "shared",
            name: "package-reference",
            source: "approved-source.md"
          }
        );
        assert.ok(
          discovered.data.sources.some(({ name }) => name === "approved-source.md")
        );
        assert.match(approvedSource.data.text, /Synthetic authorized content/);

        const inventoryBefore = await callTool<{
          sha256: string;
          inventory: string;
        }>(client, "get_inventory");
        const inventoryReplacement =
          "### Package reference\nPurpose: package onboarding marker.\n";
        const inventoryUpdate = await callTool<{
          newSha256: string;
          backupPath: string;
          updated: boolean;
        }>(client, "update_inventory", {
          content: inventoryReplacement,
          expectedSha256: inventoryBefore.data.sha256
        });
        assert.equal(inventoryUpdate.isError, false);
        assert.equal(inventoryUpdate.data.updated, true);
        await access(inventoryUpdate.data.backupPath);

        const updatedSearch = await callTool<{ matchCount: number }>(
          client,
          "search_inventory",
          { query: "package onboarding marker" }
        );
        assert.equal(updatedSearch.data.matchCount, 1);

        const staleInventory = await callTool<{ code: string }>(
          client,
          "update_inventory",
          {
            content: "### Stale\nMust not win.\n",
            expectedSha256: inventoryBefore.data.sha256
          }
        );
        assert.equal(staleInventory.isError, true);
        assert.equal(staleInventory.data.code, "PCW_INVENTORY_STALE");

        const created = await callTool<{
          workstream: string;
          mode: string;
          continuityPath: string;
          contextPath: string | null;
          configBackupPath: string;
          created: boolean;
          initialContinuitySha256: string;
        }>(client, "create_workstream", {
          name: "PACKAGE-LAB",
          mode: "with-context",
          initialObjective: "Validate workstream creation from the installed package."
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
            workstream: "PACKAGE-LAB",
            mode: "with-context",
            continuityPath: "continuity/PACKAGE-LAB.md",
            contextPath: "workstreams/PACKAGE-LAB",
            created: true
          }
        );
        assert.match(created.data.initialContinuitySha256, /^[a-f0-9]{64}$/);
        await access(join(contextRoot, created.data.continuityPath));
        await access(join(contextRoot, created.data.contextPath!));
        await access(join(contextRoot, created.data.configBackupPath));

        const createdWorkstreams = await callTool<Array<{ name: string }>>(
          client,
          "list_workstreams"
        );
        const createdContinuity = await callTool<{ continuity: string }>(
          client,
          "get_continuity",
          { name: "package-lab" }
        );
        assert.deepEqual(
          createdWorkstreams.data.map((workstream) => workstream.name),
          ["BACKEND", "OPERATIONS", "PACKAGE-LAB"]
        );
        assert.match(
          createdContinuity.data.continuity,
          /Validate workstream creation from the installed package/
        );
        assert.match(
          await readFile(join(contextRoot, "pcw.yml"), "utf8"),
          /PACKAGE-LAB/
        );

        const winningContent = "# BACKEND\n\n## Current state\n\nPackaged smoke update wins.\n";
        const update = await callTool<{
          updated: boolean;
          newSha256: string;
          backupPath: string;
        }>(client, "update_continuity", {
          name: "BACKEND",
          content: winningContent,
          expectedSha256: before.data.sha256
        });
        assert.equal(update.isError, false);
        assert.equal(update.data.updated, true);
        assert.match(update.data.backupPath, /[\\/].pcw[\\/]history[\\/]BACKEND[\\/]/);

        const stale = await callTool<{
          code: string;
          currentSha256: string;
          action: string;
        }>(client, "update_continuity", {
          name: "BACKEND",
          content: "# BACKEND\n\nStale content.\n",
          expectedSha256: before.data.sha256
        });
        const after = await callTool<{
          sha256: string;
          continuity: string;
        }>(client, "get_continuity", { name: "BACKEND" });

        assert.equal(stale.isError, true);
        assert.equal(stale.data.code, "PCW_CONTINUITY_STALE");
        assert.equal(stale.data.currentSha256, update.data.newSha256);
        assert.match(stale.data.action, /get_continuity again/);
        assert.equal(after.data.continuity, winningContent);
        assert.equal(after.data.sha256, update.data.newSha256);
      }
    );

    await withInstalledServer(serverEntry, contextRoot, "cli", async (client) => {
      const project = await callTool<{ project: { id: string } }>(
        client,
        "get_project_info"
      );
      assert.equal(project.data.project.id, "example-taskboard");
    });

    await t.test("uninstall and reinstall preserve the user context", async () => {
      const contextBeforeUninstall = await snapshotDirectory(contextRoot);

      await runNpm(
        ["uninstall", "pcw-mcp", "--ignore-scripts", "--no-audit", "--no-fund"],
        installationRoot
      );
      await assert.rejects(access(installedPackageRoot));
      assert.deepEqual(await snapshotDirectory(contextRoot), contextBeforeUninstall);

      await runNpm(
        [
          "install",
          artifactPath,
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund"
        ],
        installationRoot
      );
      await access(serverEntry);
      const reinstalledVersion = runInstalledEntrypoint(serverEntry, ["--version"]);
      assert.equal(reinstalledVersion.status, 0);
      assert.equal(reinstalledVersion.stdout.trim(), PCW_SOFTWARE_VERSION);

      await withInstalledServer(serverEntry, contextRoot, "cli", async (client) => {
        const continuity = await callTool<{ continuity: string }>(
          client,
          "get_continuity",
          { name: "BACKEND" }
        );
        assert.match(continuity.data.continuity, /Packaged smoke update wins/);
      });
      assert.deepEqual(await snapshotDirectory(contextRoot), contextBeforeUninstall);
    });
  } finally {
    assert.deepEqual(
      await snapshotDirectory(publicExampleRoot),
      originalExample,
      "packaged smoke tests must not modify the committed public example"
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
