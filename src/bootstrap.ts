import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContextInitializationError,
  initializeContextRoot
} from "./initialization/context-initializer.js";

type BootstrapOptions = {
  command: "init-context";
  contextRoot: string;
};

export function parseBootstrapArgs(args: string[]): BootstrapOptions {
  if (args[0] !== "init-context") {
    throw new Error("Usage: bootstrap init-context --context-root <absolute-path>");
  }
  if (args.length !== 3 || args[1] !== "--context-root" || !args[2]?.trim()) {
    throw new Error("Usage: bootstrap init-context --context-root <absolute-path>");
  }
  return { command: "init-context", contextRoot: args[2] };
}

async function main(): Promise<void> {
  try {
    const options = parseBootstrapArgs(process.argv.slice(2));
    const result = await initializeContextRoot({ contextRoot: options.contextRoot });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const code = error instanceof ContextInitializationError
      ? error.code
      : "PCW_CONTEXT_INITIALIZATION_FAILED";
    const message = error instanceof Error ? error.message : "Unknown initialization failure";
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
