# Task 5 report: SSCC, офисные пользователи и «секретов нет в журнале»

Plan: `1b1`. Branch: `claude/autonomous-desktop-station-9e6f13`. Commit: `7e8106616806ec35159f0fd878bf81161ca2e0a0`.

## What was implemented

1. **Proto DTOs** (`apps/standalone/proto/src/lib.rs`): `SsccCounter`, `SsccState`,
   `SsccCounterUpdate`, `BlockSizesUpdate`, `OfficeUserRecord`, `OfficeUserCreate`,
   `OfficeUserUpdate`, `PasswordSet` — added verbatim from the brief.
2. **Fixtures** (`apps/standalone/proto/fixtures/`): `sscc-state.json`,
   `sscc-counter-update.json`, `block-sizes-update.json`, `office-user-record.json`,
   `office-user-create.json`, `office-user-update.json`, `password-set.json` —
   byte-for-byte from the brief, verified unchanged by `prettier --write`.
3. **Fixture round-trip test** (`apps/standalone/proto/tests/fixtures.rs`): added the
   new type imports and `sscc_and_user_admin_fixtures_round_trip`.
4. **`GET /v1/office/sscc`** (`apps/standalone/host/src/routes/sscc.rs::get_sscc`):
   any office role reads counters (with `maxSerial` derived from
   `validate::serial_capacity`) plus the device block sizes from `site`.
5. **`PUT /v1/office/sscc/counters/{prefix}/{extension}`** (`put_counter`):
   admin-only, forward-only (`sscc_below_floor` with `details.currentNextSerial`
   when the new serial is below the current one), `expectedRev`-checked
   (`stale_revision`), range-checked via `validate::sscc_serial`
   (`validation_failed` on `nextSerial`), `not_found` for an unknown
   prefix/extension pair. Audits `sscc.counter.update` with
   `target_id = "{prefix}/{extension}"` and `details = { from, to }`.
6. **`PUT /v1/office/sscc/block-sizes`** (`put_block_sizes`): admin-only,
   validates `boxBlockSize` (1-100000) and `palletBlockSize` (1-10000),
   `expectedRev`-checked against `site.rev`, audits
   `sscc.block_sizes.update` on target `site/1`, returns the full refreshed
   `SsccState`.
7. **Office user administration** (`apps/standalone/host/src/routes/office_users.rs`):
   - `GET /v1/office/users` (`list_users`, admin-only, ordered by
     `login COLLATE NOCASE`);
   - `POST /v1/office/users` (`create_user`, admin-only; validates login/name/
     password, hashes off the async runtime via `spawn_blocking`, maps a unique
     violation on `login` to `409 conflict`, audits `office_user.create` with
     `{ login, role }`);
   - `PUT /v1/office/users/{id}` (`update_user`, admin-only, `expectedRev`-checked,
     the last-active-admin guard returning `409 last_admin`, deletes the user's
     sessions when deactivated, audits `office_user.update` with
     `{ changed: [...] }`);
   - `PUT /v1/office/users/{id}/password` (`set_password`, admin-only, validates
     the new password, deletes every _other_ session of that user
     (`id <> context.session_id`) so the caller's own session survives when an
     admin resets their own password, audits `office_user.password` with `{}`,
     returns `204 No Content`).
8. **Routing** (`apps/standalone/host/src/routes/mod.rs`, `server.rs`): registered
   `office_users` and `sscc` modules; wired the six new routes into
   `protected_routes()`, importing `put` from `axum::routing`.
9. **Tests** (`apps/standalone/host/tests/office_admin.rs`, in-process, 5 tests) and
   (`apps/standalone/host/tests/no_secrets_in_logs.rs`, its own binary, real HTTPS,
   1 test) — added verbatim from the brief (see Deviations for formatting-only
   differences from `cargo fmt`).
10. **Spec edits** (`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`):
    - §4.6: inserted `method_not_allowed` into the error-code list after `not_found`;
    - §4.3: appended the `name_key`/migration-1b1 sentence to the `lines` bullet,
      the default-template-columns sentence to the `org_profile` bullet, and the
      "closed/expired session is deleted" sentence to the `office_sessions` bullet.

## TDD evidence

**RED** — `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test office_admin`
(run before `routes/sscc.rs`/`routes/office_users.rs` existed or were wired into
`server.rs`; the test file itself compiled unchanged against the existing
support harness):

```
thread 'sscc_counters_move_only_forward_within_capacity' panicked at host/tests/office_admin.rs:37:5:
assertion `left == right` failed
  left: 404
 right: 200
thread 'technologists_cannot_administer' panicked at host/tests/office_admin.rs:166:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for POST /v1/office/users"}}
  left: 404
 right: 200
thread 'users_are_created_updated_and_the_last_admin_is_protected' panicked at host/tests/office_admin.rs:203:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for POST /v1/office/users"}}
  left: 404
 right: 200
thread 'block_sizes_are_validated_and_versioned' panicked ... Option::unwrap() on a None value  (rev missing: GET /v1/office/sscc also 404'd)
thread 'deactivation_and_password_changes_end_the_users_sessions' panicked ... Option::unwrap() on a None value

test result: FAILED. 0 passed; 5 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s
```

Matches the brief's expected RED: "нет маршрутов SSCC и пользователей."

**GREEN** — after implementing `routes/sscc.rs`, `routes/office_users.rs` and wiring
them into `server.rs`/`routes/mod.rs`:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test office_admin
cargo test: 5 passed (1 suite, 0.34s)

$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test no_secrets_in_logs   (sandbox disabled — binds 127.0.0.1)
cargo test: 1 passed (1 suite, 0.18s)

$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --test fixtures
cargo test: 12 passed (1 suite, 0.00s)   # includes sscc_and_user_admin_fixtures_round_trip
```

The `office_admin` test binds no ports and ran inside the sandbox; `no_secrets_in_logs`
hit the documented sandbox EPERM on `127.0.0.1:0` first try
(`cannot listen on 127.0.0.1:0: Operation not permitted (os error 1)`) and passed
once re-run with the sandbox disabled, as the task's environment notes predicted.

## Final-check results ("Итоговая проверка плана")

All run **after** the commit, from the worktree root.

1. `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
   (sandbox disabled — `hello.rs`, `platform.rs`'s lock test and
   `no_secrets_in_logs.rs` bind real ports): **19 test suites, 82 tests, 0 failed.**
   Exit code 0. New tests confirmed present in the log: `no_secrets_in_logs`
   (1/1 ok), `office_admin` (5/5 ok, all named), `sscc_and_user_admin_fixtures_round_trip`
   (ok). No `FAILED` lines anywhere in the log.
2. `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: clean,
   exit 0.
3. `git diff --check`: clean, exit 0 (run after commit against the working tree,
   which was clean).
4. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`:
   **4 test files, 16 tests, all passed.** Confirms the new Rust-only fixtures
   don't break the Vitest suite (per the plan's constraint note, these fixtures
   get Zod schemas only in plan 1b2).

`node_modules/.bin/prettier --check` on the 7 new fixture JSON files and on the
edited spec doc and `apps/standalone/AGENTS.md`: all already matched Prettier's
style (`--write` reported "unchanged" for every file); `--check` passed.

## Files changed

```
 apps/standalone/host/src/routes/mod.rs             |   2 +
 apps/standalone/host/src/routes/office_users.rs    | 260 ++++++++++++++ (new)
 apps/standalone/host/src/routes/sscc.rs            | 186 ++++++++++ (new)
 apps/standalone/host/src/server.rs                 |  24 +-
 apps/standalone/host/tests/no_secrets_in_logs.rs   | 116 ++++++ (new)
 apps/standalone/host/tests/office_admin.rs         | 388 +++++++++++++++++++++ (new)
 apps/standalone/proto/fixtures/block-sizes-update.json      |   1 + (new)
 apps/standalone/proto/fixtures/office-user-create.json      |   6 + (new)
 apps/standalone/proto/fixtures/office-user-record.json      |   9 + (new)
 apps/standalone/proto/fixtures/office-user-update.json      |   1 + (new)
 apps/standalone/proto/fixtures/password-set.json            |   1 + (new)
 apps/standalone/proto/fixtures/sscc-counter-update.json     |   1 + (new)
 apps/standalone/proto/fixtures/sscc-state.json              |  21 ++ (new)
 apps/standalone/proto/src/lib.rs                   |  80 +++++
 apps/standalone/proto/tests/fixtures.rs            |  21 +-
 docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md | 11 +-
 16 files changed, 1121 insertions(+), 7 deletions(-)
```

No files outside this list were touched; `git status --short` was clean both
before staging (only these paths appeared) and after the commit.

## Deviations from the brief's code

Only one class of deviation, purely mechanical:

- **`cargo fmt` line-wrapping.** I typed `routes/sscc.rs`, `routes/office_users.rs`,
  `tests/office_admin.rs` and `tests/no_secrets_in_logs.rs` from the brief, then ran
  the required `cargo fmt --all`. Rustfmt re-wrapped roughly a dozen lines that
  exceeded the 100-column limit (e.g. `fn counter(...)`'s parameter list, several
  chained `.call(...)`/`assert_eq!(...)` expressions in the tests, the
  `markiro_proto::{codes, ...}` import in `office_users.rs`). I diffed every
  generated file against the brief's verbatim listing after formatting: every
  hunk is whitespace/line-break only — no token, string, number, or expression
  changed. Verified by re-running the affected test binaries after `fmt` and
  confirming they still pass. No other deviation: all type names, field names,
  SQL, route paths, error codes, and audit `details` shapes match the brief
  exactly.

No brief code failed to compile as written; no behavioral fix was needed.

## Self-review findings

- **`update_user` audits and bumps `rev` even on a true no-op** (identical name/
  role/active). This differs from `routes/org.rs::put_org`'s pattern from task 4
  (which explicitly detects an empty `changed` list and returns early without
  writing a row, bumping the revision, or auditing a no-op — that was itself a
  fix landed in `4a9b4d2f2`). The brief's `office_users.rs` code has no such
  guard, and no test in `office_admin.rs` exercises a same-value update, so this
  is exactly what was specified and every test passes. I did not add the org.rs
  no-op guard myself, since the brief's code is explicit and unambiguous here
  and the task instructions say to implement the brief as given and only fix
  what fails to compile. Flagging it because a future task tightening user-admin
  parity with org profile semantics may want the same treatment.
- **`set_password` always ends sessions and bumps `rev`**, even if (hypothetically)
  the same password were resubmitted — there's no comparison against the old
  hash. This is arguably correct (a password-set request should always be
  treated as sensitive and always rotate sessions), and matches the brief.
- Confirmed the extractor order in `put_counter`/`put_block_sizes`/`update_user`/
  `set_password` (`State`, then `OfficeContext`, then `ApiPath`, then `ApiJson`
  last) is required by axum (only the final extractor may consume the body) and
  is what makes `context.require_admin()` run only after a valid device+session
  are established, but still before any database mutation — verified this is
  exactly the pattern already used by `org.rs::put_org` in task 4.
- Verified the last-admin guard's `other_admins` count query excludes the row
  being updated (`id <> ?`) and only counts `active = 1` administrators, so
  promoting a technologist to admin before demoting the original admin (as the
  test does) works, and demoting/deactivating the sole admin is blocked.
- Verified `office_admin.rs`'s audit assertions match column-for-column what
  `audit::record` writes (`actor_kind`/`actor_id` derived from
  `context.actor()`, `details` serialized via `serde_json::Value::to_string()`).

## Concerns

- None that block completion. The no-op-update asymmetry with `org.rs` noted
  above is a design-consistency observation, not a defect against this task's
  brief or tests.
- Per the brief and the plan's final-check list, the following were **not**
  exercised and are out of scope for this task: Windows CI job behavior and the
  Windows service host (`apps/standalone/src-tauri`, `service.rs`'s
  `#[cfg(windows)]` path) were not run on Windows; only host-only Cargo tests on
  macOS were executed. No browser/manual verification was performed (there is no
  UI surface in this task — it is host-only Rust).

## Fix round 1

Review came back "Needs fixes": handlers were correct, but `office_admin.rs`
only checked audit `details` (not the full row), two mutating actions
(`office_user.update`, `sscc.block_sizes.update`) had no audit assertion at
all, several regression-prone guarantees had no covering test, and
`update_user`/`put_counter`/`put_block_sizes` needed the same no-op-write
guard task 4 gave `org.rs::put_org`. Commit `5b8f0844d3b0102812b3d1040d13134230aea915`
on top of `7e8106616806ec35159f0fd878bf81161ca2e0a0` addresses all six points.

### 1. Exact audit rows

Added `assert_audit(admin, action, target_type, target_id, details)` to
`office_admin.rs`: it reads `(actor_kind, actor_id, action, target_type,
target_id, result, details)` from `audit_log` for that `action`/`target_id`
and compares the whole tuple in one `assert_eq!` (actor as
`("office_user", <admin.id>)`, `result = "ok"`, `details` parsed back to
`Value` so key order never matters). `Admin` now carries an `id: String`
field, fetched once via `GET /v1/office/me` right after bootstrap in the
`admin()` fixture. Wired into all five actions: `sscc.counter.update`,
`sscc.block_sizes.update`, `office_user.create`, `office_user.update` (on the
tech-to-admin promotion, `details = { "changed": ["role"] }`), and
`office_user.password`.

### 2. Regression-guard tests added

- **2a** — deactivating the sole admin with `role` left as `"admin"` and only
  `active: false` changed: asserts `409 last_admin`, then re-reads
  `GET /v1/office/users` and asserts the admin's `active` and `rev` are
  unchanged.
- **2b** — extended `technologists_cannot_administer` with `403 forbidden` on
  `POST /v1/office/users`, `PUT /v1/office/users/{id}`,
  `PUT /v1/office/users/{id}/password` and `PUT /v1/office/sscc/block-sizes`,
  alongside the existing `GET /v1/office/users` and counter-PUT cases.
- **2c** — right after the deactivating `PUT`, queries
  `SELECT COUNT(*) FROM office_sessions WHERE user_id = ?` and asserts `0`,
  _before_ the subsequent `GET /v1/office/me` call — proving the direct
  `DELETE` in `update_user`, not `OfficeContext`'s lazy expiry check, is what
  empties the table.
- **2d** — after the successful counter move, re-reads `GET /v1/office/sscc`
  and asserts `nextSerial == 2000` and that counter's `rev` equals
  `host_revision.rev`.

### 3. No-op PUTs

- `put_counter` (`routes/sscc.rs`): added `if update.next_serial == current`
  right after the stale-revision check, before the strict `<` floor check —
  returns the current counter via the existing `counter(...)` constructor,
  no `next_revision`/`UPDATE`/audit call.
- `put_block_sizes` (`routes/sscc.rs`): changed the initial read from
  `SELECT rev FROM site` to `SELECT box_block_size, pallet_block_size, rev
FROM site` (reads current sizes inside the same transaction, as asked), and
  added the no-op branch after the stale-revision check, returning
  `read_state(&state)`.
- `update_user` (`routes/office_users.rs`): added `if changed.is_empty()`
  right after the `changed` vector is built (i.e. after both the
  stale-revision and last-admin checks), returning `Ok(Json(current))`.
- Comment wording mirrors `org.rs::put_org`'s existing no-op comment for
  consistency.
- Covering tests (folded into the most relevant existing test function rather
  than new standalone ones, since each already carries the needed setup
  state): the counter no-op is asserted inside
  `sscc_counters_move_only_forward_within_capacity`, the block-sizes no-op
  inside `block_sizes_are_validated_and_versioned`, and the user no-op inside
  `users_are_created_updated_and_the_last_admin_is_protected` (right after the
  tech-to-admin promotion). Each asserts: `200`, the returned `rev` equals the
  pre-call `rev`, `host_revision.rev` is unchanged, and
  `audit_count(admin, action, target_id)` is unchanged.

### 4. Self password change

New test `admin_changing_their_own_password_keeps_the_callers_session`: pairs
a second device (`kind: "office"`), logs the same admin in on it, then has the
admin change their own password via `PUT /v1/office/users/{admin.id}/password`
from the _first_ device/session. Asserts `GET /v1/office/me` on the original
session still returns `200`, the second device's session returns `401`, and
`SELECT COUNT(*) FROM office_sessions WHERE token_hash = ?` for the second
token is `0`.

### 5. Revision exactness

- `sscc_counters_move_only_forward_within_capacity` and
  `block_sizes_are_validated_and_versioned` now read `host_revision.rev`
  immediately before the successful mutating call, assert the response's
  `rev` equals that value `+ 1`, and assert `host_revision.rev` afterward
  equals the response's `rev`.
- The `stale_revision` case in the counter test now also asserts
  `body["error"]["details"]["currentRev"] == rev`.
- Added the accepted capacity edge (`nextSerial: 9_999_999` on the 9-digit
  `460068200` prefix, whose valid range tops out at `capacity - 1 =
9_999_999`) asserting `200` and the echoed `nextSerial`.

### 6. `no_secrets_in_logs.rs` extended

Added, in order: a successful login of the created technologist
(`tech_session`/`tech_token`); an admin-initiated
`PUT /v1/office/users/{tech_id}/password` for them (`204`, new password
`tech_new_password` added to the needles); one `GET /v1/office/me` with a
garbage `Authorization: Bearer` value (`401`, value added to the needles as
`wrong_device_key`); one `GET /v1/office/me` with a garbage
`x-office-session` value (`401`, value added to the needles as
`wrong_session_token`). Also added `tech_token` to the needles (symmetric
with the existing admin `token` needle) and the badge salt encoded with
`base64::engine::general_purpose::STANDARD` (`Engine` trait imported), next
to the existing hex encoding.

### Mutation checks (evidence the new assertions are load-bearing)

Before finalizing, temporarily broke four behaviors one at a time, confirmed
the relevant test failed with the expected message, then reverted:

1. Disabled `update_user`'s session-`DELETE` on deactivation
   (`if false && !update.active`) → `deactivation_and_password_changes_end_the_users_sessions`
   failed at the new session-count assertion (`left: 1, right: 0`), _not_ at
   the `401` check — exactly the false-positive risk named in the review.
2. Disabled `put_counter`'s no-op guard (`if false && update.next_serial ==
current`) → `sscc_counters_move_only_forward_within_capacity` failed on
   `host_revision(&admin).await` (`left: 3, right: 2`, i.e. it bumped when it
   shouldn't have).
3. Broadened `set_password`'s session `DELETE` to drop the `AND id <> ?`
   exclusion → `admin_changing_their_own_password_keeps_the_callers_session`
   failed at "the caller's own session must survive" (`left: 401, right:
200`).
4. Weakened `update_user`'s `loses_admin` condition to ignore `active`
   (`current.role == OfficeRole::Admin && update.role != OfficeRole::Admin`
   only) → `users_are_created_updated_and_the_last_admin_is_protected` failed
   at the deactivate-sole-admin check (`left: (200, Null), right: (409,
"last_admin")`).

All four were reverted immediately after observing the failure; `git diff`
after reverting matched the pre-mutation state exactly (verified by
re-running the full focused suite, all green again).

### Commands and results

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test office_admin
running 6 tests
test block_sizes_are_validated_and_versioned ... ok
test sscc_counters_move_only_forward_within_capacity ... ok
test admin_changing_their_own_password_keeps_the_callers_session ... ok
test technologists_cannot_administer ... ok
test users_are_created_updated_and_the_last_admin_is_protected ... ok
test deactivation_and_password_changes_end_the_users_sessions ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.33s

$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test no_secrets_in_logs   (sandbox disabled)
test secrets_never_reach_the_process_log ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.30s

$ cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline   (sandbox disabled)
19 test suites, all "test result: ok", 0 "FAILED", 0 "^error" lines in the log.
office_admin now reports 6 passed (up from 5); every other suite unchanged.

$ cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
(clean, exit 0)

$ git diff --check
(clean, exit 0)
```

No JSON fixtures or spec/markdown files changed in this round, so no
`prettier` run was needed (`git status --short` before staging showed only
the four `.rs` files listed below).

### Files changed (fix round 1)

```
 apps/standalone/host/src/routes/office_users.rs  |   5 +
 apps/standalone/host/src/routes/sscc.rs          |  27 +-
 apps/standalone/host/tests/no_secrets_in_logs.rs |  58 ++++
 apps/standalone/host/tests/office_admin.rs       | 411 +++++++++++++++++++++--
 4 files changed, 467 insertions(+), 34 deletions(-)
```

### Concerns after fix round 1

None blocking. Same out-of-scope items as before (Windows CI/service, no
browser/UI surface in this task) still apply and were not re-exercised.
