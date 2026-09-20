# GitHub Actions release-build verification

`.github/workflows/release-build.yml` is separate release-build verification
infrastructure. It does not create a GitHub Release, tag, registry publication,
or private-beta download channel. The existing `ci.yml` remains the branch/PR
CI path.

## Development verification

Pushes to `v0.3-distribution` run the workflow as development verification.
`workflow_dispatch` is retained for future manual use, but GitHub requires
the workflow file on the default branch (`main`) before it can be dispatched.
After an authorized integration into `main`, an operator may select an
appropriate ref. Both triggers produce development-grade results; neither
creates an official release.

The repository is public. Actions artifacts are accessible to readers, so
acknowledgement inputs are not access control. GitHub Actions builds and
checks the full private-beta set on its ephemeral runner, but it does not
upload the Core TGZ or handoff ZIP. Controlled private-beta delivery is
deferred to the AI4Context/Vercel distribution phase.

Validation runs `npm ci`, `npm run build`, and `npm test` on Node `22.x` and
`24.x`; Node 22 also runs `npm run test:package-install`. Packaging waits for
both successful jobs. It uses `ubuntu-24.04` and exact Node `24.3.0`, whose
bundled npm is `11.4.2`; the job asserts both versions before `npm ci`. This
pin controls the current packaging toolchain without changing PCW's runtime
requirement (`>=22.9.0`) or the compatibility matrix. The lockfile fixes the
dependency graph. Runner image updates and upstream action versions can still
affect future cross-run reproducibility; this workflow proves two builds on
the same checkout and job, not bit-for-bit portability across builders.

The packaging job runs `release:build` twice with `--channel private-beta`.
After each build, `scripts/verify-release-set.mjs` independently checks the
exact four-file set, manifest descriptors and artifact sizes/hashes,
`SHA256SUMS.txt`, and byte identity between the top-level TGZ and the TGZ in
the handoff ZIP. It snapshots all four first-build SHA-256 values outside the
release set and rejects any second-build difference. The existing release
build continues to run the package allowlist and installed-handoff privacy
smoke tests. After a successful comparison, the verifier copies only
`release-manifest.json` and `SHA256SUMS.txt` and writes
`verification-report.json`. The report records source commit, software version,
channel, actual packaging Node/npm versions, all four hashes, deterministic
comparison, Core byte identity, and success. Only these three non-binary
metadata files are uploaded with `actions/upload-artifact`, under a name
containing PCW, version, channel, source SHA, and run ID. Retention is seven
days. Neither TGZ nor ZIP bytes are retained as an Actions artifact. Push and
manual runs use a development-grade manifest, even on a clean checkout; they
do not pass `--release`.

## Future annotated-tag runs

An automatic `v*` tag trigger is intentionally deferred. Before enabling it,
decide the release-grade distribution channel and access policy. The existing
`release:build --release`
already requires a clean tree and matching annotated `v<package-version>` tag
at HEAD. A tag workflow should derive `--released-at` deterministically from
the annotated tagger timestamp, convert it to canonical UTC ISO-8601, and
reject missing/lightweight/mismatched tags. It must not use runner wall time.
No tag, release-grade run, or binary publication is performed by this
workflow.
