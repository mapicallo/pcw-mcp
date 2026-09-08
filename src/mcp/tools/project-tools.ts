import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { loadPcwConfig } from "../../config/pcw-config.js";
import { jsonResponse, textResponse } from "../responses.js";

export function registerProjectTools(
  server: McpServer,
  contextRoot: string
): void {
  server.registerTool(
    "hello",
    {
      description: "Simple test tool to verify that the PCW MCP server is working",
      inputSchema: z.object({
        name: z.string().describe("Name of the person to greet")
      })
    },
    async ({ name }) =>
      textResponse(`Hello ${name}. PCW MCP is running correctly.`)
  );

  server.registerTool(
    "get_project_info",
    {
      description:
        "Reads pcw.yml from the configured PCW context root and returns basic project information",
      inputSchema: z.object({})
    },
    async () => {
      const { config, configPath } = await loadPcwConfig(contextRoot);

      const result = {
        contextRoot,
        configPath,
        version: config?.version ?? null,
        project: {
          id: config?.project?.id ?? null,
          name: config?.project?.name ?? null
        },
        inventory: config?.inventory?.path ?? null
      };

      return jsonResponse(result);
    }
  );
}
