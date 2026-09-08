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

## Selective Retrieval

The full durable context may be large. PCW should help an agent discover available sources, search the inventory, and read only selected relevant files instead of loading everything into the active model context.
