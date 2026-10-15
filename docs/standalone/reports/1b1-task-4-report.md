# Task 4 report: Мастер первого запуска и профиль организации

## What was implemented

Followed `.superpowers/sdd/1b1-task-4-brief.md` step by step (TDD), copying every
code block from the brief verbatim (see "Deviations" below — there were none).

1. **Migration** `apps/standalone/host/migrations/0004_org_sscc.sql` — `org_profile`
   (single row, `id = 1`, checked `name`/`inn`/`gln`/`gs1_prefixes` JSON array/`time_zone`)
   and `sscc_counters` (`issuer_prefix` + `extension` composite key, `next_serial`, `rev`).
2. **Protocol types** in `apps/standalone/proto/src/lib.rs`: `NewOfficeUser`,
   `OrgProfileInput`, `SsccStart`, `BootstrapRequest`/`BootstrapResponse` (`POST
/v1/bootstrap`), `OrgProfile`/`OrgProfileUpdate` (`GET`/`PUT /v1/office/org`). New
   fixtures `bootstrap-request.json`, `bootstrap-response.json`, `org-profile.json`,
   `org-profile-update.json`, and the `bootstrap_and_org_fixtures_round_trip` test in
   `proto/tests/fixtures.rs`.
3. **Test harness**: `bootstrap_body()` and `bootstrap()` added to
   `host/tests/support/app.rs`; `host/tests/bootstrap.rs` created with the 5 tests from
   the brief (happy path incl. audit/session/hello.initialized, loopback+device+
   once-only gating, concurrent-request race, 12 field-level validation cases, and the
   org profile read/update with revision checks).
4. **RED**: confirmed all 5 new tests fail (they compile fine — the test file never
   references not-yet-existing Rust symbols directly, only HTTP routes — and fail at
   runtime because `/v1/bootstrap` and `/v1/office/org` don't exist yet, so every
   request hits the router's `not_found` fallback instead of the expected 200/403/401).
5. **Implementation**:
   - `host/src/validate.rs`: added `use markiro_proto::OrgProfileInput;` next to
     `use crate::error::ApiError;`, plus `ValidOrg`, `digits`, `org`, `issuer_prefix`,
     `serial_capacity`, `first_serial`, `line_name`, `sscc_serial`.
   - `host/src/routes/bootstrap.rs` (new): `bootstrap` handler — loopback + device +
     not-yet-initialized guards, full field validation, PBKDF2 hash off the write lock
     (`spawn_blocking`), one `BEGIN IMMEDIATE` transaction inserting the admin, the
     badge salt + `site.initialized_at`, `org_profile`, both `sscc_counters` rows, all
     lines, opening the session and recording `host.bootstrap` in the audit log.
   - `host/src/routes/org.rs` (new): `get_org` (any authenticated office role) and
     `put_org` (admin only, `expectedRev` optimistic concurrency, computes the
     `changed` field list, seeds fresh `sscc_counters` for a new GLN's issuer prefix
     with `INSERT OR IGNORE`, records `org.update`).
   - `routes/mod.rs`: added `pub mod bootstrap;` and `pub mod org;`.
   - `server.rs`: wired `POST /v1/bootstrap` and `GET|PUT /v1/office/org` into
     `protected_routes()`.
6. **GREEN**: full workspace test suite passes (74 tests across 17 suites, up from 68
   before this task — 5 new `bootstrap.rs` integration tests + 1 new fixture test).
7. Formatting: `cargo fmt --all` reformatted line-wraps in 3 files
   (`validate.rs`, `routes/bootstrap.rs`, `tests/bootstrap.rs`); `-- --check` clean
   afterwards. `prettier --write`/`--check` on the 4 new fixtures — already
   prettier-clean (brief supplied them pre-formatted), no changes.

## TDD evidence

**RED** — `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test bootstrap`, run after `host/tests/bootstrap.rs` and the `support::app` helpers existed but before any Step-5 implementation file was touched:

```
---- the_wizard_initializes_the_host_and_signs_the_admin_in stdout ----
thread '...' panicked at host/tests/bootstrap.rs:18:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for POST /v1/bootstrap"}}
  left: 404
 right: 200

---- the_wizard_runs_once_from_loopback_with_a_device stdout ----
thread '...' panicked at host/tests/bootstrap.rs:101:5:
assertion `left == right` failed
  left: (404, String("not_found"))
 right: (403, String("loopback_only"))

---- concurrent_wizards_initialize_exactly_once stdout ----
thread '...' panicked at host/tests/bootstrap.rs:126:5:
assertion `left == right` failed
  left: [404, 404]
 right: [200, 409]

---- invalid_wizard_input_names_the_field stdout ----
thread '...' panicked at host/tests/bootstrap.rs:153:9:
assertion `left == right` failed: admin.login
  left: 404
 right: 400

---- the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions stdout ----
thread '...' panicked at host/tests/support/app.rs:179:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for POST /v1/bootstrap"}}
  left: 404
 right: 200

test result: FAILED. 0 passed; 5 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

Matches the brief's expected failure exactly ("нет маршрутов мастера и профиля") — the
test binary compiled cleanly; every failure is a 404 from the router's fallback because
the routes did not exist yet.

**GREEN** — after implementation (raw, unfiltered output via `rtk proxy`):

- `cargo build --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline`
  → clean compile, **zero warnings**.
- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --test fixtures`
  → **11 passed**, including `bootstrap_and_org_fixtures_round_trip` (was 10 before this task).
- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test bootstrap`
  → **5 passed, 0 failed**, finished in 0.17-0.18s (run twice: once right after
  implementation, once after `cargo fmt`). Does not bind any TCP port (in-process
  `tower::ServiceExt::oneshot` router calls), so it ran fine inside the sandbox.
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
  (run with the sandbox disabled, since `tests/hello.rs` and the lock test in
  `tests/platform.rs` bind real TCP sockets — EPERM under the sandbox, as flagged in
  the task instructions): **all green, run twice** (once before `cargo fmt`, once
  after) — markiro-host lib 9/9, markiro-host bin 3/3, `bootstrap.rs` 5/5,
  `foundation.rs` 12/12, `hello.rs` 5/5, `office_auth.rs` 9/9, `pairing.rs` 5/5,
  `platform.rs` 6/6, markiro-proto lib 0/0, `fixtures.rs` 11/11, `markiro_standalone_lib`
  6/6, `markiro_standalone` bin 0/0, `host_probe.rs` 2/2, `host_probe_proxy.rs` 1/1,
  3× doc-tests 0/0 — **74 passed, 0 failed** across 17 suites. Wall time ~1.3-1.4s
  (the task-1 `aws-lc-sys` dev-profile optimization keeps PBKDF2 fast even in debug
  builds).
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` → clean.
- `node_modules/.bin/prettier --check` on the 4 new fixtures → clean, no changes needed.
- `git diff --check --cached` on the 14 staged files → clean (no whitespace errors).

## Files changed

Created:

- `apps/standalone/host/migrations/0004_org_sscc.sql`
- `apps/standalone/host/src/routes/bootstrap.rs`
- `apps/standalone/host/src/routes/org.rs`
- `apps/standalone/host/tests/bootstrap.rs`
- `apps/standalone/proto/fixtures/bootstrap-request.json`
- `apps/standalone/proto/fixtures/bootstrap-response.json`
- `apps/standalone/proto/fixtures/org-profile.json`
- `apps/standalone/proto/fixtures/org-profile-update.json`

Modified:

- `apps/standalone/proto/src/lib.rs` (+74/-0)
- `apps/standalone/proto/tests/fixtures.rs` (+13/-5)
- `apps/standalone/host/src/validate.rs` (+139/-0)
- `apps/standalone/host/src/server.rs` (+5/-0)
- `apps/standalone/host/src/routes/mod.rs` (+2/-0)
- `apps/standalone/host/tests/support/app.rs` (+28/-0)

14 files changed, 956 insertions(+), 3 deletions(-). No changes outside
`apps/standalone/proto` and `apps/standalone/host`; no `Cargo.toml`/`Cargo.lock`
changes (both required dependencies — `aws-lc-rs`, `base64` — and the dev-dependencies
— `tower`, `http-body-util` — were already present per the global constraints; `time`
already has the `parsing` feature). `apps/station` untouched.

## Deviations from the brief's code

None. Every code block in Step 1 (migration), Step 2 (proto types/fixtures/test),
Step 3 (test support helpers and `bootstrap.rs`), and Step 5 (`validate.rs` additions,
`routes/bootstrap.rs`, `routes/org.rs`, `routes/mod.rs`, `server.rs`) was copied
character-for-character from the brief and compiled and passed unmodified. The only
changes to those files afterward were `cargo fmt`'s automatic line-wrap reflows in
`validate.rs`, `routes/bootstrap.rs`, and `tests/bootstrap.rs` (whitespace/line-break
only, confirmed by rereading each file after formatting and by the tests staying
green across both runs).

## Self-review

- Walked every new/changed file against the brief line by line after `cargo fmt`
  reformatted the 3 files above, confirming the reflow changed only whitespace.
  Reread `git diff --cached --stat` to confirm exactly the brief's declared file list
  changed (14 files: 8 created, 6 modified) — no unrelated file touched, nothing
  under `apps/station`.
- Traced every one of the 12 `invalid_wizard_input_names_the_field` cases by hand
  against `validate::office_login`/`person_name`/`password`/`org`/`sscc_serial`/
  `line_name` to confirm each produces exactly the expected `details.field` string
  (e.g. `"ад"` fails `office_login`'s ASCII-only byte check regardless of its 4-byte
  UTF-8 length; `10_000_000` for `palletNextSerial` sits exactly at
  `serial_capacity("460068200") == 10^7`, the first invalid value; `" линия 1 "`
  collides with `"Линия 1"`'s `name_key` after trim+lowercase, landing on index 1).
- Confirmed `issuer_prefix(gln: &str) -> &str { &gln[..9] }` is only ever called
  after `validate::org` has already checked the GLN is exactly 13 ASCII digits (both
  in `bootstrap.rs` and `org.rs`), so the byte-slice index can't panic on a
  multi-byte boundary.
- Confirmed the revision bookkeeping in `the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions`:
  the test's `seed_office_user` helper _also_ calls `next_revision` (bumping the
  global counter independently of `org_profile.rev`), so the test's assertions
  correctly compare relative values (`body["rev"] > rev`, `body["rev"] == global`)
  rather than hard-coded absolutes — verified this holds given `put_org`'s ordering
  (re-read current row and check `expected_rev` first, then call `next_revision`
  once and stamp every row it touches with that same value).
- Verified `&mut Transaction<'static, Sqlite>` and `&mut PoolConnection<Sqlite>`
  both coerce to the `&mut SqliteConnection` parameter `read_org` and
  `next_revision`/`begin_write`-adjacent helpers expect, via deref coercion — proven
  by the successful compile, not just inspection.
- Ran the full workspace suite three times total (RED capture excluded): once right
  after implementation, once after `cargo fmt`, and once more with `rtk proxy` for
  unfiltered raw output to confirm exact per-suite pass counts for this report — all
  three green with identical counts.
- Checked `git status --short` before staging: no pre-existing user changes were
  present or at risk of being touched; `apps/standalone/target` confirmed gitignored.

## Concerns

None outstanding. Full-workspace `cargo test` and the two socket-binding test files
(`hello.rs`, the lock test in `platform.rs`) required `dangerouslyDisableSandbox:
true`, exactly as anticipated by the task's environment notes; every other command
(migrations, proto fixtures, the new `bootstrap.rs` in-process router tests, `cargo
fmt`, `prettier`, `git diff --check`) ran fine inside the sandbox.

## Fix round 1

Review of commit `337c3766d` came back "Needs fixes" with four findings. Fixed on top
of that commit in `apps/standalone/host/src/routes/org.rs` and
`apps/standalone/host/tests/bootstrap.rs` only — no migration, proto, or other module
changes were needed.

### 1. (Repo rule) `org.update` audit assertion checked only `details`

The root `AGENTS.md` and `apps/standalone/AGENTS.md` require audit tests to assert
exact actor, action, target and result, not just a growing count or the free-form
`details` blob. `the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions`
in `host/tests/bootstrap.rs` only checked `details` for the `org.update` row.

Fixed by:

- Calling `GET /v1/office/me` with the admin token right after `bootstrap()` (which
  only returns the token) to obtain the admin's id, the same pattern already used in
  `the_wizard_initializes_the_host_and_signs_the_admin_in`.
- Selecting `actor_kind, actor_id, action, target_type, target_id, result, details`
  for the `org.update` row (a 7-column `query_as`, the same arity already proven to
  work in this file's `host.bootstrap` assertion) and asserting the tuple equals
  exactly `("office_user", Some(<admin id>), "org.update", Some("org_profile"),
Some("1"), "ok")`, with the existing `details` equality check kept as a separate
  assertion right after.

### 2. (Integrity) `INSERT OR IGNORE` on `sscc_counters` could silently swallow a CHECK violation

In `host/src/routes/org.rs`, `put_org`'s new-issuer-prefix counter seeding used
`INSERT OR IGNORE INTO sscc_counters (...) VALUES (...)`. SQLite's `OR IGNORE`
conflict clause applies to _any_ constraint violation on the statement — unique/
primary-key conflicts, but also `CHECK` and `NOT NULL` — so a hypothetical
CHECK-violating row (not reachable today only because `validate::org`/
`validate::first_serial` already guarantee valid values, but a defense-in-depth gap)
would vanish with no error instead of surfacing as a bug.

Fixed by changing the statement to:

```sql
INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES (?, ?, ?, ?)
ON CONFLICT (issuer_prefix, extension) DO NOTHING
```

`ON CONFLICT (issuer_prefix, extension) DO NOTHING` only matches a conflict on that
exact column list (the table's primary key) — a CHECK failure is a different SQLite
error class entirely and is never routed through the conflict clause, so it now
propagates as a real `sqlx::Error` → `ApiError::internal` (500) instead of being
dropped.

**Verified directly against the real schema** (not just by reasoning about SQLite
semantics), using the `sqlite3` CLI (3.44.4) against a scratch database created from
the exact `sscc_counters` DDL in `migrations/0004_org_sscc.sql`:

```
== 1. fresh insert should succeed ==
exit=0
460709100|0|1|3
== 2. conflicting key should be silently skipped (no error, no row change) ==
exit=0
460709100|0|1|3
== 3. CHECK-violating row (bad extension) must now surface as an ERROR, not be silently dropped ==
Error: stepping, CHECK constraint failed: extension IN (0, 1) (19)
exit=19
460709100|0|1|3
== 4. for comparison: the OLD 'INSERT OR IGNORE' silently drops the same CHECK violation ==
exit=0
460709100|0|1|3
```

Case 4 reproduces exactly the bug the review flagged (silent drop, `exit=0`, no row
written, no error); case 3 with the new statement turns the same input into a hard
error, confirming the fix. No new automated test was added for this specific case:
the HTTP route can't currently be driven into it (upstream validation always produces
a valid `issuer_prefix`/extension pair), so the meaningful verification is this direct
SQL-level probe against the real DDL, mirroring the review's own methodology.

### 3. (No-op writes) `PUT /v1/office/org` with nothing changed still wrote

`put_org` already computed a `changed: Vec<&str>` list for the audit `details`, but
used it only for reporting — even an empty `changed` still called `next_revision`
(bumping `host_revision` and re-stamping `org_profile` with a rev nothing needed),
ran the `UPDATE org_profile` with identical values, and wrote an `org.update` audit
row with `details: { "changed": [] }`.

Fixed in `host/src/routes/org.rs` by returning right after the stale-revision check
and the `changed` computation, before `next_revision`:

```rust
if changed.is_empty() {
    // Nothing actually changed: report the profile as-is without bumping
    // the revision, writing a row nobody changed, or auditing a no-op.
    return Ok(Json(current));
}
let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
```

The stale-revision check (`if current.rev != update.expected_rev { return
Err(ApiError::stale_revision(...)); }`) still runs first and is untouched, so a
no-op request with a stale `expectedRev` still correctly gets `409 stale_revision`
rather than silently succeeding. The early return drops `tx` without calling
`.commit()`; since only a `SELECT` had run inside the `BEGIN IMMEDIATE` transaction
at that point, the implicit `ROLLBACK` has nothing to undo and simply releases the
write lock — the same already-proven pattern `bootstrap.rs`'s `already_initialized`
guard uses.

Covering test: new `putting_the_org_profile_unchanged_is_a_no_op` in
`host/tests/bootstrap.rs` — bootstraps, reads the org profile, `PUT`s back exactly
the same field values (the literal org values from `bootstrap_body()`) with the
current `expectedRev`, and asserts: `200 OK`, response `rev` equals the pre-PUT
`rev`, `host_revision.rev` is unchanged, and `COUNT(*) FROM audit_log WHERE action =
'org.update'` is unchanged.

**Sabotage-verified**: temporarily changed the guard to `if false && changed.is_empty()`
and re-ran just this test — it failed as expected (`left: 2, right: 1` on the
`host_revision.rev` comparison, i.e., the no-op PUT had bumped the global revision).
Reverted the sabotage and confirmed the test (and the full `bootstrap.rs` suite)
passed again before proceeding.

### 4. (Revision exactness) Loosened assertions tightened

In the same test (`the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions`):

- Replaced `assert!(body["rev"].as_i64().unwrap() > rev)` with capturing
  `host_revision.rev` immediately before the successful `PUT` into `global_before`,
  then asserting the response `rev` equals exactly `global_before + 1` — precise
  instead of merely "increased".
- Added `rev` to the `sscc_counters` query's selected columns and its `ORDER BY`
  comparison tuple (now `(String, i64, i64, i64)`): the pre-existing prefix's two
  counters (`460068200`) keep `rev = 1` (untouched, from the original bootstrap
  transaction), while the two newly-seeded counters for the new prefix
  (`460709100`) carry the just-computed `new_rev` (the same value as the PUT
  response's `rev` and `host_revision.rev`), confirming `put_org` stamps freshly
  inserted counter rows with the transaction's own revision rather than a stale or
  default value.

### Commands and output

```
cargo build --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests --offline
  -> Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.17s, zero warnings

cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test bootstrap
  -> running 6 tests ... test result: ok. 6 passed; 0 failed; finished in 0.19-0.20s
     (run three times: right after the fix, once with the item-3 guard sabotaged
     (1 failed, as expected), and once more after reverting the sabotage — final
     state green)

cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline   (sandbox disabled:
  tests/hello.rs and the lock test in tests/platform.rs bind real TCP sockets)
  -> all green: markiro-host lib 9/9, markiro-host bin 3/3, bootstrap.rs 6/6
     (was 5/5), foundation.rs 12/12, hello.rs 5/5, office_auth.rs 9/9, pairing.rs 5/5,
     platform.rs 6/6, markiro-proto lib 0/0, fixtures.rs 11/11, markiro_standalone_lib
     6/6, markiro_standalone bin 0/0, host_probe.rs 2/2, host_probe_proxy.rs 1/1,
     3x doc-tests 0/0 -- 75 passed, 0 failed, 17 suites (was 74/17) -- ~4s wall time

cargo fmt --manifest-path apps/standalone/Cargo.toml --all
  -> no output (nothing to reformat; the two changed files were already
     rustfmt-clean as written)

cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
  -> clean (exit 0)

git diff --check --cached
  -> clean (exit 0), staged files: apps/standalone/host/src/routes/org.rs,
     apps/standalone/host/tests/bootstrap.rs (2 files changed, 116 insertions(+),
     14 deletions(-))
```

### Files changed (fix round 1)

- `apps/standalone/host/src/routes/org.rs` (+7/-1): `put_org`'s no-op short-circuit
  after computing `changed`; the `sscc_counters` seed statement changed from
  `INSERT OR IGNORE` to `INSERT ... ON CONFLICT (issuer_prefix, extension) DO
NOTHING`.
- `apps/standalone/host/tests/bootstrap.rs` (+109/-13): admin-id lookup via `GET
/v1/office/me`, exact `org.update` audit-row assertion, exact revision-arithmetic
  assertion, `rev` added to the counters query, and the new
  `putting_the_org_profile_unchanged_is_a_no_op` test.

No other deviations from the review's four points; nothing outside these two files
changed.
