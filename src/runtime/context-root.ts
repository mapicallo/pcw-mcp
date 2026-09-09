import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export type RuntimeEnvironment = {
  PCW_CONTEXT_ROOT?: string;
};

export type RuntimeOptions =
  | { mode: "server"; contextRoot: string }
  | { mode: "help" }
  | { mode: "version" };

export type ResolveRuntimeOptionsInput = {
  argv: readonly string[];
  environment: RuntimeEnvironment;
};

export class RuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

export const PCW_RUNTIME_USAGE = `Usage: node dist/server.js [options]

Options:
  --context-root <path>  PCW context root (overrides PCW_CONTEXT_ROOT)
  --help                 Show this help
  --version              Show the software version`;

function parseArguments(argv: readonly string[]): {
  mode: "server" | "help" | "version";
  contextRoot?: string;
} {
  let mode: "server" | "help" | "version" = "server";
  let contextRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "--version") {
      if (mode !== "server" || contextRoot !== undefined || argv.length !== 1) {
        throw new RuntimeConfigurationError(
          `${argument} cannot be combined with other options.`
        );
      }
      mode = argument === "--help" ? "help" : "version";
      continue;
    }

    if (argument === "--context-root") {
      if (contextRoot !== undefined) {
        throw new RuntimeConfigurationError(
          "--context-root may be specified only once."
        );
      }

      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new RuntimeConfigurationError(
          "--context-root requires a path value."
        );
      }
      if (value.trim().length === 0) {
        throw new RuntimeConfigurationError(
          "--context-root must not be empty."
        );
      }

      contextRoot = value.trim();
      index += 1;
      continue;
    }

    throw new RuntimeConfigurationError(`Unknown option: ${argument}`);
  }

  return { mode, contextRoot };
}

export function resolveRuntimeOptions(
  input: ResolveRuntimeOptionsInput
): RuntimeOptions {
  const parsed = parseArguments(input.argv);

  if (parsed.mode !== "server") {
    return { mode: parsed.mode };
  }

  const configuredRoot =
    parsed.contextRoot ?? input.environment.PCW_CONTEXT_ROOT;
  if (configuredRoot === undefined || configuredRoot.trim().length === 0) {
    throw new RuntimeConfigurationError(
      "PCW context root is not configured. Use --context-root <path> or set PCW_CONTEXT_ROOT."
    );
  }

  return {
    mode: "server",
    contextRoot: resolve(configuredRoot.trim())
  };
}

export async function validateRuntimeContextRoot(
  contextRoot: string
): Promise<void> {
  let rootInfo;
  try {
    rootInfo = await stat(contextRoot);
  } catch {
    throw new RuntimeConfigurationError(
      `PCW context root does not exist: ${contextRoot}`
    );
  }

  if (!rootInfo.isDirectory()) {
    throw new RuntimeConfigurationError(
      `PCW context root is not a directory: ${contextRoot}`
    );
  }

  const configPath = resolve(contextRoot, "pcw.yml");
  let configInfo;
  try {
    configInfo = await stat(configPath);
  } catch {
    throw new RuntimeConfigurationError(
      `pcw.yml was not found in PCW context root: ${contextRoot}`
    );
  }

  if (!configInfo.isFile()) {
    throw new RuntimeConfigurationError(
      `pcw.yml is not a file in PCW context root: ${contextRoot}`
    );
  }
}
