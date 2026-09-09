# pcw.yml Contract

`pcw.yml` maps user-defined logical context to physical paths beneath one PCW context root. Logical names do not imply folder names:

```text
LOGICAL STRUCTURE != PHYSICAL STRUCTURE
```

The current implementation reloads and validates the file on each tool call; it does not cache configuration.

## Synthetic Example

```yaml
version: 1

project:
  id: sample
  name: Sample Project

inventory:
  path: knowledge/inventory.md

shared_context:
  general:
    path: knowledge/general

workstreams:
  BACKEND:
    context:
      path: areas/backend
    continuity:
      path: continuity/BACKEND.md

  OPERATIONS:
    continuity:
      path: continuity/OPERATIONS.md
```

`OPERATIONS` deliberately has continuity without specialized context.

## Current Schema

The YAML document must parse to an object. All top-level properties are currently optional.

| Field | Accepted value | Semantics |
| --- | --- | --- |
| `version` | string or number, optional | Configuration-schema marker. It is not the PCW software version. |
| `project` | object, optional | Project metadata container. |
| `project.id` | string, optional | Project identifier. |
| `project.name` | string, optional | Human-readable project name. |
| `inventory` | object, optional | Inventory configuration. |
| `inventory.path` | non-empty string, optional | One inventory file path. |
| `shared_context` | map, optional | Dynamic logical names to path objects. |
| `shared_context.<name>.path` | non-empty string, optional | Physical section directory. |
| `workstreams` | map, optional | Dynamic workstream names to configuration objects. |
| `workstreams.<name>.context` | object, optional | Specialized context configuration. |
| `workstreams.<name>.context.path` | non-empty string, optional | Specialized context directory. |
| `workstreams.<name>.continuity` | object, optional | Continuity configuration, independent of context. |
| `workstreams.<name>.continuity.path` | non-empty string, optional | Canonical continuity file. |

An optional path object may exist without `path`; tools then treat that resource as not configured. Workstream and shared-context keys are dynamic. Lookup is case-insensitive, but responses preserve canonical configured spelling.

## Version Distinction

The server software version is currently `0.2.0-dev.1` and comes from `package.json`.

The independent `pcw.yml.version` field remains optional and accepts strings or numbers because that is the validated POC behavior. A future schema migration should define a required canonical integer such as `version: 1`, but that would be an explicit compatibility change and is not part of this baseline.

## Path Rules

Relative configured paths are resolved against `PCW_CONTEXT_ROOT` and are preferred. Existing absolute paths that resolve inside the root remain accepted for compatibility. Paths escaping the root are rejected. Existing targets also receive realpath containment checks, and source reads remain inside their selected shared/workstream section.

Configuration structure is validated by Zod. Filesystem safety is enforced separately by the filesystem boundary.

## Operational Semantics

- A workstream may have context, continuity, both, or neither.
- Continuity does not default to `continuity/<name>.md`; its path must be configured.
- Shared sections and workstreams are not inferred from physical folders.
- Inventory is one configured document, not a source crawler or database.
- Configuration edits become visible without restarting the server.

Malformed YAML and invalid structure return concise MCP errors. Validation reports at most three issue summaries and does not expose raw Zod objects or stack traces.
