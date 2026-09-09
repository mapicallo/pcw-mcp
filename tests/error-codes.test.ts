import assert from "node:assert/strict";
import test from "node:test";

import { PcwConfigError } from "../src/config/pcw-config.js";
import {
  ContinuityStaleWriteError,
  ContinuityWorkstreamNotFoundError
} from "../src/continuity/continuity-service.js";
import { PcwPathError } from "../src/filesystem/paths.js";
import { PCW_ERROR_CODES } from "../src/mcp/error-codes.js";
import {
  continuityUpdateErrorResponse,
  unexpectedErrorResponse
} from "../src/mcp/error-mapper.js";
import { jsonResponse } from "../src/mcp/responses.js";

function payload(response: ReturnType<typeof unexpectedErrorResponse>) {
  const item = response.content[0];
  assert.equal(item.type, "text");
  return JSON.parse(item.text) as Record<string, unknown>;
}

test("public PCW error codes are unique and frozen", () => {
  const codes = Object.values(PCW_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(codes.sort(), [
    "PCW_CONFIG_INVALID",
    "PCW_CONTEXT_NOT_CONFIGURED",
    "PCW_CONTINUITY_INVALID",
    "PCW_CONTINUITY_NOT_CONFIGURED",
    "PCW_CONTINUITY_STALE",
    "PCW_INTERNAL_ERROR",
    "PCW_INVENTORY_ERROR",
    "PCW_PATH_UNSAFE",
    "PCW_SOURCE_ERROR",
    "PCW_WORKSTREAM_NOT_FOUND"
  ].sort());
});

test("stale continuity code preserves the complete concurrency payload", () => {
  const response = continuityUpdateErrorResponse(
    new ContinuityStaleWriteError("BACKEND", "a".repeat(64), "b".repeat(64)),
    "BACKEND"
  );
  const result = payload(response);

  assert.equal(result.code, PCW_ERROR_CODES.CONTINUITY_STALE);
  assert.equal(result.error, "Continuity has changed since it was read");
  assert.equal(result.workstream, "BACKEND");
  assert.equal(result.expectedSha256, "a".repeat(64));
  assert.equal(result.currentSha256, "b".repeat(64));
  assert.match(String(result.action), /get_continuity again/);
});

test("unknown workstream code preserves available workstreams", () => {
  const response = continuityUpdateErrorResponse(
    new ContinuityWorkstreamNotFoundError("MISSING", ["BACKEND"]),
    "MISSING"
  );
  const result = payload(response);

  assert.equal(result.code, PCW_ERROR_CODES.WORKSTREAM_NOT_FOUND);
  assert.deepEqual(result.availableWorkstreams, ["BACKEND"]);
  assert.equal(result.error, "Workstream 'MISSING' is not defined");
});

test("configuration errors map to a concise stable code", () => {
  const result = payload(unexpectedErrorResponse(
    new PcwConfigError("Invalid synthetic PCW configuration")
  ));

  assert.deepEqual(result, {
    code: PCW_ERROR_CODES.CONFIG_INVALID,
    error: "Invalid synthetic PCW configuration"
  });
});

test("unsafe paths map to a stable code", () => {
  const result = payload(unexpectedErrorResponse(new PcwPathError()));
  assert.equal(result.code, PCW_ERROR_CODES.PATH_UNSAFE);
  assert.match(String(result.error), /escapes the configured PCW context root/);
});

test("unexpected errors are sanitized and do not expose stacks", () => {
  const error = new Error("Sensitive internal detail");
  error.stack = "Sensitive internal detail\nprivate stack location";
  const serialized = JSON.stringify(payload(unexpectedErrorResponse(error)));

  assert.deepEqual(JSON.parse(serialized), {
    code: PCW_ERROR_CODES.INTERNAL_ERROR,
    error: "Unexpected PCW error"
  });
  assert.doesNotMatch(serialized, /Sensitive|private stack/);
});

test("error codes do not alter successful responses", () => {
  const result = payload(jsonResponse({ status: "ok" }));
  assert.deepEqual(result, { status: "ok" });
  assert.equal("code" in result, false);
});
