# Start Here: PCW-MCP Private Beta

[Español: START-HERE-ES.md](START-HERE-ES.md)

PCW keeps project knowledge and workstream continuity outside temporary AI sessions. This kit contains a local MCP server, templates, and a fictional sample context.

## Requirements

- Node.js 22.9.0 or newer and npm;
- an authorized copy of this private handoff kit;
- a local directory for the PCW context;
- a stdio MCP client such as Codex or Cursor.

Read `PRIVATE-BETA-TERMS.md` before use. Do not redistribute or publicly upload the kit without written authorization.

## Install

From a directory outside the kit:

```powershell
mkdir pcw-test
cd pcw-test
npm init -y
npm install "<path-to-kit>\package\pcw-mcp-0.2.0-beta.3.tgz" --omit=dev
```

```powershell
node node_modules\pcw-mcp\dist\server.js --version
node node_modules\pcw-mcp\dist\server.js --help
```

Copy `sample-context` to a user-owned directory before testing writes. Do not use the copy inside the ZIP as durable state.

## Register With Codex

Check the CLI and current registrations:

```powershell
codex --version
codex mcp list
```

Register PCW with placeholders replaced by absolute paths:

```powershell
codex mcp add pcw --env PCW_CONTEXT_ROOT="C:\Contexts\sample-context" -- node "C:\Tools\pcw-test\node_modules\pcw-mcp\dist\server.js"
codex mcp list
codex mcp get pcw
```

`codex mcp get pcw` may hide environment values for security. To disconnect PCW later:

```powershell
codex mcp remove pcw
```

This CLI flow was validated with the beta environment and may evolve in future Codex versions. A tested Codex integration inside IntelliJ and Codex Desktop used the same global registration. Some clients can expose a newly registered server to an existing session; reconnect or restart if it is not visible.

## Configure Cursor

Package installation is the same; only client registration differs:

```json
{
  "mcpServers": {
    "pcw": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Tools\\pcw-test\\node_modules\\pcw-mcp\\dist\\server.js"],
      "env": { "PCW_CONTEXT_ROOT": "C:\\Contexts\\sample-context" }
    }
  }
}
```

## Create Your First Context

For a minimal useful context, copy `templates/pcw-minimal.yml` as `pcw.yml`, copy `templates/inventory.md` as `inventory.md`, and copy `templates/continuity.md` as `continuity/WORKSTREAM.md`. Replace placeholders and keep all configured paths inside the context root.

```text
my-context/
  pcw.yml
  inventory.md
  continuity/
    WORKSTREAM.md
```

Specialized workstream context and shared context are optional. A workstream can have continuity without either. Name workstreams after durable work such as `BACKEND` or `OBSERVABILITY`, never after a chat or session.

See `docs/pcw-yml.md` for the exact schema and `templates/pcw.yml` for a fuller example.

## Create A New Workstream

For the normal case, ask the connected AI client to use PCW instead of editing `pcw.yml` manually:

```text
Create a PCW workstream named PLATFORM-LAB with specialized context. Its initial objective is to validate the fictional platform workflow.
```

The AI may call `create_workstream` with `mode: "with-context"`. PCW creates `continuity/PLATFORM-LAB.md`, `workstreams/PLATFORM-LAB/`, a checked configuration entry, and an exact pre-change config backup. The default `"continuity-only"` mode creates only continuity. Manual `pcw.yml` editing remains supported for advanced custom physical layouts.

Any chat connected to the same PCW context can discover the new workstream immediately. The workstream belongs to the durable context, not to the chat that created it; for example, one chat can continue `BACKEND` while another continues `PLATFORM-LAB`.

## First Prompts

```text
Use PCW to list the available workstreams and summarize the project structure. Do not modify anything.
```

```text
Use PCW to continue the BACKEND workstream. This is a completely new session. Reconstruct persistent state before modifying anything. Do not update continuity yet.
```

At a meaningful milestone:

```text
Update the BACKEND checkpoint in PCW. Reread continuity and its SHA first. Preserve only durable workstream state needed by a completely new session.
```

`update_continuity` replaces the complete Markdown checkpoint, creates history under `.pcw/history`, and rejects stale SHAs. Do not save chat transcripts or the temporary mechanics of creating a checkpoint.

## Next Guides

- `docs/daily-use.md`: normal sessions, checkpoints, broken chats, and stale writes;
- `docs/adopting-existing-session.md`: migrate an existing conversation safely;
- `docs/lifecycle.md`: disable, uninstall, reinstall, upgrade, and multiple projects;
- `docs/runtime.md`: context-root and client configuration details.

## Security

PCW constrains access to configured context boundaries but is not an operating-system sandbox. A connected cloud AI client may transmit content to its provider. Configure only data you are authorized to share with that AI system.

Changing `pcw.yml` inside one root is dynamically visible. Changing `PCW_CONTEXT_ROOT` may require reconnecting or restarting the client because an existing MCP process retains its startup root.
