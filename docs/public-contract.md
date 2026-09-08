# PCW v0.2 Public Contract Baseline

This document defines the externally observable contract of the PCW-MCP v0.2 development line. The current software version is `0.2.0-dev.0`; this is a SemVer prerelease, not a release or stability claim.

Detailed tool and configuration contracts live in [MCP tools](mcp-tools.md) and [pcw.yml](pcw-yml.md).

## Public And Internal Surfaces

The public contract currently includes:

- MCP server identity and version;
- `node dist/server.js` as the stdio entrypoint;
- `PCW_CONTEXT_ROOT` runtime selection;
- the 13 registered MCP tools, their descriptions, schemas, payloads, and error semantics;
- the accepted `pcw.yml` structure;
- continuity SHA-256 concurrency and replacement protocol;
- paths currently returned as `absolutePath` and `backupPath`.

Module paths, service classes, helper functions, source layout, temporary filenames, and internal error classes are implementation details unless explicitly documented otherwise.

## Identity And Versioning

The MCP server name is `pcw-mcp`. The package version in `package.json` is the single runtime source of the advertised MCP version. The current value is `0.2.0-dev.0`.

Software version and `pcw.yml` schema version are separate:

- software version identifies this server implementation;
- `pcw.yml.version` identifies a configuration format and currently remains optional, accepting a string or number.

No `v0.2.0` release or release tag exists yet.

## Runtime

The supported executable path remains:

```text
node dist/server.js
```

Stdio is the only implemented transport. `PCW_CONTEXT_ROOT` selects the context root. If the variable is absent, the current legacy development fallback is `C:\rmms-context`.

That machine-specific fallback is compatibility behavior, not a public example or suitable distribution default. Before private beta, the recommendation is to require `PCW_CONTEXT_ROOT` and fail clearly when it is missing. CLI arguments and context discovery require separate design and are not current features.

The declared Node engine is `>=22.9.0`. This satisfies the installed production dependencies' declared requirements and uses a supported LTS-generation baseline. The suite is currently verified on Node 24.3.0; Node 22.9.0 has not yet been exercised in CI.

## MCP Tools

The public baseline contains exactly these 13 tools:

`hello`, `get_project_info`, `list_workstreams`, `get_workstream_info`, `get_continuity`, `list_shared_context`, `list_sources`, `get_inventory`, `search_inventory`, `read_text_source`, `read_docx_source`, `read_pdf_source`, and `update_continuity`.

`update_continuity` is the only intended write operation. Every other tool is diagnostic, discovery, search, or read-only.

`hello` remains in this development baseline for compatibility. It duplicates MCP initialization as a health check, so the recommendation is to remove it before the first beta, with explicit owner approval and release notes. If shipped in a beta, it should then be treated as supported for that compatibility line.

## Response And Error Semantics

Successful structured results use one MCP text content item containing pretty-printed JSON. `hello` returns plain text. Expected operational failures set `isError: true`.

Current stable semantic error categories include:

- unknown workstream or shared context, with available names where currently supplied;
- continuity or inventory not configured;
- malformed or structurally invalid `pcw.yml`;
- unsafe or escaping paths;
- missing sources or non-file targets;
- unsupported reader or continuity extensions;
- inventory read/search failures;
- stale continuity updates;
- invalid continuity targets and update failures;
- sanitized unexpected failures.

Configuration loading errors currently use the SDK's plain-text MCP error response. They include a concise read, parse, or validation message and the configured `pcw.yml` path. Structural validation includes at most three bounded issue summaries. Stack traces, raw Zod objects, and file contents are not returned.

Other expected domain errors generally use JSON text payloads. Fields such as `available`, `availableWorkstreams`, `path`, `source`, and `details` remain category-specific. Clients should inspect `isError` before parsing the text payload.

Stale continuity errors preserve `error`, `workstream`, `expectedSha256`, `currentSha256`, and `action`. These fields form part of the concurrency protocol.

PCW currently has no machine-readable error codes. Before beta, the recommendation is to add a small stable code set for major client decisions, while preserving human-readable messages and existing fields. A broad taxonomy is not justified.

## Path Exposure

Several validated responses expose `absolutePath`; successful continuity updates also expose `backupPath`. This is current public behavior and remains unchanged for compatibility.

These fields reveal local filesystem topology. They are tolerable for the current local-only private-beta model but should be reviewed before any remote transport or broader public release. A future breaking contract should prefer configured relative paths or an explicit redaction policy.

## Continuity Update Protocol

The public write protocol is:

1. call `get_continuity`;
2. receive the complete content and its SHA-256;
3. prepare a complete replacement document;
4. call `update_continuity` with `expectedSha256`;
5. PCW compares it with the current SHA;
6. a stale value is rejected without backup or overwrite;
7. a current value causes the old content to be backed up;
8. PCW atomically replaces the canonical Markdown file;
9. the response returns previous and new SHA values plus backup metadata.

This is complete-document replacement, not a patch. PCW does not retry, merge, or resolve conflicts automatically.

## Compatibility Policy

PCW is pre-1.0, so interfaces may still evolve. Changes will not be made silently:

- patch releases fix defects while preserving documented contracts;
- minor/prerelease iterations may add tools, optional fields, or capabilities;
- removals, renamed fields, changed validation, changed error semantics, and incompatible `pcw.yml` changes require explicit documentation, migration guidance, and an intentional version decision;
- Git tags identify releases but are not runtime version sources.

## Current Non-Goals

The v0.2 foundation does not provide remote synchronization, distributed locking, HTTP/SSE MCP, authentication, vector search, embeddings, RAG, OCR, automatic conflict merging, continuity restore APIs, cloud accounts, or arbitrary filesystem writes.

## Distribution Metadata

`package.json` declares the package name, prerelease version, description, ESM mode, scripts, `dist/server.js` main entry, Node engine, and `ISC` license value. No standalone LICENSE file currently exists. The owner must confirm the intended license and add its text before external distribution. Package file allowlisting, author/repository metadata, packaging, and publication remain future work.
