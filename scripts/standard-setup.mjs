import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuntimeConfig, runDoctor } from "./standard-runtime-doctor.mjs";
import {
  CLIENT_IDS,
  IntegrationError,
  applyIntegration,
  clientAdapters,
  createPcwRegistration,
  inspectOwnedIntegration,
  planIntegration,
  removeIntegration
} from "./standard-integrations/index.mjs";

export const STANDARD_SETUP_COMMANDS = Object.freeze([
  "validate-context",
  "detect-clients",
  "plan",
  "apply",
  "remove",
  "doctor"
]);

const optionNames = new Map([
  ["--runtime-root", "runtimeRoot"],
  ["--context-root", "contextRoot"],
  ["--state-root", "stateRoot"],
  ["--home-directory", "homeDirectory"],
  ["--registration-name", "registrationName"],
  ["--client", "clientId"],
  ["--config-path", "explicitConfigPath"],
  ["--result-file", "resultFile"]
]);

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SetupError("missing-option", `${key} is required`);
  }
  return value;
}

function absolute(options, key) {
  const value = required(options, key);
  if (!isAbsolute(value)) throw new SetupError("invalid-path", `${key} must be an absolute path`);
  return resolve(value);
}

export class SetupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SetupError";
    this.code = code;
    this.details = details;
  }
}

export function parseStandardSetupArgs(args) {
  const [command, ...tokens] = args;
  if (!STANDARD_SETUP_COMMANDS.includes(command)) {
    throw new SetupError("invalid-command", `Expected one of: ${STANDARD_SETUP_COMMANDS.join(", ")}`);
  }
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--allow-update" || token === "--all-owned") {
      const key = token === "--allow-update" ? "allowUpdate" : "allOwned";
      if (options[key] !== undefined) throw new SetupError("duplicate-option", `Repeated option: ${token}`);
      options[key] = true;
      continue;
    }
    const key = optionNames.get(token);
    const value = tokens[index + 1];
    if (!key || !value || value.startsWith("--")) {
      throw new SetupError("invalid-option", `Invalid or incomplete option: ${token}`);
    }
    if (options[key] !== undefined) throw new SetupError("duplicate-option", `Repeated option: ${token}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

async function runtimeIdentity(runtimeRoot) {
  const metadata = JSON.parse(
    await readFile(join(runtimeRoot, "metadata", "standard-runtime.json"), "utf8")
  );
  if (metadata?.target?.os !== "windows" || metadata?.target?.arch !== "x64" ||
      typeof metadata?.core?.version !== "string") {
    throw new SetupError("invalid-runtime", "Standard runtime metadata is invalid or not windows/x64");
  }
  return metadata;
}

async function validateContext(runtimeRoot, contextRoot, configLoader = loadRuntimeConfig) {
  const info = await stat(contextRoot);
  if (!info.isDirectory()) throw new SetupError("invalid-context", "Context root is not a directory");
  await configLoader(runtimeRoot, contextRoot);
  return { ok: true, status: "valid", contextRoot };
}

async function registrationOptions(options) {
  const runtimeRoot = absolute(options, "runtimeRoot");
  const metadata = await runtimeIdentity(runtimeRoot);
  const registration = createPcwRegistration({
    registrationName: required(options, "registrationName"),
    launcherPath: join(runtimeRoot, "bin", "pcw.cmd"),
    contextRoot: absolute(options, "contextRoot"),
    pcwVersion: metadata.core.version
  });
  return {
    runtimeRoot,
    metadata,
    clientId: required(options, "clientId"),
    homeDirectory: options.homeDirectory ? absolute(options, "homeDirectory") : undefined,
    explicitConfigPath: options.explicitConfigPath ? absolute(options, "explicitConfigPath") : undefined,
    stateRoot: absolute(options, "stateRoot"),
    registration,
    allowUpdate: options.allowUpdate === true
  };
}

async function detectClients(options, adapters = clientAdapters) {
  const homeDirectory = absolute(options, "homeDirectory");
  const cursor = await adapters.cursor.discover({
    homeDirectory,
    explicitConfigPath: options.explicitConfigPath ? absolute(options, "explicitConfigPath") : undefined
  });
  return {
    ok: true,
    status: "detected",
    clients: {
      cursor,
      codex: await adapters.codex.discover(),
      "claude-desktop": await adapters["claude-desktop"].discover()
    }
  };
}

async function readOwnedRegistrations(stateRoot) {
  let ledger;
  try {
    ledger = JSON.parse(await readFile(join(stateRoot, "integrations.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.registrations)) {
    throw new SetupError("invalid-ledger", "PCW integration ownership ledger is invalid");
  }
  return ledger.registrations;
}

async function removeOwned(options, remove = removeIntegration) {
  const stateRoot = absolute(options, "stateRoot");
  const entries = await readOwnedRegistrations(stateRoot);
  const results = [];
  for (const entry of entries) {
    results.push(await remove({
      clientId: entry.clientId,
      stateRoot,
      explicitConfigPath: entry.configPath,
      registration: {
        registrationName: entry.registrationName,
        launcherPath: entry.launcherPath,
        contextRoot: entry.contextRoot,
        pcwVersion: entry.pcwVersion
      }
    }));
  }
  return {
    ok: results.every((result) => result.removed || ["missing", "not-installed"].includes(result.status)),
    status: results.length === 0 ? "nothing-owned" : "completed",
    results
  };
}

export async function runStandardSetupCommand(command, options = {}, dependencies = {}) {
  if (!STANDARD_SETUP_COMMANDS.includes(command)) throw new SetupError("invalid-command", `Unknown command: ${command}`);
  if (command === "detect-clients") return detectClients(options, dependencies.clientAdapters ?? clientAdapters);
  if (command === "remove" && options.allOwned === true) {
    return removeOwned(options, dependencies.removeIntegration ?? removeIntegration);
  }

  const runtimeRoot = absolute(options, "runtimeRoot");
  const contextRoot = absolute(options, "contextRoot");
  if (command === "validate-context") {
    await runtimeIdentity(runtimeRoot);
    return validateContext(runtimeRoot, contextRoot, dependencies.loadRuntimeConfig ?? loadRuntimeConfig);
  }
  if (command === "doctor") {
    let integrationCheck;
    if (options.clientId && options.registrationName && options.stateRoot) {
      const operation = await registrationOptions(options);
      integrationCheck = () => inspectOwnedIntegration(operation);
    }
    const checks = await (dependencies.runDoctor ?? runDoctor)({ runtimeRoot, contextRoot, integrationCheck });
    const ok = checks.every((check) => check.ok);
    return { ok, status: ok ? "healthy" : "failed", checks };
  }

  await validateContext(runtimeRoot, contextRoot, dependencies.loadRuntimeConfig ?? loadRuntimeConfig);
  const operation = await registrationOptions(options);
  if (command === "plan") {
    const plan = await (dependencies.planIntegration ?? planIntegration)(operation);
    return { ok: true, status: plan.status, dryRun: true, plan };
  }
  if (command === "apply") {
    const result = await (dependencies.applyIntegration ?? applyIntegration)(operation);
    return { ok: true, status: result.status, result };
  }
  const result = await (dependencies.removeIntegration ?? removeIntegration)(operation);
  return { ok: true, status: result.status, result };
}

export function setupErrorPayload(error) {
  if (error instanceof IntegrationError || error instanceof SetupError) {
    return { ok: false, error: { code: error.code, message: error.message, ...error.details } };
  }
  return { ok: false, error: { code: "setup-failed", message: error instanceof Error ? error.message : "Unknown failure" } };
}

async function emitResult(payload, resultFile, stream) {
  const text = `${JSON.stringify(payload)}\n`;
  if (resultFile) await writeFile(resolve(resultFile), text, "utf8");
  stream.write(text);
}

async function main() {
  let parsed;
  try {
    parsed = parseStandardSetupArgs(process.argv.slice(2));
    const result = await runStandardSetupCommand(parsed.command, parsed.options);
    await emitResult(result, parsed.options.resultFile, process.stdout);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const payload = setupErrorPayload(error);
    await emitResult(payload, parsed?.options?.resultFile, process.stderr);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
