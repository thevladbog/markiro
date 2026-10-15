# Task 8 report (plan 1d2): FromStr, shared password hash, validate tests, shared test support

**Status: DONE.** Commit `bfa19e2ba` on `claude/autonomous-desktop-station-9e6f13`
(baseline `9779b0f4d`), 14 files, +221 / -172. Trailer is exactly
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, one such line
(checked with `git log -1 --format=%B`).

## What was implemented

Behaviour-preserving refactor plus tests; every edit is the brief's, verbatim.

- `proto`: `UnknownVariant(pub String)` (`Debug, Clone, PartialEq, Eq`, `Display`, `Error`),
  `impl FromStr for DeviceKind` and `impl FromStr for OfficeRole`, and the unit test
  `tests::stored_names_parse_back_into_their_variants` (pins `as_str` == `FromStr` == serde).
- `host`: the six `serde_json::from_value(Value::String(..))` sites (3 in `auth.rs`, and one each in
  `routes/devices.rs`, `routes/office_auth.rs`, `routes/office_users.rs`) now call `.parse()`.
- `secrets::hash_password_blocking(Secret) -> Result<String, JoinError>`; `office_users.rs` (`create_user`,
  `set_password`; local `hash` fn removed) and `bootstrap.rs` use it. `office_auth::change_password`
  is untouched, as the brief says.
- 7 unit tests for `validate.rs`: office login, person name, password, organization time zone,
  line name, SSCC serial (with `issuer_prefix`, `serial_capacity`, `first_serial`), device registration.
- `office_admin.rs` uses shared `Admin` / `admin()`; `device_line.rs` and `claim.rs` use shared
  `audit_trail` / `AuditRow`; `changes_stream.rs`, `device_line.rs`, `office_auth.rs` use shared `host_revision`.
- `apps/standalone/AGENTS.md` ("Verification"): the bullet on shared host test support.

Method: a throwaway script (outside the repo, `/private/tmp/claude/task8/apply_brief.py`) read the old/new
fragments straight from the brief file and asserted each anchor occurs exactly once before replacing, so
bytes (Cyrillic included) are the brief's. All 29 anchors (11 + 17 + 1) matched exactly once. No
literal `\uXXXX` in any changed file (grep over the diff: none).

## Baseline (before any edit, HEAD 9779b0f4d)

- Host suites: lib 28, bootstrap 6, office_admin 8, device_line 4, claim 8, office_auth 16, pairing 6, devices 6.
- `cargo test --workspace --offline` (outside sandbox): exit 0, 35 result lines (suites), **287 passed**, 0 failed, 0 warnings.

## TDD evidence

### RED (Step 2, proto)

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --lib --offline     -> exit 101
error[E0432]: unresolved import `super::UnknownVariant`      (proto/src/lib.rs:809)
error[E0277]: the trait bound `DeviceKind: FromStr` is not satisfied   (lines 820, 828)
error[E0277]: the trait bound `OfficeRole: FromStr` is not satisfied   (lines 824, 832)
error: could not compile `markiro-proto` (lib test) due to 5 previous errors
```

Exactly the failure the brief predicts. The other Step 2 commands passed on arrival, as the brief says
(they pin behaviour the host already has):

| Command                                                                                  | Result                         |
| ---------------------------------------------------------------------------------------- | ------------------------------ |
| `-p markiro-host --lib validate`                                                         | 16 passed (9 existing + 7 new) |
| `-p markiro-host --test office_admin --test device_line --test claim --test office_auth` | 8, 4, 8, 16 passed             |
| `-p markiro-host --test changes_stream` (outside sandbox)                                | 8 passed                       |

### GREEN (Step 4)

```
-p markiro-proto                       -> exit 0: unit 3 passed (incl. tests::stored_names_parse_back_into_their_variants), fixtures 27 passed, doc 0
-p markiro-host --lib --test bootstrap --test office_admin --test office_auth --test pairing --test devices
                                       -> exit 0: 35, 6, 8, 16, 6, 6 passed
```

## Verification commands and results

| Command                                                                                         | Result                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                         | exit 0, clean                                                                                                                                                     |
| `node_modules/.bin/prettier --check apps/standalone/AGENTS.md`                                  | clean                                                                                                                                                             |
| `git diff --check` (and on `9779b0f4d..HEAD`)                                                   | clean                                                                                                                                                             |
| `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`     | 4/4 tasks successful. The sandbox blocked turbo's telemetry call to `telemetry.vercel.com`; harmless. No tracked file changed.                                    |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside sandbox) | exit 0: 35 suites, **295 passed**, 0 failed, 0 ignored, 0 warnings. Run twice on the final tree: before the mutation check and again on the exact committed tree. |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`    | exit 0, 0 warnings (also run twice)                                                                                                                               |

Per-suite before/after (workspace): the only counts that changed are host lib 28 -> 35 (+7 validate tests)
and proto lib 2 -> 3 (+1). Every migrated integration suite has identical counts (claim 8, device_line 4,
office_admin 8, office_auth 16, changes_stream 8). Total 287 + 8 = 295.

## Files changed (14)

`apps/standalone/proto/src/lib.rs`, `host/src/{auth,secrets,validate}.rs`,
`host/src/routes/{devices,office_auth,office_users,bootstrap}.rs`,
`host/tests/{office_admin,device_line,claim,changes_stream,office_auth}.rs`, `apps/standalone/AGENTS.md`.
Nothing in `apps/station`, `apps/standalone/src-tauri`, `apps/standalone/src`, `tools/ci/affected.mjs`
or the lockfile.

## Deviations

1. **The brief's expected counts are stale by one or two; actual counts are higher.** Lib is 35 (brief: 34),
   `validate` is 16 (brief: 15), workspace total is 295 (brief: 293); suite count 35 matches. Cause: the
   task-5 review-fix commit `b0ce2be75` added two tests after the plan's counts were computed
   (`validate::tests::a_zero_padded_iteration_count_is_a_second_spelling_and_is_refused` and
   `badges.rs::a_zero_padded_copy_of_an_active_badge_is_refused_not_stored_twice`). Confirmed by the
   baseline: 287 before, +8 from this task = 295, with the per-suite diff above. No test failed and
   nothing else differs from the brief.
2. None otherwise: every edit is the brief's text; nothing improvised.

## Self-review

- **Completeness:** Steps 1-6 done; names as specified (`UnknownVariant`, `hash_password_blocking`).
  `graphify update .` not run: there is no `graphify-out/` in this worktree.
- **No assertion weakened:** the removed code is only local helper duplicates, equivalent to the shared
  versions: `Admin`/`admin()` are identical code; `Admin::call` delegates to `call_as(&self.token, ..)`
  with the same request building; `host_revision` is the same SQL; `audit_trail(app, action)` binds the
  action instead of a literal and has the same columns, `ORDER BY id` and `details` parsing. Helpers with a
  different shape stay, per the brief: `host_revision(&Admin)` in `office_admin.rs`, `code_audit`,
  `password_audit`, `audit_rows`, and `office_auth.rs`'s own `AuditRow`/`last_audit`.
- **New tests verify behaviour (mutation check):** they pass on arrival, so I broke the code under test one
  small change at a time (31 mutants: bounds, trimming, char-vs-byte counting, allowed characters, error
  field path, Unicode vs ASCII lower case, SSCC bounds/exponent/first serial, FromStr arms, error payload,
  as_str vs serde drift), ran the tests, and restored the file from backup each time. **30 of 31 killed**
  by the intended test; both files restored byte-for-byte (sha256 verified). One survivor: see Concerns.
- **Route behaviour:** HTTP-visible behaviour is unchanged (same statuses, codes, bodies, audit rows;
  `ApiError::internal` still returns the fixed `internal` body). The one diagnostic difference: for a corrupt
  stored role or device kind, the `tracing::error!` line now reads `unknown value "..."` (the
  `UnknownVariant` Display) instead of serde's longer message. The value is a role/kind name, not a secret.
- `hash_password_blocking` has no dedicated unit test (the brief specifies none); it is covered end to end
  by `bootstrap.rs:85` (stored admin hash verifies the wizard password) and `office_admin.rs:663` (stored
  hash verifies the reset password), and `create_user` through the login that follows.
- No secrets, hashes, keys or pairing codes were printed or logged by anything I ran.

## Concerns

None blocking. Two small observations for the controller:

1. **Gap in the brief's test** `a_device_registration_checks_its_version_and_capabilities`: it does not assert
   the 64-character capability limit (`capability.len() > 64`); mutating it to 65 survived. I kept the test
   exactly as specified. A one-line assertion (a 65-character capability names `capabilities`) would close it
   if wanted.
2. `apps/standalone/AGENTS.md` "Writes" still says to hash passwords "off the async runtime
   (`spawn_blocking`)". Accurate, but `secrets::hash_password_blocking` is now the shared way; the brief
   did not ask to touch that line, so I left it.

## Not verified (as the brief lists, and why)

- The new routes have no consumers yet (office screens and station copies are plans 1d3/1d4; PIN/badge
  sign-in is plan 1f).
- Device revocation and the end of its stream across two PCs on a real network: by hand after plan 1d3.
- CI job `standalone-windows-build`: needs a push. Windows, DPAPI and the Windows service were not
  exercised (this was a macOS run).
- Vitest / TypeScript: not run; this task changes no TS, Zod schema or fixture.
- Tests that bind 127.0.0.1 (`changes_stream` and the full workspace run) were run outside the sandbox, as
  the constraints require; everything else ran inside it.
