import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  getContinuitySnapshot,
  updateContinuity
} from "../../continuity/continuity-service.js";
import { loadPcwConfig } from "../../config/pcw-config.js";
import {
  continuityReadErrorResponse,
  continuityUpdateErrorResponse,
  withMcpErrorBoundary
} from "../error-mapper.js";
import { jsonResponse } from "../responses.js";

export function registerContinuityTools(
  server: McpServer,
  contextRoot: string
): void {
  server.registerTool(
    "get_continuity",
    {
      description:
        "Reads the durable continuity document for a persistent workstream",
      inputSchema: z.object({
        name: z.string().min(1)
          .describe("Name of the workstream, for example SNMP")
      })
    },
    async ({ name }) => withMcpErrorBoundary(async () => {
      const { config } = await loadPcwConfig(contextRoot);

      try {
        const snapshot = await getContinuitySnapshot(contextRoot, config, name);
        return jsonResponse({
          workstream: snapshot.workstream,
          path: snapshot.configuredPath,
          sha256: snapshot.sha256,
          absolutePath: snapshot.absolutePath,
          continuity: snapshot.content
        });
      } catch (error) {
        return continuityReadErrorResponse(error, name);
      }
    })
  );

  server.registerTool(
    "update_continuity",
    {
      description:
        "Safely replaces the durable continuity document of a configured workstream. " +
        "The caller must provide the SHA-256 of the version it previously read, " +
        "preventing accidental overwrites of newer continuity state.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Workstream name, for example SNMP"),
        content: z.string().min(1).max(200_000)
          .describe("Complete new Markdown content for the continuity document"),
        expectedSha256: z.string().length(64)
          .describe("SHA-256 returned by get_continuity for the version being replaced")
      })
    },
    async ({ name, content, expectedSha256 }) =>
      withMcpErrorBoundary(async () => {
        const { config } = await loadPcwConfig(contextRoot);

        try {
          const result = await updateContinuity(contextRoot, config, {
            requestedWorkstream: name,
            content,
            expectedSha256
          });
          return jsonResponse({
            workstream: result.workstream,
            path: result.configuredPath,
            absolutePath: result.absolutePath,
            previousSha256: result.previousSha256,
            newSha256: result.newSha256,
            backupPath: result.backupPath,
            updated: result.updated
          });
        } catch (error) {
          return continuityUpdateErrorResponse(error, name);
        }
      })
  );
}
