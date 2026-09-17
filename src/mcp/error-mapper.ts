import type { CallToolResult } from "@modelcontextprotocol/server";

import { PcwConfigError } from "../config/pcw-config.js";
import { PcwConfigStaleError } from "../config/config-mutation.js";
import {
  ContextCreateConflictError,
  ContextWorkstreamNotFoundError,
  SharedContextAlreadyExistsError,
  SharedContextNameInvalidError,
  WorkstreamContextAlreadyConfiguredError
} from "../contexts/context-service.js";
import {
  ContinuityNotConfiguredError,
  ContinuityNotMarkdownError,
  ContinuityReadError,
  ContinuityStaleWriteError,
  ContinuityUpdateError,
  ContinuityWorkstreamNotFoundError
} from "../continuity/continuity-service.js";
import { PcwPathError } from "../filesystem/paths.js";
import {
  InventoryNotFileError,
  InventoryStaleWriteError,
  InventoryUpdateError
} from "../inventory/inventory-service.js";
import {
  WorkstreamAlreadyExistsError,
  WorkstreamCreateConflictError,
  WorkstreamNameInvalidError
} from "../workstreams/workstream-service.js";
import { PCW_ERROR_CODES } from "./error-codes.js";
import { codedErrorResponse } from "./responses.js";

const UNEXPECTED_ERROR_DETAILS = "Unexpected PCW error";

function errorChainIncludes(
  error: unknown,
  predicate: (candidate: Error) => boolean
): boolean {
  const visited = new Set<Error>();
  let candidate = error;

  while (candidate instanceof Error && !visited.has(candidate)) {
    if (predicate(candidate)) {
      return true;
    }
    visited.add(candidate);
    candidate = candidate.cause;
  }

  return false;
}

function isUnsafePathError(error: unknown): boolean {
  return errorChainIncludes(error, (candidate) => candidate instanceof PcwPathError);
}


export function safeErrorDetails(error: unknown): string {
  if (error instanceof PcwPathError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return UNEXPECTED_ERROR_DETAILS;
}

export function unexpectedErrorResponse(error: unknown): CallToolResult {
  if (error instanceof PcwConfigError) {
    return codedErrorResponse(PCW_ERROR_CODES.CONFIG_INVALID, {
      error: error.message
    });
  }

  if (isUnsafePathError(error)) {
    return codedErrorResponse(PCW_ERROR_CODES.PATH_UNSAFE, {
      error: safeErrorDetails(error)
    });
  }

  if (error instanceof WorkstreamNameInvalidError) {
    return codedErrorResponse(PCW_ERROR_CODES.WORKSTREAM_NAME_INVALID, {
      error: error.message,
      name: error.requestedName,
      rule: error.rule
    });
  }

  if (error instanceof WorkstreamAlreadyExistsError) {
    return codedErrorResponse(PCW_ERROR_CODES.WORKSTREAM_ALREADY_EXISTS, {
      error: error.message,
      name: error.requestedName,
      existingWorkstream: error.existingWorkstream
    });
  }

  if (error instanceof PcwConfigStaleError) {
    return codedErrorResponse(PCW_ERROR_CODES.CONFIG_STALE, {
      error: error.message,
      expectedSha256: error.expectedSha256,
      currentSha256: error.currentSha256,
      action: error.action
    });
  }

  if (error instanceof WorkstreamCreateConflictError) {
    return codedErrorResponse(PCW_ERROR_CODES.WORKSTREAM_CREATE_CONFLICT, {
      error: error.message,
      workstream: error.requestedName,
      ...(error.path ? { path: error.path } : {}),
      ...(error.rollbackFailures.length > 0
        ? { rollbackFailures: error.rollbackFailures }
        : {})
    });
  }

  if (error instanceof SharedContextNameInvalidError) {
    return codedErrorResponse(PCW_ERROR_CODES.SHARED_CONTEXT_NAME_INVALID, {
      error: error.message,
      name: error.requestedName,
      rule: error.rule
    });
  }

  if (error instanceof SharedContextAlreadyExistsError) {
    return codedErrorResponse(PCW_ERROR_CODES.SHARED_CONTEXT_ALREADY_EXISTS, {
      error: error.message,
      name: error.requestedName,
      existingContext: error.existingContext
    });
  }

  if (error instanceof WorkstreamContextAlreadyConfiguredError) {
    return codedErrorResponse(
      PCW_ERROR_CODES.WORKSTREAM_CONTEXT_ALREADY_CONFIGURED,
      {
        error: error.message,
        workstream: error.workstream,
        path: error.contextPath
      }
    );
  }

  if (error instanceof ContextWorkstreamNotFoundError) {
    return codedErrorResponse(PCW_ERROR_CODES.WORKSTREAM_NOT_FOUND, {
      error: error.message,
      availableWorkstreams: error.availableWorkstreams
    });
  }

  if (error instanceof ContextCreateConflictError) {
    return codedErrorResponse(PCW_ERROR_CODES.CONTEXT_CREATE_CONFLICT, {
      error: error.message,
      name: error.requestedName,
      ...(error.path ? { path: error.path } : {}),
      ...(error.rollbackFailures.length > 0
        ? { rollbackFailures: error.rollbackFailures }
        : {})
    });
  }

  return codedErrorResponse(PCW_ERROR_CODES.INTERNAL_ERROR, {
    error: UNEXPECTED_ERROR_DETAILS
  });
}

export async function withMcpErrorBoundary(
  operation: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return unexpectedErrorResponse(error);
  }
}

export function logicalContextNotFoundErrorResponse(
  kind: "shared" | "workstream",
  message: string,
  available: string[]
): CallToolResult {
  const code = kind === "workstream"
    ? PCW_ERROR_CODES.WORKSTREAM_NOT_FOUND
    : PCW_ERROR_CODES.CONTEXT_NOT_CONFIGURED;
  return codedErrorResponse(code, { error: message, available });
}

export function contextNotConfiguredErrorResponse(
  message: string
): CallToolResult {
  return codedErrorResponse(PCW_ERROR_CODES.CONTEXT_NOT_CONFIGURED, {
    error: message
  });
}

export function sourceTypeErrorResponse(
  message: string,
  source: string
): CallToolResult {
  return codedErrorResponse(PCW_ERROR_CODES.SOURCE_ERROR, {
    error: message,
    source
  });
}

export function sourceListingErrorResponse(
  publicMessage: string,
  absolutePath: string,
  error: unknown
): CallToolResult {
  const code = isUnsafePathError(error)
    ? PCW_ERROR_CODES.PATH_UNSAFE
    : PCW_ERROR_CODES.SOURCE_ERROR;

  return codedErrorResponse(code, {
    error: publicMessage,
    path: absolutePath
  });
}

export function sourceReadErrorResponse(
  publicMessage: string,
  error: unknown
): CallToolResult {
  const code = isUnsafePathError(error)
    ? PCW_ERROR_CODES.PATH_UNSAFE
    : PCW_ERROR_CODES.SOURCE_ERROR;

  return codedErrorResponse(code, {
    error: publicMessage,
    details: safeErrorDetails(error)
  });
}

export function inventoryReadErrorResponse(
  error: unknown,
  absolutePath: string
): CallToolResult {
  const code = isUnsafePathError(error)
    ? PCW_ERROR_CODES.PATH_UNSAFE
    : PCW_ERROR_CODES.INVENTORY_ERROR;

  return codedErrorResponse(code, {
    error: error instanceof InventoryNotFileError
      ? "Configured inventory path is not a file"
      : "Could not read the configured inventory document",
    path: absolutePath
  });
}

export function inventorySearchErrorResponse(
  error: unknown,
  absolutePath: string
): CallToolResult {
  const code = isUnsafePathError(error)
    ? PCW_ERROR_CODES.PATH_UNSAFE
    : PCW_ERROR_CODES.INVENTORY_ERROR;

  return codedErrorResponse(code, {
    error: "Could not search the configured inventory",
    path: absolutePath
  });
}

export function inventoryUpdateErrorResponse(
  error: unknown,
  absolutePath: string
): CallToolResult {
  if (error instanceof InventoryStaleWriteError) {
    return codedErrorResponse(PCW_ERROR_CODES.INVENTORY_STALE, {
      error: error.message,
      expectedSha256: error.expectedSha256,
      currentSha256: error.currentSha256,
      action: "Call get_inventory again, reconcile the newer inventory, and retry."
    });
  }

  const code = isUnsafePathError(error)
    ? PCW_ERROR_CODES.PATH_UNSAFE
    : PCW_ERROR_CODES.INVENTORY_ERROR;
  return codedErrorResponse(code, {
    error: "Could not update the configured inventory",
    path: absolutePath,
    ...(error instanceof InventoryUpdateError
      ? { details: error.details }
      : {})
  });
}
export function continuityReadErrorResponse(
  error: unknown,
  requestedWorkstream: string
): CallToolResult {
  if (error instanceof ContinuityWorkstreamNotFoundError) {
    return codedErrorResponse(PCW_ERROR_CODES.WORKSTREAM_NOT_FOUND, {
      error: error.message,
      availableWorkstreams: error.availableWorkstreams
    });
  }

  if (error instanceof ContinuityNotConfiguredError) {
    return codedErrorResponse(PCW_ERROR_CODES.CONTINUITY_NOT_CONFIGURED, {
      error: error.message
    });
  }

  const workstream = error instanceof ContinuityReadError
    ? error.workstream
    : requestedWorkstream;
  const path = error instanceof ContinuityReadError
    ? error.absolutePath ?? error.configuredPath
    : null;
  const code = isUnsafePathError(error)
    ? PCW_ERROR_CODES.PATH_UNSAFE
    : PCW_ERROR_CODES.CONTINUITY_INVALID;

  return codedErrorResponse(code, {
    error: `Could not read continuity document for '${workstream}'`,
    path
  });
}

export function continuityUpdateErrorResponse(
  error: unknown,
  requestedWorkstream: string
): CallToolResult {
  if (error instanceof ContinuityWorkstreamNotFoundError) {
    return codedErrorResponse(PCW_ERROR_CODES.WORKSTREAM_NOT_FOUND, {
      error: error.message,
      availableWorkstreams: error.availableWorkstreams
    });
  }

  if (error instanceof ContinuityNotConfiguredError) {
    return codedErrorResponse(PCW_ERROR_CODES.CONTINUITY_NOT_CONFIGURED, {
      error: error.message
    });
  }

  if (error instanceof ContinuityNotMarkdownError) {
    return codedErrorResponse(PCW_ERROR_CODES.CONTINUITY_INVALID, {
      error: error.message,
      path: error.configuredPath
    });
  }

  if (error instanceof ContinuityStaleWriteError) {
    return codedErrorResponse(PCW_ERROR_CODES.CONTINUITY_STALE, {
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
  const code = isUnsafePathError(error)
    ? PCW_ERROR_CODES.PATH_UNSAFE
    : PCW_ERROR_CODES.CONTINUITY_INVALID;

  return codedErrorResponse(code, {
    error: `Could not update continuity for '${workstream}'`,
    details
  });
}
