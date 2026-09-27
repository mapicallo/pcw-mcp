import { access, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { CLIENT_IDS, CLIENT_SUPPORT, IntegrationError, createManualIntegration } from "./domain.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonClientConfig(text, configPath) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new IntegrationError("malformed-config", `Client configuration is not valid JSON: ${configPath}`);
  }
  if (!isRecord(config)) {
    throw new IntegrationError("unsupported-config-schema", "Client configuration root must be a JSON object");
  }
  if (config.mcpServers !== undefined && !isRecord(config.mcpServers)) {
    throw new IntegrationError("unsupported-config-schema", "mcpServers must be a JSON object when present");
  }
  return config;
}

export function serializeJsonClientConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function discoverSingleJsonConfig({ clientId, candidates, explicitConfigPath }) {
  if (explicitConfigPath && !isAbsolute(explicitConfigPath)) {
    throw new IntegrationError("unsafe-config-path", "Explicit client config path must be absolute");
  }
  const paths = explicitConfigPath
    ? [resolve(explicitConfigPath)]
    : [...new Set(candidates.filter(Boolean).map((path) => resolve(path)))];
  const present = [];
  for (const path of paths) {
    if (await exists(path)) {
      const [fileInfo, parentInfo] = await Promise.all([lstat(path), lstat(dirname(path))]);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
        throw new IntegrationError("unsafe-config-path", `Client configuration is not a regular local file: ${path}`);
      }
      parseJsonClientConfig(await readFile(path, "utf8"), path);
      present.push(path);
    }
  }
  if (present.length > 1) {
    return { clientId, support: CLIENT_SUPPORT.SUPPORTED, status: "ambiguous", candidates: present };
  }
  if (present.length === 0) {
    return {
      clientId,
      support: CLIENT_SUPPORT.SUPPORTED,
      status: explicitConfigPath ? "config-missing" : "not-installed",
      candidates: paths
    };
  }
  return {
    clientId,
    support: CLIENT_SUPPORT.SUPPORTED,
    status: "detected",
    configPath: present[0],
    candidates: present
  };
}

export const cursorAdapter = Object.freeze({
  clientId: CLIENT_IDS.CURSOR,
  support: CLIENT_SUPPORT.SUPPORTED,
  format: "json",
  restartRequired: true,
  getCandidates({ homeDirectory, candidateConfigPaths = [] }) {
    return [...(homeDirectory ? [join(homeDirectory, ".cursor", "mcp.json")] : []), ...candidateConfigPaths];
  },
  discover(options) {
    return discoverSingleJsonConfig({
      clientId: CLIENT_IDS.CURSOR,
      candidates: this.getCandidates(options),
      explicitConfigPath: options.explicitConfigPath
    });
  },
  parse: parseJsonClientConfig,
  serialize: serializeJsonClientConfig
});

function guidedAdapter({ clientId, format, configLocations, restartRequired, reason }) {
  return Object.freeze({
    clientId,
    support: CLIENT_SUPPORT.GUIDED,
    format,
    configLocations,
    restartRequired,
    reason,
    async discover() {
      return { clientId, support: CLIENT_SUPPORT.GUIDED, status: "guided", reason };
    },
    instructions(registration) {
      return { ...createManualIntegration({ clientId, registration }), restartRequired, reason, configLocations };
    }
  });
}

export const codexAdapter = guidedAdapter({
  clientId: CLIENT_IDS.CODEX,
  format: "toml",
  configLocations: ["%USERPROFILE%\\.codex\\config.toml", "<project>\\.codex\\config.toml"],
  restartRequired: true,
  reason: "PCW does not rewrite user-maintained TOML without a comment-preserving writer"
});

export const claudeDesktopAdapter = guidedAdapter({
  clientId: CLIENT_IDS.CLAUDE_DESKTOP,
  format: "json-or-mcpb",
  configLocations: ["Claude Desktop Settings > Extensions", "%APPDATA%\\Claude\\claude_desktop_config.json (legacy local MCP)"],
  restartRequired: true,
  reason: "Current Claude Desktop guidance prefers MCPB and does not provide a stable automatic legacy JSON path contract"
});

export const manualAdapter = guidedAdapter({
  clientId: CLIENT_IDS.MANUAL,
  format: "json-or-toml",
  configLocations: [],
  restartRequired: true,
  reason: "Manual fallback for MCP clients without a proven automatic adapter"
});

export const clientAdapters = Object.freeze({
  [CLIENT_IDS.CURSOR]: cursorAdapter,
  [CLIENT_IDS.CODEX]: codexAdapter,
  [CLIENT_IDS.CLAUDE_DESKTOP]: claudeDesktopAdapter,
  [CLIENT_IDS.MANUAL]: manualAdapter
});

export function getClientAdapter(clientId) {
  const adapter = clientAdapters[clientId];
  if (!adapter) throw new IntegrationError("unsupported-client", `Unsupported MCP client: ${clientId}`);
  return adapter;
}
