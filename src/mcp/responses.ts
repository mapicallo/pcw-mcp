import type { CallToolResult } from "@modelcontextprotocol/server";

import type { PcwErrorCode } from "./error-codes.js";

export function textResponse(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }]
  };
}

export function jsonResponse(value: unknown): CallToolResult {
  const serialized = JSON.stringify(value, null, 2);

  if (serialized === undefined) {
    throw new TypeError("MCP JSON response payload is not serializable");
  }

  return textResponse(serialized);
}

export function jsonErrorResponse(value: unknown): CallToolResult {
  return {
    ...jsonResponse(value),
    isError: true
  };
}

export function codedErrorResponse(
  code: PcwErrorCode,
  payload: { error: string } & Record<string, unknown>
): CallToolResult {
  return jsonErrorResponse({ ...payload, code });
}
