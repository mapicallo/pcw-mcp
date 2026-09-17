import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { loadPcwConfig } from "../../config/pcw-config.js";
import {
  loadInventoryDocument,
  resolveInventoryPath,
  searchInventory,
  updateInventory
} from "../../inventory/inventory-service.js";
import { PCW_ERROR_CODES } from "../error-codes.js";
import {
  inventoryReadErrorResponse,
  inventorySearchErrorResponse,
  inventoryUpdateErrorResponse,
  withMcpErrorBoundary
} from "../error-mapper.js";
import { codedErrorResponse, jsonResponse } from "../responses.js";

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
    async () => withMcpErrorBoundary(async () => {
      const { config } = await loadPcwConfig(contextRoot);
      const inventoryPath = config?.inventory?.path ?? null;

      if (!inventoryPath) {
        return codedErrorResponse(PCW_ERROR_CODES.INVENTORY_ERROR, {
          error: "No inventory document is configured in pcw.yml"
        });
      }

      const absolutePath = resolveInventoryPath(contextRoot, inventoryPath);

      try {
        const document = await loadInventoryDocument(contextRoot, inventoryPath);
        return jsonResponse({
          path: document.configuredPath,
          absolutePath: document.absolutePath,
          sizeBytes: document.sizeBytes,
          modifiedAt: document.modifiedAt,
          sha256: document.sha256,
          inventory: document.content
        });
      } catch (error) {
        return inventoryReadErrorResponse(error, absolutePath);
      }
    })
  );

  server.registerTool(
    "search_inventory",
    {
      description:
        "Searches the semantic document inventory and returns only the relevant inventory sections instead of loading the complete inventory",
      inputSchema: z.object({
        query: z.string().min(1).describe("Text to search for in the document inventory"),
        limit: z.number().int().min(1).max(20).optional()
          .describe("Maximum number of matching sections to return")
      })
    },
    async ({ query, limit }) => withMcpErrorBoundary(async () => {
      const { config } = await loadPcwConfig(contextRoot);
      const inventoryPath = config?.inventory?.path ?? null;

      if (!inventoryPath) {
        return codedErrorResponse(PCW_ERROR_CODES.INVENTORY_ERROR, {
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
      } catch (error) {
        return inventorySearchErrorResponse(error, absolutePath);
      }
    })
  );

  server.registerTool(
    "update_inventory",
    {
      description:
        "Safely replaces the complete configured inventory using the SHA-256 returned by get_inventory",
      inputSchema: z.object({
        content: z.string().min(1).max(200_000)
          .describe("Complete replacement Markdown content for the inventory"),
        expectedSha256: z.string().length(64)
          .describe("SHA-256 returned by get_inventory for the version being replaced")
      })
    },
    async ({ content, expectedSha256 }) =>
      withMcpErrorBoundary(async () => {
        const { config } = await loadPcwConfig(contextRoot);
        const inventoryPath = config.inventory?.path ?? null;
        if (!inventoryPath) {
          return codedErrorResponse(PCW_ERROR_CODES.INVENTORY_ERROR, {
            error: "No inventory document is configured in pcw.yml"
          });
        }

        const absolutePath = resolveInventoryPath(contextRoot, inventoryPath);
        try {
          const result = await updateInventory(
            contextRoot,
            inventoryPath,
            { content, expectedSha256 }
          );
          return jsonResponse({
            path: result.configuredPath,
            absolutePath: result.absolutePath,
            previousSha256: result.previousSha256,
            newSha256: result.newSha256,
            backupPath: result.backupPath,
            updated: result.updated
          });
        } catch (error) {
          return inventoryUpdateErrorResponse(error, absolutePath);
        }
      })
  );
}
