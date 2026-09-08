import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { registerContinuityTools } from "./mcp/tools/continuity-tools.js";
import { registerInventoryTools } from "./mcp/tools/inventory-tools.js";
import { registerProjectTools } from "./mcp/tools/project-tools.js";
import { registerSourceTools } from "./mcp/tools/source-tools.js";
import { registerWorkstreamTools } from "./mcp/tools/workstream-tools.js";

const server = new McpServer({
  name: "pcw-mcp",
  version: "0.1.0"
});

/*
 * Durante el POC usamos C:\rmms-context por defecto.
 *
 * Más adelante podremos indicar cualquier contexto mediante:
 * PCW_CONTEXT_ROOT
 */
const contextRoot =
  process.env.PCW_CONTEXT_ROOT ?? "C:\\rmms-context";

registerProjectTools(server, contextRoot);
registerWorkstreamTools(server, contextRoot);
registerSourceTools(server, contextRoot);
registerInventoryTools(server, contextRoot);
registerContinuityTools(server, contextRoot);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal PCW MCP error:", error);
  process.exit(1);
});
