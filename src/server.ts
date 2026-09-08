import {
  copyFile,
  mkdir,
  readFile,
  stat
} from "node:fs/promises";

import {
  extname,
  join
} from "node:path";

import writeFileAtomic from "write-file-atomic";

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
import { sha256Text } from "./filesystem/hashing.js";
import {
  assertExistingPathInsideBase,
  ensureInsideBase,
  resolveConfiguredPath
} from "./filesystem/paths.js";
import {
  InventoryNotFileError,
  loadInventoryDocument,
  resolveInventoryPath,
  searchInventory
} from "./inventory/inventory-service.js";
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
  async ({ name }) => ({
    content: [
      {
        type: "text",
        text: `Hello ${name}. PCW MCP is running correctly.`
      }
    ]
  })
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(workstreams, null, 2)
        }
      ]
    };
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

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Workstream '${name}' is not defined`,
                availableWorkstreams: available
              },
              null,
              2
            )
          }
        ]
      };
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
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

    const workstreamsConfig = getWorkstreams(config);

    const resolvedWorkstream = findWorkstream(config, name);
    const realName = resolvedWorkstream?.name;

    if (!realName) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Workstream '${name}' is not defined`,
                availableWorkstreams: Object.keys(workstreamsConfig)
              },
              null,
              2
            )
          }
        ]
      };
    }

    const continuityPath =
      resolvedWorkstream?.config.continuity?.path ?? null;

    if (!continuityPath) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Workstream '${realName}' has no continuity document configured`
              },
              null,
              2
            )
          }
        ]
      };
    }

    const absolutePath = resolveConfiguredPath(contextRoot, continuityPath);

    try {
      await assertExistingPathInsideBase(contextRoot, absolutePath);
      const continuity = await readFile(absolutePath, "utf8");
      const continuitySha256 = sha256Text(continuity);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                workstream: realName,
                path: continuityPath,
                sha256: continuitySha256,
                absolutePath,
                continuity
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Could not read continuity document for '${realName}'`,
                path: absolutePath
              },
              null,
              2
            )
          }
        ]
      };
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(sections, null, 2)
        }
      ]
    };
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
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Shared context '${name}' is not defined`,
                  available: Object.keys(sharedConfig)
                },
                null,
                2
              )
            }
          ]
        };
      }

      configuredPath = resolvedSharedContext?.config.path ?? null;
    }

    if (scope === "workstream") {
      const workstreamsConfig = getWorkstreams(config);

      const resolvedWorkstream = findWorkstream(config, name);
      logicalName = resolvedWorkstream?.name ?? null;

      if (!logicalName) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Workstream '${name}' is not defined`,
                  available: Object.keys(workstreamsConfig)
                },
                null,
                2
              )
            }
          ]
        };
      }

      configuredPath =
        resolvedWorkstream?.config.context?.path ?? null;

      if (!configuredPath) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Workstream '${logicalName}' has no specialized context configured`
                },
                null,
                2
              )
            }
          ]
        };
      }
    }

    if (!configuredPath) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `No context path configured for '${name}'`
              },
              null,
              2
            )
          }
        ]
      };
    }

    const absolutePath = resolveConfiguredPath(contextRoot, configuredPath);

    try {
      const listing = await discoverSources(contextRoot, configuredPath);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                scope,
                name: logicalName,
                path: configuredPath,
                absolutePath: listing.absolutePath,
                sourceCount: listing.sources.length,
                sources: listing.sources
              },
              null,
              2
            )
          }
        ]
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Could not list sources for '${name}'`,
                path: absolutePath
              },
              null,
              2
            )
          }
        ]
      };
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
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "No inventory document is configured in pcw.yml"
              },
              null,
              2
            )
          }
        ]
      };
    }

    const absolutePath = resolveInventoryPath(contextRoot, inventoryPath);

    try {
      const document = await loadInventoryDocument(
        contextRoot,
        inventoryPath
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                path: document.configuredPath,
                absolutePath: document.absolutePath,
                sizeBytes: document.sizeBytes,
                modifiedAt: document.modifiedAt,
                inventory: document.content
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      if (error instanceof InventoryNotFileError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Configured inventory path is not a file",
                  path: absolutePath
                },
                null,
                2
              )
            }
          ]
        };
      }

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Could not read the configured inventory document",
                path: absolutePath
              },
              null,
              2
            )
          }
        ]
      };
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
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "No inventory document is configured in pcw.yml"
              },
              null,
              2
            )
          }
        ]
      };
    }

    const absolutePath = resolveInventoryPath(contextRoot, inventoryPath);

    try {
      const result = await searchInventory(
        contextRoot,
        inventoryPath,
        query,
        limit
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query,
                inventory: result.document.configuredPath,
                matchCount: result.matches.length,
                matches: result.matches
              },
              null,
              2
            )
          }
        ]
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Could not search the configured inventory",
                path: absolutePath
              },
              null,
              2
            )
          }
        ]
      };
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
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Shared context '${name}' is not defined`,
                  available: Object.keys(sharedConfig)
                },
                null,
                2
              )
            }
          ]
        };
      }

      configuredPath = resolvedSharedContext?.config.path ?? null;
    }

    if (scope === "workstream") {
      const workstreamsConfig = getWorkstreams(config);

      const resolvedWorkstream = findWorkstream(config, name);
      logicalName = resolvedWorkstream?.name ?? null;

      if (!logicalName) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Workstream '${name}' is not defined`,
                  available: Object.keys(workstreamsConfig)
                },
                null,
                2
              )
            }
          ]
        };
      }

      configuredPath =
        resolvedWorkstream?.config.context?.path ?? null;
    }

    if (!configuredPath) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `No readable context path configured for '${name}'`
              },
              null,
              2
            )
          }
        ]
      };
    }

    if (!isTextSourcePath(source)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "This tool only supports Markdown (.md) and plain-text (.txt) sources",
                source
              },
              null,
              2
            )
          }
        ]
      };
    }

    try {
      const resolvedSource = await resolveSourceFile(
        contextRoot,
        configuredPath,
        source
      );
      const text = await readTextFile(resolvedSource.absolutePath);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                scope,
                name: logicalName,
                source,
                absolutePath: resolvedSource.absolutePath,
                sizeBytes: resolvedSource.sizeBytes,
                modifiedAt: resolvedSource.modifiedAt,
                text
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Could not read source '${source}'`,
                details:
                  error instanceof Error ? error.message : String(error)
              },
              null,
              2
            )
          }
        ]
      };
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
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Shared context '${name}' is not defined`,
                  available: Object.keys(sharedConfig)
                },
                null,
                2
              )
            }
          ]
        };
      }

      configuredPath = resolvedSharedContext?.config.path ?? null;
    }

    if (scope === "workstream") {
      const workstreamsConfig = getWorkstreams(config);

      const resolvedWorkstream = findWorkstream(config, name);
      logicalName = resolvedWorkstream?.name ?? null;

      if (!logicalName) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Workstream '${name}' is not defined`,
                  available: Object.keys(workstreamsConfig)
                },
                null,
                2
              )
            }
          ]
        };
      }

      configuredPath =
        resolvedWorkstream?.config.context?.path ?? null;
    }

    if (!configuredPath) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `No context path configured for '${name}'`
              },
              null,
              2
            )
          }
        ]
      };
    }

    if (!isDocxSourcePath(source)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "This tool only supports DOCX files",
                source
              },
              null,
              2
            )
          }
        ]
      };
    }

    try {
      const resolvedSource = await resolveSourceFile(
        contextRoot,
        configuredPath,
        source
      );
      const result = await readDocxFile(resolvedSource.absolutePath);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                scope,
                name: logicalName,
                source,
                absolutePath: resolvedSource.absolutePath,
                sizeBytes: resolvedSource.sizeBytes,
                modifiedAt: resolvedSource.modifiedAt,
                text: result.text,
                warnings: result.warnings
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Could not read DOCX source '${source}'`,
                details:
                  error instanceof Error ? error.message : String(error)
              },
              null,
              2
            )
          }
        ]
      };
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
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Shared context '${name}' is not defined`,
                  available: Object.keys(sharedConfig)
                },
                null,
                2
              )
            }
          ]
        };
      }

      configuredPath = resolvedSharedContext?.config.path ?? null;
    }

    if (scope === "workstream") {
      const workstreamsConfig = getWorkstreams(config);

      const resolvedWorkstream = findWorkstream(config, name);
      logicalName = resolvedWorkstream?.name ?? null;

      if (!logicalName) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Workstream '${name}' is not defined`,
                  available: Object.keys(workstreamsConfig)
                },
                null,
                2
              )
            }
          ]
        };
      }

      configuredPath =
        resolvedWorkstream?.config.context?.path ?? null;
    }

    if (!configuredPath) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `No context path configured for '${name}'`
              },
              null,
              2
            )
          }
        ]
      };
    }

    if (!isPdfSourcePath(source)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "This tool only supports PDF files",
                source
              },
              null,
              2
            )
          }
        ]
      };
    }

    try {
      const resolvedSource = await resolveSourceFile(
        contextRoot,
        configuredPath,
        source
      );
      const text = await readPdfFile(resolvedSource.absolutePath);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                scope,
                name: logicalName,
                source,
                absolutePath: resolvedSource.absolutePath,
                sizeBytes: resolvedSource.sizeBytes,
                modifiedAt: resolvedSource.modifiedAt,
                text
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Could not read PDF source '${source}'`,
                details:
                  error instanceof Error ? error.message : String(error)
              },
              null,
              2
            )
          }
        ]
      };
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

    const workstreamsConfig = getWorkstreams(config);

    const resolvedWorkstream = findWorkstream(config, name);
    const realName = resolvedWorkstream?.name ?? null;

    if (!realName) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Workstream '${name}' is not defined`,
                availableWorkstreams: Object.keys(workstreamsConfig)
              },
              null,
              2
            )
          }
        ]
      };
    }

    const continuityPath =
      resolvedWorkstream?.config.continuity?.path ?? null;

    if (!continuityPath) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Workstream '${realName}' has no continuity document configured`
              },
              null,
              2
            )
          }
        ]
      };
    }

    if (extname(continuityPath).toLowerCase() !== ".md") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Continuity documents must be Markdown (.md)",
                path: continuityPath
              },
              null,
              2
            )
          }
        ]
      };
    }

    try {
      /*
       * Security boundary:
       * even if pcw.yml were modified incorrectly, the configured
       * continuity path may never escape the PCW context root.
       */
      const absolutePath = resolveConfiguredPath(
        contextRoot,
        continuityPath
      );
      await assertExistingPathInsideBase(contextRoot, absolutePath);

      const info = await stat(absolutePath);

      if (!info.isFile()) {
        throw new Error("Configured continuity path is not a file");
      }

      const currentContent = await readFile(absolutePath, "utf8");
      const currentSha256 = sha256Text(currentContent);

      /*
       * Optimistic concurrency check.
       *
       * If another agent/session updated continuity after this caller
       * read it, reject the write rather than losing newer information.
       */
      if (currentSha256 !== expectedSha256) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Continuity has changed since it was read",
                  workstream: realName,
                  expectedSha256,
                  currentSha256,
                  action:
                    "Call get_continuity again, reconcile the newer state, and retry."
                },
                null,
                2
              )
            }
          ]
        };
      }

      /*
       * Create durable history before replacing the current checkpoint.
       */
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-");

      const historyDirectory = resolveConfiguredPath(
        contextRoot,
        join(".pcw", "history", realName)
      );

      await mkdir(historyDirectory, {
        recursive: true
      });
      await assertExistingPathInsideBase(
        contextRoot,
        historyDirectory
      );

      const backupPath = ensureInsideBase(
        historyDirectory,
        join(
          historyDirectory,
          `${timestamp}-${currentSha256.slice(0, 12)}.md`
        )
      );

      await copyFile(
        absolutePath,
        backupPath
      );

      /*
       * Atomic replacement.
       */
      await writeFileAtomic(
        absolutePath,
        content,
        {
          encoding: "utf8"
        }
      );

      const newSha256 = sha256Text(content);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                workstream: realName,
                path: continuityPath,
                absolutePath,
                previousSha256: currentSha256,
                newSha256,
                backupPath,
                updated: true
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Could not update continuity for '${realName}'`,
                details:
                  error instanceof Error
                    ? error.message
                    : String(error)
              },
              null,
              2
            )
          }
        ]
      };
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