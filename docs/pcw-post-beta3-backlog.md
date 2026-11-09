# PCW Post-beta.3 Backlog

This backlog starts after the frozen `v0.3.0-beta.3` private-beta release. It
does not reopen or modify beta.3 artifacts. Priorities describe the next
engineering cycles; accepted private-beta limitations are not automatically
P0 incidents.

## P0

No known P0 blocker remains at beta.3 closure. A verified integrity,
authorization, context-loss, or remote-download-control regression would be
promoted to P0 if discovered.

## Prioritized backlog

| ID | Priority | Problem | Why it matters | Proposed direction | Acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| PCW-POST3-001 | P1 | Real Windows symlink mutation tests are skipped because the current host returns `EPERM`. | The fail-closed design is covered indirectly, but the real link path lacks executable evidence. | Add a privileged or supported Windows CI lane that creates controlled symlinks without weakening normal CI. | Real config replacement by symlink executes on Windows; target survives; mutation fails closed; ordinary CI retains an explicit capability skip. |
| PCW-POST3-002 | P1 | A narrow pathname TOCTOU interval remains between final `lstat` and `unlink`. | A concurrent local writer can replace a pathname after identity validation. | Evaluate handle-based/platform-specific deletion or a smaller Windows-native boundary; retain conservative fallback. | A documented implementation or feasibility decision exists, race-focused tests pass, and no path/link protection regresses. |
| PCW-POST3-003 | P1 | Automatic Cursor discovery covers only the canonical `%LOCALAPPDATA%\Programs\Cursor\Cursor.exe` layout. | Portable and custom installs can be reported as not installed despite being usable. | Add an explicit, bounded discovery matrix with injectable roots and ambiguity handling. | Supported layouts are documented and tested; multiple candidates fail as ambiguous; no broad disk scan is introduced. |
| PCW-POST3-004 | P1 | Lifecycle harnesses need permanent protection against accidental real HOME/client access. | A test-variable mistake could mutate developer configuration. | Centralize synthetic HOME/LOCALAPPDATA guards and assert all target paths remain under the test root before mutation. | Apply/remove/lifecycle tests abort outside TEMP, exercise no real config, and include a deliberate escape regression test. |
| PCW-POST3-005 | P1 | The complete Standard Windows release lifecycle is not yet one continuously enforced CI gate. | Manual evidence can drift from the exact artifact later finalized. | Automate exact-A install, Doctor, MCP, Cursor lifecycle, uninstall, and preservation checks against finalized candidate bytes. | CI binds artifact SHA through build, lifecycle, and finalization; 16 tools and context preservation are asserted; no binary is publicly retained. |
| PCW-POST3-006 | P1 | Preview/Production publication smoke tests require substantial manual orchestration. | Authorization, revocation, and exact-byte delivery are release-critical. | Build a restricted smoke runner with short-lived grants, explicit target version, and guaranteed revocation cleanup. | Request-to-revoke checks run against Preview and Production, verify exact hashes, leave zero active smoke grants, and emit sanitized evidence. |
| PCW-POST3-007 | P1 | The unsigned installer can trigger SmartScreen. | It reduces trust and usability for external private-beta users. | Define Authenticode certificate custody, signing, timestamping, post-signature hashing, and verification policy. | A signed candidate verifies on clean Windows, final hashes describe signed bytes, unsigned reproducibility evidence remains linked, and key handling is documented. |
| PCW-POST3-008 | P2 | Cursor JSONC/comments are rejected rather than preserved. | Some users maintain commented configuration and cannot use automatic integration. | Evaluate a comment-preserving parser/writer with semantic ownership checks and stable formatting. | JSONC round-trips comments and unrelated data, malformed input fails closed, and drift/remove semantics remain safe. |
| PCW-POST3-009 | P2 | Runtime metadata does not encode the frozen Git commit; SBOM/attestation is absent. | Artifact-to-source provenance depends on external release metadata. | Add backward-compatible runtime provenance plus optional SBOM and signed/verified attestation. | Installed Doctor can report source commit without local paths; manifest compatibility is explicit; SBOM/attestation is deterministic or separately signed. |
| PCW-POST3-010 | P2 | Codex and Claude remain guided, and MCP Bundle packaging is not implemented. | Broader client adoption still requires manual setup. | Prototype MCPB first, then evaluate narrowly scoped safe adapters per client. | Each supported client has an isolated lifecycle test, explicit ownership model, idempotent removal, and no generic config mutation framework. |

## Release invariants for future work

- Build canonical Core once; wrappers consume those exact bytes.
- Keep publication artifact paths immutable and write `publication.json` last.
- Do not offer Core as a browser-selectable download; Standard Windows remains
  the recommended user path.
- Never rebuild frozen release artifacts.
- Tags resolve to the exact frozen source used for release metadata.
- Preserve beta.N-1 tags, artifacts, and catalog records unchanged.
- Treat signing as a byte-changing stage with a new final hash.
- Keep private publication distinct from public catalog discovery.
