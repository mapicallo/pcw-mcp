# PCW-MCP

PCW-MCP is a proof-of-concept MCP server for PCW: Persistent Context Workstreams.

Its central principle is:

```text
Sessions are temporary. Workstreams are persistent.
```

PCW addresses the finite context window and temporary nature of AI coding sessions by keeping project knowledge and workstream state outside any single chat. Durable context is stored in human-readable files owned by the project. AI sessions can then resume work by reading the relevant shared context, workstream context, inventory, and continuity document.

PCW is intended to be vendor/provider neutral. The persistent state does not belong to Codex, Cursor, ChatGPT, Claude, Gemini, Copilot, MCP, or any specific chat. MCP is currently one integration layer for accessing the PCW model.

## Status

PCW-MCP v0.1 is a validated functional POC. It has demonstrated local stdio MCP access, selective persistent context retrieval, continuity versioning, controlled continuity writes, history backup, and optimistic concurrency.

This project is not production-ready. The current software version is `0.2.0-dev.2`; v0.2 work is validating a local private-beta candidate and its public onboarding context.

## Current Stack

- TypeScript
- Node.js
- MCP stdio transport
- `@modelcontextprotocol/server`
- Zod
- `yaml`
- `mammoth`
- `pdf-parse`
- `write-file-atomic`

The POC is local-first and does not require a backend, account, database, cloud service, vector store, or embeddings.

## Documentation

- [Public contract baseline](docs/public-contract.md)
- [Private beta guide](docs/private-beta.md)
- [Local runtime and distribution](docs/runtime.md)
- [MCP tool contract](docs/mcp-tools.md)
- [pcw.yml contract](docs/pcw-yml.md)
- [PCW model](docs/pcw-model.md)
- [v0.1 POC validation](docs/v0.1-poc-validation.md)
- [Security notes](docs/security.md)
- [Roadmap](docs/roadmap.md)

## Build and test

Install dependencies from the lockfile and compile the MCP server:

```text
npm ci
npm run build
```

Run the automated characterization suite:

```text
npm test
```

Run the slower clean-install smoke test, which packs and installs PCW entirely under the operating system temporary directory:

```text
npm run test:package-install
```

The tests start the compiled MCP stdio server through the official MCP client. They use only synthetic contexts and disposable copies in the operating system temporary directory; no private context is required.

## Quick Start: Private Beta

1. Build or obtain the local PCW-MCP package.
2. Copy `examples/sample-context` to a user-owned context directory, or start from `templates/`.
3. Set `PCW_CONTEXT_ROOT=<path>` or pass `--context-root <path>`.
4. Start `node dist/server.js` and configure it as a stdio MCP server.
5. Ask: `Use PCW to list the available workstreams.`
6. Continue with: `Use PCW to continue the BACKEND workstream. Reconstruct its current state before modifying anything.`
7. Before ending the session, read the latest continuity SHA and use `update_continuity` to replace the complete checkpoint.

The sample is a fictional Example Taskboard context. `BACKEND` has specialized context and continuity; `OPERATIONS` has continuity only. The semantic inventory demonstrates how to search first and read only relevant sources. See the [private beta guide](docs/private-beta.md) for generic Codex and Cursor configurations and current limitations.

## Local runtime

Build first, then select a context root explicitly. The CLI value takes precedence over the environment:

```text
PCW_CONTEXT_ROOT=<path> node dist/server.js
node dist/server.js --context-root <path>
```

On PowerShell, the environment form is:

```powershell
$env:PCW_CONTEXT_ROOT = "C:\Contexts\sample-project"
node dist/server.js
```

If neither source supplies a non-empty root, startup fails. The selected root must exist, be a directory, and contain a `pcw.yml` file. Use `node dist/server.js --help` for usage or `--version` for the package/MCP version.

Stdio is the only implemented MCP transport. Normal runtime stdout is reserved exclusively for MCP protocol messages. See [local runtime and client configuration](docs/runtime.md) for generic Codex and Cursor examples.

## Source retrieval

PCW keeps retrieval selective and on demand:

1. consult the relevant workstream continuity;
2. search the semantic inventory;
3. identify a logical section and list its sources;
4. read only the selected documents.

Supported readers are Markdown/plain text (`.md` and `.txt`), DOCX, and PDF. DOCX extraction is text-oriented. PDF extraction supports selectable text; OCR and image extraction are not supported, so image-only PDFs may return little or no text. Readers operate locally and every source remains constrained by the PCW filesystem boundary.

The automated suite includes fully synthetic DOCX and PDF fixtures. No private context is required.
