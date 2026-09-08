# PCW Model

PCW means Persistent Context Workstreams.

The model separates durable project knowledge from disposable AI sessions. A session can end, lose context, or be replaced by another client, while the workstream remains recoverable through files owned by the project.

## Core Components

PCW is built from these concepts:

- Shared Context: durable context that applies across workstreams.
- Specialized Workstream Context: durable context relevant to one workstream.
- Continuity: the current state checkpoint for a workstream.
- Inventory: a semantic map of available sources.
- Physical Sources: Markdown, text, DOCX, PDF, or other project documents.
- Disposable AI Sessions: Codex, Cursor, or other clients that read selected PCW context through an adapter.

## Logical Structure And Physical Structure

PCW does not require a mandatory folder hierarchy.

The physical layout belongs to the user or project. The logical PCW model is described by `pcw.yml`.

For example, one project might have:

```text
docs/
decisions/
observability/
backend/
```

Another might have:

```text
GENERAL/
PAYMENTS/
KAFKA/
runbooks/
```

Both can represent the same PCW concepts if `pcw.yml` maps those physical folders into shared context, workstream context, continuity, and inventory.


## Runtime Configuration Contract

The external `pcw.yml` document is loaded through one typed configuration boundary and validated with Zod on every MCP tool call. It is intentionally not cached, so edits become visible without restarting the server.

The current compatible contract accepts optional project metadata, inventory, shared-context maps, and workstream maps. When present, project identifiers and names must be strings, version must be a string or number, and configured paths must be non-empty strings. Workstream context and continuity are independently optional.

Shared-context and workstream keys remain dynamic logical names. Lookups are case-insensitive while responses preserve the canonical configured spelling. Paths continue to define user-owned physical locations; PCW does not infer folders from logical names.

## Workstreams

A workstream represents persistent task/domain state. Examples using fictional names:

- `BACKEND`
- `OBSERVABILITY`
- `PAYMENTS`
- `KAFKA`

A workstream may have specialized context, but it does not have to. Some workstreams can be resumed from shared context plus continuity only.

## Canonical Continuity

Continuity is the durable checkpoint for a workstream. Session numbers are conceptual, not separate canonical files.

For example:

```text
PAYMENTS1 -> PAYMENTS2 -> PAYMENTS3
```

all update the same logical continuity file:

```text
continuity/PAYMENTS.md
```

Continuity should not become a full transcript. It should capture only what a future session needs to resume work: current objective, completed work, decisions, rejected approaches, tests, unresolved issues, relevant sources, and next actions.

Each configured workstream has at most one canonical continuity document. PCW reads it as UTF-8 text and identifies its current version with a SHA-256 hash. An update must present the previously read hash; a stale hash is rejected without changing the document. Successful updates first preserve the replaced content under `.pcw/history/<WORKSTREAM>/` and then atomically replace the canonical file. PCW does not automatically merge conflicting updates.

## MCP Adapter Boundary

PCW configuration and domain services return typed results or throw typed operational errors without constructing MCP responses. The MCP adapter translates those values into the established text-content envelopes. Domain-oriented modules under `src/mcp/tools/` retain explicit tool registrations and input schemas, while `src/server.ts` composes those modules and starts the stdio transport.

This keeps the durable PCW model independent from its current transport representation: MCP is an interface to PCW, not PCW itself.

## Selective Retrieval

The full durable context may be large. PCW provides persistent external context plus selective rehydration; it does not claim to create an infinite model context window.

A normal retrieval flow is:

1. understand the current workstream and task;
2. consult its continuity checkpoint;
3. search the inventory;
4. identify candidate logical sections and physical sources;
5. read only the sources relevant to the task.

The inventory is a semantic map of the source corpus, not the corpus itself. Searching it does not crawl or load the referenced source documents.

The current search strategy splits the Markdown inventory at level-three (`###`) headings and applies case-insensitive substring matching to each complete section. Results preserve inventory document order and are limited to 8 by default; the MCP input accepts explicit limits from 1 through 20. There is no relevance ranking, fuzzy matching, embedding model, vector database, or RAG pipeline. A richer strategy may later replace or augment substring search behind the inventory service without changing MCP tool orchestration.
