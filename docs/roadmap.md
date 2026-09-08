# Roadmap

## v0.1: Functional POC

Status: Done.

Validated:

- local stdio MCP server;
- shared and workstream context;
- semantic inventory;
- selective source retrieval;
- continuity versioning;
- controlled continuity writes;
- history backup;
- optimistic concurrency;
- Codex and Cursor reconstruction from the same persistent context.

## v0.2: Foundation

Planned:

- freeze and document v0.1 behavior;
- modularize `src/server.ts`;
- define typed `pcw.yml` model;
- add explicit configuration validation;
- add automated tests with synthetic fixtures;
- reduce duplicated logic;
- centralize safe path resolution;
- formalize current MCP tool behavior;
- prepare documentation and examples for future distribution.

## Later

Possible later work, not yet committed:

- CLI;
- private beta packaging;
- provider/client adapters;
- MCP resources and prompts;
- richer indexing;
- possible semantic retrieval;
- optional installer;
- MCP Registry or public publication.

No cloud architecture is currently planned or required.
