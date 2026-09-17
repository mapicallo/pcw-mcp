# Security Notes

PCW-MCP treats context documents as potentially sensitive local project data.

The v0.2 foundation is not a complete sandbox or production security boundary. These notes describe the protections that are currently implemented and the risks that remain.

## Implemented Boundaries

- PCW-MCP requires an explicit context root from `--context-root` or `PCW_CONTEXT_ROOT`; there is no developer-specific fallback.
- Startup verifies that the selected root exists, is a directory, and contains a `pcw.yml` file before stdio starts.
- PCW-MCP reads configuration from the selected PCW context root.
- Every configured path used for filesystem access is resolved through the filesystem boundary and must remain inside that root.
- Relative traversal and absolute paths outside the root are rejected with path-aware containment checks.
- Absolute configured paths remain supported only when they resolve inside the root.
- Source discovery and reading are additionally confined to their configured shared-context or workstream section.
- Existing source targets pass realpath containment and file readers reject directory inputs.
- Inventory reads use the same root and realpath boundary; searching inventory does not crawl referenced sources.
- The intended write surface is limited to generated context/workstream creation, complete inventory replacement, and continuity replacement; there is no arbitrary-file, external-import, delete, or rename tool.
- Automatic workstream names use a conservative 1-64 character ASCII rule and generated paths; callers cannot supply arbitrary creation paths.
- Workstream creation rejects existing generated targets, case-insensitive logical duplicates, traversal-like names, and links that route generated paths outside the context root.
- Workstream creation, shared-context creation, and enabling workstream context use one exclusive PCW config lock, recheck the configuration SHA before commit, back up the exact prior `pcw.yml`, and atomically replace it.
- Failed structural creation performs best-effort rollback and reports incomplete rollback explicitly.
- Continuity writes require the expected SHA-256 and reject stale versions.
- Inventory replacement requires the SHA-256 returned by `get_inventory`, rejects stale versions, and backs up the exact prior inventory under `.pcw/history/inventory/`.
- Previous continuity is backed up before atomic replacement.
- History directories and continuity targets are checked against the context root.
- Canonical workstream names containing path separators, traversal components, NUL characters, or no visible characters are rejected before being used as history directory names.
- History directories are created in checked stages, and backup creation must succeed before continuity replacement begins.
- Expected continuity, inventory, and path errors are translated into their existing diagnostic payloads at the MCP boundary.
- Unexpected non-Error thrown values are replaced with a generic message, and stack traces are never returned in MCP tool responses.

PCW-MCP must not be treated as a general filesystem browser. Configuration and tool inputs do not grant access outside the selected context root.

PCW does not expose arbitrary external-path import. The safe onboarding sequence is to create a generated PCW-managed section, have an authorized human copy approved material into that in-root directory, then discover/read it through PCW and update the semantic inventory with optimistic concurrency.

Domain services do not depend on MCP response types. Transport formatting and error translation are confined to `src/mcp`, which reduces the risk of domain failures accidentally serializing arbitrary objects. This separation is not a complete security boundary and does not make PCW production-hardened.

## Path Safety

Containment uses normalized paths plus `relative()` and `isAbsolute()`; it does not use unsafe string-prefix comparisons. This distinguishes a real child from a similarly named sibling such as `context-other`.

The Zod configuration schema validates path field structure. Filesystem safety is enforced separately when a configured path is resolved.

Tool-provided source paths have two boundaries:

- the complete PCW context root;
- the specific configured section selected by the tool call.

A source path that remains inside the global root but escapes its selected section is rejected.

## Symbolic Links And Reparse Points

For existing targets, PCW-MCP resolves the real paths of the root and target before reading metadata or content. Existing source targets are checked against both the real context root and the real configured section. This rejects symbolic links and Windows junctions that lead outside an allowed boundary.

A residual time-of-check/time-of-use risk remains: a local actor with concurrent filesystem write access could replace a link or path after the `realpath` check and before the subsequent open, copy, or atomic-write operation. Fully eliminating that race requires lower-level handle-based and platform-specific controls and is deferred.

The config lock coordinates all three PCW structural writers but not manual editors or non-cooperating programs. The SHA recheck rejects changes observed before commit, but it is not an operating-system compare-and-swap. A crash can leave the lock or partially created artifacts; automatic stale-lock recovery and structural repair are not implemented.

Workstream creation is a guarded multi-file operation, not a fully atomic transaction. PCW validates first, writes `pcw.yml` last, and rolls back its own new artifacts on failure. Rollback itself can fail and is then reported as `PCW_WORKSTREAM_CREATE_CONFLICT`.

SHA comparison provides optimistic stale-write detection, not a filesystem lock or compare-and-swap primitive. Two truly simultaneous local updates can both validate the same version before either replacement completes. PCW does not claim distributed or multi-process write consistency.

The server therefore does not claim protection against a malicious local user who can mutate the context tree concurrently.

## Sensitive Context

Real project contexts may contain private documents, internal decisions, customer data, credentials, or other sensitive information.

Private context directories must not be committed into this repository. Public examples, tests, fixtures, and documentation use synthetic data.

## Prompt Injection Risk

Context documents are data. They may contain text that looks like instructions to an AI agent.

PCW should continue to distinguish between project knowledge, PCW control metadata, and explicit agent instructions. Stronger treatment of document-originated prompt injection remains future work.

## Non-Claims

PCW-MCP does not currently claim:

- production security hardening;
- operating-system sandboxing;
- multi-user isolation;
- authentication;
- remote access safety;
- protection against concurrent local filesystem mutation;
- sandboxing of document contents.

## MCP Error Boundary

Expected public failures are translated to a small stable string `code` plus the existing human-readable and category-specific fields. Unexpected exceptions use `PCW_INTERNAL_ERROR`; stack traces and arbitrary thrown objects are not returned. This limits accidental disclosure but does not make PCW a complete sandbox.
