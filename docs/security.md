# Security Notes

PCW-MCP treats context documents as potentially sensitive local project data.

The current POC is not security-hardened or production-ready. These notes document the intended boundaries and known areas for improvement.

## Existing Boundaries

- PCW-MCP reads from a configured PCW context root.
- Source-reading tools are scoped to configured shared context sections or workstream context sections.
- Continuity update is currently the only intended write capability.
- Continuity writes require an expected SHA-256 to reduce accidental overwrites.
- Stale continuity writes are rejected.
- Previous continuity content is backed up before replacement.
- Continuity replacement uses atomic file writing.
- Path traversal protection exists through an `ensureInsideBase` helper.

## Sensitive Context

Real project contexts may contain private documents, internal decisions, customer data, credentials, or other sensitive information.

Private context directories must not be committed into this repository. Public examples, tests, fixtures, and documentation must use synthetic data.

## Path Safety

PCW-MCP must never expose arbitrary filesystem reads. Configured paths and user-provided source names should be resolved through a central safe path helper that verifies the final path remains inside the intended base directory.

One v0.2 hardening task is to apply safe resolution consistently to all read, list, and write paths.

## Prompt Injection Risk

Context documents are data. They may contain text that looks like instructions to an AI agent.

PCW should continue to distinguish between:

- project knowledge/data;
- PCW control metadata;
- explicit agent instructions.

This separation is a future security concern and should be documented and tested as the model evolves.

## Non-Claims

PCW-MCP does not currently claim:

- production security hardening;
- multi-user isolation;
- authentication;
- remote access safety;
- sandboxing of document contents;
- protection against all malicious local configurations.
