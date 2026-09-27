# Local release build

`npm run release:build -- --channel private-beta` builds one local release set
under `artifacts/releases/<package-version>/private-beta/`. This command does
not publish, upload, sign, or tag anything. It reuses the existing
`package:private-beta` path, including its build, tests, package inspection,
and installed-handoff smoke test. The Core tarball is built first with the
same `npm pack` helper used by standalone private-beta packaging. The handoff
then embeds that exact tarball; the release builder compares the embedded
bytes to the top-level Core before finalizing. It never obtains the canonical
Core by extracting the ZIP. The legacy `artifacts/private-beta/<version>/`
output remains available, and `npm run package:private-beta` still works alone.

The base private-beta release set contains:

- `pcw-mcp-<version>.tgz`
- `PCW-MCP-<version>-PRIVATE-BETA.zip`
- `release-manifest.json`
- `SHA256SUMS.txt`

The manifest uses the existing v1 descriptor and provenance contract. It
describes the TGZ and ZIP, including their final-byte sizes and SHA-256 values.
`SHA256SUMS.txt` hashes those two files plus `release-manifest.json`, sorted by
relative filename, with LF line endings. Neither metadata file hashes itself;
the manifest does not describe `SHA256SUMS.txt`, avoiding a checksum cycle.
The build independently verifies each artifact against the manifest and all
three checksums before finalizing.

The build uses a fresh staging directory below the exact version directory.
Only after all checks pass does it replace the exact channel directory. A
failed rebuild retains the previous completed release set; staging data is
removed. An existing directory from a previous run cannot contribute stale
files to the new set. Only the controlled `artifacts/releases/<version>/`
location is replaced; no other channel or version is cleaned.

Development builds may have `source.dirty: true`; such manifests are for
development/debugging and are **not** release-grade source provenance. No
wall-clock release date is implicit. Release-grade finalization must consume a
previously transported canonical Core; it cannot run the source packer. Its
invocation is conceptually:

```text
npm run release:build -- --channel private-beta --release --released-at 2026-09-19T12:00:00.000Z \
  --core-tgz <downloaded-canonical-core.tgz> \
  --core-transport-metadata <core-transport.json> \
  --expected-source-commit <40-hex-commit> \
  --release-invocation <approved-invocation-id>
```

The date must be explicitly approved and canonical UTC. Release grade retains
the manifest generator's requirements: clean Git tree, annotated
`v<package-version>` tag at HEAD, and Git-ignored or external output. It is
not available for the current untagged release candidate. See
[release manifest generation](release-manifest.md) for the provenance contract.

The architecture names `private-beta`, `beta`, and `stable`, but this command
currently supports **only `private-beta`**. `beta` and `stable` fail clearly;
there is no MCPB artifact yet. Repeated local builds
from identical inputs should produce identical hashes for all four files.
Cross-platform bit-for-bit reproducibility remains unproven.

## Cross-job canonical Core transport

The GitHub Actions release validation uses one explicit invocation identity:
`github-<run-id>-<run-attempt>`. An Ubuntu producer creates the Core TGZ once
and writes `core-transport.json` with software version, source commit,
invocation, filename, byte length, and SHA-256. The temporary artifact contains
only those two files. Windows downloads the actual TGZ, recalculates its hash,
and verifies every identity field before runtime assembly. GitHub's artifact
ZIP wrapper is not an identity source: the extracted TGZ bytes must still hash
to the producer value.

Windows builds independent unsigned installers A and B, proves reproducibility,
runs Doctor and the MCP lifecycle against exact A, confirms the context survives
uninstall, and returns exact A plus `standard-verification.json` and
`standard-transport.json`. Finalization downloads both transports, checks Core,
installer, version, commit, invocation, and evidence hashes, then creates the
handoff and development release-set verification from the transported Core. It
does not rebuild the installer. Release-grade `release:build` refuses to run
without the transferred Core arguments, so `npm pack` cannot silently replace
the producer's bytes. The standalone/PR Windows engineering path may still pack
a disposable Core and does not upload its installer.

Both binary transport artifacts use one-day retention and deterministic names
containing the workflow run ID and attempt. They are CI transport, not
publication. In this
public repository they may be downloadable by people who can access Actions;
short retention does not make them secret. The seven-day retained verification
artifact still contains only `release-manifest.json`, `SHA256SUMS.txt`, and
`verification-report.json`. No GitHub Release or product download URL is
created. A release whose bytes must remain private needs direct handoff to the
authorized AI4Context publication store or another access-controlled transport.

Pushes use development dry-run mode. Manual dispatch also defaults to
`release-grade: false`. The release-grade switch is only an orchestration gate:
the existing clean tree, non-development version, annotated version tag, and
explicit `released-at` checks still apply. When authorized, it finalizes the
downloaded Standard EXE and evidence directly; it does not invoke Inno again.

The separate GitHub Actions verification pipeline is described in
[release CI](release-ci.md). None of its workflow artifacts is a published
release.

A release-grade invocation may additionally supply a verified
PCW-Setup-<version>.exe and its evidence. The manifest then describes
standard-windows-installer / windows-installer for windows/x64 with Node
22.23.3, and SHA256SUMS.txt includes it. The optional Standard input is refused
in development build mode and for development software versions. There is no
MCPB artifact yet.
