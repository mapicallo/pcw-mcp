# Installation And Lifecycle

Keep these three things separate:

```text
PCW software != MCP client registration != PCW contexts
```

PCW software is replaceable. Contexts are durable user data owned by the user and include continuity, inventory, configured sources, and `.pcw/history`.

## Install

In a dedicated local directory:

```powershell
npm init -y
npm install "<handoff>\package\pcw-mcp-0.2.0-beta.2.tgz" --omit=dev
```

## Disable Or Disconnect

Disable or remove the MCP registration in the AI client. For Codex:

```powershell
codex mcp remove pcw
```

This does not uninstall PCW and does not delete any context.

## Uninstall Software

From the installation directory:

```powershell
npm uninstall pcw-mcp
```

Close Codex, IDE integrations, and other clients using PCW first. Windows may otherwise report npm `EPERM` cleanup warnings while native dependencies are open. Never delete context directories as part of package uninstall.

## Reinstall

Install the package again, register the MCP server again, and point it to the existing context. Persistent workstreams become available from the existing files.

## Upgrade

There is no automatic upgrade system. Obtain the approved newer private package, stop connected clients, install that package in the software directory, verify `--version`, and reconnect the existing MCP registration or update its server path if necessary. Back up important contexts according to normal project policy; package replacement must not modify them.

## Context Root Changes

Edits to `pcw.yml` within the same root are reread dynamically. Changing `PCW_CONTEXT_ROOT` changes process configuration: an already-running MCP process may continue exposing the old root until the client reconnects, restarts, or reopens/restores the chat.

## Multiple Projects

One PCW MCP registration represents one `contextRoot`, which may contain many workstreams. For separate projects today, register separate named servers, for example `pcw-platform` and `pcw-analytics`, each with its own root. Native multi-project selection is not implemented.
