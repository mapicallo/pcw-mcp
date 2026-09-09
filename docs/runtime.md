# Local Runtime

PCW-MCP is a local stdio server. The context root must be selected explicitly by command line or environment.

## Context Root Selection

Precedence is deterministic:

1. `--context-root <path>`;
2. `PCW_CONTEXT_ROOT`;
3. startup failure when neither contains a non-empty value.

The selected root is normalized to an absolute path. Before stdio starts, PCW verifies that the root exists, is a directory, and contains a `pcw.yml` file. Structural YAML validation remains in the configuration layer.

Environment examples:

```powershell
$env:PCW_CONTEXT_ROOT = "C:\Contexts\sample-project"
node C:\Tools\pcw-mcp\dist\server.js
```

```sh
PCW_CONTEXT_ROOT=/home/user/contexts/sample-project \
  node /opt/pcw-mcp/dist/server.js
```

CLI examples:

```powershell
node C:\Tools\pcw-mcp\dist\server.js --context-root C:\Contexts\sample-project
```

```sh
node /opt/pcw-mcp/dist/server.js --context-root /home/user/contexts/sample-project
```

When both forms are supplied, the CLI value wins.

## Process Options

```text
--context-root <path>  Select the PCW context root
--help                 Print concise usage and exit
--version              Print the package/MCP software version and exit
```

Unknown options, missing values, empty roots, missing directories, non-directory roots, and roots without a `pcw.yml` file fail before MCP starts. Expected configuration failures are written to stderr without a stack trace. Normal operation writes no banner or diagnostic text to stdout because stdout is reserved for the MCP protocol. Help and version intentionally use stdout and do not start MCP.

## Client Configuration

A Codex-style local configuration can provide the root through the environment:

```toml
[mcp_servers.pcw]
command = "node"
args = ["C:\\Tools\\pcw-mcp\\dist\\server.js"]
env = { PCW_CONTEXT_ROOT = "C:\\Contexts\\sample-project" }
```

A Cursor-style stdio configuration can use the same runtime contract:

```json
{
  "mcpServers": {
    "pcw": {
      "command": "node",
      "args": ["C:\\Tools\\pcw-mcp\\dist\\server.js"],
      "env": {
        "PCW_CONTEXT_ROOT": "C:\\Contexts\\sample-project"
      }
    }
  }
}
```

Client configuration formats can evolve; these examples describe the process contract and use placeholders rather than developer-specific paths. Automated tests validate the stdio server with the official MCP client. They do not claim product-specific integration certification.

## Distribution Boundary

The private-beta npm package allowlist contains:

- `dist/`;
- `README.md`;
- the public contract, MCP tools, `pcw.yml`, PCW model, runtime, security, and private-beta guides;
- `templates/`;
- `examples/sample-context/`;
- npm-required `package.json` metadata.

It excludes source, tests and fixtures, project continuity, Git/IDE state, temporary files, and private contexts. The package is marked `private: true` to prevent accidental npm publication. This still permits local `npm pack --dry-run` inspection.

No ZIP, installer, executable bundle, npm publication, GitHub release, or MCP Registry entry is produced in this development block. Stdio remains the only implemented transport.
