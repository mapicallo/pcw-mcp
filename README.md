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

This project is not production-ready. The current software version is `0.2.0-dev.0`; v0.2 work is defining and validating a maintainable public-contract foundation before private beta.

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

The tests start the compiled MCP stdio server through the official MCP client. They use only the synthetic context under `tests/fixtures/sample-context` and disposable copies in the operating system temporary directory. They do not require or inspect the private RMMS context.

## Source retrieval

PCW keeps retrieval selective and on demand:

1. consult the relevant workstream continuity;
2. search the semantic inventory;
3. identify a logical section and list its sources;
4. read only the selected documents.

Supported readers are Markdown/plain text (`.md` and `.txt`), DOCX, and PDF. DOCX extraction is text-oriented. PDF extraction supports selectable text; OCR and image extraction are not supported, so image-only PDFs may return little or no text. Readers operate locally and every source remains constrained by the PCW filesystem boundary.

The automated suite includes fully synthetic DOCX and PDF fixtures. No private context is required.
