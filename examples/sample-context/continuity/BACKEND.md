# BACKEND

## Current objective

Define pagination for task listing while preserving the fictional API's current response fields.

## Current state

Task creation, completion, and unpaginated listing are documented. Request validation occurs at the HTTP boundary.

## Completed

- Documented the API boundary and current validation behavior.
- Identified pagination as the next isolated contract change.

## Decisions

- Keep persistence details behind an adapter.
- Treat response-field compatibility as a constraint.

## Avoid repeating

- Do not add pagination by silently changing the existing list response shape.

## Open questions / blockers

- The default page size is not decided.

## Relevant sources

- Shared `general`: `architecture.md`.
- Workstream `BACKEND`: `backend-api.md`.

## Next action

Draft the pagination input and response contract before implementation.
