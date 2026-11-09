import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CLIENT_IDS,
  CLIENT_SUPPORT,
  IntegrationError,
  applyIntegration,
  clientAdapters,
  createManualIntegration,
  createPcwRegistration,
  entryFingerprint,
  inspectOwnedIntegration,
  planIntegration,
  registrationEntry,
  removeIntegration
} from "../scripts/standard-integrations/index.mjs";

const fixedClock = () => new Date("2026-01-02T03:04:05.000Z");

async function withFixture(run, initialConfig = { mcpServers: {} }) {
  const root = await mkdtemp(join(tmpdir(), "pcw-standard-integration-"));
  try {
    const homeDirectory = join(root, "home");
    const configPath = join(homeDirectory, ".cursor", "mcp.json");
    const stateRoot = join(root, "state");
    const launcherPath = join(root, "PCW Runtime", "bin", "pcw.cmd");
    const contextRoot = join(root, "PCW Contexts", "Project A");
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(launcherPath), { recursive: true });
    await mkdir(contextRoot, { recursive: true });
    await writeFile(configPath, typeof initialConfig === "string" ? initialConfig : `${JSON.stringify(initialConfig, null, 2)}\n`);
    await writeFile(launcherPath, "@echo off\r\n");
    const registration = {
      registrationName: "PCW - Project A",
      launcherPath,
      contextRoot,
      pcwVersion: "9.8.7-test.1"
    };
    const options = {
      clientId: CLIENT_IDS.CURSOR,
      homeDirectory,
      stateRoot,
      registration,
      clock: fixedClock
    };
    return await run({ root, homeDirectory, configPath, stateRoot, launcherPath, contextRoot, registration, options });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withColdStartFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-cursor-remove-cold-start-"));
  try {
    const homeDirectory = join(root, "home");
    const localAppData = join(root, "local-app-data");
    const configPath = join(homeDirectory, ".cursor", "mcp.json");
    const stateRoot = join(root, "state");
    const launcherPath = join(root, "runtime", "bin", "pcw.cmd");
    const contextRoot = join(root, "contexts", "Remove To Absent");
    const cursorExecutable = join(localAppData, "Programs", "Cursor", "Cursor.exe");
    const registrationName = "PCW - Remove To Absent";
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(launcherPath), { recursive: true });
    await mkdir(contextRoot, { recursive: true });
    await mkdir(dirname(cursorExecutable), { recursive: true });
    await writeFile(launcherPath, "@echo off\r\n");
    await writeFile(cursorExecutable, "synthetic Cursor installation marker\n");
    const options = {
      clientId: CLIENT_IDS.CURSOR,
      homeDirectory,
      localAppData,
      stateRoot,
      registration: {
        registrationName,
        launcherPath,
        contextRoot,
        pcwVersion: "0.3.0-beta.3"
      },
      clock: fixedClock
    };
    return await run({ root, configPath, stateRoot, contextRoot, registrationName, options });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("client matrix supports Cursor automatically and keeps Codex and Claude guided", () => {
  assert.equal(clientAdapters.cursor.support, CLIENT_SUPPORT.SUPPORTED);
  assert.equal(clientAdapters.codex.support, CLIENT_SUPPORT.GUIDED);
  assert.equal(clientAdapters["claude-desktop"].support, CLIENT_SUPPORT.GUIDED);
  assert.equal(clientAdapters.manual.support, CLIENT_SUPPORT.GUIDED);
});

test("Cursor discovery uses injected roots and reports an absent client without failure", async () => {
  await withFixture(async ({ homeDirectory, options }) => {
    const absentHome = join(homeDirectory, "absent");
    const absentLocalAppData = join(homeDirectory, "absent-local-app-data");
    assert.equal((await clientAdapters.cursor.discover({ homeDirectory })).status, "detected");
    assert.equal((await clientAdapters.cursor.discover({
      homeDirectory: absentHome,
      localAppData: absentLocalAppData
    })).status, "not-installed");
    const plan = await planIntegration({
      ...options,
      homeDirectory: absentHome,
      localAppData: absentLocalAppData
    });
    assert.equal(plan.status, "not-installed");
    assert.equal(plan.changeRequired, false);
  });
});

test("Cursor plan reports a missing canonical global config when Cursor is installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-cursor-cold-start-"));
  try {
    const homeDirectory = join(root, "home");
    const localAppData = join(root, "local-app-data");
    const configPath = join(homeDirectory, ".cursor", "mcp.json");
    const stateRoot = join(root, "state");
    const launcherPath = join(root, "runtime", "bin", "pcw.cmd");
    const contextRoot = join(root, "contexts", "Cold Start");
    const cursorExecutable = join(localAppData, "Programs", "Cursor", "Cursor.exe");

    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(launcherPath), { recursive: true });
    await mkdir(contextRoot, { recursive: true });
    await mkdir(dirname(cursorExecutable), { recursive: true });
    await writeFile(launcherPath, "@echo off\r\n");
    await writeFile(cursorExecutable, "synthetic Cursor installation marker\n");

    const plan = await planIntegration({
      clientId: CLIENT_IDS.CURSOR,
      homeDirectory,
      localAppData,
      stateRoot,
      registration: {
        registrationName: "PCW - Cursor Cold Start",
        launcherPath,
        contextRoot,
        pcwVersion: "0.3.0-beta.3"
      },
      clock: fixedClock
    });

    await assert.rejects(readFile(configPath), { code: "ENOENT" });
    await assert.rejects(readFile(join(stateRoot, "integrations.json")), { code: "ENOENT" });
    await assert.rejects(readdir(join(stateRoot, "backups")), { code: "ENOENT" });
    assert.deepEqual({
      status: plan.status,
      changeRequired: plan.changeRequired,
      willCreateConfig: plan.willCreateConfig,
      configPath: plan.configPath
    }, {
      status: "cursor-config-missing",
      changeRequired: true,
      willCreateConfig: true,
      configPath
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor apply bootstraps the missing canonical global config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-cursor-apply-cold-start-"));
  try {
    const homeDirectory = join(root, "home");
    const localAppData = join(root, "local-app-data");
    const configPath = join(homeDirectory, ".cursor", "mcp.json");
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const launcherPath = join(runtimeRoot, "bin", "pcw.cmd");
    const contextRoot = join(root, "contexts", "Cold Start");
    const cursorExecutable = join(localAppData, "Programs", "Cursor", "Cursor.exe");
    const registrationName = "PCW - Cursor Cold Start";

    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(launcherPath), { recursive: true });
    await mkdir(contextRoot, { recursive: true });
    await mkdir(dirname(cursorExecutable), { recursive: true });
    await writeFile(launcherPath, "@echo off\r\n");
    await writeFile(cursorExecutable, "synthetic Cursor installation marker\n");

    const result = await applyIntegration({
      clientId: CLIENT_IDS.CURSOR,
      homeDirectory,
      localAppData,
      stateRoot,
      registration: {
        registrationName,
        launcherPath,
        contextRoot,
        pcwVersion: "0.3.0-beta.3"
      },
      clock: fixedClock
    });

    assert.equal(result.status, "configured");
    const configBytes = await readFile(configPath);
    assert.equal(configBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
    assert.equal(configBytes.toString("utf8").endsWith("\n"), true);
    assert.deepEqual(JSON.parse(configBytes.toString("utf8")), {
      mcpServers: {
        [registrationName]: {
          command: launcherPath,
          args: ["--context-root", contextRoot]
        }
      }
    });
    assert.equal((await lstat(configPath)).isFile(), true);
    await assert.rejects(readdir(join(stateRoot, "backups", "cursor")), { code: "ENOENT" });
    const ledger = await readJson(join(stateRoot, "integrations.json"));
    const [ownership] = ledger.registrations;
    assert.deepEqual({
      schemaVersion: ledger.schemaVersion,
      configOrigin: ownership.configOrigin,
      createdConfigSha256: ownership.createdConfigSha256,
      backupPath: ownership.backupPath
    }, {
      schemaVersion: 2,
      configOrigin: "pcw-created",
      createdConfigSha256: createHash("sha256").update(configBytes).digest("hex"),
      backupPath: undefined
    });
    assert.equal(ownership.clientId, CLIENT_IDS.CURSOR);
    assert.equal(ownership.registrationName, registrationName);
    assert.equal(ownership.configPath, configPath);
    assert.equal(ownership.contextRoot, contextRoot);
    assert.equal(ownership.backupPath, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-existing Cursor config records v2 provenance and retains its backup", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const config = await readJson(configPath);
    assert.deepEqual(config.mcpServers.existing, { command: "other", args: ["--safe"] });

    const ledger = await readJson(join(stateRoot, "integrations.json"));
    const [ownership] = ledger.registrations;
    assert.deepEqual({
      schemaVersion: ledger.schemaVersion,
      configOrigin: ownership.configOrigin,
      createdConfigSha256: ownership.createdConfigSha256,
      hasBackupPath: typeof ownership.backupPath === "string",
      backupSha256: ownership.backupSha256
    }, {
      schemaVersion: 2,
      configOrigin: "pre-existing",
      createdConfigSha256: undefined,
      hasBackupPath: true,
      backupSha256: ownership.backupSha256
    });
    assert.match(ownership.backupSha256, /^[a-f0-9]{64}$/u);
  }, { mcpServers: { existing: { command: "other", args: ["--safe"] } } });
});

test("v1 ownership remains readable, plan does not rewrite it, and mutation migrates conservatively", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    const registration = createPcwRegistration(options.registration);
    const entry = registrationEntry(registration);
    const config = await readJson(configPath);
    config.mcpServers[registration.registrationName] = entry;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await mkdir(stateRoot, { recursive: true });
    const v1Ledger = {
      schemaVersion: 1,
      registrations: [{
        clientId: CLIENT_IDS.CURSOR,
        registrationName: registration.registrationName,
        configPath,
        contextRoot: registration.contextRoot,
        launcherPath: registration.launcherPath,
        pcwVersion: registration.pcwVersion,
        entryFingerprint: entryFingerprint(entry),
        createdAt: fixedClock().toISOString(),
        updatedAt: fixedClock().toISOString()
      }]
    };
    const ledgerPath = join(stateRoot, "integrations.json");
    await writeFile(ledgerPath, `${JSON.stringify(v1Ledger, null, 2)}\n`);
    const before = await readFile(ledgerPath, "utf8");

    assert.equal((await planIntegration(options)).status, "already-configured");
    assert.equal(await readFile(ledgerPath, "utf8"), before);

    const nextContextRoot = join(options.registration.contextRoot, "Next");
    await mkdir(nextContextRoot, { recursive: true });
    const result = await applyIntegration({
      ...options,
      allowUpdate: true,
      registration: { ...options.registration, contextRoot: nextContextRoot }
    });
    assert.equal(result.status, "updated");
    const migrated = await readJson(ledgerPath);
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.registrations[0].configOrigin, "pre-existing");
    assert.equal(migrated.registrations[0].createdConfigSha256, undefined);
  });
});

test("v2 ledger rejects invalid provenance combinations without mutation", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    const registration = createPcwRegistration(options.registration);
    const entry = registrationEntry(registration);
    const baseOwnership = {
      clientId: CLIENT_IDS.CURSOR,
      registrationName: registration.registrationName,
      configPath,
      contextRoot: registration.contextRoot,
      launcherPath: registration.launcherPath,
      pcwVersion: registration.pcwVersion,
      entryFingerprint: entryFingerprint(entry),
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString()
    };
    const cases = [
      { ...baseOwnership, configOrigin: "pcw-created" },
      { ...baseOwnership, configOrigin: "pre-existing", createdConfigSha256: "a".repeat(64) },
      { ...baseOwnership, configOrigin: "unknown" }
    ];
    await mkdir(stateRoot, { recursive: true });
    const ledgerPath = join(stateRoot, "integrations.json");
    const configBefore = await readFile(configPath, "utf8");

    for (const ownership of cases) {
      const ledgerText = `${JSON.stringify({ schemaVersion: 2, registrations: [ownership] }, null, 2)}\n`;
      await writeFile(ledgerPath, ledgerText);
      await assert.rejects(planIntegration(options), (error) => error.code === "invalid-ledger");
      assert.equal(await readFile(configPath, "utf8"), configBefore);
      assert.equal(await readFile(ledgerPath, "utf8"), ledgerText);
    }
  });
});

test("future ledger schema fails closed without mutating config or ledger", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    await mkdir(stateRoot, { recursive: true });
    const ledgerPath = join(stateRoot, "integrations.json");
    await writeFile(ledgerPath, '{"schemaVersion":999,"registrations":[]}\n');
    const configBefore = await readFile(configPath, "utf8");
    const ledgerBefore = await readFile(ledgerPath, "utf8");
    const error = await planIntegration(options).then(() => null, (failure) => failure);

    assert.equal(await readFile(configPath, "utf8"), configBefore);
    assert.equal(await readFile(ledgerPath, "utf8"), ledgerBefore);
    assert.equal(error?.code, "unsupported-ledger-schema");
    assert.match(error?.message ?? "", /unsupported.*ledger.*schema/iu);
  });
});

test("explicit config override must be absolute", async () => {
  await assert.rejects(
    clientAdapters.cursor.discover({ explicitConfigPath: "relative/mcp.json" }),
    (error) => error instanceof IntegrationError && error.code === "unsafe-config-path"
  );
});

test("malformed JSON is rejected before any backup or mutation", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    const before = await readFile(configPath, "utf8");
    await assert.rejects(applyIntegration(options), (error) => error.code === "malformed-config");
    assert.equal(await readFile(configPath, "utf8"), before);
    await assert.rejects(readdir(stateRoot), { code: "ENOENT" });
  }, "{ invalid json");
});

test("add preserves unrelated JSON and writes exact structured command and args", async () => {
  await withFixture(async ({ configPath, launcherPath, contextRoot, options }) => {
    const result = await applyIntegration(options);
    assert.equal(result.status, "configured");
    assert.equal(result.restartRequired, true);
    const config = await readJson(configPath);
    assert.deepEqual(config.window, { theme: "dark", unicode: "España" });
    assert.deepEqual(config.mcpServers.existing, { command: "other", args: ["--safe"] });
    assert.deepEqual(config.mcpServers["PCW - Project A"], {
      command: launcherPath,
      args: ["--context-root", contextRoot]
    });
  }, { window: { theme: "dark", unicode: "España" }, mcpServers: { existing: { command: "other", args: ["--safe"] } } });
});

test("paths with spaces, ampersands, parentheses and Unicode remain unescaped structured values", async () => {
  await withFixture(async ({ root, options, configPath, launcherPath }) => {
    const contextRoot = join(root, "PCW Contexts", "R&D (2026) - España");
    await mkdir(contextRoot, { recursive: true });
    await applyIntegration({ ...options, registration: { ...options.registration, contextRoot } });
    assert.deepEqual((await readJson(configPath)).mcpServers["PCW - Project A"], {
      command: launcherPath,
      args: ["--context-root", contextRoot]
    });
  });
});

test("duplicate apply is idempotent and creates no duplicate or additional backup", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const backupDirectory = join(stateRoot, "backups", "cursor");
    const backupsBefore = await readdir(backupDirectory);
    const second = await applyIntegration(options);
    assert.deepEqual(second, { updated: false, status: "already-configured", restartRequired: false });
    assert.equal(Object.keys((await readJson(configPath)).mcpServers).length, 1);
    assert.deepEqual(await readdir(backupDirectory), backupsBefore);
  });
});

test("unowned registration-name collision is refused", async () => {
  await withFixture(async ({ configPath, options }) => {
    const before = await readFile(configPath, "utf8");
    await assert.rejects(applyIntegration(options), (error) => error.code === "conflict");
    assert.equal(await readFile(configPath, "utf8"), before);
  }, { mcpServers: { "PCW - Project A": { command: "someone-else", args: [] } } });
});

test("owned changes require explicit update and update ledger fingerprint safely", async () => {
  await withFixture(async ({ root, configPath, options }) => {
    await applyIntegration(options);
    const nextContext = join(root, "PCW Contexts", "Project B");
    await mkdir(nextContext, { recursive: true });
    const changed = { ...options, registration: { ...options.registration, contextRoot: nextContext } };
    assert.equal((await planIntegration(changed)).status, "update-available");
    assert.equal((await applyIntegration(changed)).updated, false);
    assert.equal((await applyIntegration({ ...changed, allowUpdate: true })).status, "updated");
    assert.equal((await readJson(configPath)).mcpServers["PCW - Project A"].args[1], nextContext);
    assert.deepEqual(await inspectOwnedIntegration(changed), { ok: true, status: "already-configured" });
  });
});

test("manual edits to an owned entry are detected as drift and never replaced", async () => {
  await withFixture(async ({ configPath, options }) => {
    await applyIntegration(options);
    const config = await readJson(configPath);
    config.mcpServers["PCW - Project A"].args[1] = "C:\\manual-change";
    await writeFile(configPath, JSON.stringify(config, null, 2));
    assert.equal((await planIntegration(options)).status, "drift");
    await assert.rejects(applyIntegration({ ...options, allowUpdate: true }), (error) => error.code === "drift");
    assert.equal((await readJson(configPath)).mcpServers["PCW - Project A"].args[1], "C:\\manual-change");
  });
});

test("two owned contexts coexist and removing one preserves the other", async () => {
  await withFixture(async ({ root, configPath, options }) => {
    await applyIntegration(options);
    const contextB = join(root, "PCW Contexts", "Project B");
    await mkdir(contextB, { recursive: true });
    const optionsB = {
      ...options,
      registration: { ...options.registration, registrationName: "PCW - Project B", contextRoot: contextB }
    };
    await applyIntegration(optionsB);
    const beforeRemoval = await readJson(configPath);
    assert.equal(Object.keys(beforeRemoval.mcpServers).length, 2);
    const removed = await removeIntegration(options);
    assert.equal(removed.status, "removed");
    const afterRemoval = await readJson(configPath);
    assert.equal(afterRemoval.mcpServers["PCW - Project A"], undefined);
    assert.deepEqual(afterRemoval.mcpServers["PCW - Project B"], beforeRemoval.mcpServers["PCW - Project B"]);
  });
});

test("remove preserves unrelated servers and refuses unowned or drifted entries", async () => {
  await withFixture(async ({ configPath, options }) => {
    await applyIntegration(options);
    let config = await readJson(configPath);
    config.mcpServers.other = { command: "other", args: ["x"] };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    assert.equal((await removeIntegration(options)).removed, true);
    assert.deepEqual((await readJson(configPath)).mcpServers.other, { command: "other", args: ["x"] });
    assert.equal((await removeIntegration(options)).status, "missing");
  });
});

test("remove returns a PCW-created sole-registration config to its original absent state", async () => {
  await withColdStartFixture(async ({ configPath, stateRoot, contextRoot, registrationName, options }) => {
    await applyIntegration(options);
    const configuredBytes = await readFile(configPath);
    const ledgerBefore = await readJson(join(stateRoot, "integrations.json"));
    assert.equal(ledgerBefore.registrations[0].configOrigin, "pcw-created");
    assert.equal(
      ledgerBefore.registrations[0].createdConfigSha256,
      createHash("sha256").update(configuredBytes).digest("hex")
    );
    assert.deepEqual(Object.keys((await readJson(configPath)).mcpServers), [registrationName]);

    const result = await removeIntegration(options);

    assert.equal(result.removed, true);
    assert.equal(result.status, "removed");
    const remainingConfig = await readFile(configPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    assert.equal(remainingConfig, null);
    assert.equal((await readJson(join(stateRoot, "integrations.json"))).registrations.length, 0);
    assert.equal((await lstat(contextRoot)).isDirectory(), true);
    assert.deepEqual(await readFile(result.backupPath), configuredBytes);
    assert.equal((await readdir(join(stateRoot, "backups", "cursor"))).length, 1);
  });
});

test("remove preserves a PCW-created config when another MCP was added", async () => {
  await withColdStartFixture(async ({ configPath, stateRoot, registrationName, options }) => {
    await applyIntegration(options);
    const config = await readJson(configPath);
    config.mcpServers.other = { command: "other", args: ["--safe"] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = await removeIntegration(options);

    assert.equal(result.removed, true);
    assert.equal((await lstat(configPath)).isFile(), true);
    const after = await readJson(configPath);
    assert.equal(after.mcpServers[registrationName], undefined);
    assert.deepEqual(after.mcpServers.other, { command: "other", args: ["--safe"] });
    assert.equal((await readJson(join(stateRoot, "integrations.json"))).registrations.length, 0);
  });
});

test("remove preserves a PCW-created config when unrelated top-level data was added", async () => {
  await withColdStartFixture(async ({ configPath, stateRoot, registrationName, options }) => {
    await applyIntegration(options);
    const config = await readJson(configPath);
    config.someUserField = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = await removeIntegration(options);

    assert.equal(result.removed, true);
    assert.equal((await lstat(configPath)).isFile(), true);
    const after = await readJson(configPath);
    assert.equal(after.mcpServers[registrationName], undefined);
    assert.deepEqual(after.mcpServers, {});
    assert.equal(after.someUserField, true);
    assert.equal((await readJson(join(stateRoot, "integrations.json"))).registrations.length, 0);
  });
});

test("remove fails closed on owned-entry drift in a PCW-created config", async () => {
  await withColdStartFixture(async ({ configPath, stateRoot, registrationName, options }) => {
    await applyIntegration(options);
    const config = await readJson(configPath);
    config.mcpServers[registrationName].args[1] = "C:\\concurrent-change";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const configBefore = await readFile(configPath);
    const ledgerPath = join(stateRoot, "integrations.json");
    const ledgerBefore = await readFile(ledgerPath);

    const result = await removeIntegration(options);

    assert.deepEqual(result, { removed: false, status: "drift" });
    assert.deepEqual(await readFile(configPath), configBefore);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  });
});

test("remove never deletes a pre-existing sole-registration config", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const ledger = await readJson(join(stateRoot, "integrations.json"));
    assert.equal(ledger.registrations[0].configOrigin, "pre-existing");

    const result = await removeIntegration(options);

    assert.equal(result.removed, true);
    assert.equal((await lstat(configPath)).isFile(), true);
    assert.deepEqual(await readJson(configPath), { mcpServers: {} });
  });
});

test("remove treats v1 ownership conservatively and never deletes its config", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    const registration = createPcwRegistration(options.registration);
    const entry = registrationEntry(registration);
    await writeFile(configPath, `${JSON.stringify({
      mcpServers: { [registration.registrationName]: entry }
    }, null, 2)}\n`);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "integrations.json"), `${JSON.stringify({
      schemaVersion: 1,
      registrations: [{
        clientId: CLIENT_IDS.CURSOR,
        registrationName: registration.registrationName,
        configPath,
        contextRoot: registration.contextRoot,
        launcherPath: registration.launcherPath,
        pcwVersion: registration.pcwVersion,
        entryFingerprint: entryFingerprint(entry),
        createdAt: fixedClock().toISOString(),
        updatedAt: fixedClock().toISOString()
      }]
    }, null, 2)}\n`);

    const result = await removeIntegration(options);

    assert.equal(result.removed, true);
    assert.equal((await lstat(configPath)).isFile(), true);
    assert.deepEqual(await readJson(configPath), { mcpServers: {} });
  });
});

test("every mutation creates a controlled exact backup", async () => {
  await withFixture(async ({ configPath, options }) => {
    const before = await readFile(configPath);
    const result = await applyIntegration(options);
    assert.deepEqual(await readFile(result.backupPath), before);
    const configured = await readFile(configPath);
    const removal = await removeIntegration(options);
    assert.deepEqual(await readFile(removal.backupPath), configured);
  }, { nested: { keep: true }, mcpServers: {} });
});

test("atomic config-write failure preserves the original and does not create ownership", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    const before = await readFile(configPath, "utf8");
    await assert.rejects(applyIntegration({
      ...options,
      atomicWriter: async () => { throw new Error("synthetic atomic failure"); }
    }), /synthetic atomic failure/);
    assert.equal(await readFile(configPath, "utf8"), before);
    await assert.rejects(readFile(join(stateRoot, "integrations.json")), { code: "ENOENT" });
  });
});

test("ledger-write failure semantically rolls back only the PCW entry", async () => {
  await withFixture(async ({ configPath, options }) => {
    const before = await readJson(configPath);
    await assert.rejects(applyIntegration({
      ...options,
      ledgerWriter: async () => { throw new Error("synthetic ledger failure"); }
    }), (error) => error.code === "ledger-write-failed");
    assert.deepEqual(await readJson(configPath), before);
  }, { preference: "preserved", mcpServers: { other: { command: "other" } } });
});

test("normal uninstall is a semantic reverse mutation, not whole-file backup restoration", async () => {
  await withFixture(async ({ configPath, options }) => {
    await applyIntegration(options);
    const config = await readJson(configPath);
    config.addedAfterInstall = { retained: true };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    await removeIntegration(options);
    const after = await readJson(configPath);
    assert.deepEqual(after.addedAfterInstall, { retained: true });
    assert.equal(after.mcpServers["PCW - Project A"], undefined);
  });
});

test("dry-run planning performs zero mutation", async () => {
  await withFixture(async ({ configPath, stateRoot, options }) => {
    const before = await readFile(configPath, "utf8");
    const plan = await planIntegration(options);
    assert.equal(plan.status, "missing");
    assert.equal(plan.changeRequired, true);
    assert.equal(await readFile(configPath, "utf8"), before);
    await assert.rejects(readFile(join(stateRoot, "integrations.json")), { code: "ENOENT" });
  });
});

test("manual and guided adapters emit structured JSON and TOML snippets", async () => {
  await withFixture(async ({ registration, options }) => {
    const model = createPcwRegistration(registration);
    const manual = createManualIntegration({ registration: model });
    assert.match(manual.snippets.json, /"args": \[/u);
    assert.match(manual.snippets.toml, /\[mcp_servers\."PCW - Project A"\]/u);
    assert.equal(JSON.parse(manual.snippets.json).mcpServers["PCW - Project A"].args[1], registration.contextRoot);
    const codex = await planIntegration({ ...options, clientId: CLIENT_IDS.CODEX });
    const claude = await planIntegration({ ...options, clientId: CLIENT_IDS.CLAUDE_DESKTOP });
    assert.equal(codex.status, "guided");
    assert.equal(claude.status, "guided");
  });
});

test("registration names reject controls and cannot become command strings", async () => {
  await withFixture(async ({ registration }) => {
    assert.throws(
      () => createPcwRegistration({ ...registration, registrationName: "PCW\nmalicious" }),
      (error) => error.code === "invalid-registration-name"
    );
    const safe = createPcwRegistration({ ...registration, registrationName: "PCW - R&D (2026)" });
    assert.equal(safe.registrationName, "PCW - R&D (2026)");
  });
});

test("config symlink or junction is refused before mutation", { skip: process.platform !== "win32" }, async () => {
  await withFixture(async ({ root, configPath, options }) => {
    const real = join(root, "real-config.json");
    await writeFile(real, await readFile(configPath));
    await rm(configPath);
    try { await symlink(real, configPath, "file"); }
    catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return;
      throw error;
    }
    await assert.rejects(applyIntegration(options), (error) => error.code === "unsafe-config-path");
    assert.deepEqual(await readJson(real), { mcpServers: {} });
  });
});

test("ledger records no secrets and fingerprints only the owned entry", async () => {
  await withFixture(async ({ stateRoot, options }) => {
    await applyIntegration({
      ...options,
      registration: { ...options.registration, environment: { SAFE_MODE: "1" } }
    });
    const ledgerText = await readFile(join(stateRoot, "integrations.json"), "utf8");
    const ledger = JSON.parse(ledgerText);
    assert.equal(ledger.schemaVersion, 2);
    assert.equal(ledger.registrations.length, 1);
    assert.match(ledger.registrations[0].entryFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(ledgerText.includes("SAFE_MODE"), false);
  });
});
