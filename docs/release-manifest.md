# Release Manifest Generation

The versioned `release-manifest.json` describes built artifact bytes and their
Git provenance. It does not publish artifacts or contain download URLs. The
generator lives in `scripts/generate-release-manifest.mjs` and uses the
repository's existing Zod dependency for runtime validation. There is no
portable JSON Schema file yet; consumers outside this repository must treat
the documented v1 fields as the contract until such a schema is added.

## Inputs

`package.json` supplies `productId` (package name) and `softwareVersion`.
Git supplies the full HEAD commit and worktree state. The caller supplies a
channel (`private-beta`, `beta`, or `stable`), an artifact descriptor, an
output path, and optionally an explicit release date. No value is inferred
from a filename except its basename for `fileName`.

Descriptor example (paths are relative to the descriptor file):

```json
{
  "artifacts": [
    {
      "artifactId": "core-npm-tarball",
      "type": "npm-tarball",
      "file": "pcw-mcp-0.3.0-dev.0.tgz",
      "target": { "os": "any", "arch": "any" },
      "runtime": { "node": ">=22.9.0" }
    }
  ]
}
```

`artifactId` must be unique and stable within a manifest. `type` is an
explicit identifier rather than a filename guess. `target` and `runtime`
are optional when not applicable. Supported target OS values are `any`,
`windows`, `macos`, and `linux`; architectures are `any`, `x64`, and
`arm64`. The descriptor's local `file` path is never serialized into the
manifest. Unknown descriptor fields, including publication URLs, are rejected.
The generator hashes each existing regular file, counts its bytes, and sorts
the resulting records by `artifactId`.

From a source checkout, after creating an artifact and descriptor:

```text
npm run release:manifest -- --channel private-beta --descriptor artifacts/descriptor.json --output artifacts/release-manifest.json
```

The output path is explicit. `artifacts/` is ignored by Git, so development
generation does not add generated files to the repository. The generator
neither runs `npm pack` nor creates the private-beta ZIP: it describes files
that already exist. The existing `npm run package:private-beta` and other
package commands remain separate.

## Provenance and release-grade mode

Development mode permits an uncommitted tree and records
`source.dirty: true`; `source.gitCommit` still identifies the actual HEAD.
`source.gitTag` is null unless the tree is clean and an annotated
`v<softwareVersion>` tag points at HEAD. A dirty tree cannot be represented
as a tagged clean release. A dirty manifest is for development/debugging only:
HEAD plus `dirty: true` does not uniquely identify uncommitted source bytes,
so it is **not** release-grade reproducible Git provenance. Artifact SHA-256
still verifies the artifact bytes, but does not fill that source-provenance gap.

For a release-grade manifest, pass `--release` and an explicit canonical UTC
timestamp such as `--released-at 2026-09-19T12:00:00.000Z`. The timestamp
must be the approved release date, not the time the command runs. Release
grade requires a clean tree and a matching annotated version tag; it cannot
be used for the current untagged `0.3.0-dev.0` development line. The frozen
`v0.2.0-beta.4` tag is not changed or reused by this script.
The matching annotated tag must resolve to HEAD; release output records
`source.dirty: false`.
Release-grade output must be outside the repository or in a Git-ignored path,
so writing the manifest cannot invalidate its clean-tree claim.

No implicit wall-clock field is generated. Given the same Git state, package
metadata, descriptor, artifact bytes, channel, and explicit date, the
two-space-indented JSON with a final newline is byte-identical. Artifact
files must remain unchanged while being hashed.

## Manifest v1

The generator emits `manifestSchemaVersion: 1`, `productId`,
`softwareVersion`, `channel`, `source` (`gitCommit`, `gitTag`, `dirty`),
an optional `releasedAt`, and `artifacts`. Each artifact has
`artifactId`, `type`, `fileName`, `sizeBytes`, `sha256`, and optional
`target`/`runtime`. Version 1 is independent of the PCW software version.
`configCompatibility` is omitted because the current optional
`pcw.yml.version` does not yet define a meaningful migration range.

The manifest describes **what was built**, not **where it was published**.
Vercel Blob IDs, GitHub/S3/CDN locations, signed URLs, and other provider
state belong to a future publication mapping. SHA-256 must be checked
against a separately trusted release record; a hash by itself is not
publisher authentication.
