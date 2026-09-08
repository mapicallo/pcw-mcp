import { stat } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  findWorkstream,
  getSharedContexts,
  getWorkstreams,
  loadPcwConfig
} from "../../config/pcw-config.js";
import {
  assertExistingPathInsideBase,
  resolveConfiguredPath
} from "../../filesystem/paths.js";
import { jsonErrorResponse, jsonResponse } from "../responses.js";

export function registerWorkstreamTools(
  server: McpServer,
  contextRoot: string
): void {
  async function getPathStatus(path: string | null) {
    if (!path) {
      return {
        configured: false,
        exists: false,
        absolutePath: null,
        type: null
      };
    }

    const absolutePath = resolveConfiguredPath(contextRoot, path);

    try {
      await assertExistingPathInsideBase(contextRoot, absolutePath);
      const info = await stat(absolutePath);

      return {
        configured: true,
        exists: true,
        absolutePath,
        type: info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other"
      };
    } catch {
      return {
        configured: true,
        exists: false,
        absolutePath,
        type: null
      };
    }
  }

  server.registerTool(
    "list_workstreams",
    {
      description:
        "Lists the persistent workstreams defined in pcw.yml and their configured context and continuity paths",
      inputSchema: z.object({})
    },
    async () => {
      const { config } = await loadPcwConfig(contextRoot);

      const workstreamsConfig = getWorkstreams(config);

      const workstreams = Object.entries(workstreamsConfig).map(
        ([name, value]) => ({
          name,
          contextPath: value?.context?.path ?? null,
          continuityPath: value?.continuity?.path ?? null
        })
      );

      return jsonResponse(workstreams);
    }
  );

  server.registerTool(
    "get_workstream_info",
    {
      description:
        "Returns configuration and filesystem status for a persistent workstream defined in pcw.yml",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe("Name of the workstream, for example SNMP")
      })
    },
    async ({ name }) => {
      const { config } = await loadPcwConfig(contextRoot);

      const workstreamsConfig = getWorkstreams(config);

      // Permitimos SNMP, snmp, Snmp...
      const resolvedWorkstream = findWorkstream(config, name);
      const realName = resolvedWorkstream?.name;

      if (!realName) {
        const available = Object.keys(workstreamsConfig);

        return jsonErrorResponse({
          error: `Workstream '${name}' is not defined`,
          availableWorkstreams: available
        });
      }

      const workstream = resolvedWorkstream?.config;

      const contextPath = workstream?.context?.path ?? null;
      const continuityPath = workstream?.continuity?.path ?? null;

      const contextStatus = await getPathStatus(contextPath);
      const continuityStatus = await getPathStatus(continuityPath);

      const result = {
        name: realName,

        context: {
          path: contextPath,
          ...contextStatus
        },

        continuity: {
          path: continuityPath,
          ...continuityStatus
        }
      };

      return jsonResponse(result);
    }
  );

  server.registerTool(
    "list_shared_context",
    {
      description:
        "Lists the shared context sections defined in pcw.yml and checks whether their configured paths exist",
      inputSchema: z.object({})
    },
    async () => {
      const { config } = await loadPcwConfig(contextRoot);

      const sharedContextConfig = getSharedContexts(config);

      const sections = await Promise.all(
        Object.entries(sharedContextConfig).map(
          async ([name, value]) => {
            const path = value?.path ?? null;
            const status = await getPathStatus(path);

            return {
              name,
              path,
              ...status
            };
          }
        )
      );

      return jsonResponse(sections);
    }
  );
}
