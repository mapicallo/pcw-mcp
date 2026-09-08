import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createPcwMcpServer } from "./mcp/create-server.js";
import { resolveRuntimeContextRoot } from "./runtime/context-root.js";

async function main(): Promise<void> {
  const contextRoot = resolveRuntimeContextRoot(process.env);
  const server = createPcwMcpServer({ contextRoot });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal PCW MCP error:", error);
  process.exit(1);
});
