import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";

export const INTEGRATION_LEDGER_SCHEMA_VERSION = 1;
export const CLIENT_IDS = Object.freeze({
  CURSOR: "cursor",
  CODEX: "codex",
  CLAUDE_DESKTOP: "claude-desktop",
  MANUAL: "manual"
});

export const CLIENT_SUPPORT = Object.freeze({
  SUPPORTED: "supported",
  GUIDED: "guided",
  UNSUPPORTED: "unsupported"
});

export class IntegrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.details = details;
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new IntegrationError("invalid-registration", `${name} must be a non-empty string`);
  }
  return value;
}

export function validateRegistrationName(value) {
  const name = requireString(value, "registrationName");
  if (name !== name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new IntegrationError(
      "invalid-registration-name",
      "registrationName must be trimmed, at most 120 characters, and contain no control characters"
    );
  }
  return name;
}

function validateAbsolutePath(value, name) {
  const path = requireString(value, name);
  if (!isAbsolute(path)) {
    throw new IntegrationError("invalid-registration", `${name} must be an absolute path`);
  }
  return resolve(path);
}

export function createPcwRegistration({
  registrationName,
  launcherPath,
  contextRoot,
  pcwVersion,
  environment = {}
}) {
  const launcher = validateAbsolutePath(launcherPath, "launcherPath");
  if (basename(launcher).toLowerCase() !== "pcw.cmd") {
    throw new IntegrationError("invalid-launcher", "launcherPath must point to the stable pcw.cmd launcher");
  }
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new IntegrationError("invalid-environment", "environment must be an object of string values");
  }
  const env = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || key.startsWith("PCW_")) {
      throw new IntegrationError("invalid-environment", "environment must contain safe non-PCW string variables");
    }
    env[key] = value;
  }
  return Object.freeze({
    registrationName: validateRegistrationName(registrationName),
    launcherPath: launcher,
    contextRoot: validateAbsolutePath(contextRoot, "contextRoot"),
    pcwVersion: requireString(pcwVersion, "pcwVersion"),
    environment: Object.freeze(env)
  });
}

export function registrationEntry(registration) {
  const entry = {
    command: registration.launcherPath,
    args: ["--context-root", registration.contextRoot]
  };
  if (Object.keys(registration.environment).length > 0) entry.env = { ...registration.environment };
  return entry;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function entryFingerprint(entry) {
  return createHash("sha256").update(JSON.stringify(stableValue(entry))).digest("hex");
}

function quoteToml(value) {
  return JSON.stringify(value).replace(/\u2028|\u2029/gu, (match) =>
    `\\u${match.codePointAt(0).toString(16).padStart(4, "0")}`
  );
}

export function createManualIntegration({ clientId = CLIENT_IDS.MANUAL, registration }) {
  const entry = registrationEntry(registration);
  const json = JSON.stringify({ mcpServers: { [registration.registrationName]: entry } }, null, 2);
  const envLines = entry.env
    ? [`env = { ${Object.entries(entry.env).map(([key, value]) => `${key} = ${quoteToml(value)}`).join(", ")} }`]
    : [];
  const toml = [
    `[mcp_servers.${quoteToml(registration.registrationName)}]`,
    `command = ${quoteToml(entry.command)}`,
    `args = [${entry.args.map(quoteToml).join(", ")}]`,
    ...envLines
  ].join("\n");
  return {
    clientId,
    support: CLIENT_SUPPORT.GUIDED,
    registrationName: registration.registrationName,
    launcherPath: registration.launcherPath,
    args: [...entry.args],
    environment: { ...registration.environment },
    snippets: { json, toml }
  };
}
