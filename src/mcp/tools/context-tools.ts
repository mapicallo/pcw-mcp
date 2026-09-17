import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  createSharedContext,
  enableWorkstreamContext
} from "../../contexts/context-service.js";
import { withMcpErrorBoundary } from "../error-mapper.js";
import { jsonResponse } from "../responses.js";

export function registerContextTools(
  server: McpServer,
  contextRoot: string
): void {
  server.registerTool(
    "create_shared_context",
    {
      description:
        "Creates a safely named shared-context section inside the PCW root and adds it to pcw.yml",
      inputSchema: z.object({
        name: z.string().describe(
          "Shared-context name using 1-64 ASCII letters, digits, hyphens, or underscores"
        )
      })
    },
    async ({ name }) => withMcpErrorBoundary(async () =>
      jsonResponse(await createSharedContext(contextRoot, { name }))
    )
  );

  server.registerTool(
    "enable_workstream_context",
    {
      description:
        "Creates and configures specialized context for an existing workstream that does not already have it",
      inputSchema: z.object({
        name: z.string().min(1).describe("Existing workstream name")
      })
    },
    async ({ name }) => withMcpErrorBoundary(async () =>
      jsonResponse(await enableWorkstreamContext(contextRoot, { name }))
    )
  );
}
