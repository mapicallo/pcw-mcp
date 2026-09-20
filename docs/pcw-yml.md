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

The server software version is currently `0.3.0-beta.1` and comes from `package.json`.

The independent `pcw.yml.version` field remains optional and accepts strings or numbers because that is the validated POC behavior. A future schema migration should define a required canonical integer such as `version: 1`, but that would be an explicit compatibility change and is not part of this baseline.

## Path Rules

Relative configured paths are resolved against `PCW_CONTEXT_ROOT` and are preferred. Existing absolute paths that resolve inside the root remain accepted for compatibility. Paths escaping the root are rejected. Existing targets also receive realpath containment checks, and source reads remain inside their selected shared/workstream section.

Configuration structure is validated by Zod. Filesystem safety is enforced separately by the filesystem boundary.

## Operational Semantics

- A workstream may have context, continuity, both, or neither.
- Manually configured continuity has no inferred default; its path must be explicit.
- Shared sections and workstreams are not inferred from physical folders.
- Inventory is one configured document, not a source crawler or database.
- Configuration edits become visible without restarting the server.

## Automatic Workstream Convention

`create_workstream` deliberately does not accept filesystem paths. For a safe name `PLATFORM-LAB`, continuity-only creation adds `continuity/PLATFORM-LAB.md`; `with-context` also creates `workstreams/PLATFORM-LAB/`. The matching paths are written to a new `workstreams.PLATFORM-LAB` entry.

This convention applies only to automatic creation. Existing and manually edited contexts may map logical names to different physical paths, provided those paths remain inside the PCW root. Automatic creation does not modify the inventory.

## Automatic Context Conventions

`create_shared_context` accepts only a safe logical name and generates `shared/<NAME>/`; `enable_workstream_context` resolves an existing workstream case-insensitively and generates `workstreams/<CANONICAL>/`. Neither accepts a caller-provided path. Both preserve unrelated YAML, use the shared structural-write lock, store the exact previous configuration under `.pcw/history/config/`, and atomically replace `pcw.yml`.

These conventions authorize only generated locations inside the selected PCW root. External documents must be copied into them by an authorized human before PCW can discover or read them.

## Minimal Useful Context

Although every top-level schema property is optional, tools can only expose resources that are configured. A small useful context can contain one inventory and one continuity-only workstream:

```text
pcw.yml
inventory.md
continuity/
  WORKSTREAM.md
```

Start from `templates/pcw-minimal.yml`. Specialized workstream context and shared context are optional; continuity is configured independently. Name a workstream for its durable line of work, not for the chat that happens to use it.

Malformed YAML and invalid structure return concise MCP errors. Validation reports at most three issue summaries and does not expose raw Zod objects or stack traces.
