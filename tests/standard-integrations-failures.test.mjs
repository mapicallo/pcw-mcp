import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

async function coldStartFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-standard-integration-cold-start-"));
  try {
    const homeDirectory = join(root, "home");
    const localAppData = join(root, "local-app-data");
    const configPath = join(homeDirectory, ".cursor", "mcp.json");
    const stateRoot = join(root, "state");
    const launcherPath = join(root, "runtime", "bin", "pcw.cmd");
    const contextRoot = join(root, "contexts", "cold-start");
    const cursorExecutable = join(localAppData, "Programs", "Cursor", "Cursor.exe");
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
        registrationName: "PCW - Cold Start",
        launcherPath,
        contextRoot,
        pcwVersion: "0.3.0-beta.3"
      }
    };
    return await run({ root, configPath, stateRoot, options });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
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

test("cold-start apply refuses to overwrite a config that appears before exclusive creation", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    const competingConfig = '{"mcpServers":{"competing":{"command":"other"}}}\n';
    await assert.rejects(applyIntegration({
      ...options,
      exclusiveCreator: async (path, content) => {
        await writeFile(path, competingConfig, { flag: "wx" });
        await writeFile(path, content, { flag: "wx" });
      }
    }), (error) => error.code === "conflict");

    assert.equal(await readFile(configPath, "utf8"), competingConfig);
    await assert.rejects(readFile(join(stateRoot, "integrations.json")), { code: "ENOENT" });
  });
});

test("cold-start ledger failure rolls back an unchanged PCW-created config to absent", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    const error = await applyIntegration({
      ...options,
      ledgerWriter: async () => { throw new Error("synthetic ledger failure"); }
    }).then(() => null, (failure) => failure);

    assert.deepEqual({
      errorCode: error?.code,
      configExists: await pathExists(configPath),
      ledgerExists: await pathExists(join(stateRoot, "integrations.json")),
      backupsExist: await pathExists(join(stateRoot, "backups"))
    }, {
      errorCode: "ledger-write-failed",
      configExists: false,
      ledgerExists: false,
      backupsExist: false
    });
  });
});

test("cold-start ledger failure preserves a concurrently modified config and requires recovery", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    const concurrentConfig = '{"mcpServers":{"concurrent":{"command":"other"}}}\n';
    let pcwCreatedConfig;
    const error = await applyIntegration({
      ...options,
      ledgerWriter: async () => {
        pcwCreatedConfig = await readFile(configPath, "utf8");
        await writeFile(configPath, concurrentConfig);
        throw new Error("synthetic ledger failure after concurrent change");
      }
    }).then(() => null, (failure) => failure);

    assert.notEqual(pcwCreatedConfig, concurrentConfig);
    assert.equal(await readFile(configPath, "utf8"), concurrentConfig);
    assert.equal(await pathExists(join(stateRoot, "integrations.json")), false);
    assert.equal(await pathExists(join(stateRoot, "backups")), false);
    assert.deepEqual({
      errorCode: error?.code,
      rollback: error?.details?.rollback,
      configPath: error?.details?.configPath
    }, {
      errorCode: "recovery-required",
      rollback: "configuration-changed",
      configPath
    });
  });
});

test("cold-start rollback does not follow or delete a replacement symlink", async (t) => {
  await coldStartFixture(async ({ root, configPath, stateRoot, options }) => {
    const targetPath = join(root, "controlled-symlink-target.json");
    const probePath = join(root, "symlink-capability-probe");
    const targetContent = '{"controlled":"target"}\n';
    await writeFile(targetPath, targetContent);
    try {
      await symlink(targetPath, probePath, "file");
      await rm(probePath);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`File symlinks are unavailable in this environment: ${error.code}`);
        return;
      }
      throw error;
    }

    const error = await applyIntegration({
      ...options,
      ledgerWriter: async () => {
        await rm(configPath);
        await symlink(targetPath, configPath, "file");
        throw new Error("synthetic ledger failure after symlink replacement");
      }
    }).then(() => null, (failure) => failure);

    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal(error?.details?.rollback, "unsafe-path");
    assert.equal((await lstat(configPath)).isSymbolicLink(), true);
    assert.equal(await readFile(targetPath, "utf8"), targetContent);
    assert.equal(await pathExists(join(stateRoot, "integrations.json")), false);
    assert.equal(await pathExists(join(stateRoot, "backups")), false);
  });
});

test("cold-start rollback preserves a directory that replaced the created config", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    const error = await applyIntegration({
      ...options,
      ledgerWriter: async () => {
        await rm(configPath);
        await mkdir(configPath);
        throw new Error("synthetic ledger failure after directory replacement");
      }
    }).then(() => null, (failure) => failure);

    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal(error?.details?.rollback, "file-type-changed");
    assert.equal((await lstat(configPath)).isDirectory(), true);
    assert.equal(await pathExists(join(stateRoot, "integrations.json")), false);
    assert.equal(await pathExists(join(stateRoot, "backups")), false);
  });
});

test("cold-start rollback reports recovery-required when unlink fails", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    const error = await applyIntegration({
      ...options,
      ledgerWriter: async () => { throw new Error("synthetic ledger failure"); },
      rollbackUnlink: async () => { throw new Error("synthetic unlink failure"); }
    }).then(() => null, (failure) => failure);

    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal(error?.details?.rollback, "rollback-delete-failed");
    assert.equal(await pathExists(configPath), true);
    assert.equal(await pathExists(join(stateRoot, "integrations.json")), false);
    assert.equal(await pathExists(join(stateRoot, "backups")), false);
  });
});

test("remove-to-absent unlink failure preserves config and ledger", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const configBefore = await readFile(configPath);
    const ledgerPath = join(stateRoot, "integrations.json");
    const ledgerBefore = await readFile(ledgerPath);
    const error = await removeIntegration({
      ...options,
      removeUnlink: async () => { throw new Error("synthetic remove unlink failure"); }
    }).then(() => null, (failure) => failure);

    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal(error?.details?.rollback, "remove-delete-failed");
    assert.deepEqual(await readFile(configPath), configBefore);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  });
});

test("remove-to-absent restores exact bytes when ledger persistence fails", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const configBefore = await readFile(configPath);
    const ledgerPath = join(stateRoot, "integrations.json");
    const ledgerBefore = await readFile(ledgerPath);
    let observedAbsent = false;
    const error = await removeIntegration({
      ...options,
      ledgerWriter: async () => {
        observedAbsent = !(await pathExists(configPath));
        throw new Error("synthetic remove ledger failure");
      }
    }).then(() => null, (failure) => failure);

    assert.equal(observedAbsent, true);
    assert.equal(error?.code, "ledger-write-failed");
    assert.deepEqual(await readFile(configPath), configBefore);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
    assert.deepEqual(await readFile(error.details.backupPath), configBefore);
  });
});

test("remove-to-absent never clobbers a config that reappears before restore", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const concurrentConfig = '{"mcpServers":{"concurrent":{"command":"other"}}}\n';
    const ledgerPath = join(stateRoot, "integrations.json");
    const ledgerBefore = await readFile(ledgerPath);
    const error = await removeIntegration({
      ...options,
      ledgerWriter: async () => {
        await writeFile(configPath, concurrentConfig, { flag: "wx" });
        throw new Error("synthetic ledger failure after concurrent recreation");
      }
    }).then(() => null, (failure) => failure);

    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal(error?.details?.rollback, "remove-ledger-failure-recovery-required");
    assert.equal(typeof error?.details?.backupPath, "string");
    assert.equal(await readFile(configPath, "utf8"), concurrentConfig);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  });
});

test("remove-to-absent preserves a directory that replaces the target before unlink", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const ledgerPath = join(stateRoot, "integrations.json");
    const ledgerBefore = await readFile(ledgerPath);
    const error = await removeIntegration({
      ...options,
      beforeRemoveUnlink: async () => {
        await rm(configPath);
        await mkdir(configPath);
      }
    }).then(() => null, (failure) => failure);

    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal(typeof error?.details?.backupPath, "string");
    assert.match(error?.details?.rollback ?? "", /remove-delete-failed|remove-target-changed|file-type-changed/u);
    assert.equal((await lstat(configPath)).isDirectory(), true);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  });
});

test("remove-to-absent does not unlink a replacement symlink", async (t) => {
  await coldStartFixture(async ({ root, configPath, stateRoot, options }) => {
    const targetPath = join(root, "remove-symlink-target.json");
    const probePath = join(root, "remove-symlink-probe");
    const targetContent = '{"target":"preserved"}\n';
    await writeFile(targetPath, targetContent);
    try {
      await symlink(targetPath, probePath, "file");
      await rm(probePath);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`File symlinks are unavailable in this environment: ${error.code}`);
        return;
      }
      throw error;
    }
    await applyIntegration(options);
    const ledgerPath = join(stateRoot, "integrations.json");
    const ledgerBefore = await readFile(ledgerPath);
    const error = await removeIntegration({
      ...options,
      beforeRemoveUnlink: async () => {
        await rm(configPath);
        await symlink(targetPath, configPath, "file");
      }
    }).then(() => null, (failure) => failure);

    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal((await lstat(configPath)).isSymbolicLink(), true);
    assert.equal(await readFile(targetPath, "utf8"), targetContent);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  });
});

test("remove-to-absent does not unlink a replacement regular file with identical bytes", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const originalBytes = await readFile(configPath);
    const originalIdentity = await lstat(configPath);
    const ledgerPath = join(stateRoot, "integrations.json");
    const ledgerBefore = await readFile(ledgerPath);
    let replacementIdentity;
    const error = await removeIntegration({
      ...options,
      beforeRemoveUnlink: async () => {
        await rm(configPath);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        await writeFile(configPath, originalBytes, { flag: "wx" });
        replacementIdentity = await lstat(configPath);
      }
    }).then(() => null, (failure) => failure);

    assert.equal(
      originalIdentity.dev !== replacementIdentity.dev ||
        originalIdentity.ino !== replacementIdentity.ino ||
        originalIdentity.mtimeMs !== replacementIdentity.mtimeMs,
      true
    );
    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal(error?.details?.rollback, "remove-target-changed");
    assert.deepEqual(await readFile(configPath), originalBytes);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  });
});

test("remove-to-absent reports restore writer failure without claiming rollback", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const ledgerPath = join(stateRoot, "integrations.json");
    const ledgerBefore = await readFile(ledgerPath);
    const error = await removeIntegration({
      ...options,
      ledgerWriter: async () => { throw new Error("synthetic ledger failure"); },
      restoreWriter: async () => { throw new Error("synthetic restore writer failure"); }
    }).then(() => null, (failure) => failure);

    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal(typeof error?.details?.backupPath, "string");
    assert.equal(error?.details?.restore, "restore-write-failed");
    assert.equal(await pathExists(configPath), false);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
    assert.equal(await pathExists(error.details.backupPath), true);
  });
});

test("remove-to-absent preserves an unsafe object that appears before restore", async () => {
  await coldStartFixture(async ({ configPath, stateRoot, options }) => {
    await applyIntegration(options);
    const ledgerPath = join(stateRoot, "integrations.json");
    const ledgerBefore = await readFile(ledgerPath);
    const error = await removeIntegration({
      ...options,
      ledgerWriter: async () => {
        await mkdir(configPath);
        throw new Error("synthetic ledger failure after directory recreation");
      }
    }).then(() => null, (failure) => failure);

    assert.equal(error?.code, "recovery-required");
    assert.equal(error?.details?.configPath, configPath);
    assert.equal(typeof error?.details?.backupPath, "string");
    assert.equal((await lstat(configPath)).isDirectory(), true);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
    assert.equal(await pathExists(error.details.backupPath), true);
  });
});
