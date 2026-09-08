import { stat } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import {
  findSharedContext,
  findWorkstream,
  getSharedContexts,
  getWorkstreams,
  loadPcwConfig
} from "./config/pcw-config.js";
import {
  assertExistingPathInsideBase,
  resolveConfiguredPath
} from "./filesystem/paths.js";
import {
  getContinuitySnapshot,
  updateContinuity
} from "./continuity/continuity-service.js";
import {
  loadInventoryDocument,
  resolveInventoryPath,
  searchInventory
} from "./inventory/inventory-service.js";
import {
  continuityReadErrorResponse,
  continuityUpdateErrorResponse,
  inventoryReadErrorResponse,
  sourceReadErrorResponse
} from "./mcp/error-mapper.js";
import {
  jsonErrorResponse,
  jsonResponse,
  textResponse
} from "./mcp/responses.js";
import {
  isDocxSourcePath,
  readDocxFile
} from "./readers/docx-reader.js";
import {
  isPdfSourcePath,
  readPdfFile
} from "./readers/pdf-reader.js";
import {
  isTextSourcePath,
  readTextFile
} from "./readers/text-reader.js";
import {
  discoverSources,
  resolveSourceFile
} from "./sources/source-service.js";

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
  "get_continuity",
  {
    description:
      "Reads the durable continuity document for a persistent workstream",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .describe("Name of the workstream, for example SNMP")
    })
  },
  async ({ name }) => {
    const { config } = await loadPcwConfig(contextRoot);

    try {
      const snapshot = await getContinuitySnapshot(
        contextRoot,
        config,
        name
      );

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


server.registerTool(
  "list_sources",
  {
    description:
      "Lists the files and directories available in a shared context section or workstream-specific context without reading their contents",
    inputSchema: z.object({
      scope: z
        .enum(["shared", "workstream"])
        .describe("Context scope: shared or workstream"),

      name: z
        .string()
        .min(1)
        .describe(
          "Shared context section or workstream name, for example general or SNMP"
        )
    })
  },

  async ({ scope, name }) => {
    const { config } = await loadPcwConfig(contextRoot);

    let logicalName: string | null = null;
    let configuredPath: string | null = null;

    if (scope === "shared") {
      const sharedConfig = getSharedContexts(config);

      const resolvedSharedContext = findSharedContext(config, name);
      logicalName = resolvedSharedContext?.name ?? null;

      if (!logicalName) {
        return jsonErrorResponse({
          error: `Shared context '${name}' is not defined`,
          available: Object.keys(sharedConfig)
        });
      }

      configuredPath = resolvedSharedContext?.config.path ?? null;
    }

    if (scope === "workstream") {
      const workstreamsConfig = getWorkstreams(config);

      const resolvedWorkstream = findWorkstream(config, name);
      logicalName = resolvedWorkstream?.name ?? null;

      if (!logicalName) {
        return jsonErrorResponse({
          error: `Workstream '${name}' is not defined`,
          available: Object.keys(workstreamsConfig)
        });
      }

      configuredPath =
        resolvedWorkstream?.config.context?.path ?? null;

      if (!configuredPath) {
        return jsonErrorResponse({
          error: `Workstream '${logicalName}' has no specialized context configured`
        });
      }
    }

    if (!configuredPath) {
      return jsonErrorResponse({
        error: `No context path configured for '${name}'`
      });
    }

    const absolutePath = resolveConfiguredPath(contextRoot, configuredPath);

    try {
      const listing = await discoverSources(contextRoot, configuredPath);

      return jsonResponse({
        scope,
        name: logicalName,
        path: configuredPath,
        absolutePath: listing.absolutePath,
        sourceCount: listing.sources.length,
        sources: listing.sources
      });
    } catch {
      return jsonErrorResponse({
        error: `Could not list sources for '${name}'`,
        path: absolutePath
      });
    }
  }
);

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

server.registerTool(
  "read_text_source",
  {
    description:
      "Reads a Markdown or plain-text source from a configured shared context section or workstream context",
    inputSchema: z.object({
      scope: z.enum(["shared", "workstream"]),

      name: z
        .string()
        .min(1)
        .describe("Shared context section or workstream name"),

      source: z
        .string()
        .min(1)
        .describe("Relative source filename inside the configured context directory")
    })
  },

  async ({ scope, name, source }) => {
    const { config } = await loadPcwConfig(contextRoot);

    let logicalName: string | null = null;
    let configuredPath: string | null = null;

    if (scope === "shared") {
      const sharedConfig = getSharedContexts(config);

      const resolvedSharedContext = findSharedContext(config, name);
      logicalName = resolvedSharedContext?.name ?? null;

      if (!logicalName) {
        return jsonErrorResponse({
          error: `Shared context '${name}' is not defined`,
          available: Object.keys(sharedConfig)
        });
      }

      configuredPath = resolvedSharedContext?.config.path ?? null;
    }

    if (scope === "workstream") {
      const workstreamsConfig = getWorkstreams(config);

      const resolvedWorkstream = findWorkstream(config, name);
      logicalName = resolvedWorkstream?.name ?? null;

      if (!logicalName) {
        return jsonErrorResponse({
          error: `Workstream '${name}' is not defined`,
          available: Object.keys(workstreamsConfig)
        });
      }

      configuredPath =
        resolvedWorkstream?.config.context?.path ?? null;
    }

    if (!configuredPath) {
      return jsonErrorResponse({
        error: `No readable context path configured for '${name}'`
      });
    }

    if (!isTextSourcePath(source)) {
      return jsonErrorResponse({
        error:
          "This tool only supports Markdown (.md) and plain-text (.txt) sources",
        source
      });
    }

    try {
      const resolvedSource = await resolveSourceFile(
        contextRoot,
        configuredPath,
        source
      );
      const text = await readTextFile(resolvedSource.absolutePath);

      return jsonResponse({
        scope,
        name: logicalName,
        source,
        absolutePath: resolvedSource.absolutePath,
        sizeBytes: resolvedSource.sizeBytes,
        modifiedAt: resolvedSource.modifiedAt,
        text
      });
    } catch (error) {
      return sourceReadErrorResponse(
        `Could not read source '${source}'`,
        error
      );
    }
  }
);


server.registerTool(
  "read_docx_source",
  {
    description:
      "Extracts plain text from a DOCX source inside a configured shared context section or workstream context",
    inputSchema: z.object({
      scope: z.enum(["shared", "workstream"]),

      name: z
        .string()
        .min(1)
        .describe("Shared context section or workstream name"),

      source: z
        .string()
        .min(1)
        .describe("DOCX filename inside the configured context directory")
    })
  },

  async ({ scope, name, source }) => {
    const { config } = await loadPcwConfig(contextRoot);

    let logicalName: string | null = null;
    let configuredPath: string | null = null;

    if (scope === "shared") {
      const sharedConfig = getSharedContexts(config);

      const resolvedSharedContext = findSharedContext(config, name);
      logicalName = resolvedSharedContext?.name ?? null;

      if (!logicalName) {
        return jsonErrorResponse({
          error: `Shared context '${name}' is not defined`,
          available: Object.keys(sharedConfig)
        });
      }

      configuredPath = resolvedSharedContext?.config.path ?? null;
    }

    if (scope === "workstream") {
      const workstreamsConfig = getWorkstreams(config);

      const resolvedWorkstream = findWorkstream(config, name);
      logicalName = resolvedWorkstream?.name ?? null;

      if (!logicalName) {
        return jsonErrorResponse({
          error: `Workstream '${name}' is not defined`,
          available: Object.keys(workstreamsConfig)
        });
      }

      configuredPath =
        resolvedWorkstream?.config.context?.path ?? null;
    }

    if (!configuredPath) {
      return jsonErrorResponse({
        error: `No context path configured for '${name}'`
      });
    }

    if (!isDocxSourcePath(source)) {
      return jsonErrorResponse({
        error: "This tool only supports DOCX files",
        source
      });
    }

    try {
      const resolvedSource = await resolveSourceFile(
        contextRoot,
        configuredPath,
        source
      );
      const result = await readDocxFile(resolvedSource.absolutePath);

      return jsonResponse({
        scope,
        name: logicalName,
        source,
        absolutePath: resolvedSource.absolutePath,
        sizeBytes: resolvedSource.sizeBytes,
        modifiedAt: resolvedSource.modifiedAt,
        text: result.text,
        warnings: result.warnings
      });
    } catch (error) {
      return sourceReadErrorResponse(
        `Could not read DOCX source '${source}'`,
        error
      );
    }
  }
);


server.registerTool(
  "read_pdf_source",
  {
    description:
      "Extracts text from a PDF source inside a configured shared context section or workstream context",
    inputSchema: z.object({
      scope: z.enum(["shared", "workstream"]),

      name: z
        .string()
        .min(1)
        .describe("Shared context section or workstream name"),

      source: z
        .string()
        .min(1)
        .describe("PDF filename inside the configured context directory")
    })
  },

  async ({ scope, name, source }) => {
    const { config } = await loadPcwConfig(contextRoot);

    let logicalName: string | null = null;
    let configuredPath: string | null = null;

    if (scope === "shared") {
      const sharedConfig = getSharedContexts(config);

      const resolvedSharedContext = findSharedContext(config, name);
      logicalName = resolvedSharedContext?.name ?? null;

      if (!logicalName) {
        return jsonErrorResponse({
          error: `Shared context '${name}' is not defined`,
          available: Object.keys(sharedConfig)
        });
      }

      configuredPath = resolvedSharedContext?.config.path ?? null;
    }

    if (scope === "workstream") {
      const workstreamsConfig = getWorkstreams(config);

      const resolvedWorkstream = findWorkstream(config, name);
      logicalName = resolvedWorkstream?.name ?? null;

      if (!logicalName) {
        return jsonErrorResponse({
          error: `Workstream '${name}' is not defined`,
          available: Object.keys(workstreamsConfig)
        });
      }

      configuredPath =
        resolvedWorkstream?.config.context?.path ?? null;
    }

    if (!configuredPath) {
      return jsonErrorResponse({
        error: `No context path configured for '${name}'`
      });
    }

    if (!isPdfSourcePath(source)) {
      return jsonErrorResponse({
        error: "This tool only supports PDF files",
        source
      });
    }

    try {
      const resolvedSource = await resolveSourceFile(
        contextRoot,
        configuredPath,
        source
      );
      const text = await readPdfFile(resolvedSource.absolutePath);

      return jsonResponse({
        scope,
        name: logicalName,
        source,
        absolutePath: resolvedSource.absolutePath,
        sizeBytes: resolvedSource.sizeBytes,
        modifiedAt: resolvedSource.modifiedAt,
        text
      });
    } catch (error) {
      return sourceReadErrorResponse(
        `Could not read PDF source '${source}'`,
        error
      );
    }
  }
);


server.registerTool(
  "update_continuity",
  {
    description:
      "Safely replaces the durable continuity document of a configured workstream. " +
      "The caller must provide the SHA-256 of the version it previously read, " +
      "preventing accidental overwrites of newer continuity state.",

    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .describe("Workstream name, for example SNMP"),

      content: z
        .string()
        .min(1)
        .max(200_000)
        .describe("Complete new Markdown content for the continuity document"),

      expectedSha256: z
        .string()
        .length(64)
        .describe(
          "SHA-256 returned by get_continuity for the version being replaced"
        )
    })
  },

  async ({ name, content, expectedSha256 }) => {
    const { config } = await loadPcwConfig(contextRoot);

    try {
      const result = await updateContinuity(
        contextRoot,
        config,
        {
          requestedWorkstream: name,
          content,
          expectedSha256
        }
      );

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
  }
);


async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}


main().catch((error) => {
  console.error("Fatal PCW MCP error:", error);
  process.exit(1);
});