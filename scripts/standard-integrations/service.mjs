import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import writeFileAtomic from "write-file-atomic";

import {
  CLIENT_SUPPORT,
  INTEGRATION_LEDGER_SCHEMA_VERSION,
  IntegrationError,
  createPcwRegistration,
  entryFingerprint,
  registrationEntry
} from "./domain.mjs";
import { getClientAdapter } from "./clients.mjs";

const defaultClock = () => new Date();

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function emptyLedger() {
  return { schemaVersion: INTEGRATION_LEDGER_SCHEMA_VERSION, registrations: [] };
}

function ownershipKey(clientId, registrationName, configPath) {
  return `${clientId}\u0000${registrationName}\u0000${resolve(configPath).toLowerCase()}`;
}

function findOwnership(ledger, clientId, registrationName, configPath) {
  const key = ownershipKey(clientId, registrationName, configPath);
  return ledger.registrations.find((entry) =>
    ownershipKey(entry.clientId, entry.registrationName, entry.configPath) === key
  );
}

const LEDGER_ENTRY_STRING_KEYS = [
  "clientId",
  "registrationName",
  "configPath",
  "contextRoot",
  "launcherPath",
  "pcwVersion",
  "entryFingerprint",
  "createdAt",
  "updatedAt"
];

function invalidLedgerEntry() {
  return new IntegrationError("invalid-ledger", "PCW integration ownership ledger contains an invalid entry");
}

function validateLedgerEntry(entry, schemaVersion) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      !LEDGER_ENTRY_STRING_KEYS.every((key) => typeof entry[key] === "string")) {
    throw invalidLedgerEntry();
  }
  if (schemaVersion === 1) {
    return { ...entry, configOrigin: "pre-existing" };
  }
  if (!["pcw-created", "pre-existing"].includes(entry.configOrigin)) {
    throw invalidLedgerEntry();
  }
  if (entry.configOrigin === "pcw-created" &&
      (typeof entry.createdConfigSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.createdConfigSha256))) {
    throw invalidLedgerEntry();
  }
  if (entry.configOrigin === "pre-existing" && entry.createdConfigSha256 !== undefined) {
    throw invalidLedgerEntry();
  }
  return entry;
}

function validateLedger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isInteger(value.schemaVersion) || !Array.isArray(value.registrations)) {
    throw new IntegrationError("invalid-ledger", "PCW integration ownership ledger is invalid");
  }
  if (value.schemaVersion > INTEGRATION_LEDGER_SCHEMA_VERSION) {
    throw new IntegrationError(
      "unsupported-ledger-schema",
      `Unsupported PCW integration ownership ledger schema: ${value.schemaVersion}`
    );
  }
  if (![1, INTEGRATION_LEDGER_SCHEMA_VERSION].includes(value.schemaVersion)) {
    throw new IntegrationError("invalid-ledger", "PCW integration ownership ledger is invalid");
  }
  const registrations = value.registrations.map((entry) => validateLedgerEntry(entry, value.schemaVersion));
  if (value.schemaVersion === 1) {
    return { ...value, schemaVersion: INTEGRATION_LEDGER_SCHEMA_VERSION, registrations };
  }
  return { ...value, registrations };
}

async function readLedger(ledgerPath) {
  try {
    return validateLedger(JSON.parse(await readFile(ledgerPath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyLedger();
    if (error instanceof SyntaxError) {
      throw new IntegrationError("invalid-ledger", "PCW integration ownership ledger is not valid JSON");
    }
    throw error;
  }
}

async function rejectLink(path, { allowMissing = false } = {}) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new IntegrationError("unsafe-config-path", `Refusing symbolic link or junction path: ${path}`);
    }
    return info;
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    throw error;
  }
}

async function validateMutationPath(path) {
  const parent = dirname(path);
  const parentInfo = await rejectLink(parent);
  if (!parentInfo.isDirectory()) throw new IntegrationError("unsafe-config-path", "Configuration parent is not a directory");
  const fileInfo = await rejectLink(path, { allowMissing: true });
  if (fileInfo && !fileInfo.isFile()) {
    throw new IntegrationError("unsafe-config-path", "Configuration path is not a regular file");
  }
}

async function validateRegistrationTargets(registration) {
  const launcher = await rejectLink(registration.launcherPath);
  if (!launcher.isFile()) throw new IntegrationError("invalid-launcher", "PCW launcher is not a regular file");
  const context = await rejectLink(registration.contextRoot);
  if (!context.isDirectory()) throw new IntegrationError("invalid-context-root", "PCW context root is not a directory");
}

async function defaultAtomicWriter(path, content) {
  await writeFileAtomic(path, content, { encoding: "utf8", fsync: true });
}

async function defaultExclusiveCreator(path, content) {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
}

async function createConfigExclusive(path, content, exclusiveCreator) {
  try {
    await exclusiveCreator(path, content);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new IntegrationError(
        "conflict",
        "Client configuration appeared during bootstrap; run integration plan again"
      );
    }
    throw error;
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

async function rollbackPcwCreatedConfigAfterLedgerFailure({ configPath, expectedBytes, unlinkFile = unlink }) {
  try {
    await validateMutationPath(configPath);
    const before = await lstat(configPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      return { removed: false, reason: "file-type-changed" };
    }
    const currentBytes = await readFile(configPath);
    const afterRead = await lstat(configPath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() ||
        !sameFileIdentity(before, afterRead) || !currentBytes.equals(expectedBytes)) {
      return { removed: false, reason: "configuration-changed" };
    }
    await unlinkFile(configPath);
    const remaining = await rejectLink(configPath, { allowMissing: true });
    if (remaining !== null) return { removed: false, reason: "rollback-delete-failed" };
    return { removed: true, reason: "removed-pcw-created-config" };
  } catch (error) {
    let reason = "rollback-delete-failed";
    if (error instanceof IntegrationError && error.code === "unsafe-config-path") {
      reason = "unsafe-path";
      try {
        const current = await lstat(configPath);
        if (!current.isSymbolicLink() && !current.isFile()) reason = "file-type-changed";
      } catch {
        // Preserve the original unsafe-path classification when type cannot be inspected safely.
      }
    }
    return {
      removed: false,
      reason,
      cause: error instanceof Error ? error.message : "Unknown rollback failure"
    };
  }
}

function contentWithoutRegistration(config, registrationName) {
  const copy = structuredClone(config);
  if (copy.mcpServers) delete copy.mcpServers[registrationName];
  return copy;
}

function assertUnrelatedPreserved(before, after, registrationName) {
  if (JSON.stringify(contentWithoutRegistration(before, registrationName)) !==
      JSON.stringify(contentWithoutRegistration(after, registrationName))) {
    throw new IntegrationError("verification-failed", "Unrelated client configuration changed unexpectedly");
  }
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/gu, "-");
}

async function createBackup({ configPath, stateRoot, clientId, registrationName, clock }) {
  const bytes = await readFile(configPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const key = createHash("sha256")
    .update(`${clientId}\u0000${registrationName}\u0000${resolve(configPath)}`)
    .digest("hex").slice(0, 12);
  const directory = join(resolve(stateRoot), "backups", clientId);
  await mkdir(directory, { recursive: true });
  await rejectLink(directory);
  let backupPath = join(directory, `${timestampForPath(clock())}-${key}-${hash.slice(0, 12)}${extname(configPath) || ".bak"}`);
  for (let suffix = 1; ; suffix += 1) {
    try {
      await lstat(backupPath);
      backupPath = join(directory, `${timestampForPath(clock())}-${key}-${hash.slice(0, 12)}-${suffix}${extname(configPath) || ".bak"}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  await copyFile(configPath, backupPath);
  await chmod(backupPath, 0o600);
  return { path: backupPath, sha256: hash };
}

async function writeLedger(ledgerPath, ledger, atomicWriter) {
  await mkdir(dirname(ledgerPath), { recursive: true });
  await validateMutationPath(ledgerPath);
  await atomicWriter(ledgerPath, stableJson(ledger));
  await chmod(ledgerPath, 0o600);
  validateLedger(JSON.parse(await readFile(ledgerPath, "utf8")));
}

async function resolveOperation({
  clientId,
  registration,
  stateRoot,
  homeDirectory,
  localAppData,
  explicitConfigPath
}) {
  if (!isAbsolute(stateRoot)) {
    throw new IntegrationError("unsafe-state-path", "PCW integration state root must be absolute");
  }
  const adapter = getClientAdapter(clientId);
  if (adapter.support !== CLIENT_SUPPORT.SUPPORTED) {
    return { adapter, guided: adapter.instructions(registration) };
  }
  const detection = await adapter.discover({ homeDirectory, localAppData, explicitConfigPath });
  const configCreatedByPcw = detection.status === "cursor-config-missing";
  if (detection.status !== "detected" && !configCreatedByPcw) return { adapter, detection };
  const configPath = detection.configPath;
  const config = configCreatedByPcw
    ? { mcpServers: {} }
    : adapter.parse(await readFile(configPath, "utf8"), configPath);
  const ledgerPath = join(resolve(stateRoot), "integrations.json");
  const ledger = await readLedger(ledgerPath);
  const ownership = findOwnership(ledger, clientId, registration.registrationName, configPath);
  const currentEntry = config.mcpServers?.[registration.registrationName];
  const desiredEntry = registrationEntry(registration);
  const desiredFingerprint = entryFingerprint(desiredEntry);
  let status;
  if (currentEntry === undefined) status = "missing";
  else if (!ownership) status = "conflict";
  else if (entryFingerprint(currentEntry) !== ownership.entryFingerprint) status = "drift";
  else if (entryFingerprint(currentEntry) === desiredFingerprint) status = "already-configured";
  else status = "update-available";
  return {
    adapter,
    detection,
    configPath,
    config,
    ledgerPath,
    ledger,
    ownership,
    currentEntry,
    desiredEntry,
    desiredFingerprint,
    configCreatedByPcw,
    status
  };
}

export async function planIntegration(options) {
  const registration = createPcwRegistration(options.registration);
  const operation = await resolveOperation({ ...options, registration });
  if (operation.guided) return { mode: "guided", status: "guided", ...operation.guided };
  if (operation.detection?.status !== "detected") {
    const configMissing = operation.detection.status === "cursor-config-missing";
    return {
      mode: "automatic",
      clientId: options.clientId,
      support: operation.adapter.support,
      status: operation.detection.status,
      candidates: operation.detection.candidates,
      ...(operation.detection.configPath ? { configPath: operation.detection.configPath } : {}),
      ...(operation.detection.willCreateConfig !== undefined
        ? { willCreateConfig: operation.detection.willCreateConfig }
        : {}),
      restartRequired: operation.adapter.restartRequired,
      changeRequired: configMissing
    };
  }
  return {
    mode: "automatic",
    clientId: options.clientId,
    support: operation.adapter.support,
    status: operation.status,
    configPath: operation.configPath,
    registrationName: registration.registrationName,
    command: registration.launcherPath,
    args: ["--context-root", registration.contextRoot],
    environment: { ...registration.environment },
    restartRequired: operation.adapter.restartRequired,
    changeRequired: ["missing", "update-available"].includes(operation.status)
  };
}

async function rollbackEntry({ adapter, configPath, registrationName, expectedFingerprint, previousEntry, atomicWriter }) {
  const current = adapter.parse(await readFile(configPath, "utf8"), configPath);
  const entry = current.mcpServers?.[registrationName];
  if (entry === undefined || entryFingerprint(entry) !== expectedFingerprint) {
    throw new IntegrationError("recovery-required", "Configuration changed during rollback; manual recovery is required");
  }
  if (previousEntry === undefined) delete current.mcpServers[registrationName];
  else current.mcpServers[registrationName] = previousEntry;
  await atomicWriter(configPath, adapter.serialize(current));
}

export async function applyIntegration(options) {
  const registration = createPcwRegistration(options.registration);
  await validateRegistrationTargets(registration);
  const operation = await resolveOperation({ ...options, registration });
  if (operation.guided) return { updated: false, status: "guided", instructions: operation.guided };
  if (operation.detection?.status !== "detected" && operation.configCreatedByPcw !== true) {
    throw new IntegrationError(operation.detection.status, "A unique supported client configuration was not detected");
  }
  if (["conflict", "drift"].includes(operation.status)) {
    throw new IntegrationError(operation.status, `Registration cannot be changed because its state is ${operation.status}`);
  }
  if (operation.status === "already-configured") {
    return { updated: false, status: operation.status, restartRequired: false };
  }
  if (operation.status === "update-available" && options.allowUpdate !== true) {
    return { updated: false, status: operation.status, restartRequired: operation.adapter.restartRequired };
  }
  await validateMutationPath(operation.configPath);
  const backup = operation.configCreatedByPcw
    ? null
    : await createBackup({
        configPath: operation.configPath,
        stateRoot: options.stateRoot,
        clientId: options.clientId,
        registrationName: registration.registrationName,
        clock: options.clock ?? defaultClock
      });
  const before = structuredClone(operation.config);
  const after = structuredClone(operation.config);
  after.mcpServers ??= {};
  after.mcpServers[registration.registrationName] = operation.desiredEntry;
  const atomicWriter = options.atomicWriter ?? defaultAtomicWriter;
  const serialized = operation.adapter.serialize(after);
  const serializedBytes = Buffer.from(serialized, "utf8");
  if (operation.configCreatedByPcw) {
    await createConfigExclusive(
      operation.configPath,
      serializedBytes,
      options.exclusiveCreator ?? defaultExclusiveCreator
    );
  } else {
    await atomicWriter(operation.configPath, serialized);
  }
  const verified = operation.adapter.parse(await readFile(operation.configPath, "utf8"), operation.configPath);
  assertUnrelatedPreserved(before, verified, registration.registrationName);
  if (entryFingerprint(verified.mcpServers?.[registration.registrationName]) !== operation.desiredFingerprint) {
    throw new IntegrationError("verification-failed", "PCW registration did not survive read-back verification");
  }
  const now = (options.clock ?? defaultClock)().toISOString();
  const previousCreatedAt = operation.ownership?.createdAt ?? now;
  const configOrigin = operation.ownership?.configOrigin ??
    (operation.configCreatedByPcw ? "pcw-created" : "pre-existing");
  const nextOwnership = {
    clientId: options.clientId,
    registrationName: registration.registrationName,
    configPath: operation.configPath,
    contextRoot: registration.contextRoot,
    launcherPath: registration.launcherPath,
    pcwVersion: registration.pcwVersion,
    entryFingerprint: operation.desiredFingerprint,
    createdAt: previousCreatedAt,
    updatedAt: now,
    configOrigin,
    ...(configOrigin === "pcw-created"
      ? { createdConfigSha256: createHash("sha256").update(serializedBytes).digest("hex") }
      : {}),
    ...(backup ? { backupPath: backup.path, backupSha256: backup.sha256 } : {})
  };
  const nextLedger = structuredClone(operation.ledger);
  nextLedger.registrations = nextLedger.registrations.filter((entry) =>
    ownershipKey(entry.clientId, entry.registrationName, entry.configPath) !==
      ownershipKey(options.clientId, registration.registrationName, operation.configPath)
  );
  nextLedger.registrations.push(nextOwnership);
  nextLedger.registrations.sort((a, b) => ownershipKey(a.clientId, a.registrationName, a.configPath)
    .localeCompare(ownershipKey(b.clientId, b.registrationName, b.configPath)));
  try {
    await writeLedger(operation.ledgerPath, nextLedger, options.ledgerWriter ?? atomicWriter);
  } catch (error) {
    if (operation.configCreatedByPcw) {
      const rollback = await rollbackPcwCreatedConfigAfterLedgerFailure({
        configPath: operation.configPath,
        expectedBytes: serializedBytes,
        unlinkFile: options.rollbackUnlink ?? unlink
      });
      if (rollback.removed) {
        throw new IntegrationError(
          "ledger-write-failed",
          "Ledger update failed; the PCW-created client configuration was removed",
          {
            rollback: rollback.reason,
            cause: error instanceof Error ? error.message : "Unknown ledger failure"
          }
        );
      }
      throw new IntegrationError(
        "recovery-required",
        "Ledger update failed after creating the client configuration; manual recovery is required",
        {
          configPath: operation.configPath,
          rollback: rollback.reason,
          cause: error instanceof Error ? error.message : "Unknown ledger failure",
          ...(rollback.cause ? { rollbackCause: rollback.cause } : {})
        }
      );
    }
    try {
      await rollbackEntry({
        adapter: operation.adapter,
        configPath: operation.configPath,
        registrationName: registration.registrationName,
        expectedFingerprint: operation.desiredFingerprint,
        previousEntry: operation.currentEntry,
        atomicWriter
      });
    } catch (rollbackError) {
      throw new IntegrationError("recovery-required", "Ledger update failed and automatic rollback was unsafe", {
        backupPath: backup.path,
        cause: error instanceof Error ? error.message : "Unknown ledger failure",
        rollback: rollbackError instanceof Error ? rollbackError.message : "Unknown rollback failure"
      });
    }
    throw new IntegrationError("ledger-write-failed", "Ledger update failed; the client configuration change was rolled back", {
      backupPath: backup.path
    });
  }
  return {
    updated: true,
    status: operation.status === "missing" ? "configured" : "updated",
    clientId: options.clientId,
    registrationName: registration.registrationName,
    configPath: operation.configPath,
    ...(backup ? { backupPath: backup.path } : {}),
    restartRequired: operation.adapter.restartRequired
  };
}

function sameOwnedPath(left, right) {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function hasPcwCreatedProvenance(ownership, configPath) {
  return ownership.configOrigin === "pcw-created" &&
    typeof ownership.createdConfigSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(ownership.createdConfigSha256) &&
    sameOwnedPath(ownership.configPath, configPath);
}

function isEmptyClientConfig(config) {
  return Object.keys(config).length === 1 &&
    config.mcpServers && typeof config.mcpServers === "object" &&
    !Array.isArray(config.mcpServers) && Object.keys(config.mcpServers).length === 0;
}

async function readStableConfigSnapshot(configPath) {
  await validateMutationPath(configPath);
  const before = await lstat(configPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new IntegrationError("recovery-required", "Client configuration is no longer a regular file", {
      configPath,
      rollback: "file-type-changed"
    });
  }
  const bytes = await readFile(configPath);
  const after = await lstat(configPath);
  if (after.isSymbolicLink() || !after.isFile() || !sameFileIdentity(before, after)) {
    throw new IntegrationError("recovery-required", "Client configuration changed during remove verification", {
      configPath,
      rollback: "configuration-changed"
    });
  }
  return { bytes, identity: after };
}

async function assertRemoveTargetUnchanged(configPath, expectedIdentity) {
  await validateMutationPath(configPath);
  const current = await lstat(configPath);
  if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(expectedIdentity, current)) {
    throw new IntegrationError("remove-target-changed", "Client configuration target changed before unlink");
  }
}

async function restoreRemovedConfig({ configPath, bytes, exclusiveCreator }) {
  try {
    await validateMutationPath(configPath);
    if (await rejectLink(configPath, { allowMissing: true }) !== null) {
      return { restored: false, reason: "configuration-reappeared" };
    }
  } catch (error) {
    return {
      restored: false,
      reason: "restore-failed",
      cause: error instanceof Error ? error.message : "Unknown restore validation failure"
    };
  }
  try {
    await exclusiveCreator(configPath, bytes);
  } catch (error) {
    return {
      restored: false,
      reason: error?.code === "EEXIST" ? "configuration-reappeared" : "restore-write-failed",
      cause: error instanceof Error ? error.message : "Unknown restore write failure"
    };
  }
  try {
    await chmod(configPath, 0o600);
    const restored = await readStableConfigSnapshot(configPath);
    if (!restored.bytes.equals(bytes)) return { restored: false, reason: "restore-verification-failed" };
    return { restored: true, reason: "restored-exact-backup" };
  } catch (error) {
    return {
      restored: false,
      reason: "restore-failed",
      cause: error instanceof Error ? error.message : "Unknown restore failure"
    };
  }
}

export async function removeIntegration(options) {
  const adapter = getClientAdapter(options.clientId);
  if (adapter.support !== CLIENT_SUPPORT.SUPPORTED) {
    return { removed: false, status: "guided", instructions: adapter.instructions(createPcwRegistration(options.registration)) };
  }
  const registration = createPcwRegistration(options.registration);
  const operation = await resolveOperation({ ...options, registration });
  if (operation.detection?.status !== "detected") {
    return { removed: false, status: operation.detection.status };
  }
  if (!operation.ownership) return { removed: false, status: operation.currentEntry ? "conflict" : "missing" };
  if (!operation.currentEntry) return { removed: false, status: "missing" };
  if (entryFingerprint(operation.currentEntry) !== operation.ownership.entryFingerprint) {
    return { removed: false, status: "drift" };
  }
  await validateMutationPath(operation.configPath);
  let before = structuredClone(operation.config);
  let after = structuredClone(operation.config);
  delete after.mcpServers[registration.registrationName];
  let deleteSnapshot = null;
  if (hasPcwCreatedProvenance(operation.ownership, operation.configPath)) {
    const snapshot = await readStableConfigSnapshot(operation.configPath);
    const current = operation.adapter.parse(snapshot.bytes.toString("utf8"), operation.configPath);
    const currentEntry = current.mcpServers?.[registration.registrationName];
    if (currentEntry === undefined) return { removed: false, status: "missing" };
    if (entryFingerprint(currentEntry) !== operation.ownership.entryFingerprint) {
      return { removed: false, status: "drift" };
    }
    before = current;
    after = structuredClone(current);
    delete after.mcpServers[registration.registrationName];
    if (isEmptyClientConfig(after)) deleteSnapshot = snapshot;
  }
  const backup = await createBackup({
    configPath: operation.configPath,
    stateRoot: options.stateRoot,
    clientId: options.clientId,
    registrationName: registration.registrationName,
    clock: options.clock ?? defaultClock
  });
  const atomicWriter = options.atomicWriter ?? defaultAtomicWriter;
  const nextLedger = structuredClone(operation.ledger);
  nextLedger.registrations = nextLedger.registrations.filter((entry) =>
    ownershipKey(entry.clientId, entry.registrationName, entry.configPath) !==
      ownershipKey(options.clientId, registration.registrationName, operation.configPath)
  );
  if (deleteSnapshot) {
    const beforeDelete = await readStableConfigSnapshot(operation.configPath);
    const backupBytes = await readFile(backup.path);
    if (!sameFileIdentity(deleteSnapshot.identity, beforeDelete.identity) ||
        !deleteSnapshot.bytes.equals(beforeDelete.bytes) ||
        !deleteSnapshot.bytes.equals(backupBytes) ||
        backup.sha256 !== createHash("sha256").update(deleteSnapshot.bytes).digest("hex")) {
      throw new IntegrationError("recovery-required", "Client configuration changed before remove-to-absent", {
        configPath: operation.configPath,
        backupPath: backup.path,
        rollback: "configuration-changed"
      });
    }
    try {
      await options.beforeRemoveUnlink?.({ configPath: operation.configPath });
      await assertRemoveTargetUnchanged(operation.configPath, beforeDelete.identity);
    } catch (error) {
      throw new IntegrationError("recovery-required", "Client configuration target changed before unlink", {
        configPath: operation.configPath,
        backupPath: backup.path,
        rollback: "remove-target-changed",
        cause: error instanceof Error ? error.message : "Unknown target validation failure"
      });
    }
    try {
      await (options.removeUnlink ?? unlink)(operation.configPath);
      if (await rejectLink(operation.configPath, { allowMissing: true }) !== null) {
        throw new Error("Configuration path still exists after remove");
      }
    } catch (error) {
      throw new IntegrationError("recovery-required", "Could not remove the PCW-created client configuration", {
        configPath: operation.configPath,
        backupPath: backup.path,
        rollback: "remove-delete-failed",
        cause: error instanceof Error ? error.message : "Unknown remove failure"
      });
    }
    try {
      await writeLedger(operation.ledgerPath, nextLedger, options.ledgerWriter ?? atomicWriter);
    } catch (error) {
      const restore = await restoreRemovedConfig({
        configPath: operation.configPath,
        bytes: deleteSnapshot.bytes,
        exclusiveCreator: options.restoreWriter ?? defaultExclusiveCreator
      });
      if (restore.restored) {
        throw new IntegrationError("ledger-write-failed", "Ledger update failed; removed configuration was restored", {
          backupPath: backup.path,
          cause: error instanceof Error ? error.message : "Unknown ledger failure"
        });
      }
      throw new IntegrationError(
        "recovery-required",
        "Ledger removal failed after deleting the client configuration; manual recovery is required",
        {
          configPath: operation.configPath,
          backupPath: backup.path,
          rollback: "remove-ledger-failure-recovery-required",
          cause: error instanceof Error ? error.message : "Unknown ledger failure",
          restore: restore.reason,
          ...(restore.cause ? { restoreCause: restore.cause } : {})
        }
      );
    }
    return {
      removed: true,
      status: "removed",
      clientId: options.clientId,
      registrationName: registration.registrationName,
      configPath: operation.configPath,
      backupPath: backup.path,
      restartRequired: operation.adapter.restartRequired
    };
  }
  await atomicWriter(operation.configPath, operation.adapter.serialize(after));
  const verified = operation.adapter.parse(await readFile(operation.configPath, "utf8"), operation.configPath);
  assertUnrelatedPreserved(before, verified, registration.registrationName);
  if (verified.mcpServers?.[registration.registrationName] !== undefined) {
    throw new IntegrationError("verification-failed", "PCW registration remains after removal");
  }
  try {
    await writeLedger(operation.ledgerPath, nextLedger, options.ledgerWriter ?? atomicWriter);
  } catch (error) {
    try {
      const current = operation.adapter.parse(await readFile(operation.configPath, "utf8"), operation.configPath);
      if (current.mcpServers?.[registration.registrationName] !== undefined) {
        throw new IntegrationError("recovery-required", "Registration name was reused during rollback");
      }
      current.mcpServers[registration.registrationName] = operation.currentEntry;
      await atomicWriter(operation.configPath, operation.adapter.serialize(current));
    } catch (rollbackError) {
      throw new IntegrationError("recovery-required", "Ledger removal failed and automatic rollback was unsafe", {
        backupPath: backup.path,
        cause: error instanceof Error ? error.message : "Unknown ledger failure",
        rollback: rollbackError instanceof Error ? rollbackError.message : "Unknown rollback failure"
      });
    }
    throw new IntegrationError("ledger-write-failed", "Ledger update failed; registration removal was rolled back", {
      backupPath: backup.path
    });
  }
  return {
    removed: true,
    status: "removed",
    clientId: options.clientId,
    registrationName: registration.registrationName,
    configPath: operation.configPath,
    backupPath: backup.path,
    restartRequired: operation.adapter.restartRequired
  };
}

export async function inspectOwnedIntegration(options) {
  const registration = createPcwRegistration(options.registration);
  const operation = await resolveOperation({ ...options, registration });
  if (operation.guided) return { ok: false, status: "guided" };
  if (operation.detection?.status !== "detected") return { ok: false, status: operation.detection.status };
  return { ok: operation.status === "already-configured", status: operation.status };
}
