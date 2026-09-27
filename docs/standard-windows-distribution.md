# Standard Windows Distribution Architecture and Runtime (BLOCK 30A/30B)

Status: **runtime staging, client adapters, and engineering installer skeleton validated**. Not a release installer.
Software baseline: PCW Core `0.3.0-beta.1` (`pcw-mcp`).
Branch inspected: `v0.3-distribution`.

Related prior decision: [distribution-architecture.md](distribution-architecture.md)
(BLOCK 20). This document specializes the **Standard User / Windows-first**
wrapper around the same Core.

## Decision summary

| Topic | Recommendation |
| --- | --- |
| Core identity | Consume exact `pcw-mcp-<version>.tgz`; record SHA-256 in installer metadata / release manifest |
| Runtime | **Bundled portable Node** (≥22.9.0) + installed Core tree — not system Node, not SEA for v1 |
| Software location | Per-user `%LOCALAPPDATA%\Programs\AI4Context\PCW\` (no admin) |
| Context data | User-owned; default suggestion `%USERPROFILE%\PCW\` (never under Program Files / install dir) |
| Launcher | Stable `bin\pcw.cmd` (later optional native shim) hiding Node/Core paths |
| Installer tech (first beta) | **Inno Setup** (per-user, custom pages, EXE, CI-friendly) |
| Clients | Adapter layer outside Core; merge-only MCP config mutation |
| First-run | Create/choose context root + minimal `pcw.yml`; no workstream UI in installer |

## 1. Current Core runtime contract

### Package and entry

- Package name: `pcw-mcp` (`private: true`, `UNLICENSED`).
- Engines: `node >= 22.9.0` (`type: module`).
- Entry: `dist/server.js` (`main` / `npm start` → `node dist/server.js`).
- Transport: **stdio only**.
- Version: read at runtime from adjacent `package.json` via
  `createRequire(import.meta.url)` → `../package.json` relative to `dist/`.
  **Layout requirement:** `package.json` must remain one directory above
  `dist/server.js` (npm-install layout or equivalent).

### Context root

Precedence:

1. `--context-root <path>`
2. `PCW_CONTEXT_ROOT`
3. fail before MCP starts

Root must exist, be a directory, and contain `pcw.yml`. Paths are resolved to
absolute form. Help/version use stdout and exit without starting MCP; normal
operation must not contaminate stdout (MCP protocol).

### Dependencies (production)

| Package | Role | Bundling notes |
| --- | --- | --- |
| `@modelcontextprotocol/server` | MCP stdio server | Pure JS |
| `yaml`, `zod`, `write-file-atomic` | Config / validation / atomic writes | Pure JS |
| `mammoth` | DOCX | Pure JS |
| `pdf-parse` | PDF | Pulls **`pdfjs-dist`** and **`@napi-rs/canvas`** (native `.node`) |

Spike measurement (npm install of packed Core, omit dev, Windows x64):

- Core tarball ≈ **47 KB**
- Installed tree ≈ **109 MB** (≈35 MB `@napi-rs/*`, ≈35 MB `pdfjs-dist`)
- Server starts with context paths **containing spaces**
- No `child_process` usage inside Core `src/` (only tooling/tests)

### Relocatability

Core is **relocatable** if:

1. The package directory keeps `package.json` + `dist/` + `templates/` + docs
   allowlist files;
2. Production `node_modules` for the Core dependency tree sit where Node can
   resolve them (classic `node_modules/pcw-mcp` + siblings, or a flat install
   that preserves resolution);
3. Invocation uses an absolute path to `dist/server.js` (or a launcher that
   does).

Core does **not** assume the git checkout. It does assume a Node module layout
compatible with `createRequire` + normal `node_modules` resolution. There is
**no** init API that creates a blank context root; templates
(`templates/pcw-minimal.yml`, `templates/pcw.yml`, …) are the intended
bootstrap content for an installer companion.

### What Core is not

- Not an installer, MCPB, or client config editor.
- Not a remote MCP server.
- Not tied to a working directory for context selection (CLI/env only).

## 2. Standard user target journey (first beta)

1. Download `PCW-Setup-<version>.exe` (private-beta channel).
2. Run installer (per-user; no admin).
3. Accept private-beta terms.
4. Confirm software install location (default under LocalAppData).
5. Choose or create **PCW Context** folder (default `%USERPROFILE%\PCW\<name>`
   or `%USERPROFILE%\PCW`).
6. Select supported MCP client(s) and registration name(s).
7. Installer embeds/installs Core + runtime, writes launcher, merges MCP
   config with backup.
8. Run **PCW Doctor**.
9. Finish: open AI client → ask “List my PCW workstreams”.

Users never install Node/npm, open PowerShell, or hand-edit MCP JSON.

### Wizard pages

Welcome → Install location → Context location → Client integration → Review →
Install → Verify → Finish.

## 3. Software vs data

| Owner | Contents |
| --- | --- |
| Installer-owned | Portable Node, Core tree, `bin\pcw.cmd`, metadata (`release-manifest` slice / Core SHA), doctor helper, integration state |
| User-owned | Context root(s), `pcw.yml`, workstreams, shared context, inventory, continuity, sources, `.pcw/history` |

**Uninstall** removes software/runtime/launcher/owned registrations (after
confirm). **Never** deletes context roots by default.
**Upgrade** replaces software only; preserves contexts and preferably
integrations.

## 4. Recommended paths

### Software (per-user)

```text
%LOCALAPPDATA%\Programs\AI4Context\PCW\
  runtime\node\          # portable Node matching engines
  core\                  # installed pcw-mcp package tree
  bin\pcw.cmd            # stable MCP command
  metadata\
    core.tgz             # optional retained canonical TGZ
    core.sha256
    release-info.json
  state\
    integrations.json    # PCW-owned registration ledger
```

Rationale: no UAC; one user profile; MCP clients typically run as that user;
simpler private-beta ops. Machine-wide `Program Files` deferred (admin,
multi-user MCP config).

### Context (user-owned)

Default suggestion: `%USERPROFILE%\PCW` or a named subfolder the user chooses.
Do not place contexts under the software directory or Program Files.

## 5. Runtime packaging comparison

| Strategy | Friction | Repro | Size | Compat | Updates | Core identity | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A. Bundled portable Node + Core** | Low | High if Node archive + Core TGZ pinned | Medium–large (~Node + ~110 MB deps) | Matches tested Node 22/24 CI | Replace runtime and/or Core on upgrade | Strong (embed TGZ SHA) | **Recommended v1** |
| B. Node SEA / single EXE | Low UX | Hard | Smaller surface, hard build | **Weak** with `@napi-rs/canvas` | Hard | Weak unless carefully designed | Defer; native modules |
| C. System Node required | High | Depends on user | Smallest installer | Fragile | User patches Node | OK if TGZ proven | Reject for Standard UX |

## 6. Canonical Core identity

Build pipeline:

```text
tag/commit → npm pack → pcw-mcp-<ver>.tgz (SHA-256)
                         ├── Developer / private handoff (existing)
                         └── Standard Windows installer embeds same TGZ
```

Installer metadata must record `softwareVersion`, `coreArtifactId`
(`core-npm-tarball`), `coreSha256`, and preferably `gitCommit` / channel.
On install: expand from that TGZ (or pre-expanded tree built **only** from it
in CI) and `npm install --omit=dev` offline from a locked dependency set, or
vendor a CI-produced `node_modules` closure hashed in the manifest.

**Forbidden:** independently transpiling Core from source inside the installer
repo without a hash chain to the release TGZ.

## 7. Launcher

First beta: **`pcw.cmd`**

```bat
@echo off
setlocal
set "PCW_HOME=%~dp0.."
set "NODE=%PCW_HOME%\runtime\node\node.exe"
"%NODE%" "%PCW_HOME%\core\dist\server.js" %*
```

MCP client configs reference:

```text
…\AI4Context\PCW\bin\pcw.cmd
```

with either:

- `args`: `--context-root`, `<path>`, or
- `env`: `PCW_CONTEXT_ROOT=<path>`

Prefer args for multi-registration clarity. Quote all paths. No PATH mutation
required.

Later: optional small native shim (`pcw.exe`) if `.cmd` proves unreliable in a
specific client; keep the same public contract.

## 8. Multi-context

One install, many registrations:

| Registration name | Context root |
| --- | --- |
| `PCW – Project A` | `…\PCW\project-a` |
| `PCW – Project B` | `…\PCW\project-b` |

Same `pcw.cmd`, different `--context-root`. Do not duplicate the runtime.

## 9. Client integration adapters

Adapters live in the **Standard distribution / installer companion**, not in
Core.

| Client | Config (typical) | Notes |
| --- | --- | --- |
| Codex CLI | `codex mcp add …` / TOML under Codex config | Documented in `docs/runtime.md`; CLI may evolve |
| Cursor | JSON `mcpServers` in Cursor MCP settings | Merge by server key |
| Claude Desktop / others | App MCP JSON | Detect if present; skip if unknown |

Each adapter: detect → propose registration → backup → merge → verify.
Restart/reconnect may be required (client-specific).

## 10. Safe config mutation

```text
read → parse → validate → backup → merge only PCW-owned keys → atomic write → verify
```

- Malformed file: abort, leave original, actionable error.
- Existing PCW entry: idempotent update (same name / managed metadata).
- Uninstall: remove only PCW-owned entries recorded in
  `state\integrations.json`.

## 11. Ownership metadata

`%LOCALAPPDATA%\Programs\AI4Context\PCW\state\integrations.json` (or under
`%LOCALAPPDATA%\AI4Context\PCW\state\` if preferred to survive reinstall path
changes — decide in implementation; keep one canonical path).

Fields: `client`, `registrationName`, `configPath`, `contextRoot`,
`pcwVersion`, `createdAt`, `updatedAt`, `backupPath` (if any). No secrets.

## 12. First-run initialization

Installer scope:

- create directory if needed;
- write minimal valid root from templates (`pcw.yml` + inventory stub);
- do **not** create workstreams in the wizard.

Workstream creation remains MCP tools after first connect. Blank-root
initialization is **installer companion** work (copy templates), not a Core
MCP tool today.

## 13. PCW Doctor

`pcw doctor --context-root <path>` (companion CLI or `pcw.cmd doctor` later).

Checks: runtime files, Node exec, Core `--version`, context exists/writable,
`pcw.yml` present/parseable, launcher start (no stdout noise before protocol),
optional client registration presence, permissions.

User-facing summary:

```text
PCW Doctor
✓ Runtime
✓ PCW 0.3.0-beta.1
✓ Context root
✓ Configuration
✓ Client integration (if selected)
```

## 14. Installer technology

| Tech | Per-user / no-admin | Custom wizard | Bundle files | Helpers | Upgrade/uninstall | Signing | CI | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Inno Setup** | Excellent | Good | Excellent | Easy | Mature | Authenticode | Scriptable | Low–medium |
| WiX / MSI | Possible, heavier | Harder | Good | Custom actions | Strong enterprise | Yes | Steeper | Higher |
| MSIX | Good for Store | Constrained | Sandbox rules | Harder for MCP JSON outside package | OS update model | Yes | Medium | Higher for MCP side-effects |

**First Standard private beta: Inno Setup** producing `PCW-Setup-<ver>.exe`.

## 15. Code signing

Plan now, certificate later:

- Sign: installer EXE, any native launcher, future updater.
- Unsigned private beta: expect SmartScreen; communicate trusted SHA out-of-band.
- Signing changes bytes → hash **signed** artifact in release manifest.

## 16. Upgrade / uninstall

Upgrade: detect prior install → replace software/runtime → preserve contexts →
refresh integrations if paths moved.

Uninstall: remove software + optional PCW MCP entries; **preserve contexts**;
UI must state this explicitly.

## 17. Release manifest integration

Existing schema already allows arbitrary `artifactId` / `type` identifiers and
`target: { os: windows, arch: x64 }`.

Proposed addition (when built):

```yaml
artifactId: standard-windows-installer
type: windows-installer
fileName: PCW-Setup-0.3.0-beta.1.exe
target: { os: windows, arch: x64 }
```

Coexists with `core-npm-tarball` and `private-beta-handoff`. No schema change
required. Prefer also listing the embedded Core SHA in installer metadata even
though the Core TGZ remains a first-class manifest artifact.

## 18. Reproducibility

Separate:

- **Unsigned deterministic build** (pin Inno compiler, Node portable ZIP SHA,
  Core TGZ SHA, dependency closure SHA).
- **Signed release artifact** (different bytes; hash after sign).

CI verifies Core TGZ SHA equality between Developer and Standard inputs.

## 19. Security notes (installer-specific)

- No global PATH modification for v1.
- Quoted args; no shell string concatenation for config generation.
- Atomic MCP config writes + backups.
- Software dir should not be world-writable; contexts remain user-controlled.
- Warn on suspicious context paths; resolve carefully.
- Do not download unsigned Node/Core from arbitrary URLs at install time in
  production builds (embed CI-verified payloads).

## 20. Platform scope

- **Primary:** Windows 11 x64.
- **Also target if cheap:** Windows 10 x64 (same Node portable build).
- macOS/Linux Standard installers: out of scope; keep path/launcher design
  portable in spirit.

## 21. Spike results (non-destructive)

Temp root used under `%TEMP%\pcw-30a-spike-*` (not committed).

| Proof | Result |
| --- | --- |
| `npm pack` Core | `pcw-mcp-0.3.0-beta.1.tgz` ~48 KB |
| Install from TGZ | Works; `--version` / `--help` OK |
| Context path with spaces | Server starts |
| Native deps | `@napi-rs/canvas` present; large install |
| Layout prototype | `runtime/`, `core/`, `bin/pcw.cmd`, `metadata/` |
| Synthetic MCP JSON merge | Possible without touching real client configs |

No real Codex/Cursor/Claude configs were modified.

## 22. Manual-beta migration

Existing ZIP/npm users:

- Keep their context roots untouched.
- Install Standard → point registration at **existing** context root.
- Leave old `node_modules` / ZIP trees in place until user deletes them.
- Doctor should accept existing valid roots.

## 23. Test plan (later implementation)

Clean install; spaces/non-ASCII paths; no-admin; existing vs new context;
malformed `pcw.yml`; each client synthetic config; preserve unrelated MCP
entries; idempotent reinstall; upgrade; uninstall preserves context; config
rollback; corrupt runtime; doctor; Core SHA match.

## 24. Deferred / risks

- Exact portable Node channel (22.x LTS vs 24) and update cadence.
- Whether to ship prebuilt `node_modules` vs online `npm ci` at build time
  only (never at end-user install if offline is required).
- SEA revisit after PDF stack slimdown or optional PDF feature flag.
- Codex/Cursor config path detection matrix on current client versions.
- integrations.json location relative to install vs LocalAppData\AI4Context.
- Authenticode certificate procurement.
- WiX/MSIX only if enterprise distribution requires MSI later.

## 25. Recommended implementation blocks after 30A

| Block | Scope |
| --- | --- |
| **30B** | Portable Node pin + Core expand/install script + `pcw.cmd` + doctor MVP |
| **30C** | Client adapters + safe merge + integrations.json |
| **30D** | Inno Setup wizard skeleton (no publish) consuming 30B payloads |
| **30E** | Release pipeline: `standard-windows-installer` artifact + SHA wiring |
| **30F** | Private-beta pilot of Standard EXE (unsigned or signed) |

## 26. Ready to implement?

BLOCK 30B now implements the staging runtime described below. Installer and
client adapters remain unimplemented.

## 27. BLOCK 30B implemented runtime

The staging command is npm run standard:runtime with explicit --core-tgz,
--node-runtime, --output, and optional exact --expected-node-version inputs.
It produces:

    standard-runtime/
      bin/pcw.cmd
      bin/pcw-doctor.cmd
      runtime/node.exe
      core/package.json
      core/package-lock.json
      core/dist/
      core/node_modules/
      package/pcw-mcp-<version>.tgz
      tools/doctor.mjs
      metadata/standard-runtime.json
      metadata/core-sha256.txt
      metadata/node-runtime.json
      metadata/runtime-files.json

The package copy is byte-identical to the explicit canonical Core TGZ. The
expanded tree derives from that archive. The builder rejects unsafe entries,
checks package name/version/dependencies against the explicit npm lockfile,
and runs npm ci --omit=dev --ignore-scripts during staging. End users never
run npm.

Metadata schema version 1 records Core version/SHA-256, package-lock SHA-256,
Node version/input SHA-256, npm build version, and windows/x64. It contains no
clock, username, machine name, or absolute input path. runtime-files.json
hashes installer-owned files and never describes user data.

## 28. Node pin

The first Standard beta should consume exactly
node-v22.23.3-win-x64.zip, SHA-256
2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71.
Future release tooling must pin its versioned Node.js URL and official
checksum; it must not resolve latest-v22.x dynamically.

The local 30B proof used an explicitly supplied Node 24.3.0 directory because
that runtime was already installed. This validates the input contract and Core
compatibility, but it is not the selected Standard release payload.

## 29. Launcher and quoting

bin/pcw.cmd resolves its installation root, invokes bundled node.exe with
core/dist/server.js, forwards arguments, emits no banner, and returns the Core
exit code. It preserves --context-root and is independent of current working
directory.

Windows tests pass install/context paths with spaces, parentheses, ampersands,
and non-ASCII characters unchanged. Batch files still retain cmd.exe semantics,
especially percent expansion and client-specific dispatch. The private beta
may use this tested launcher, but a small native pcw.exe shim is recommended
before broad public distribution. No native toolchain is introduced in 30B.

## 30. Doctor

pcw-doctor.cmd is separate from MCP stdout and checks runtime metadata, the
file manifest, exact Node version, retained Core TGZ SHA-256, expanded Core
identity/entrypoint, native PDF dependencies, context existence/access,
pcw.yml through compiled Core loadPcwConfig, and an MCP initialize plus
tools/list handshake with timeout and cleanup.

Doctor is read-only for existing contexts and reuses Core validation instead
of duplicating the Zod schema.

## 31. Initialization decision

Blank-root initialization is deferred. The current pcw-minimal.yml template
includes a placeholder workstream, while 30B requires no workstream creation.
Generating another shape in the wrapper would duplicate domain policy. A
bounded Core initialization API or no-workstream template needs approval
before Standard writes new roots. Existing valid roots work unchanged.

## 32. Measured local staging result

| Component | Approximate size |
| --- | ---: |
| Portable node.exe | 84.77 MiB |
| Expanded Core plus production dependencies | 110.03 MiB |
| Retained canonical Core TGZ | 0.05 MiB |
| Metadata, launchers and doctor | 0.51 MiB |
| Total | 195.36 MiB |

Largest dependencies: @napi-rs 35.12 MiB, pdfjs-dist 34.93 MiB, pdf-parse
20.27 MiB, and @modelcontextprotocol 7.26 MiB. No development dependencies
were installed.

## 33. Validation boundary

Cross-platform builder/domain tests stay in the normal suite. Actual cmd.exe
launcher tests run only on Windows. Staging stays under ignored artifacts/;
Node and generated node_modules are not committed. No Codex, Cursor, or Claude
configuration is read or modified. BLOCK 30B creates no installer, release,
upload, or publication.

## 34. BLOCK 30C client integration adapters

BLOCK 30C adds an installer-facing integration domain under
`scripts/standard-integrations/`. It is not part of PCW Core and does not
change the MCP, `pcw.yml`, release, or runtime contract. Tests inject all
home, state, context, launcher, and config paths; the implementation does not
probe the developer's real client configuration.

### Current client matrix

| Client | Status | Current Windows convention | PCW behavior | Reload |
| --- | --- | --- | --- | --- |
| Cursor | **SUPPORTED** | Global JSON at `%USERPROFILE%\.cursor\mcp.json`; project JSON at `<project>\.cursor\mcp.json` | Automatic mutation is limited to one uniquely detected or explicitly selected JSON config. PCW uses the global path by default; project configs require explicit selection. | Restart/reload required |
| OpenAI Codex | **GUIDED** | User TOML at `%USERPROFILE%\.codex\config.toml`; project TOML at `<project>\.codex\config.toml`; `codex mcp add` is also documented | Generates exact TOML/command guidance. PCW does not rewrite user TOML because the current implementation has no comment-preserving TOML writer. | Start a new/reloaded Codex host session |
| Claude Desktop | **GUIDED** | Current UI uses Settings > Extensions and MCPB; legacy local MCP uses `%APPDATA%\Claude\claude_desktop_config.json` | Generates structured guidance only. MCPB is a later block, and PCW does not automatically mutate the legacy JSON path while the preferred client mechanism is changing. | Restart Claude Desktop |
| Other MCP clients | **GUIDED** | Client-specific | Emits launcher, argument array, environment, and JSON/TOML snippets without claiming ownership of a config file. | Client-specific |

Sources reviewed for this snapshot: the
[Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp), the
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
the [Cursor MCP documentation](https://prod.cursor.com/docs/mcp), and the
[Claude Desktop local MCP guidance](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
These are external conventions, not immutable PCW contracts.

All clients support multiple named servers in their documented MCP model.
Automatic discovery is conservative: no config means `not-installed`;
multiple live candidates mean `ambiguous`; malformed or unsupported schemas
stop without mutation. An explicit config path must be absolute and still
passes file/schema/link validation.

### Neutral registration contract

The client-neutral input is:

- `registrationName`: trimmed, user-visible, at most 120 characters, with no
  control characters;
- `launcherPath`: an absolute path whose final name is exactly `pcw.cmd`;
- `contextRoot`: an absolute path;
- `pcwVersion`: installed PCW version;
- optional string environment entries, excluding PCW-owned variable names.

Adapters serialize only the stable launcher plus structured arguments:

```text
command: <install>\bin\pcw.cmd
args: [--context-root, <context-root>]
```

They never encode `runtime\node.exe`, `core\dist\server.js`, or
`node_modules`, and never concatenate a shell command. Paths containing
spaces, ampersands, parentheses, and Unicode remain literal argument values.

### Safe mutation and ownership

A supported mutation is: discover, read, parse, validate, back up, calculate
one semantic entry change, atomically replace, read back, verify unrelated
content, then atomically update the ownership ledger. Cursor JSON preserves
unrelated values and insertion order semantically, but standard JSON has no
comments and serialization normalizes whitespace. JSONC/comments or malformed
JSON are rejected instead of stripped.

The injected state root contains `integrations.json` (schema version 1) and
`backups/<client>/`. Each ledger entry records client, registration name,
config path, context root, stable launcher, PCW version, timestamps, backup
reference, and a SHA-256 fingerprint of only the managed entry. It stores no
environment values or client secrets. Backups contain the complete client
config and therefore may contain third-party secrets; PCW places them in its
controlled state area and requests owner-only permissions.

Existing-entry states are:

- `already-configured`: owned entry exactly matches;
- `update-available`: owned and unchanged since PCW wrote it, but requested
  launcher/context differs; update requires explicit approval;
- `conflict`: the name exists without matching PCW ownership;
- `drift`: the ledger owns the name but the user changed the entry;
- `missing`: no current entry.

Repeated apply is idempotent. Multiple names may point to different contexts
through one launcher. Removal requires matching ownership and fingerprint,
deletes only that entry, and preserves unrelated/current config. It never
deletes a context and never restores an old whole-file backup during normal
uninstall.

If ledger persistence fails after config mutation, PCW attempts a semantic
rollback of only its entry. If current state no longer makes that rollback
safe, the result is `recovery-required` with the backup location. This does
not claim transactionality across independent filesystems.

### Dry run, Doctor, and security boundary

`planIntegration` is the dry-run API and performs no writes.
`inspectOwnedIntegration` can be supplied as the optional
`Client integration` check in Standard Doctor. Client integration is never
required for Core runtime health.

Mutations reject non-regular config files, direct config/parent links, invalid
registration names, missing/link launchers, and missing/link context roots.
Atomic writes use a same-target temporary file through `write-file-atomic`.
Residual limitations remain: ancestor junctions above the immediate config
directory, Windows ACL quality, and TOCTOU between validation and replacement
cannot be eliminated by this user-space adapter. Unexpected schema evolution,
ambiguous paths, parse errors, conflicts, and drift fail closed. No process is
killed or restarted.

## 35. BLOCK 30D engineering installer prototype

BLOCK 30D adds an unsigned Inno Setup skeleton around the prebuilt Standard
runtime. It is engineering-only and is deliberately excluded from release
manifests, checksums, GitHub publication, Vercel, and AI4Context downloads.
The prototype output name is
`PCW-Setup-0.3.0-beta.1-prototype.exe` so it cannot be mistaken for a frozen
release artifact.

### Toolchain and build input

The installer build helper pins **Inno Setup 6.4.3**. The compiler is an
explicit `--iscc` input and its reported version must match exactly. The build
also requires explicit `--runtime-dir` and `--output-dir` paths:

```text
npm run standard:installer -- \
  --runtime-dir <prebuilt-standard-runtime> \
  --output-dir <prototype-output> \
  --iscc <absolute-path-to-6.4.3-ISCC.exe>
```

The installer build reads `metadata/standard-runtime.json`, validates the
Windows x64 identity, and embeds the complete runtime directory without
changing it. It does not build Core, run npm, download Node, resolve
production dependencies, or rewrite the retained canonical TGZ. Generated
installer metadata records only a schema version, software version, Core TGZ
SHA-256, runtime schema, Windows/x64 target, prototype status, and unsigned
status. It records no build path, username, hostname, random ID, or implicit
wall-clock time.

Inno Setup was not installed on the BLOCK 30D development machine. Static
validation and a synthetic compiler contract test passed; no real EXE was
compiled or installed in this block. The first executable spike must use the
pinned 6.4.3 compiler before this prototype can advance.

### Install and state locations

The default no-admin install location is:

```text
%LOCALAPPDATA%\Programs\AI4Context\PCW
```

Mutable integration ownership and recovery state remains separate:

```text
%LOCALAPPDATA%\AI4Context\PCW\state
```

The installer does not modify user or system `PATH`. MCP registrations refer
only to `<install>\bin\pcw.cmd`. There is no generic GUI launch shortcut;
PCW is an MCP stdio server. Doctor remains a separate command and never emits
human diagnostics onto MCP stdout.

### Wizard and helper contract

The prototype wizard follows: Welcome, install location, existing context,
client integration, registration name, review, installing, verification, and
finish. Normal pages do not expose TGZ, npm, `node_modules`, package locks, or
stdio details.

The context page accepts only an existing context containing `pcw.yml`. This
is a lightweight UI preflight, not schema validation. After runtime copy and
before finish, the installed helper loads the configuration through compiled
Core `loadPcwConfig`; it does not duplicate the Zod schema. The page states
that new-context creation is not enabled in this prototype.

The runtime now includes `core/standard-tools/standard-setup.mjs` and the 30C integration
modules. Its machine commands are:

- `validate-context`: validate an existing root through Core;
- `detect-clients`: inspect only explicitly supplied/injected client roots;
- `plan`: return a dry-run integration plan with zero mutation;
- `apply`: delegate supported mutation to the 30C service;
- `remove`: delegate one removal, or semantic removal of all ledger-owned
  registrations for uninstall;
- `doctor`: delegate runtime/context/MCP checks to the 30B Doctor service.

Success is one JSON object on stdout. Failures are one JSON object on stderr
and a nonzero exit status. An optional explicit `--result-file` lets Inno read
the same machine result without parsing logs. Paths remain separate arguments;
the helper never accepts a concatenated shell command.

Cursor is the only automatic adapter. Planning occurs before apply, and the
30C service owns backup, atomic mutation, verification, collision/drift
handling, ledger updates, and rollback. Codex returns generated guided TOML
and command information without editing `config.toml`. Claude Desktop returns
guided/MCPB-planned information without changing legacy JSON.

### Transaction, reinstall, and uninstall

The orchestration order is: copy runtime, validate installed runtime/context,
plan integration, apply selected supported integration, verify, run Doctor,
and finish. Runtime installation may remain when integration fails; the error
is shown, the context is never removed, and 30C rollback/recovery semantics
remain authoritative. This is not represented as one cross-filesystem atomic
transaction.

A same-version reinstall replaces installer-owned runtime files while leaving
context roots and the external state directory untouched. Reapplying an
unchanged owned registration is idempotent; changed owned registrations are
planned and require the installer-selected update path. No online updater is
implemented.

During uninstall, the user is explicitly asked whether PCW-owned client
registrations should be removed. Selection calls `remove --all-owned`, which
uses the 30C ledger and semantic removal. Conflict, drift, and recovery-required
states fail closed. Whole-file backups are never restored as normal uninstall.
The runtime is removed by Inno; contexts, integration state, and recovery
backups are preserved. This allows diagnosis and manual recovery.

### Logging and security boundary

Inno setup logging is enabled. Helper output contains status, selected paths,
version, and controlled error details, but never serializes third-party config
contents, environment secrets, tokens, or credentials. Client configuration
and state locations are injected in automated tests; no developer Codex,
Cursor, or Claude configuration is read or written.

The prototype is unsigned, so Windows SmartScreen warnings are expected.
Signing and post-signature artifact hashing remain release-pipeline work.
No installer output is added to the release artifact set in BLOCK 30D.

### Blank-root gate

The installer architecture is technically ready for an executable engineering
spike against existing valid PCW contexts, subject to compilation with pinned
Inno Setup 6.4.3. It is **not ready for the real User1 Standard pilot** because
Core has no approved new-context initialization contract.

The next bounded block should add and test one official Core-owned
initialization API/contract that creates a minimal valid context without an
implicit workstream. Only after that contract is approved should the installer
offer new-root creation. The Inno script must continue to call the Core helper
rather than generating `pcw.yml` itself.
