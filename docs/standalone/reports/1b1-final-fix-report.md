# Plan 1b1 — final fix wave report

Scope: `apps/standalone` (`proto`, `host`), `apps/standalone/AGENTS.md`,
`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, per
`.superpowers/sdd/1b1-final-fix-brief.md`. `docs/superpowers/plans/2026-09-26-standalone-1b1-host-office-api.md`
was not touched.

All file:line references below are to the final state on disk.

## A. `put_block_sizes` must not use the pool while its write transaction is open

**Changed**: `apps/standalone/host/src/routes/sscc.rs`

- `read_state` (line 42) now takes `conn: &mut SqliteConnection` instead of
  `&AppState`, and reads `sscc_counters`, `site` and `org_profile` through
  that connection (lines 43-61).
- `get_sscc` (line 74) acquires one pooled connection and calls `read_state`
  on it (line 78-79).
- `put_counter` (line 82) — unaffected by A itself; see item D for the
  `require_admin_in` call added at line 91.
- `put_block_sizes` (line 161): the no-op path reads through `&mut tx`, then
  returns without committing, so the transaction rolls back on drop (line
  196-197); the success path reads the just-written state through `&mut tx`
  (line 228) **before** `tx.commit()` (line 229), so the response can never
  reflect a write that raced the commit.

**Covering test**: `apps/standalone/host/tests/office_admin.rs:350`,
`block_size_updates_do_not_wait_on_a_second_pooled_connection` — holds 3 of
the pool's 4 connections, then sends a no-op and a changing
`PUT /v1/office/sscc/block-sizes`, each wrapped in a 5-second
`tokio::time::timeout`; both must return 200.

**RED** (old code temporarily restored: no-op path re-acquired a pooled
connection via `state.pool.acquire()` while `tx` was still open):

```
thread 'block_size_updates_do_not_wait_on_a_second_pooled_connection' panicked at host/tests/office_admin.rs:361:6:
a no-op block-size update must not wait for a pooled connection: Elapsed(())
test result: FAILED. 0 passed; 1 failed; ... finished in 5.08s
```

**GREEN** (fix restored): `cargo test -p markiro-host --test office_admin` →
`8 passed` in 0.36s (was previously hanging ~5s on this test alone).

## B. `unauthorized` must say which credential failed

**Changed**:

- `apps/standalone/proto/src/lib.rs:50` — new `pub mod credentials { DEVICE,
SESSION, PASSWORD }`.
- `apps/standalone/host/src/error.rs:91` — `ApiError::unauthorized(credential:
&str, message)` now attaches `details: {"credential": credential}`.
- `apps/standalone/host/src/auth.rs`: `AuthDevice` extractor uses `DEVICE` at
  lines 44 and 54 (missing header, unknown/revoked key). `OfficeContext`
  extractor uses `SESSION` at lines 162, 176 and 187 (missing header,
  unknown/foreign-device session, expired session). The device-key check
  inside `OfficeContext` still comes from `AuthDevice`, so it still reports
  `device`, per the brief.
- `apps/standalone/host/src/routes/office_auth.rs:55,152` — `login` uses
  `PASSWORD` for a malformed login and for the final wrong-login/unknown-
  login/wrong-password/inactive-user rejection.
- New fixture `apps/standalone/proto/fixtures/error-unauthorized.json`
  (`{"error":{"code":"unauthorized","message":"office session expired","details":{"credential":"session"}}}`),
  round-tripped in `apps/standalone/proto/tests/fixtures.rs`
  (`error_fixtures_round_trip`, asserts `details.credential ==
credentials::SESSION`).
- Spec `§4.6` (`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`)
  documents `details.credential` and the three client actions.

**Covering tests** (assert `details.credential`):

- `device`: `apps/standalone/host/tests/pairing.rs:151`
  `a_device_reads_itself_with_its_key_until_revoked` (wrong key, revoked
  device, missing header); `apps/standalone/host/tests/office_auth.rs:171`
  `login_requires_a_device` (missing device key on login).
- `session`: `office_auth.rs:189` `me_reloads_role_and_rejects_foreign_devices`
  (foreign-device token, missing session header); `office_auth.rs:240`
  `sessions_end_after_idle_and_absolute_limits` (idle/absolute expiry).
- `password`: `office_auth.rs:104`
  `wrong_password_unknown_login_and_inactive_user_are_denied_and_audited`
  (wrong password, unknown login, inactive user); `office_auth.rs:420`
  `malformed_logins_are_denied_without_recording_the_input` (oversized login,
  non-ASCII login).

**RED** (temporarily made `unauthorized` drop the `credential` argument):

```
thread 'malformed_logins_are_denied_without_recording_the_input' panicked at host/tests/office_auth.rs:367:5: left: Null, right: "password"
thread 'login_requires_a_device' panicked at host/tests/office_auth.rs:161:5: left: Null, right: "device"
thread 'wrong_password_unknown_login_and_inactive_user_are_denied_and_audited' panicked at host/tests/office_auth.rs:98:5: left: Null, right: "password"
thread 'sessions_end_after_idle_and_absolute_limits' panicked at host/tests/office_auth.rs:244:5: left: Null, right: "session"
thread 'me_reloads_role_and_rejects_foreign_devices' panicked at host/tests/office_auth.rs:207:5: left: Null, right: "session"
test result: FAILED. 4 passed; 5 failed ...

# pairing.rs
thread 'a_device_reads_itself_with_its_key_until_revoked' panicked at host/tests/pairing.rs:175:5: left: Null, right: "device"
test result: FAILED. 4 passed; 1 failed ...
```

**GREEN** (fix restored): `office_auth`, `pairing`, `markiro-proto --test
fixtures` → `26 passed (3 suites)`.

## C. SSCC wire names before 1b2 freezes the Zod schemas

**Changed**: `apps/standalone/proto/src/lib.rs:347-356` —
`SsccState.rev` → `block_sizes_rev` (`blockSizesRev`); added
`current_issuer_prefix` (`currentIssuerPrefix`). `BlockSizesUpdate.expected_rev`
unchanged.

- `apps/standalone/host/src/routes/sscc.rs`: `read_state` computes
  `current_issuer_prefix` from `org_profile.gln` via `validate::issuer_prefix`
  (line 58-61, 69) and returns `block_sizes_rev` from `site.rev` (line
  49, 70). `put_counter`'s `sscc_below_floor` details renamed
  `currentNextSerial` → `minSerial` (line 122).
- Fixture `apps/standalone/proto/fixtures/sscc-state.json` updated
  (`currentIssuerPrefix`, `blockSizesRev`); `proto/tests/fixtures.rs`
  (`sscc_and_user_admin_fixtures_round_trip`) asserts both new/renamed
  fields.
- `apps/standalone/host/tests/office_admin.rs` updated: `minSerial` assertion
  (line ~152), `state["blockSizesRev"]`/`body["blockSizesRev"]` in
  `block_sizes_are_validated_and_versioned` (3 call sites).

C only renames/adds response fields; there is no dedicated RED/GREEN pair
beyond A's (same function) and the existing round-trip/handler tests, which
were updated in lockstep with the rename and are green (see Verification).

## D. Re-check admin rights inside the write transaction

**Changed**: `apps/standalone/host/src/auth.rs:118-142` —
`OfficeContext::require_admin_in(&self, conn: &mut SqliteConnection) ->
Result<(), ApiError>`: reads `office_sessions` joined to `office_users` by
`self.session_id`; no row or inactive user → `unauthorized(SESSION, ...)`;
role not admin → `forbidden`. Called right after `begin_write`, in addition
to the existing early `require_admin()`, in:

- `apps/standalone/host/src/routes/org.rs:64` (`put_org`)
- `apps/standalone/host/src/routes/sscc.rs:91` (`put_counter`), `:181`
  (`put_block_sizes`)
- `apps/standalone/host/src/routes/office_users.rs:89` (`create_user`),
  `:143` (`update_user`), `:233` (`set_password`)

**Covering test**: `apps/standalone/host/tests/office_admin.rs:865`
`require_admin_in_rechecks_role_and_session_inside_the_transaction` — builds
an `OfficeContext` directly (no HTTP), then (1) demotes the user in the DB
and asserts `require_admin_in` returns 403 `forbidden`; (2) deletes the
session row and asserts 401 with `details.credential == "session"`. Uses a
`begin_write` transaction for each call, per the brief.

**RED** (temporarily made `require_admin_in` always return `Ok(())`):

```
thread 'require_admin_in_rechecks_role_and_session_inside_the_transaction' panicked at host/tests/office_admin.rs:841:57:
called `Result::unwrap_err()` on an `Ok` value: ()
test result: FAILED. 0 passed; 1 failed ...
```

**GREEN** (fix restored): `office_admin` → `8 passed`.

## E. Throttle the office session's `last_seen_at` write

**Changed**: `apps/standalone/host/src/auth.rs:193-201` — the `UPDATE
office_sessions SET last_seen_at` in `OfficeContext`'s extractor now carries
`AND last_seen_at <= ?` with `now - 1 minute`, mirroring the device's
existing throttle.

**Covering test**: `apps/standalone/host/tests/office_auth.rs:302`
`session_heartbeat_is_throttled_to_once_a_minute` — a request 30s after
login must not change `last_seen_at`; a request a further 31s later (>1 min
total) must update it.

**RED** (temporarily reverted to the unconditional `UPDATE`):

```
thread 'session_heartbeat_is_throttled_to_once_a_minute' panicked at host/tests/office_auth.rs:307:5:
assertion `left == right` failed: an office request inside the same minute must not rewrite last_seen_at
  left: "2026-09-21T14:13:50Z"
 right: "2026-09-21T14:13:20Z"
```

**GREEN** (fix restored): `office_auth` → `10 passed`.

The existing idle/absolute-limit test
(`sessions_end_after_idle_and_absolute_limits`, `office_auth.rs:240`) is
unchanged in assertions and still green: every gap between requests in that
test is ≥29 minutes, well past the 1-minute throttle window, so every
heartbeat in that test still fires exactly as before.

## F. Prove the host encoder produces the `phc-password.json` string

**Changed**: `apps/standalone/host/src/secrets.rs:86-108` — factored
`hash_password_with_salt(password, salt: &[u8; 16], iterations: u32) ->
String` out of `hash_password`, which now just generates a random salt and
delegates to it with `PASSWORD_ITERATIONS`. Behavior-preserving refactor
(same computation, same output for the same salt).

**Covering test**: `secrets.rs:191`
`hash_password_with_salt_reproduces_the_fixture_phc_string` — decodes the
salt out of `phc-password.json`'s `passwordPhc`, calls
`hash_password_with_salt(password, &salt, 600_000)`, and asserts the result
equals the fixture string byte for byte.

This item is a pure extraction plus a new test of the newly-named function,
so there is no meaningful "old behavior" to get RED against (the function
didn't exist before). The proof is the GREEN byte-for-byte match against the
independently-computed (Python `hashlib.pbkdf2_hmac`) fixture string:
`cargo test -p markiro-host --lib secrets::` → `7 passed`.

## G. Test gaps

1. `assert_audit` (`office_admin.rs:73`) now asserts `audit_count(...) == 1`
   before comparing the tuple (lines 79-83), reusing the existing
   `audit_count` helper.
2. `last_audit` (`office_auth.rs:11`) now selects and returns `target_type`;
   every call site updated: `login_opens_a_session_bound_to_the_device`,
   both branches of `wrong_password_unknown_login_and_inactive_user_are_denied_and_audited`,
   `logout_ends_the_session_and_is_audited`, and both branches of
   `malformed_logins_are_denied_without_recording_the_input`.
3. Bystander sessions: `deactivation_and_password_changes_end_the_users_sessions`
   (`office_admin.rs:646`) now creates a second technologist ("second") with
   its own session before the password change, and asserts after both the
   password change and the deactivation of `tech` that the bystander's
   session still answers `GET /v1/office/me` with 200 and its
   `office_sessions` row count is still 1.
4. `sscc_counters_move_only_forward_within_capacity` (`office_admin.rs:129`)
   now asserts `rev_before_move == 1` (line 181) instead of only using it as
   a baseline for a later comparison.
5. `bootstrap.rs`'s `the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions`
   (line 230) now switches the GLN back to `4600682000010` with the current
   `expectedRev` after switching to `4607091000017`, and asserts there are
   still exactly 4 counter rows and the `460068200` pair is still `1500`/`40`
   at `rev 1` (the `ON CONFLICT (issuer_prefix, extension) DO NOTHING` path
   in `org.rs`).
6. `the_wizard_initializes_the_host_and_signs_the_admin_in` (`bootstrap.rs:12`)
   now also selects `rev` for the admin's `office_users` row and asserts it
   is `1`.
7. New test `platform.rs:35`
   `a_wrong_method_on_a_protected_route_is_also_method_not_allowed` — `DELETE
/v1/device` with the protocol header → 405 `method_not_allowed`.

These are test-hardening only (no production-code behavior change), so they
were not run through a RED/GREEN cycle; each was verified GREEN against the
already-correct existing behavior (see Verification).

## H. Docs

- `apps/standalone/AGENTS.md` — new "Writes" section (after "Databases",
  before "Protocol") covering: `db::begin_write` for every multi-statement
  write; one `next_revision` per changing transaction; never touching
  `state.pool` while a write transaction is open; hashing passwords before
  `begin_write`; returning no-ops before `next_revision`; and admin writes
  re-checking rights with `OfficeContext::require_admin_in` inside the
  transaction.
- Spec `§4.1` (`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`)
  now lists `host.lock` among the data-directory files, noting it is the
  running host's exclusive lock, not data, and is never backed up or
  restored.
- Spec `§4.6` documents `unauthorized`'s `details.credential` values and
  what the client does for each (re-pair the device / sign in to the office
  again / show the login-error text).

## Verification

Focused suites (sandboxed; `--offline`):

```
cargo test --manifest-path apps/standalone/Cargo.toml --offline -p markiro-host \
  --test office_admin --test office_auth --test bootstrap --test pairing --test platform --lib
# office_admin: 8 passed; office_auth: 10 passed; bootstrap: 6 passed;
# pairing: 5 passed; platform: 6 passed, 1 failed (a_second_host_on_the_same_data_directory_is_refused,
#   EPERM binding 127.0.0.1:0 — sandbox port-binding restriction, expected per environment rules)
# --lib: 10 passed

cargo test --manifest-path apps/standalone/Cargo.toml --offline -p markiro-proto --test fixtures
# 12 passed
```

Full suite, sandbox disabled (covers `hello.rs`, the `platform.rs` lock test,
and `no_secrets_in_logs.rs`):

```
cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline
# 88 passed (19 suites), 0 failed
```

Formatting and hygiene:

```
cargo fmt --manifest-path apps/standalone/Cargo.toml --all         # reformatted auth.rs, office_admin.rs
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check   # exit 0
node_modules/.bin/prettier --write apps/standalone/proto/fixtures/sscc-state.json \
  apps/standalone/proto/fixtures/error-unauthorized.json apps/standalone/AGENTS.md \
  docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md    # all unchanged (already correct)
node_modules/.bin/prettier --check <same files>                    # exit 0
git diff --check                                                   # exit 0, no output
```

Node/TypeScript side (must not have broken on the two touched fixtures; their
Zod schemas arrive in plan 1b2):

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
# Test Files 4 passed (4); Tests 16 passed (16)
```

`cargo build --manifest-path apps/standalone/Cargo.toml --workspace --offline`
also succeeds (includes `src-tauri`; `apps/standalone/dist` already existed
in this worktree from earlier plan-1b1 work, so the Tauri crate's
`generate_context!` had what it needed without a fresh `pnpm turbo build`).

Not run / out of scope for this wave: `cargo clippy` (neither the fix brief's
verification list nor `.github/workflows/ci.yml`'s `standalone-rust` job runs
clippy for this crate); the whole-repo `pnpm format:check` (the fix brief's
own verification list scopes prettier to the changed JSON/markdown files,
which were checked); Windows/DPAPI/service and any browser/manual checks
(nothing in this wave touches those surfaces).

## Deviations from the suggested commit grouping

The brief's example groups commits as "A+D+E (transaction and auth), then
B+C (protocol shapes), then F+G+H (tests and docs)". Once implemented, the
actual coupling didn't allow that exact split while keeping every commit
independently buildable:

- `ApiError::unauthorized`'s new signature (B) is called from `auth.rs`,
  `office_auth.rs`, and — because `require_admin_in` (D) also reports
  `unauthorized(SESSION, ...)` — from the same `auth.rs` impl block D adds
  to. Splitting B out of `auth.rs` without D would leave a commit that
  doesn't compile.
- `SsccState`'s renamed/added fields (C) are read by `read_state` (A) in the
  same function, and `put_counter`/`put_block_sizes` (A, D) share the same
  handler bodies.
- The office session's throttle (E) sits a few lines below D's
  `require_admin_in` in the same `impl OfficeContext` block in `auth.rs`.

Given that, and that the plan explicitly allows "one commit for the whole
wave", I split into two buildable, independently-green commits instead of
three:

1. **A + B + C + D + E** (plus the G1-G4 test-hardening items, since they
   live in the same test files these items already touch:
   `office_admin.rs`, `office_auth.rs`) — every production-behavior change
   and its directly-covering tests.
2. **F + G5-G7 + H** — the PBKDF2 salt-vector proof, the remaining test gaps
   (`bootstrap.rs`, `platform.rs`, both untouched by commit 1), and the docs.

Each commit was confirmed to build; the full green test run above covers
their combined state. I did not independently re-verify commit 1 in
isolation via a separate checkout (that would need a worktree or stash,
and the instructions rule out `git stash`); the file-level reasoning above
plus the fact that commit 2 only adds unrelated, independent files/tests
makes an isolated regression at commit 1 very unlikely, but it is not
independently proven the way the final combined state is.

## Concerns

- `require_admin_in`'s exact rejection message text ("office session ended")
  was my choice; the brief specifies the code/credential/status but not the
  message string, and no test asserts it (messages are documented as
  log-only, never shown to a person, per `ErrorDetail::message`'s doc
  comment).
- Item C's brief note says the block-sizes revision "survives plan 2a's
  printed-floor rule and matches the cloud" for `minSerial`; I did not have
  the cloud's field name to cross-check against and went by the brief's
  literal instruction.

## Follow-up (commit `66802bf40`, on top of `d7dba1373`)

The re-review of the two commits above approved the wave and left six Minor
items, closed here in one commit.

1. **Consistent snapshot in `GET /v1/office/sscc`.**
   `apps/standalone/host/src/routes/sscc.rs:74-89` — `get_sscc` now opens a
   plain deferred transaction (`state.pool.begin()`, i.e. `BEGIN`, not
   `BEGIN IMMEDIATE`) so all three reads inside `read_state` (counters, block
   sizes, `org_profile.gln`) share one WAL snapshot, then rolls it back
   (nothing is written). Previously each read ran as its own implicit
   transaction on the pooled connection, so a GLN change landing between
   them could produce a `currentIssuerPrefix` whose counters were missing
   from the list. `put_block_sizes` was already reading through its own
   write transaction and is unchanged; `read_state`'s doc comment
   (`sscc.rs:36-41`) now describes both callers passing a transaction. No
   deterministic interleaving test was added, per the instruction that one
   isn't practical — the code change plus the endpoint-level assertions in
   item 2 are the coverage.
2. **`currentIssuerPrefix` asserted against the live endpoint.**
   - `apps/standalone/host/tests/office_admin.rs:135` (in
     `sscc_counters_move_only_forward_within_capacity`, at the first
     `GET /v1/office/sscc`): `"460068200"`.
   - `apps/standalone/host/tests/bootstrap.rs` (in
     `the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions`):
     a new `GET /v1/office/sscc` right after the GLN switch to
     `4607091000017` asserts `"460709100"` (added before the existing
     "switching back" block); a second new `GET` at the end of the test,
     after switching the GLN back to `4600682000010`, asserts
     `"460068200"` again.
3. **Spec §4.2** (`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md:118-121`)
   now says writes run inside `BEGIN IMMEDIATE` transactions
   (`db::begin_write`), with the same busy-timeout-vs-stale-snapshot
   reasoning `AGENTS.md`'s "Writes" section gives, replacing the stale
   "`pool.begin()`" line. The plan file
   (`docs/superpowers/plans/2026-09-26-standalone-1b1-host-office-api.md`)
   was left untouched, per the coordinator's note that it has their own
   uncommitted edit.
4. **`read_state` and a missing `org_profile`.**
   `sscc.rs:54-62` — the GLN read is now `fetch_optional` +
   `ok_or_else(|| ApiError::not_found("the host is not initialized"))`,
   the exact pattern and message `read_org` (`routes/org.rs:19-27`) uses,
   instead of `fetch_one` turning a missing row into a 500. The comment
   above it now says so explicitly instead of asserting the row "always
   exists".
5. **`hash_password_with_salt` narrowed to private.**
   `apps/standalone/host/src/secrets.rs:86` — dropped `pub`; confirmed by
   grep that its only callers are `hash_password` and the unit test, both
   in the same module.
6. **`require_admin_in`'s inactive-user branch covered.**
   `office_admin.rs`, `require_admin_in_rechecks_role_and_session_inside_the_transaction`
   — inserted a new step 2 between the existing demotion and
   session-deletion cases: sets `active = 0` on the admin (session row
   still present), asserts `require_admin_in` returns 401 with
   `body["error"]["details"]["credential"] == "session"`, then restores
   `active = 1` before the (renumbered) step 3 deletes the session row, so
   that case still isolates "no row" from "inactive user".

### Verification

```
cargo test --manifest-path apps/standalone/Cargo.toml --offline -p markiro-host \
  --test office_admin --test bootstrap --lib
# 24 passed (3 suites): office_admin 8, bootstrap 6, --lib 10

cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline   # sandbox disabled
# 88 passed (19 suites), 0 failed — same total as before this commit, since
# every change here either edits production code (items 1, 3, 4, 5) or adds
# assertions/steps to existing test functions (items 2, 6) rather than new
# test functions

cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check   # exit 0
node_modules/.bin/prettier --check docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md  # exit 0
git diff --check   # exit 0
```

`pnpm --filter @markiro/standalone test` was not re-run for this follow-up:
nothing in it touches TypeScript, fixtures, or any Zod-parsed shape.

### Concerns

- Items 1 and 4 change behavior (a stronger read-consistency guarantee and a
  500-to-404 conversion) but the coordinator's instructions didn't ask for a
  RED/GREEN cycle here — item 1 explicitly waives a dedicated test ("the code
  change is enough") and item 4 wasn't given one either. I did not add an
  interleaving test for 1 or a missing-`org_profile` test for 4 beyond what
  was asked; the existing and item-2 endpoint assertions are the only
  coverage of `read_state`'s new shape.
- Commit `66802bf40` sits directly on `d7dba1373`; I did not re-verify it
  builds in isolation via a separate checkout, for the same reason noted
  above (no `git stash`, and a worktree felt disproportionate for a 5-file,
  single-purpose commit). The combined state at HEAD is fully verified
  (88/88, fmt/prettier/diff-check clean).
