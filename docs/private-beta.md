# PCW-MCP Private Beta Guide

PCW-MCP `0.2.0-dev.2` is a local-only development candidate. It is not production-ready, published, or available through a remote MCP transport.

## Prerequisites

- Node.js `>=22.9.0` based on dependency engine requirements;
- an unpacked or locally installed PCW-MCP package;
- a PCW context containing `pcw.yml`.

Runtime smoke testing currently uses Node 24.3.0. Node 22 remains to be verified in CI or another clean environment.

## Package Contents

The private package contains compiled `dist/` modules, this public documentation, `README.md`, `templates/`, `examples/sample-context/`, and package metadata. It excludes TypeScript source, tests and fixtures, project development continuity, Git/IDE state, and private contexts.

The package is marked `private: true`. It may be packed and installed locally for testing, but it cannot be published accidentally through npm.

## First Context

Copy `examples/sample-context/` to a user-owned location, or create a context from the files under `templates/`. The sample is a fictional project named Example Taskboard and demonstrates:

- shared logical contexts mapped to arbitrary physical folders;
- `BACKEND` with specialized context and continuity;
- `OPERATIONS` with continuity but no specialized context;
- a semantic inventory for selective retrieval.

Do not point a writable beta session at the copy inside the installed package. Use a user-owned copy so package upgrades cannot replace project state.

## Start The Server

Select the context through the environment:

```powershell
$env:PCW_CONTEXT_ROOT = "C:\Contexts\sample-context"
node C:\Tools\pcw-mcp\dist\server.js
```

or through the CLI:

```powershell
node C:\Tools\pcw-mcp\dist\server.js --context-root C:\Contexts\sample-context
```

The CLI value takes precedence. Missing, empty, or physically invalid roots fail before stdio starts. Stdio is the only transport.

## MCP Clients

A generic Codex-style configuration is:

```toml
[mcp_servers.pcw]
command = "node"
args = ["C:\\Tools\\pcw-mcp\\dist\\server.js"]
env = { PCW_CONTEXT_ROOT = "C:\\Contexts\\sample-context" }
```

A generic Cursor-style configuration is:

```json
{
  "mcpServers": {
    "pcw": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Tools\\pcw-mcp\\dist\\server.js"],
      "env": {
        "PCW_CONTEXT_ROOT": "C:\\Contexts\\sample-context"
      }
    }
  }
}
```

These examples describe the tested process contract with generic paths; they are not product-specific certification.

## Suggested First Session

Ask the client to use PCW explicitly:

```text
Use PCW to list the available workstreams.
```

Then reconstruct a durable workstream before changing it:

```text
Use PCW to continue the BACKEND workstream. Reconstruct its current state before modifying anything.
```

Search the inventory before reading selected sources. At the end, read the latest continuity SHA and call `update_continuity` with a complete replacement checkpoint and `expectedSha256`.

## Current Limitations And Release Blockers

- `hello` is a development compatibility tool; its beta-contract decision is pending. Do not depend on it.
- Machine-readable MCP error codes remain a pending contract decision.
- `absolutePath` and `backupPath` remain visible for local operation and must be reconsidered before remote use.
- `ISC` is declared in package metadata, but the owner has not confirmed the license and no `LICENSE` file exists.
- Node 22 has not been runtime-tested.
- There is no HTTP/SSE transport, authentication, installer, global CLI, publication, or remote synchronization.
