import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parse } from "yaml";

import type {
  PcwConfig,
  PcwSharedContextConfig,
  PcwWorkstreamConfig,
  ResolvedSharedContext,
  ResolvedWorkstream
} from "../domain/pcw-types.js";
import { pcwConfigSchema } from "./pcw-schema.js";

export interface LoadedPcwConfig {
  configPath: string;
  config: PcwConfig;
}

export class PcwConfigError extends Error {
  constructor(
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PcwConfigError";
  }
}

export async function loadPcwConfig(
  contextRoot: string
): Promise<LoadedPcwConfig> {
  const configPath = join(contextRoot, "pcw.yml");

  let yamlContent: string;

  try {
    yamlContent = await readFile(configPath, "utf8");
  } catch (cause) {
    throw new PcwConfigError(
      `Could not read PCW configuration at '${configPath}'`,
      { cause }
    );
  }

  let parsedConfig: unknown;

  try {
    parsedConfig = parse(yamlContent);
  } catch (cause) {
    throw new PcwConfigError(
      `Could not parse PCW configuration at '${configPath}'`,
      { cause }
    );
  }

  const result = pcwConfigSchema.safeParse(parsedConfig);

  if (!result.success) {
    const details = result.error.issues
      .slice(0, 3)
      .map((issue) => {
        const location = issue.path.length > 0
          ? issue.path.join(".")
          : "configuration";

        return `${location}: ${issue.message}`;
      })
      .join("; ");

    throw new PcwConfigError(
      `Invalid PCW configuration at '${configPath}': ${details}`
    );
  }

  return {
    configPath,
    config: result.data
  };
}

export function getWorkstreams(
  config: PcwConfig
): Record<string, PcwWorkstreamConfig> {
  return config.workstreams ?? {};
}

export function getSharedContexts(
  config: PcwConfig
): Record<string, PcwSharedContextConfig> {
  return config.shared_context ?? {};
}

export function findWorkstream(
  config: PcwConfig,
  requestedName: string
): ResolvedWorkstream | null {
  const workstreams = getWorkstreams(config);
  const normalizedName = requestedName.trim().toLowerCase();
  const name = Object.keys(workstreams).find(
    (candidate) => candidate.toLowerCase() === normalizedName
  );

  return name
    ? { name, config: workstreams[name] }
    : null;
}

export function findSharedContext(
  config: PcwConfig,
  requestedName: string
): ResolvedSharedContext | null {
  const sharedContexts = getSharedContexts(config);
  const normalizedName = requestedName.trim().toLowerCase();
  const name = Object.keys(sharedContexts).find(
    (candidate) => candidate.toLowerCase() === normalizedName
  );

  return name
    ? { name, config: sharedContexts[name] }
    : null;
}

export function resolveConfiguredPath(
  contextRoot: string,
  configuredPath: string
): string {
  return resolve(contextRoot, configuredPath);
}
