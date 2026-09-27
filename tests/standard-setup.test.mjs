import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseStandardSetupArgs,
  runStandardSetupCommand
} from "../scripts/standard-setup.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const helperPath = join(repositoryRoot, "scripts", "standard-setup.mjs");

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-standard-setup-"));
  try {
    const runtimeRoot = join(root, "Installed PCW Ñ");
    const contextRoot = join(root, "Contexts", "Project Ñ & Alpha");
    const homeDirectory = join(root, "Synthetic Home");
    const stateRoot = join(root, "State");
    const configPath = join(homeDirectory, ".cursor", "mcp.json");
    await mkdir(join(runtimeRoot, "metadata"), { recursive: true });
    await mkdir(join(runtimeRoot, "bin"), { recursive: true });
    await mkdir(join(runtimeRoot, "core", "dist", "config"), { recursive: true });
    await mkdir(contextRoot, { recursive: true });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(join(runtimeRoot, "metadata", "standard-runtime.json"), JSON.stringify({
      schemaVersion: 1,
      target: { os: "windows", arch: "x64" },
      core: { version: "9.8.7-test.1", sha256: "a".repeat(64) }
    }));
    await writeFile(join(runtimeRoot, "bin", "pcw.cmd"), "@echo off\r\n");
    await writeFile(join(runtimeRoot, "core", "dist", "config", "pcw-config.js"), `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export async function loadPcwConfig(root) {
  const text = await readFile(join(root, "pcw.yml"), "utf8");
  if (!text.includes("version:")) throw new Error("Invalid synthetic PCW config");
  return { config: {} };
}
`);
    await writeFile(join(contextRoot, "pcw.yml"), "version: 1\nworkstreams: {}\n");
    await writeFile(configPath, '{"mcpServers":{"unrelated":{"command":"other"}}}\n');
    const common = {
      runtimeRoot,
      contextRoot,
      homeDirectory,
      stateRoot,
      registrationName: "PCW - Project Ñ",
      clientId: "cursor"
    };
    return await run({ root, runtimeRoot, contextRoot, homeDirectory, stateRoot, configPath, common });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("setup CLI exposes explicit machine-oriented commands and options", () => {
  assert.deepEqual(parseStandardSetupArgs([
    "plan", "--runtime-root", "C:\\PCW", "--context-root", "C:\\Context", "--allow-update"
  ]), {
    command: "plan",
    options: { runtimeRoot: "C:\\PCW", contextRoot: "C:\\Context", allowUpdate: true }
  });
  assert.throws(() => parseStandardSetupArgs(["unknown"]), /Expected one of/);
});

test("validate-context accepts an existing valid synthetic PCW root", () =>
  fixture(async ({ common, contextRoot }) => {
    assert.deepEqual(await runStandardSetupCommand("validate-context", common), {
      ok: true, status: "valid", contextRoot
    });
  }));
test("init-context delegates to the installed Core initializer", () =>
  fixture(async ({ root, runtimeRoot, common }) => {
    const contextRoot = join(root, "Contexts", "New Empty Context Ñ");
    let received;
    const result = await runStandardSetupCommand("init-context", {
      ...common,
      contextRoot
    }, {
      initializeContextRoot: async (receivedRuntime, receivedContext) => {
        received = { runtimeRoot: receivedRuntime, contextRoot: receivedContext };
        return {
          status: "initialized",
          contextRoot: receivedContext,
          configPath: join(receivedContext, "pcw.yml"),
          workstreamCount: 0,
          createdDirectory: true
        };
      }
    });

    assert.deepEqual(received, { runtimeRoot, contextRoot });
    assert.deepEqual(result, {
      ok: true,
      status: "initialized",
      contextRoot,
      workstreamCount: 0
    });
  }));

test("validate-context rejects missing and invalid synthetic contexts", () =>
  fixture(async ({ root, common, contextRoot }) => {
    await assert.rejects(
      runStandardSetupCommand("validate-context", { ...common, contextRoot: join(root, "missing") }),
      /ENOENT/
    );
    await writeFile(join(contextRoot, "pcw.yml"), "not-a-version\n");
    await assert.rejects(runStandardSetupCommand("validate-context", common), /Invalid synthetic PCW config/);
  }));

test("CLI writes one JSON result to stdout and errors only to stderr", () =>
  fixture(async ({ common, root }) => {
    const success = await execFileAsync(process.execPath, [
      helperPath, "validate-context", "--runtime-root", common.runtimeRoot,
      "--context-root", common.contextRoot
    ]);
    assert.equal(success.stderr, "");
    assert.equal(JSON.parse(success.stdout).status, "valid");
    await assert.rejects(execFileAsync(process.execPath, [
      helperPath, "validate-context", "--runtime-root", common.runtimeRoot,
      "--context-root", join(root, "missing")
    ]), (error) => {
      assert.equal(error.stdout, "");
      assert.equal(JSON.parse(error.stderr).ok, false);
      return true;
    });
  }));

test("detect-clients finds only the injected Cursor config and marks Codex and Claude guided", () =>
  fixture(async ({ homeDirectory, configPath }) => {
    const result = await runStandardSetupCommand("detect-clients", { homeDirectory });
    assert.equal(result.clients.cursor.status, "detected");
    assert.equal(result.clients.cursor.configPath, configPath);
    assert.equal(result.clients.codex.status, "guided");
    assert.equal(result.clients["claude-desktop"].status, "guided");
  }));

test("plan routes through 30C and performs no mutation", () =>
  fixture(async ({ common, configPath, stateRoot }) => {
    const before = await readFile(configPath, "utf8");
    const result = await runStandardSetupCommand("plan", common);
    assert.equal(result.dryRun, true);
    assert.equal(result.status, "missing");
    assert.equal(await readFile(configPath, "utf8"), before);
    await assert.rejects(access(join(stateRoot, "integrations.json")), { code: "ENOENT" });
  }));

test("apply routes through 30C and writes only the injected Cursor configuration", () =>
  fixture(async ({ common, configPath, stateRoot }) => {
    const result = await runStandardSetupCommand("apply", common);
    assert.equal(result.status, "configured");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.mcpServers[common.registrationName].command, join(common.runtimeRoot, "bin", "pcw.cmd"));
    assert.deepEqual(config.mcpServers[common.registrationName].args, ["--context-root", common.contextRoot]);
    assert.equal((JSON.parse(await readFile(join(stateRoot, "integrations.json"), "utf8"))).registrations.length, 1);
  }));

test("remove routes through 30C and preserves unrelated client entries", () =>
  fixture(async ({ common, configPath }) => {
    await runStandardSetupCommand("apply", common);
    const result = await runStandardSetupCommand("remove", common);
    assert.equal(result.status, "removed");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.mcpServers.unrelated, { command: "other" });
    assert.equal(config.mcpServers[common.registrationName], undefined);
  }));

test("remove --all-owned uses the ownership ledger and semantic removal", () =>
  fixture(async ({ common, configPath }) => {
    await runStandardSetupCommand("apply", common);
    const result = await runStandardSetupCommand("remove", {
      stateRoot: common.stateRoot,
      allOwned: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.results[0].status, "removed");
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).mcpServers[common.registrationName], undefined);
  }));

test("doctor delegates to the 30B doctor service", () =>
  fixture(async ({ common }) => {
    let received;
    const result = await runStandardSetupCommand("doctor", common, {
      runDoctor: async (options) => {
        received = options;
        return [{ label: "Synthetic", ok: true }];
      }
    });
    assert.equal(received.runtimeRoot, common.runtimeRoot);
    assert.equal(received.contextRoot, common.contextRoot);
    assert.deepEqual(result, { ok: true, status: "healthy", checks: [{ label: "Synthetic", ok: true }] });
  }));

for (const clientId of ["codex", "claude-desktop"]) {
  test(`${clientId} remains guided and performs no config mutation`, () =>
    fixture(async ({ common, configPath, stateRoot }) => {
      const before = await readFile(configPath, "utf8");
      const result = await runStandardSetupCommand("plan", { ...common, clientId });
      assert.equal(result.status, "guided");
      assert.equal(await readFile(configPath, "utf8"), before);
      await assert.rejects(access(join(stateRoot, "integrations.json")), { code: "ENOENT" });
    }));
}

test("paths containing spaces, ampersands and Unicode remain structured values", () =>
  fixture(async ({ common, configPath }) => {
    await runStandardSetupCommand("apply", common);
    const entry = JSON.parse(await readFile(configPath, "utf8")).mcpServers[common.registrationName];
    assert.equal(entry.command, join(common.runtimeRoot, "bin", "pcw.cmd"));
    assert.equal(entry.args[1], common.contextRoot);
  }));

test("apply and remove never delete the selected context", () =>
  fixture(async ({ common, contextRoot }) => {
    await runStandardSetupCommand("apply", common);
    await runStandardSetupCommand("remove", common);
    assert.equal((await stat(contextRoot)).isDirectory(), true);
    assert.equal((await readFile(join(contextRoot, "pcw.yml"), "utf8")).includes("version: 1"), true);
  }));

test("tests use injected config, home and state paths only", () =>
  fixture(async ({ common, homeDirectory, stateRoot }) => {
    const result = await runStandardSetupCommand("plan", common);
    assert.equal(result.plan.configPath.startsWith(homeDirectory), true);
    assert.equal(result.plan.configPath, join(homeDirectory, ".cursor", "mcp.json"));
    assert.equal(stateRoot.startsWith(tmpdir()), true);
  }));
