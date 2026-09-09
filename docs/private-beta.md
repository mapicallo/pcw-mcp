# PCW-MCP Private Beta Guide

PCW-MCP `0.2.0-beta.1` is a local-only private-beta release candidate. It is not published, tagged as a release, or available through a remote transport.

## Prerequisites

- Node.js `>=22.9.0`;
- the locally supplied PCW-MCP package;
- a PCW context containing `pcw.yml`.

CI has passed on Node 22 and Node 24. The Node 22 job also completed the packaged clean-install smoke test.

## Package Contents

The package contains compiled `dist/` modules, public documentation, `README.md`, `templates/`, `examples/sample-context/`, and npm metadata. It excludes source, tests, fixtures, development continuity, Git/IDE state, and private contexts. `private: true` prevents accidental npm publication.

Copy `examples/sample-context/` to a user-owned location before writable testing. The fictional Example Taskboard demonstrates dynamic physical paths, shared contexts, `BACKEND` with context and continuity, and `OPERATIONS` with continuity only.

## Start The Server

```powershell
$env:PCW_CONTEXT_ROOT = "C:\Contexts\sample-context"
node C:\Tools\pcw-mcp\dist\server.js
```

or:

```powershell
node C:\Tools\pcw-mcp\dist\server.js --context-root C:\Contexts\sample-context
```

The CLI value takes precedence. Invalid or missing roots fail before stdio starts.

## MCP Client Examples

Codex-style configuration:

```toml
[mcp_servers.pcw]
command = "node"
args = ["C:\\Tools\\pcw-mcp\\dist\\server.js"]
env = { PCW_CONTEXT_ROOT = "C:\\Contexts\\sample-context" }
```

Cursor-style configuration:

```json
{
  "mcpServers": {
    "pcw": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Tools\\pcw-mcp\\dist\\server.js"],
      "env": { "PCW_CONTEXT_ROOT": "C:\\Contexts\\sample-context" }
    }
  }
}
```

## First-User Handoff Checklist

1. Confirm a supported Node version is installed.
2. Obtain and locally install or unpack the PCW package.
3. Copy the sample or prepare a permitted PCW context.
4. Set `--context-root` or `PCW_CONTEXT_ROOT`.
5. Add the stdio server to Codex or Cursor.
6. Confirm the 12 PCW tools are visible.
7. Ask PCW to list workstreams.
8. Continue a workstream by reading its continuity and selecting relevant sources.
9. Permit `update_continuity` only when a durable checkpoint is intended.

A useful first request is: `Use PCW to list the available workstreams.` Then: `Use PCW to continue the BACKEND workstream. Reconstruct its current state before modifying anything.`

## Tester Security Checklist

- Configure only context documents the tester is authorized to expose to the connected AI client/model.
- Remember that a local PCW server may be connected to a client using a cloud model.
- Treat `update_continuity` as writable; it replaces the complete configured Markdown document.
- History backups are stored below `.pcw/history` in the context root.
- PCW constrains configured and requested paths, but it is not a general operating-system sandbox.
- Do not run writable tests against the context copy inside an installed package.

## Error Handling

Expected MCP errors contain a stable `code`, a human-readable `error`, and category-specific diagnostics. Clients should branch on `code` and present the message. A stale update uses `PCW_CONTINUITY_STALE`; clients must read continuity again, reconcile, and retry rather than overwrite.

## Release-Candidate Verification

From a source checkout, run:

```text
npm ci
npm run verify:beta
```

This compiles, runs the standard suite, creates and clean-installs a temporary package for functional smoke testing, checks the installed allowlist/privacy boundary, and performs an npm pack dry run. It does not publish or create a Git tag.

## Current Limitations And Blocker

- `absolutePath` and `backupPath` remain visible for local beta operation.
- There is no HTTP/SSE transport, authentication, installer, global CLI, remote synchronization, OCR, or automatic conflict merge.
- CI currently validates Node 22 and Node 24; compatibility below the declared `>=22.9.0` minimum is unsupported.
- `ISC` remains in metadata, but licensing has not been approved and no `LICENSE` file exists.

External handoff is blocked on owner confirmation of licensing terms. Local technical validation may continue.
