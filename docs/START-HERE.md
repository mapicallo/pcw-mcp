# Start Here: PCW-MCP Private Beta

PCW keeps project knowledge and workstream continuity outside temporary AI sessions. This kit contains a local MCP server package and a fictional sample context for evaluation.

## What You Need

- Node.js 22.9.0 or newer and npm;
- this private handoff kit;
- an authorized local directory for any real PCW context;
- a stdio MCP client such as Codex or Cursor.

Read `PRIVATE-BETA-TERMS.md` before use. Redistribution or public uploading is not permitted without prior written authorization.

## Install Locally

From a directory outside this kit:

```powershell
mkdir pcw-test
cd pcw-test
npm init -y
npm install "<path-to-kit>\package\pcw-mcp-0.2.0-beta.1.tgz" --omit=dev
```

Copy `sample-context` to a user-owned directory before testing continuity writes. Do not write into the copy inside the ZIP or an installed package.

Check the runtime:

```powershell
node node_modules\pcw-mcp\dist\server.js --version
node node_modules\pcw-mcp\dist\server.js --help
```

## Select The Sample Context

Use one of these mechanisms:

```powershell
node node_modules\pcw-mcp\dist\server.js --context-root "C:\path\to\sample-context"
```

or:

```powershell
$env:PCW_CONTEXT_ROOT = "C:\path\to\sample-context"
node node_modules\pcw-mcp\dist\server.js
```

Only one root-selection mechanism is required. The CLI option takes precedence.

## Configure Codex

```toml
[mcp_servers.pcw]
command = "node"
args = ["C:\\path\\to\\pcw-test\\node_modules\\pcw-mcp\\dist\\server.js"]
env = { PCW_CONTEXT_ROOT = "C:\\path\\to\\sample-context" }
```

## Configure Cursor

```json
{
  "mcpServers": {
    "pcw": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\pcw-test\\node_modules\\pcw-mcp\\dist\\server.js"],
      "env": { "PCW_CONTEXT_ROOT": "C:\\path\\to\\sample-context" }
    }
  }
}
```

## First Prompts

Discovery:

```text
Use PCW to list the available workstreams and summarize the project structure. Do not modify anything.
```

Continuation:

```text
Use PCW to continue the BACKEND workstream. This is a completely new session. Reconstruct the current state from persistent context before suggesting changes. Do not modify continuity yet.
```

Checkpoint:

```text
Read the current BACKEND continuity and its SHA. Prepare an updated complete continuity document preserving relevant durable state, then update it through PCW using optimistic concurrency.
```

`update_continuity` replaces the complete canonical Markdown document and creates a backup under `.pcw/history`. A stale SHA is rejected; read again and reconcile instead of overwriting.

## Security

PCW limits filesystem access to configured context boundaries. It is not an operating-system sandbox. If the connected AI client uses a cloud model, content read through PCW may be sent to that provider. Never configure data you are not authorized to share with the selected AI system.

Do not publish or redistribute this kit, use the committed sample as writable durable state, bypass stale-write protection, or treat the beta as production software.
