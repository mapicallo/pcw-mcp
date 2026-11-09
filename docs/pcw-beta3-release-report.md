# PCW 0.3.0-beta.3 Private-Beta Release Closure

## Status

PCW `0.3.0-beta.3` is **RELEASED** as a restricted private beta. The private
publication is live, the public `/pcw` delivery page is live, and both Preview
and Production smoke tests passed.

This release is **NOT GA** and **NOT STABLE**.

## Release identity

| Field | Value |
| --- | --- |
| Version | `0.3.0-beta.3` |
| Source commit | `d7f91a44d1c544b38330470cc206f05ec9aad063` |
| Annotated tag | `v0.3.0-beta.3` |
| Tag object | `3e6114b6ce1e5338f168c6deea63facc2c874936` |
| Released at | `2026-11-09T15:02:47.000Z` |
| Channel | `private-beta` |
| Visibility | `restricted` |

The tag resolves to the exact frozen source commit. The release manifest uses
schema version 1 and records a clean, tagged source tree.

## Authoritative artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `pcw-mcp-0.3.0-beta.3.tgz` | 51,669 | `387bdb660a332fd7a7234fb7b0c9b4b5fceae7efc48be47cc1033b0c471e326b` |
| `PCW-MCP-0.3.0-beta.3-PRIVATE-BETA.zip` | 88,319 | `7dca52bd70dbeb81987d168fda7b6dd5ea13453ff5735c68d12aa71ecbb97ffa` |
| `PCW-Setup-0.3.0-beta.3.exe` | 41,994,956 | `5c24d816b23fe5e584e5089a0a253f9a4cf314845d802477532c3067346c3f10` |
| `release-manifest.json` | 1,455 | `d684db63c4cc41c055c3a34f2f9ccdf8edc845ca00ffb44d1e81a1e0c8ee7bbc` |
| `SHA256SUMS.txt` | 376 | `697fabea43be1e8ac005857c169e33a8949f4c9892a83bec5d3d5a0a4d776f94` |

The ZIP contains the exact canonical Core TGZ. The Standard Windows runtime
uses Node `22.23.3` from pinned input SHA-256
`2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71`,
npm `11.4.2`, and Inno Setup `6.4.3`. The installer is per-user and unsigned.

## Hardening delivered

- Cursor cold-start distinguishes an installed client with a missing canonical
  global config from a client that is not installed.
- Standard setup propagates explicit `--local-app-data`, then `LOCALAPPDATA`,
  with a conservative undefined fallback.
- Missing Cursor configuration is created exclusively (`wx`) with no-clobber
  behavior and rollback after ownership-ledger failure.
- Ownership ledger schema 2 records `pcw-created` versus `pre-existing` origin
  and the exact created-config SHA where applicable. Version 1 is read
  conservatively as pre-existing; unknown future schemas fail closed.
- Remove-to-absent deletes a PCW-created config only when no unrelated MCP
  server or top-level user data remains. Pre-existing and adopted files are
  preserved.
- Drift, fingerprint, backup, file-identity, rollback, and recovery-required
  paths remain fail closed.

The public Core contract did not change: 16 MCP tools, 19 public error codes,
the existing `pcw.yml` schema, and release manifest schema version 1 remain in
place. No beta.3 hardening change was made under `src/`.

## Validation and lifecycle

- Full suite before freeze: 337 total, 335 passed, 0 failed, 2 skipped.
- The two skips were real symlink-mutation tests that Windows refused with
  `EPERM`; directory and regular-file replacement paths passed.
- Packaged-install checks: 2/2 passed.
- Core TGZ, private ZIP, and unsigned Windows EXE each rebuilt byte-for-byte
  identically under the controlled toolchain.
- The exact official EXE passed Doctor, MCP initialization, 16-tool discovery,
  synthetic workstream creation, fresh Cursor apply/remove-to-absent,
  pre-existing/adopted-config preservation, and uninstall preservation.
- Uninstall removed the runtime while preserving context, continuity, state,
  and recovery backups.

## Private publication and web delivery

The three authoritative artifacts are stored under
`pcw/releases/0.3.0-beta.3/private-beta/`. The immutable catalog commit point is
`pcw/catalog/v1/releases/0.3.0-beta.3/private-beta/publication.json`, written
last with status `published`, restricted visibility, and no general download
availability. Private publication is not public catalog discovery.

The `/pcw` page recommends Standard Windows, offers the private ZIP as the
alternate delivery, and does not expose Core as a browser-selectable download.
Preview deployment `dpl_HECy9a38a8wZLqvX49S4uC3hZ9g9` and Production
deployment `dpl_A6Zbxtm2vdxDkiRSuxXUg8t4bZRF` both passed request, approval,
grant, redemption, exact-byte download, revocation, and post-revocation denial
checks. All smoke grants were revoked.

Production was a Vercel rebuild of the exact validated Preview commit
`4d80bd693d1fc078b722a50b0a4b483460745157`; it was not a byte promotion of
the Preview deployment itself.

## Security model and accepted limitations

PCW remains local-first. Contexts are user-owned and are never installer-owned.
Client mutation is limited to owned semantic entries, uses backups and
fingerprints, and does not restore whole client files during normal removal.
Release artifacts are immutable after freeze, and publication metadata is
written only after artifact upload and verification.

Accepted private-beta limitations:

- the Windows installer is unsigned, so SmartScreen may appear;
- real symlink mutation tests remain skipped on the current Windows host due to
  `EPERM`;
- a narrow pathname TOCTOU interval remains between final `lstat` and `unlink`;
- only the canonical Cursor installation marker is automatically detected;
- Cursor JSONC is not rewritten automatically;
- runtime metadata records Core and toolchain identity but does not currently
  encode the Git source commit;
- Codex and Claude integrations remain guided rather than automatic;
- there is no GA support, automatic updater, remote MCP, or public package
  publication.

## Release invariants

1. Build the canonical Core once per release set.
2. Every wrapper consumes the exact canonical Core bytes.
3. Freeze and tag the exact source commit before release-grade finalization.
4. Never rebuild release artifacts after freeze.
5. Treat published artifact paths as immutable.
6. Write `publication.json` last as the publication commit point.
7. Do not expose Core as a browser download; recommend Standard Windows.
8. Preserve the previous beta and its tags/artifacts unchanged.

## Previous release integrity

`v0.3.0-beta.2` still resolves to
`99b13f22107fb514d9b57fc7e32c5b277178668d`. Its Core, ZIP, and EXE hashes
remain unchanged.

## Final status

```text
PCW 0.3.0-beta.3
RELEASED
PRIVATE BETA
PRODUCTION WEB LIVE
PREVIEW PASS
PRODUCTION SMOKE PASS

NOT GA
NOT STABLE
```
