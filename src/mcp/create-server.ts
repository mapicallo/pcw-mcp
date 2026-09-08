import { McpServer } from "@modelcontextprotocol/server";

import { registerContinuityTools } from "./tools/continuity-tools.js";
import { registerInventoryTools } from "./tools/inventory-tools.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerSourceTools } from "./tools/source-tools.js";
import { registerWorkstreamTools } from "./tools/workstream-tools.js";
import { PCW_SOFTWARE_VERSION } from "../version.js";

export type CreatePcwMcpServerOptions = {
  contextRoot: string;
};

export function createPcwMcpServer(
  options: CreatePcwMcpServerOptions
): McpServer {
  const server = new McpServer({
    name: "pcw-mcp",
    version: PCW_SOFTWARE_VERSION
  });

  registerProjectTools(server, options.contextRoot);
  registerWorkstreamTools(server, options.contextRoot);
  registerSourceTools(server, options.contextRoot);
  registerInventoryTools(server, options.contextRoot);
  registerContinuityTools(server, options.contextRoot);

  return server;
}
