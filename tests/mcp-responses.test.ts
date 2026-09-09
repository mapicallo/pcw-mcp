import assert from "node:assert/strict";
import test from "node:test";

import {
  ContinuityStaleWriteError,
  ContinuityWorkstreamNotFoundError
} from "../src/continuity/continuity-service.js";
import {
  continuityUpdateErrorResponse,
  safeErrorDetails,
  sourceReadErrorResponse
} from "../src/mcp/error-mapper.js";
import {
  jsonErrorResponse,
  jsonResponse,
  textResponse
} from "../src/mcp/responses.js";

function responseText(response: ReturnType<typeof textResponse>): string {
  const content = response.content[0];
  assert.equal(content.type, "text");
  return content.text;
}

test("JSON success response uses the current MCP envelope and formatting", () => {
  const response = jsonResponse({ status: "ok", count: 2 });

  assert.equal(response.isError, undefined);
  assert.deepEqual(response.content, [{
    type: "text",
    text: '{\n  "status": "ok",\n  "count": 2\n}'
  }]);
});

test("text response preserves text exactly", () => {
  const text = "Synthetic text\nwith spacing.\n";
  assert.equal(responseText(textResponse(text)), text);
});

test("JSON error response sets isError and preserves its payload", () => {
  const response = jsonErrorResponse({ error: "Synthetic failure", value: 7 });

  assert.equal(response.isError, true);
  assert.deepEqual(JSON.parse(responseText(response)), {
    error: "Synthetic failure",
    value: 7
  });
});

test("known workstream error preserves available workstreams", () => {
  const response = continuityUpdateErrorResponse(
    new ContinuityWorkstreamNotFoundError("MISSING", ["BACKEND"]),
    "MISSING"
  );

  assert.deepEqual(JSON.parse(responseText(response)), {
    code: "PCW_WORKSTREAM_NOT_FOUND",
    error: "Workstream 'MISSING' is not defined",
    availableWorkstreams: ["BACKEND"]
  });
});

test("stale continuity error preserves all concurrency fields", () => {
  const response = continuityUpdateErrorResponse(
    new ContinuityStaleWriteError("BACKEND", "a".repeat(64), "b".repeat(64)),
    "BACKEND"
  );
  const payload = JSON.parse(responseText(response));

  assert.deepEqual(payload, {
    code: "PCW_CONTINUITY_STALE",
    error: "Continuity has changed since it was read",
    workstream: "BACKEND",
    expectedSha256: "a".repeat(64),
    currentSha256: "b".repeat(64),
    action: "Call get_continuity again, reconcile the newer state, and retry."
  });
});

test("non-Error thrown values use a safe fallback", () => {
  const response = sourceReadErrorResponse(
    "Could not read source 'sample.md'",
    { secret: "must not be serialized" }
  );
  const payload = JSON.parse(responseText(response));

  assert.equal(payload.details, "Unexpected PCW error");
  assert.doesNotMatch(responseText(response), /must not be serialized/);
});

test("stack traces are not returned", () => {
  const error = new Error("Synthetic message");
  error.stack = "Synthetic message\nprivate stack location";

  const response = sourceReadErrorResponse(
    "Could not read source 'sample.md'",
    error
  );
  assert.doesNotMatch(responseText(response), /private stack location/);
});

test("unusual Error messages remain valid JSON text", () => {
  const message = 'Nested "message"\nwith a second line';
  const response = sourceReadErrorResponse(
    "Could not read source 'sample.md'",
    new Error(message)
  );

  assert.equal(JSON.parse(responseText(response)).details, message);
});

test("safe error details never serializes arbitrary objects", () => {
  assert.equal(
    safeErrorDetails({ token: "synthetic-secret" }),
    "Unexpected PCW error"
  );
});
