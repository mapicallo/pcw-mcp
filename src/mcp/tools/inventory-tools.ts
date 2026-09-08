import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { loadPcwConfig } from "../../config/pcw-config.js";
import {
  loadInventoryDocument,
  resolveInventoryPath,
  searchInventory
} from "../../inventory/inventory-service.js";
import { inventoryReadErrorResponse } from "../error-mapper.js";
import { jsonErrorResponse, jsonResponse } from "../responses.js";

export function registerInventoryTools(
  server: McpServer,
  contextRoot: string
): void {
  server.registerTool(
    "get_inventory",
    {
      description:
        "Reads the project document inventory configured in pcw.yml. The inventory acts as the semantic map of the available context sources.",
      inputSchema: z.object({})
    },
    async () => {
      const { config } = await loadPcwConfig(contextRoot);

      const inventoryPath = config?.inventory?.path ?? null;

      if (!inventoryPath) {
        return jsonErrorResponse({
          error: "No inventory document is configured in pcw.yml"
        });
      }

      const absolutePath = resolveInventoryPath(contextRoot, inventoryPath);

      try {
        const document = await loadInventoryDocument(
          contextRoot,
          inventoryPath
        );

        return jsonResponse({
          path: document.configuredPath,
          absolutePath: document.absolutePath,
          sizeBytes: document.sizeBytes,
          modifiedAt: document.modifiedAt,
          inventory: document.content
        });
      } catch (error) {
        return inventoryReadErrorResponse(error, absolutePath);
      }
    }
  );

  server.registerTool(
    "search_inventory",
    {
      description:
        "Searches the semantic document inventory and returns only the relevant inventory sections instead of loading the complete inventory",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Text to search for in the document inventory"),

        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of matching sections to return")
      })
    },

    async ({ query, limit }) => {
      const { config } = await loadPcwConfig(contextRoot);

      const inventoryPath = config?.inventory?.path ?? null;

      if (!inventoryPath) {
        return jsonErrorResponse({
          error: "No inventory document is configured in pcw.yml"
        });
      }

      const absolutePath = resolveInventoryPath(contextRoot, inventoryPath);

      try {
        const result = await searchInventory(
          contextRoot,
          inventoryPath,
          query,
          limit
        );

        return jsonResponse({
          query,
          inventory: result.document.configuredPath,
          matchCount: result.matches.length,
          matches: result.matches
        });
      } catch {
        return jsonErrorResponse({
          error: "Could not search the configured inventory",
          path: absolutePath
        });
      }
    }
  );
}
