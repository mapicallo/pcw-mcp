# PCW v0.2 Private Beta Contract

This document defines the externally observable contract of PCW-MCP `0.2.0-beta.1`. It is a private-beta release-candidate baseline, not a `1.0` stability claim and not a published release.

Detailed contracts live in [MCP tools](mcp-tools.md), [pcw.yml](pcw-yml.md), and the [private beta guide](private-beta.md).

## Public And Internal Surfaces

The public contract includes:

- MCP server identity `pcw-mcp` and package-derived version;
- `node dist/server.js` as the stdio entrypoint;
- `--context-root <path>` and `PCW_CONTEXT_ROOT` runtime selection;
- the 12 registered MCP tools, schemas, descriptions, success payloads, and documented error semantics;
- the accepted `pcw.yml` structure;
- continuity SHA-256 concurrency and complete-document replacement protocol;
- `absolutePath` and `backupPath` fields currently returned by local operations.

Source modules, service classes, helper functions, temporary filenames, and internal error classes are implementation details.

## Identity And Versioning

`package.json` is the single software-version source of truth. The MCP server and `--version` derive `0.2.0-beta.1` from it. Software version and `pcw.yml.version` are separate: the latter is an optional string or number under the current configuration contract.

No beta release tag or publication exists yet.

## Runtime

Run `node dist/server.js`. Stdio is the only transport. Context-root precedence is:

1. `--context-root <path>`;
2. `PCW_CONTEXT_ROOT`;
3. startup failure.

The root must exist, be a directory, and contain a `pcw.yml` file. The declared Node engine is `>=22.9.0`. CI is configured for Node 22 and 24; a Node version is considered verified only after its job succeeds.

## MCP Tools

The beta baseline contains exactly 12 tools:

`get_project_info`, `list_workstreams`, `get_workstream_info`, `get_continuity`, `list_shared_context`, `list_sources`, `get_inventory`, `search_inventory`, `read_text_source`, `read_docx_source`, `read_pdf_source`, and `update_continuity`.

The POC-only `hello` tool was intentionally removed before the beta freeze. MCP initialization and tool discovery provide protocol-level availability checks. `update_continuity` remains the only intended write operation.

## Responses And Errors

Successful structured results remain pretty-printed JSON in one MCP text content item. Expected failures set `isError: true` and return a JSON text payload containing:

- a stable `code` from the list below;
- the existing human-readable `error` message;
- existing category-specific fields such as `available`, `availableWorkstreams`, `path`, `source`, or `details`.

The frozen beta codes are:

- `PCW_CONFIG_INVALID`;
- `PCW_WORKSTREAM_NOT_FOUND`;
- `PCW_CONTEXT_NOT_CONFIGURED`;
- `PCW_PATH_UNSAFE`;
- `PCW_SOURCE_ERROR`;
- `PCW_INVENTORY_ERROR`;
- `PCW_CONTINUITY_NOT_CONFIGURED`;
- `PCW_CONTINUITY_INVALID`;
- `PCW_CONTINUITY_STALE`;
- `PCW_INTERNAL_ERROR`.

Codes describe client-relevant categories, not every internal failure. Unexpected exceptions use `PCW_INTERNAL_ERROR` with a sanitized message; stacks and arbitrary thrown objects are not returned. Configuration validation remains concise and bounded to at most three schema issue summaries.

A stale continuity payload preserves `workstream`, `expectedSha256`, `currentSha256`, and `action` in addition to `code: "PCW_CONTINUITY_STALE"` and the existing message.

## Path Exposure

`absolutePath` and `backupPath` remain part of the local `0.2` beta contract. They reveal local filesystem topology and must be reconsidered before remote MCP or shared-server deployment.

## Continuity Update Protocol

1. Call `get_continuity` and retain its SHA-256.
2. Prepare a complete replacement Markdown document.
3. Call `update_continuity` with `expectedSha256`.
4. PCW rejects a stale SHA without backup or overwrite.
5. For a current SHA, PCW backs up the previous content and atomically replaces it.
6. PCW returns previous/new SHA values and backup metadata.

This is complete-document replacement, not a patch or merge operation.

## Configuration Compatibility

The `pcw.yml` schema is unchanged for this beta. Dynamic logical names remain supported, physical paths remain user-defined, and continuity may be configured without specialized workstream context. Tightening the optional string-or-number `version` field requires a future explicit schema migration.

## Compatibility Policy

PCW is pre-1.0. Fixes should preserve this documented contract. Additive fields/tools may appear in later prereleases, but removals, renames, changed validation, error-code changes, and incompatible `pcw.yml` changes require an explicit version and migration note.

## Distribution Metadata And Blocker

The private package allowlists compiled output, public documentation, templates, and the synthetic sample context. Source, tests, fixtures, Git state, and project `CONTINUITY.md` are excluded. Repository metadata points to the credential-free Git origin. Author metadata remains unset because it has not been established.

The package still declares `ISC`, but no `LICENSE` file exists and the owner has not confirmed licensing terms. External handoff remains blocked until the owner makes that decision. Nothing in this baseline publishes the package or creates a release tag.
