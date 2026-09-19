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

The release set contains exactly:

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
wall-clock release date is implicit. Release-grade invocation is:

```text
npm run release:build -- --channel private-beta --release --released-at 2026-09-19T12:00:00.000Z
```

The date must be explicitly approved and canonical UTC. Release grade retains
the manifest generator's requirements: clean Git tree, annotated
`v<package-version>` tag at HEAD, and Git-ignored or external output. It is
not available for the current untagged development version. See
[release manifest generation](release-manifest.md) for the provenance contract.

The architecture names `private-beta`, `beta`, and `stable`, but this command
currently supports **only `private-beta`**. `beta` and `stable` fail clearly;
there is no Standard installer or MCPB to include yet. Repeated local builds
from identical inputs should produce identical hashes for all four files.
Cross-platform bit-for-bit reproducibility remains unproven.
