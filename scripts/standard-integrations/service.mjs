import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile
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

function validateLedger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schemaVersion !== INTEGRATION_LEDGER_SCHEMA_VERSION ||
      !Array.isArray(value.registrations)) {
    throw new IntegrationError("invalid-ledger", "PCW integration ownership ledger is invalid");
  }
  for (const entry of value.registrations) {
    if (!entry || typeof entry !== "object" ||
        !["clientId", "registrationName", "configPath", "contextRoot", "launcherPath", "pcwVersion",
          "entryFingerprint", "createdAt", "updatedAt"].every((key) => typeof entry[key] === "string")) {
      throw new IntegrationError("invalid-ledger", "PCW integration ownership ledger contains an invalid entry");
    }
  }
  return value;
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
  explicitConfigPath
}) {
  if (!isAbsolute(stateRoot)) {
    throw new IntegrationError("unsafe-state-path", "PCW integration state root must be absolute");
  }
  const adapter = getClientAdapter(clientId);
  if (adapter.support !== CLIENT_SUPPORT.SUPPORTED) {
    return { adapter, guided: adapter.instructions(registration) };
  }
  const detection = await adapter.discover({ homeDirectory, explicitConfigPath });
  if (detection.status !== "detected") return { adapter, detection };
  const configPath = detection.configPath;
  const config = adapter.parse(await readFile(configPath, "utf8"), configPath);
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
    status
  };
}

export async function planIntegration(options) {
  const registration = createPcwRegistration(options.registration);
  const operation = await resolveOperation({ ...options, registration });
  if (operation.guided) return { mode: "guided", status: "guided", ...operation.guided };
  if (operation.detection?.status !== "detected") {
    return {
      mode: "automatic",
      clientId: options.clientId,
      support: operation.adapter.support,
      status: operation.detection.status,
      candidates: operation.detection.candidates,
      restartRequired: operation.adapter.restartRequired,
      changeRequired: false
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
  if (operation.detection?.status !== "detected") {
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
  const backup = await createBackup({
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
  await atomicWriter(operation.configPath, operation.adapter.serialize(after));
  const verified = operation.adapter.parse(await readFile(operation.configPath, "utf8"), operation.configPath);
  assertUnrelatedPreserved(before, verified, registration.registrationName);
  if (entryFingerprint(verified.mcpServers?.[registration.registrationName]) !== operation.desiredFingerprint) {
    throw new IntegrationError("verification-failed", "PCW registration did not survive read-back verification");
  }
  const now = (options.clock ?? defaultClock)().toISOString();
  const previousCreatedAt = operation.ownership?.createdAt ?? now;
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
    backupPath: backup.path,
    backupSha256: backup.sha256
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
    backupPath: backup.path,
    restartRequired: operation.adapter.restartRequired
  };
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
  const backup = await createBackup({
    configPath: operation.configPath,
    stateRoot: options.stateRoot,
    clientId: options.clientId,
    registrationName: registration.registrationName,
    clock: options.clock ?? defaultClock
  });
  const before = structuredClone(operation.config);
  const after = structuredClone(operation.config);
  delete after.mcpServers[registration.registrationName];
  const atomicWriter = options.atomicWriter ?? defaultAtomicWriter;
  await atomicWriter(operation.configPath, operation.adapter.serialize(after));
  const verified = operation.adapter.parse(await readFile(operation.configPath, "utf8"), operation.configPath);
  assertUnrelatedPreserved(before, verified, registration.registrationName);
  if (verified.mcpServers?.[registration.registrationName] !== undefined) {
    throw new IntegrationError("verification-failed", "PCW registration remains after removal");
  }
  const nextLedger = structuredClone(operation.ledger);
  nextLedger.registrations = nextLedger.registrations.filter((entry) =>
    ownershipKey(entry.clientId, entry.registrationName, entry.configPath) !==
      ownershipKey(options.clientId, registration.registrationName, operation.configPath)
  );
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
