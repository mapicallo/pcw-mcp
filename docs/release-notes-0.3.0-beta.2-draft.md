# PCW 0.3.0-beta.2 Internal Release-Note Draft

Status: internal freeze input. Not published.

## Added

- Standard Windows installer with bundled Node runtime and PCW Doctor.
- Official empty-context initialization.
- Safe client-integration foundation: automatic Cursor registration and guided Codex/Claude setup.

## Changed

- Distribution now carries one canonical Core TGZ into Standard Windows packaging.
- Release verification binds Core, installer reproducibility, exact-A lifecycle, and finalization evidence.

## Preserved

- 16 public MCP tools and 19 public PCW error codes.
- Existing `pcw.yml`, context, inventory, continuity, and source-reader compatibility.

## Known Limitations

- The Windows installer is unsigned and may trigger SmartScreen.
- Standard packaging targets Windows x64.
- Codex and Claude integration remains guided; MCPB is not included.
- There is no automatic updater, remote MCP, cloud synchronization, or macOS/Linux installer.
