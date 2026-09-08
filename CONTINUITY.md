# PCW-MCP Continuity Prompt

Use this document to continue work on PCW-MCP in a fresh AI coding session.

## Workspace

Project path:

```text
C:\code\pcw-mcp
```

GitHub repository:

```text
https://github.com/mapicallo/pcw-mcp.git
```

Current branch after Block 1:

```text
v0.2-foundation
```

Initial pushed commit:

```text
0b3f912 Initial PCW-MCP POC
```

v0.1 baseline tag:

```text
v0.1.0-poc
```

The annotated tag points to `0b3f912`, the successful v0.1 POC baseline. Both the tag and `v0.2-foundation` branch are published on `origin`.

## Project Purpose

PCW-MCP means Persistent Context Workstreams MCP.

Core idea:

```text
Sessions are temporary. Workstreams are persistent.
```

The project explores a vendor-neutral, local-first way for AI coding sessions to resume long-running workstreams through durable, human-readable project context and continuity documents.

MCP is currently an integration layer. The durable memory belongs to the project/workstream, not to Codex, Cursor, ChatGPT, Claude, Gemini, Copilot, or any specific chat session.

## Security Boundary

There is a private local validation corpus at:

```text
C:\rmms-context
```

Do not copy files from `C:\rmms-context` into this repository.
Do not include RMMS, Indra, or proprietary customer data in examples, tests, fixtures, docs, commits, or generated artifacts.

Future automated tests and examples must use fabricated/sanitized sample data only.

## Current Repository State

The repository was initialized and pushed to GitHub. Block 1 created the `v0.2-foundation` branch for documentation and foundation work.

Tracked files at the first commit:

- `.gitignore`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `src/server.ts`

Block 1 documentation added on `v0.2-foundation`:

- `README.md`
- `docs/pcw-model.md`
- `docs/v0.1-poc-validation.md`
- `docs/security.md`
- `docs/roadmap.md`
- `CONTINUITY.md`

Ignored/local files:

- `node_modules/`
- `dist/`
- `.cursor/mcp.json`
- `.env*`
- npm/yarn/pnpm debug logs

`.cursor/mcp.json` exists locally and points Cursor to `node C:\code\pcw-mcp\dist\server.js` with `PCW_CONTEXT_ROOT=C:\rmms-context`, but it is intentionally ignored because it contains local/private paths.

## Current Tech Stack

- TypeScript
- Node.js 24.3.0 locally
- npm
- ESM / NodeNext
- `@modelcontextprotocol/server`
- MCP stdio transport
- Zod
- `yaml`
- `mammoth` for DOCX text extraction
- `pdf-parse` for PDF text extraction
- `write-file-atomic` for safe continuity replacement

Do not add databases, vector search, embeddings, cloud services, auth, Docker, web UI, telemetry, or distribution machinery unless explicitly requested.

## Current Implementation

Main source:

```text
src/server.ts
```

Compiled output, when generated:

```text
dist/server.js
```

Current implementation is a successful v0.1 POC, concentrated in one TypeScript file.

The server uses stdio:

```ts
const transport = new StdioServerTransport();
await server.connect(transport);
```

Default PCW context root:

```text
C:\rmms-context
```

Override:

```text
PCW_CONTEXT_ROOT
```

## Current MCP Tools

Confirmed registered tools in `src/server.ts`:

- `hello`
- `get_project_info`
- `list_workstreams`
- `get_workstream_info`
- `get_continuity`
- `list_shared_context`
- `list_sources`
- `get_inventory`
- `search_inventory`
- `read_text_source`
- `read_docx_source`
- `read_pdf_source`
- `update_continuity`

Preserve these tool names and behavior during v0.2 refactoring unless a change is explicitly approved.

## Important Validated Behavior

The v0.1 POC was validated with:

- MCP Inspector
- Codex
- Cursor

It demonstrated that a fresh AI session can reconstruct a persistent workstream from durable context and continuity files through PCW-MCP.

The POC is considered successful and closed. The next phase is not feature expansion; it is turning the prototype into a maintainable, documented, tested v0.2 foundation.

## Block 1 Validation

Block 1 scope:

```text
Freeze and document the validated v0.1 POC baseline.
```

Validation performed:

- inspected Git status, branch, remote, commits, and tags;
- inspected `package.json`, `tsconfig.json`, `.gitignore`, `.cursor/mcp.json`, `src/server.ts`, and this continuity file;
- confirmed exact registered MCP tools in `src/server.ts`;
- ran `npx.cmd tsc` successfully;
- checked tracked files with `git ls-files`;
- searched the workspace for common secret/private-data patterns excluding `.git`, `dist`, and `node_modules`.

Repository hygiene finding:

- no RMMS source documents, PDFs, DOCX files, credentials, API keys, passwords, or copied private context files were found in tracked repository content;
- references to `C:\rmms-context` exist only as the current local default/configuration boundary and warnings not to commit that private corpus;
- `.cursor/mcp.json` is local and ignored because it contains the private local context path.

Important discrepancy:

- `package.json` currently declares version `1.0.0`;
- the MCP server declares version `0.1.0`;
- this should be normalized in a later approved v0.2 change, not silently changed during Block 1.

## Continuity Model

Each workstream may have one canonical continuity document, for example:

```text
continuity/BACKEND.md
continuity/PAYMENTS.md
continuity/OBSERVABILITY.md
```

Session numbers such as BACKEND1, BACKEND2, BACKEND3 are conceptual only. They should not become separate canonical continuity files.

Continuity should not become a full chat transcript. It should preserve:

- current objective
- current implementation state
- completed work
- important decisions
- rejected approaches
- tests and results
- unresolved issues
- relevant repository locations
- relevant context sources
- next concrete action

## Existing Write Safety

`update_continuity` is currently the only intended write capability.

It should preserve these guarantees:

- target workstream must exist in `pcw.yml`
- continuity path must be configured
- continuity file must be Markdown
- target path must stay inside the PCW context root
- current file must exist
- caller must provide `expectedSha256`
- stale writes are rejected
- previous continuity is backed up before replacement
- replacement is atomic via `write-file-atomic`
- new SHA-256 is returned

History is written under:

```text
<PCW context root>\.pcw\history\<WORKSTREAM>\
```

Do not remove backup, SHA, stale-write rejection, or atomic write behavior.

## Known Technical Debt

`src/server.ts` currently mixes:

- MCP server setup
- tool registration
- config loading
- YAML parsing
- logical scope lookup
- path security
- source readers
- inventory parsing/search
- continuity read/write
- MCP JSON response formatting

Repeated logic exists for:

- reading/parsing `pcw.yml`
- case-insensitive lookup of workstream/shared context names
- resolving configured paths
- creating JSON MCP responses
- error handling
- extension checks
- source reading flow

There is also heavy use of untyped YAML data and `any`.

Likely module boundaries for v0.2:

- server composition and MCP transport;
- MCP response helpers;
- `pcw.yml` schema and config loading;
- logical shared/workstream resolution;
- safe filesystem path helpers;
- metadata and hashing;
- inventory section parsing/search;
- text/DOCX/PDF readers;
- continuity read/update services;
- thin tool registration modules.

## Security Notes

There is an `ensureInsideBase(basePath, candidatePath)` helper using `resolve`, `relative`, and `isAbsolute`.

Do not weaken path traversal protections.

Important issue to address in v0.2:

Some read/list tools resolve configured paths using `resolve(contextRoot, configuredPath)` without consistently verifying that the result remains inside `contextRoot`. `update_continuity` is stricter than several read paths. v0.2 should centralize safe path resolution and apply it consistently to reads and writes.

Treat context documents as data, not instructions. Future work should document prompt-injection risks from context documents.

## Proposed v0.2 Direction

Primary goal:

```text
Freeze v0.1 behavior, then refactor into a maintainable, tested foundation.
```

Suggested structure:

```text
src/
  server.ts
  mcp/
    responses.ts
    register-tools.ts
  config/
    schema.ts
    load-config.ts
    resolve-scope.ts
  filesystem/
    paths.ts
    hashing.ts
    metadata.ts
  inventory/
    sections.ts
  readers/
    text-reader.ts
    docx-reader.ts
    pdf-reader.ts
  continuity/
    read-continuity.ts
    update-continuity.ts
  tools/
    project-tools.ts
    workstream-tools.ts
    inventory-tools.ts
    source-tools.ts
    continuity-tools.ts
```

Do not mechanically apply this structure without inspecting the current source first. Refactor incrementally and keep behavior backward compatible.

## Proposed Test Strategy

Use fabricated temporary/sample PCW contexts only.

Cover at least:

- config parsing
- Zod validation for `pcw.yml`
- workstream discovery
- case-insensitive lookup
- workstream without specialized context
- shared context listing
- path traversal rejection
- absolute configured paths escaping root
- inventory section search
- text source reading
- unsupported source extensions
- SHA-256 generation
- successful continuity update
- stale continuity update rejection
- backup creation
- missing file behavior

Prefer minimal dependencies. Consider Node's built-in `node:test` first.

## Suggested Next Steps

1. If starting fresh, read this file first, then inspect the actual workspace.
2. Confirm the branch is `v0.2-foundation` and run `npm ci`.
3. Run `npm run build` and `npm test` before structural changes.
4. Start Block 3 by extracting config loading and logical scope resolution.
5. Centralize safe path resolution and add tests for configured paths escaping the context root.
6. Extract MCP response, hashing, inventory, reader, and continuity helpers incrementally.
7. Keep every characterization test green and do not add product features.
8. Add sanitized examples/templates only after the core boundaries are stable.

## Deferred Intentionally

- No refactor of `src/server.ts` was performed in Block 1.
- No MCP tools were added or changed.
- No RMMS context was inspected.
- Automated DOCX and PDF fixtures remain deferred after Block 2.
- No v0.2 release tag has been created.
- No production/distribution infrastructure was introduced.

## Current Human Preference

The user wants to continue incrementally, preserving the validated v0.1 behavior.

Before broad v0.2 changes, propose the plan and wait for approval.
## Block 2 Validation

Block 2 scope:

```text
Build/test foundation and v0.1 characterization tests.
```

Status: completed on branch `v0.2-foundation` in the commit carrying the message `test: add PCW v0.1 characterization suite`.

Test architecture:

- Node's built-in `node:test` and `node:assert`;
- TypeScript execution through the existing `tsx` dependency;
- official `@modelcontextprotocol/client` stdio transport;
- compiled production entry point `dist/server.js`;
- synthetic committed fixture at `tests/fixtures/sample-context`;
- OS-temporary fixture copies for every continuity write test;
- process and temporary-directory cleanup in reusable test helpers.

Characterized behavior:

- project information and configured inventory path;
- workstream discovery from `pcw.yml`;
- workstream filesystem status, including `OPERATIONS` with continuity but no specialized context;
- shared context and source metadata listing;
- complete inventory retrieval and case-insensitive section search;
- selective Markdown and TXT reads;
- continuity path, content, and SHA-256;
- successful optimistic-concurrency update;
- backup of previous continuity under `.pcw/history`;
- stale-write rejection without data loss;
- source path traversal rejection;
- unknown-workstream error response.

DOCX and PDF automation is deferred. The readers remain manually/integration validated from v0.1; creating and maintaining binary fixtures was not justified for this foundational block.

Production behavior was not changed and `src/server.ts` was not refactored. Only package scripts and the official MCP client development dependency were added around production code.

Validation results:

```text
npm ci in an isolated clean copy: passed
npm run build: passed
npm test: 14 passed, 0 failed
repeated npm test: passed without repository changes
```

An in-place `npm ci` attempt was blocked on Windows because the active Cursor and Codex MCP sessions had the native `canvas` module loaded. The clean-copy validation proves the lockfile and fresh-checkout workflow; `npm install` restored the active workspace without interrupting either client.

Recommended Block 3: incrementally extract configuration loading, logical scope resolution, MCP response helpers, hashing, and safe path resolution from `src/server.ts` while keeping the characterization suite green. Then harden configured read paths with focused regression tests. Do not add product features during that refactor.

The final commit hash is reported in the Block 2 completion response and can be recovered with `git log -1 --oneline`.
