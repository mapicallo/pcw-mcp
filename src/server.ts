import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createPcwMcpServer } from "./mcp/create-server.js";
import {
  PCW_RUNTIME_USAGE,
  resolveRuntimeOptions,
  RuntimeConfigurationError,
  validateRuntimeContextRoot
} from "./runtime/context-root.js";
import { PCW_SOFTWARE_VERSION } from "./version.js";

async function main(): Promise<void> {
  const runtime = resolveRuntimeOptions({
    argv: process.argv.slice(2),
    environment: process.env
  });

  if (runtime.mode === "help") {
    process.stdout.write(`${PCW_RUNTIME_USAGE}\n`);
    return;
  }

  if (runtime.mode === "version") {
    process.stdout.write(`${PCW_SOFTWARE_VERSION}\n`);
    return;
  }

  await validateRuntimeContextRoot(runtime.contextRoot);
  const server = createPcwMcpServer({ contextRoot: runtime.contextRoot });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  if (error instanceof RuntimeConfigurationError) {
    console.error(error.message);
  } else {
    console.error("Fatal PCW MCP error:", error);
  }
  process.exitCode = 1;
});
