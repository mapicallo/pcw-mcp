import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CLIENT_IDS,
  applyIntegration,
  clientAdapters,
  removeIntegration
} from "../scripts/standard-integrations/index.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-standard-integration-failure-"));
  try {
    const homeDirectory = join(root, "home");
    const configPath = join(homeDirectory, ".cursor", "mcp.json");
    const stateRoot = join(root, "state");
    const launcherPath = join(root, "runtime", "bin", "pcw.cmd");
    const contextRoot = join(root, "contexts", "one");
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(launcherPath), { recursive: true });
    await mkdir(contextRoot, { recursive: true });
    await writeFile(configPath, '{"mcpServers":{},"unrelated":{"keep":true}}\n');
    await writeFile(launcherPath, "@echo off\r\n");
    const options = {
      clientId: CLIENT_IDS.CURSOR,
      homeDirectory,
      stateRoot,
      clock: () => new Date("2026-01-02T03:04:05.000Z"),
      registration: {
        registrationName: "PCW - One",
        launcherPath,
        contextRoot,
        pcwVersion: "9.8.7-test.1"
      }
    };
    return await run({ root, homeDirectory, configPath, options });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("discovery reports ambiguity instead of choosing among multiple live configs", async () => {
  await fixture(async ({ root, homeDirectory }) => {
    const second = join(root, "second", "mcp.json");
    await mkdir(dirname(second), { recursive: true });
    await writeFile(second, '{"mcpServers":{}}\n');
    const detection = await clientAdapters.cursor.discover({
      homeDirectory,
      candidateConfigPaths: [second]
    });
    assert.equal(detection.status, "ambiguous");
    assert.equal(detection.candidates.length, 2);
  });
});

test("remove refuses a manually changed owned registration", async () => {
  await fixture(async ({ configPath, options }) => {
    await applyIntegration(options);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.mcpServers["PCW - One"].command = "C:\\manual\\launcher.cmd";
    await writeFile(configPath, JSON.stringify(config, null, 2));
    assert.deepEqual(await removeIntegration(options), { removed: false, status: "drift" });
    assert.equal((JSON.parse(await readFile(configPath, "utf8"))).mcpServers["PCW - One"].command, "C:\\manual\\launcher.cmd");
  });
});

test("ledger failure reports recovery-required when semantic rollback also fails", async () => {
  await fixture(async ({ configPath, options }) => {
    let writes = 0;
    const atomicWriter = async (path, content) => {
      writes += 1;
      if (writes === 1) await writeFile(path, content);
      else throw new Error("synthetic rollback failure");
    };
    await assert.rejects(
      applyIntegration({
        ...options,
        atomicWriter,
        ledgerWriter: async () => { throw new Error("synthetic ledger failure"); }
      }),
      (error) => error.code === "recovery-required" && typeof error.details.backupPath === "string"
    );
    assert.ok(JSON.parse(await readFile(configPath, "utf8")).mcpServers["PCW - One"]);
  });
});
