# Distribution Architecture (BLOCK 20)

Status: proposed architecture, not an implemented installer or publication plan.
Frozen baseline: `v0.2.0-beta.4` at
`33937d23cad616fa30e88f0a6e40c02af89a5b3c`.
The existing private-beta ZIP SHA-256 is
`2cfaf828e59de0b3387e6fde15e01e3a3c32632d6cb3ccecc3e7609fe32a14f2`;
its nested npm tarball SHA-256 is
`919664ba081fe325f87d84dcb69fc6acfd27edb7133d5ff8d210c768d8910eef`.
Neither artifact is a Standard installer or an MCP Bundle.

## Decision and current boundary

PCW has one TypeScript Core and one local stdio MCP implementation. Standard,
MCP Bundle (MCPB), and Developer are delivery experiences around that same
implementation, not forks. `package.json` remains the software version source
of truth. The independent, currently optional `pcw.yml.version` is a config
marker, not a software version or a reliable migration gate yet.

The existing `pcw-mcp-<version>.tgz` is the **current preferred canonical
Core payload**, provisionally, pending Standard and MCPB packaging proofs.
`npm pack` already
selects compiled `dist/`, package metadata, public documentation, templates,
and the synthetic example through the package allowlist. The private-beta ZIP
contains this exact tarball plus handoff material and checksums; its clean
installation is tested. Keeping one payload makes version, file allowlist,
MCP contract, and provenance reviewable in one place. It does **not** imply
that end users must run npm: a Standard installer may install or transform
this payload internally, while an MCPB wrapper may include it. Both must prove
that they run the same built Core and resolve its production dependencies.
If embedded Node or MCPB rules make direct tarball reuse impractical, derive a
self-contained payload from the *same Core source, version, and tag* and verify
its MCP contract against the tarball. Identical internal archives are not
required; a second Core implementation is not allowed.
Cross-platform bit-for-bit reproducibility of the tarball is not yet proven.

Currently `private: true` and `UNLICENSED` are intentional. The local tarball
is installable from a file but is not an npm-registry publication. The existing
`npm run package:private-beta` creates a local, ignored ZIP and checksum; it
does not publish. The ZIP was reproduced twice on the beta.4 Windows host.
CI covers Node 22 and 24, with packaged-install smoke on Node 22. The declared
runtime minimum is Node `>=22.9.0`; the exact minimum has not been separately
certified on every target OS.

## Delivery experiences

| Responsibility | Standard (first target: Windows) | MCPB | Developer |
| --- | --- | --- | --- |
| User and install | Nontechnical user; eventual guided installer, with no Node/npm/shell or manual MCP JSON/TOML work | User of a client that supports bundle installation; client-native install flow, subject to compatibility proof | Technical user; local tarball or, after authorization, registry package and manual MCP setup |
| Contents | Same Core plus resolved runtime/dependencies, installer, and client integration | Same Core plus the format's manifest/runtime material, with no separate PCW logic | Current preferred Core tarball and its production dependencies |
| Configuration owner | Installer/configuration companion guides setup and registers a selected root; user owns the context | Host/bundle integration selects or requests a root; user owns the context | User selects `--context-root` or `PCW_CONTEXT_ROOT` and registers the stdio server |
| Runtime owner | Installed local PCW process launched by the configured MCP client; packaging must provide a working runtime | MCPB host launches the included local stdio server under its supported runtime rules | User-provided Node and MCP client launch `dist/server.js` |
| Updates | Future installer/update mechanism, with explicit verification and rollback plan | Host's supported bundle update mechanism, to be validated | User replaces the installed package intentionally |
| Uninstall and data | Remove software and client registration; preserve contexts by default | Remove bundle/registration; preserve external contexts by default | Remove package/registration; preserve contexts by default |

Standard automation is a product target, **not** a beta.4 capability. No
installer, MCPB, update service, remote transport, or automatic client
configuration exists today. Each packaging proof must test the target MCP
client rather than assume all clients offer the same registration API.

## Artifact and channel model

Proposed names (not files to generate in this block):

| Artifact | Role |
| --- | --- |
| `pcw-mcp-<version>.tgz` | Current preferred canonical Core payload; Developer installation and provisional input to other packages |
| `PCW-<version>-win-x64-setup.exe` | Standard Windows installer candidate; final extension/technology is undecided |
| `PCW-<version>.mcpb` | MCP Bundle candidate, only after host/runtime compatibility testing |
| `PCW-MCP-<version>-PRIVATE-BETA.zip` | Existing private handoff kit, not an installer |
| `release-manifest.json` and `SHA256SUMS.txt` | Release metadata and byte-level integrity for distributed artifacts |

`private-beta` is restricted to authorized evaluators and can retain
`UNLICENSED`/`private: true`. `beta` is a broader prerelease only after terms,
license, security, and delivery approvals. `stable` is for a release judged
supportable. A verified *identical* version and artifact may be promoted from
private-beta to beta without rebuilding it; separate immutable channel
publication records may point to the same hashes. A SemVer prerelease such as
`0.2.0-beta.4` must not be represented as stable: a stable promotion needs an
appropriate non-prerelease software version, tag, and release build. Channel
is distribution/audience metadata; SemVer identifies the software, not its
storage location. Channel-specific storage paths prevent naming collisions.

## Provenance and release pipeline

Proposed controlled flow:

1. Review a clean commit and run build, tests, installed-package smoke, and
   package/privacy inspection. CI must verify the exact commit.
2. Create a protected annotated version tag pointing to that commit. CI for
   tagged releases is a future gate; current CI runs on branch pushes/PRs.
3. Build the Core payload once from the tag and verify its allowlist. Create
   each wrapper from that payload or prove equivalence to the tagged build.
4. Compute SHA-256 and sizes from the final bytes. Compare repeat builds where
   practical; record any nondeterministic signing or installer layers.
5. Produce an immutable, schema-validated release manifest binding version,
   tag, commit, channel, and artifact hashes. Sign manifests/artifacts when a
   signing policy exists. Publication must not mutate already hashed bytes.
6. After explicit release approval, upload artifacts and a channel publication
   record to authorized storage. AI4Context's product page/API reads approved
   release metadata and serves or redirects downloads; it is not a dependency
   of PCW Core or the stdio runtime.

No upload or page integration is implemented by this decision. An official
checksum proves integrity against an independently trusted release record;
SHA-256 alone does not prove who published the artifact.

## Proposed release manifest

Manifest v1 is now generated and validated by the repository's Zod-based
script; see [release manifest generation](release-manifest.md) for its exact
fields and provenance rules. It records schema version, product/software
version, channel, Git commit/tag/dirty state, optional explicit UTC release
date, and artifact IDs/types/names/targets/runtime/byte sizes/SHA-256.
Logical release-notes references and config compatibility remain future
extensions, not fields currently emitted by the generator.

An artifact's stable ID identifies it without tying the release record to a
storage provider. A separate publication mapping resolves
`(channel, version, artifactId)` to a controlled download URL or storage object
key; provider-specific fields such as Vercel Blob IDs belong there, not in
the Core manifest. The publication mapping also resolves release-notes IDs
to locations. Both records need validation and immutability rules before use.
Do not invent a numeric minimum config version: current `pcw.yml.version`
is optional and accepts strings or numbers.

Illustrative future extension of manifest v1 (the date and notes ID are
placeholders, not published beta.4 metadata):

```yaml
manifestSchemaVersion: 1
productId: pcw-mcp
softwareVersion: 0.2.0-beta.4
channel: private-beta
source:
  gitTag: v0.2.0-beta.4
  gitCommit: 33937d23cad616fa30e88f0a6e40c02af89a5b3c
releasedAt: <approved UTC release timestamp>
releaseNotesId: <versioned notes identifier>
configCompatibility: null
artifacts:
  - artifactId: core-npm-tarball
    fileName: pcw-mcp-0.2.0-beta.4.tgz
    type: npm-tarball
    target:
      os: any
      arch: any
    runtime:
      node: '>=22.9.0'
    sizeBytes: 48003
    sha256: 919664ba081fe325f87d84dcb69fc6acfd27edb7133d5ff8d210c768d8910eef
```

Use real approved metadata in a published record. Add only artifacts that
actually exist, with hashes and sizes computed from their final bytes.

## Software and user data

First Standard Windows candidate: a per-user software install below
`%LOCALAPPDATA%\Programs\PCW\` to avoid admin rights, with versioned binaries
and dependencies. A machine-wide `%ProgramFiles%\PCW\` install is a separate
option requiring elevated install/uninstall testing. Default new-context
suggestion: a user-owned location such as `%USERPROFILE%\Documents\PCW\`,
subject to user choice and Windows folder redirection. Existing contexts may
remain wherever the authorized user selected. Do not put writable context
state under the software directory, inside an MCPB, or inside the npm package.
One PCW registration currently maps to one context root; multiple projects
still need separate registrations.

Context data includes `pcw.yml`, inventory, sources, continuity, and
`.pcw/history`. Installer preferences or client registrations are not the
context itself. Upgrade replaces software independently and preserves every
context byte unless an explicit, separately approved migration is needed.
Uninstall removes software and optionally registrations, not contexts. Any
destructive context deletion requires a separate, clearly named user action;
it is never implied by uninstall. A future schema migration needs a preflight,
backup, recovery/rollback plan, compatibility check, and explicit consent.

## Trust and ownership

Every distributed file needs a final-byte SHA-256 in the release record, a
traceable tag/commit, an allowlist/privacy scan, and installed-artifact smoke
testing. Reproducibility is a goal for Core and unsigned wrappers; record
builder OS/toolchain and compare independent builds before claiming it.
Windows Standard distribution will require publisher trust and code signing
before broad delivery. Unsigned private-beta artifacts must be clearly labeled
as restricted evaluation builds, verified against an out-of-band trusted hash,
and never presented as signed or generally safe to run. Signing may make final
bytes differ; hash and record the signed artifact. Protect release credentials
and signing keys outside the repository.

| Owner | Boundary |
| --- | --- |
| `pcw-mcp` repository | Core/runtime, MCP adapter, public contracts, build/packaging scripts, synthetic examples, release-manifest schema and local validation |
| AI4Context web/application repository | Product page, entitlement or download UX, approved release metadata display, and storage-provider integration; no PCW Core fork |
| External artifact storage | Immutable release bytes and controlled access/retention; no source of truth for software version or MCP behavior |
| npm registry | Developer delivery only after an explicit publication/license decision; not a requirement for Standard or MCPB |
| GitHub Releases / CI | CI checks, provenance evidence, optional approved release publication; not a substitute for user-data storage or a signed installer |

## Deferred proofs and risks

- Select Windows installer technology and per-user versus machine-wide scope
  after testing client registration, rollback, uninstall, and folder rights.
- Decide user-supplied Node versus embedded/self-contained runtime after
  measuring offline installation, dependency closure, size, and security
  update burden. Standard must not require users to install Node or npm.
- Validate the actual MCPB specification and target clients' runtime and
  context-root configuration rules before choosing its internal layout.
- Design updates and rollback only after version/channel and context-preserving
  install behavior are demonstrated. Never silently migrate user contexts.
- Choose signing provider/certificate and verification policy before broad
  Windows delivery. Decide how unsigned private builds are communicated.
- Choose storage and AI4Context/Vercel delivery only after entitlement,
  immutable artifact IDs, access control, and download integrity are defined.
- Resolve licensing, redistribution rights, dependency notices, and the
  `private: true` policy before public beta or npm publication.
- Define a real config-schema compatibility mechanism before populating
  `configCompatibility`; optional `pcw.yml.version` cannot safely drive an
  automatic migration today.
- Reconcile platform-specific build reproducibility: npm tarball, installer,
  MCPB, signing, and timestamps may differ across builders even when the
  frozen Windows private-beta ZIP reproduced locally.

The next work should be a bounded packaging feasibility proof, not a second
PCW implementation. This record creates no installer, MCPB, publication,
update mechanism, or change to the frozen beta.4 runtime contract.
