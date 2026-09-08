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

This project is not production-ready. The current v0.2 work is focused on freezing the validated baseline, documenting the model, adding automated tests, and refactoring the prototype into a maintainable foundation.

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

- [PCW model](docs/pcw-model.md)
- [v0.1 POC validation](docs/v0.1-poc-validation.md)
- [Security notes](docs/security.md)
- [Roadmap](docs/roadmap.md)
