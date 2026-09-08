import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  ContinuityNotConfiguredError,
  ContinuityNotMarkdownError,
  ContinuityReadError,
  ContinuityStaleWriteError,
  ContinuityUpdateError,
  ContinuityWorkstreamNotFoundError
} from "../continuity/continuity-service.js";
import { PcwPathError } from "../filesystem/paths.js";
import { InventoryNotFileError } from "../inventory/inventory-service.js";
import { jsonErrorResponse } from "./responses.js";

const UNEXPECTED_ERROR_DETAILS = "Unexpected PCW error";

export function safeErrorDetails(error: unknown): string {
  if (error instanceof PcwPathError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return UNEXPECTED_ERROR_DETAILS;
}

export function sourceReadErrorResponse(
  publicMessage: string,
  error: unknown
): CallToolResult {
  return jsonErrorResponse({
    error: publicMessage,
    details: safeErrorDetails(error)
  });
}

export function inventoryReadErrorResponse(
  error: unknown,
  absolutePath: string
): CallToolResult {
  return jsonErrorResponse({
    error: error instanceof InventoryNotFileError
      ? "Configured inventory path is not a file"
      : "Could not read the configured inventory document",
    path: absolutePath
  });
}

export function continuityReadErrorResponse(
  error: unknown,
  requestedWorkstream: string
): CallToolResult {
  if (error instanceof ContinuityWorkstreamNotFoundError) {
    return jsonErrorResponse({
      error: error.message,
      availableWorkstreams: error.availableWorkstreams
    });
  }

  if (error instanceof ContinuityNotConfiguredError) {
    return jsonErrorResponse({ error: error.message });
  }

  const workstream = error instanceof ContinuityReadError
    ? error.workstream
    : requestedWorkstream;
  const path = error instanceof ContinuityReadError
    ? error.absolutePath ?? error.configuredPath
    : null;

  return jsonErrorResponse({
    error: `Could not read continuity document for '${workstream}'`,
    path
  });
}

export function continuityUpdateErrorResponse(
  error: unknown,
  requestedWorkstream: string
): CallToolResult {
  if (error instanceof ContinuityWorkstreamNotFoundError) {
    return jsonErrorResponse({
      error: error.message,
      availableWorkstreams: error.availableWorkstreams
    });
  }

  if (error instanceof ContinuityNotConfiguredError) {
    return jsonErrorResponse({ error: error.message });
  }

  if (error instanceof ContinuityNotMarkdownError) {
    return jsonErrorResponse({
      error: error.message,
      path: error.configuredPath
    });
  }

  if (error instanceof ContinuityStaleWriteError) {
    return jsonErrorResponse({
      error: error.message,
      workstream: error.workstream,
      expectedSha256: error.expectedSha256,
      currentSha256: error.currentSha256,
      action: "Call get_continuity again, reconcile the newer state, and retry."
    });
  }

  const workstream = error instanceof ContinuityUpdateError
    ? error.workstream
    : requestedWorkstream;
  const details = error instanceof ContinuityUpdateError
    ? error.details
    : safeErrorDetails(error);

  return jsonErrorResponse({
    error: `Could not update continuity for '${workstream}'`,
    details
  });
}
