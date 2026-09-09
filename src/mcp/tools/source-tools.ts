import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  findSharedContext,
  findWorkstream,
  getSharedContexts,
  getWorkstreams,
  loadPcwConfig
} from "../../config/pcw-config.js";
import { resolveConfiguredPath } from "../../filesystem/paths.js";
import {
  isDocxSourcePath,
  readDocxFile
} from "../../readers/docx-reader.js";
import {
  isPdfSourcePath,
  readPdfFile
} from "../../readers/pdf-reader.js";
import {
  isTextSourcePath,
  readTextFile
} from "../../readers/text-reader.js";
import {
  discoverSources,
  resolveSourceFile
} from "../../sources/source-service.js";
import {
  contextNotConfiguredErrorResponse,
  logicalContextNotFoundErrorResponse,
  sourceListingErrorResponse,
  sourceReadErrorResponse,
  sourceTypeErrorResponse,
  withMcpErrorBoundary
} from "../error-mapper.js";
import { jsonResponse } from "../responses.js";

export function registerSourceTools(
  server: McpServer,
  contextRoot: string
): void {
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

    async ({ scope, name }) => withMcpErrorBoundary(async () => {
      const { config } = await loadPcwConfig(contextRoot);

      let logicalName: string | null = null;
      let configuredPath: string | null = null;

      if (scope === "shared") {
        const sharedConfig = getSharedContexts(config);

        const resolvedSharedContext = findSharedContext(config, name);
        logicalName = resolvedSharedContext?.name ?? null;

        if (!logicalName) {
          return logicalContextNotFoundErrorResponse(
            "shared",
            `Shared context '${name}' is not defined`,
            Object.keys(sharedConfig)
          );
        }

        configuredPath = resolvedSharedContext?.config.path ?? null;
      }

      if (scope === "workstream") {
        const workstreamsConfig = getWorkstreams(config);

        const resolvedWorkstream = findWorkstream(config, name);
        logicalName = resolvedWorkstream?.name ?? null;

        if (!logicalName) {
          return logicalContextNotFoundErrorResponse(
            "workstream",
            `Workstream '${name}' is not defined`,
            Object.keys(workstreamsConfig)
          );
        }

        configuredPath =
          resolvedWorkstream?.config.context?.path ?? null;

        if (!configuredPath) {
          return contextNotConfiguredErrorResponse(
            `Workstream '${logicalName}' has no specialized context configured`
          );
        }
      }

      if (!configuredPath) {
        return contextNotConfiguredErrorResponse(
          `No context path configured for '${name}'`
        );
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
      } catch (error) {
        return sourceListingErrorResponse(
          `Could not list sources for '${name}'`,
          absolutePath,
          error
        );
      }
    })
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

    async ({ scope, name, source }) => withMcpErrorBoundary(async () => {
      const { config } = await loadPcwConfig(contextRoot);

      let logicalName: string | null = null;
      let configuredPath: string | null = null;

      if (scope === "shared") {
        const sharedConfig = getSharedContexts(config);

        const resolvedSharedContext = findSharedContext(config, name);
        logicalName = resolvedSharedContext?.name ?? null;

        if (!logicalName) {
          return logicalContextNotFoundErrorResponse(
            "shared",
            `Shared context '${name}' is not defined`,
            Object.keys(sharedConfig)
          );
        }

        configuredPath = resolvedSharedContext?.config.path ?? null;
      }

      if (scope === "workstream") {
        const workstreamsConfig = getWorkstreams(config);

        const resolvedWorkstream = findWorkstream(config, name);
        logicalName = resolvedWorkstream?.name ?? null;

        if (!logicalName) {
          return logicalContextNotFoundErrorResponse(
            "workstream",
            `Workstream '${name}' is not defined`,
            Object.keys(workstreamsConfig)
          );
        }

        configuredPath =
          resolvedWorkstream?.config.context?.path ?? null;
      }

      if (!configuredPath) {
        return contextNotConfiguredErrorResponse(
          `No readable context path configured for '${name}'`
        );
      }

      if (!isTextSourcePath(source)) {
        return sourceTypeErrorResponse(
          "This tool only supports Markdown (.md) and plain-text (.txt) sources",
          source
        );
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
    })
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

    async ({ scope, name, source }) => withMcpErrorBoundary(async () => {
      const { config } = await loadPcwConfig(contextRoot);

      let logicalName: string | null = null;
      let configuredPath: string | null = null;

      if (scope === "shared") {
        const sharedConfig = getSharedContexts(config);

        const resolvedSharedContext = findSharedContext(config, name);
        logicalName = resolvedSharedContext?.name ?? null;

        if (!logicalName) {
          return logicalContextNotFoundErrorResponse(
            "shared",
            `Shared context '${name}' is not defined`,
            Object.keys(sharedConfig)
          );
        }

        configuredPath = resolvedSharedContext?.config.path ?? null;
      }

      if (scope === "workstream") {
        const workstreamsConfig = getWorkstreams(config);

        const resolvedWorkstream = findWorkstream(config, name);
        logicalName = resolvedWorkstream?.name ?? null;

        if (!logicalName) {
          return logicalContextNotFoundErrorResponse(
            "workstream",
            `Workstream '${name}' is not defined`,
            Object.keys(workstreamsConfig)
          );
        }

        configuredPath =
          resolvedWorkstream?.config.context?.path ?? null;
      }

      if (!configuredPath) {
        return contextNotConfiguredErrorResponse(
          `No context path configured for '${name}'`
        );
      }

      if (!isDocxSourcePath(source)) {
        return sourceTypeErrorResponse(
          "This tool only supports DOCX files",
          source
        );
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
    })
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

    async ({ scope, name, source }) => withMcpErrorBoundary(async () => {
      const { config } = await loadPcwConfig(contextRoot);

      let logicalName: string | null = null;
      let configuredPath: string | null = null;

      if (scope === "shared") {
        const sharedConfig = getSharedContexts(config);

        const resolvedSharedContext = findSharedContext(config, name);
        logicalName = resolvedSharedContext?.name ?? null;

        if (!logicalName) {
          return logicalContextNotFoundErrorResponse(
            "shared",
            `Shared context '${name}' is not defined`,
            Object.keys(sharedConfig)
          );
        }

        configuredPath = resolvedSharedContext?.config.path ?? null;
      }

      if (scope === "workstream") {
        const workstreamsConfig = getWorkstreams(config);

        const resolvedWorkstream = findWorkstream(config, name);
        logicalName = resolvedWorkstream?.name ?? null;

        if (!logicalName) {
          return logicalContextNotFoundErrorResponse(
            "workstream",
            `Workstream '${name}' is not defined`,
            Object.keys(workstreamsConfig)
          );
        }

        configuredPath =
          resolvedWorkstream?.config.context?.path ?? null;
      }

      if (!configuredPath) {
        return contextNotConfiguredErrorResponse(
          `No context path configured for '${name}'`
        );
      }

      if (!isPdfSourcePath(source)) {
        return sourceTypeErrorResponse(
          "This tool only supports PDF files",
          source
        );
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
    })
  );
}
