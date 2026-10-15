# Task 3 report: Пароли, офисные сессии и вход

## What was implemented

Followed `.superpowers/sdd/1b1-task-3-brief.md` step by step (TDD):

1. **Migration** `apps/standalone/host/migrations/0003_office_auth.sql` — `office_users`
   (login `COLLATE NOCASE`, role check, `password_phc`, `active`) and `office_sessions`
   (token hash, bound to `user_id` + `device_id`, `created_at`/`last_seen_at`/`expires_at`),
   exactly as specified.
2. **Protocol types** in `apps/standalone/proto/src/lib.rs`: `OFFICE_SESSION_HEADER`,
   `OfficeRole`, `OfficeLoginRequest` (`deny_unknown_fields`), `OfficeUser`, `OfficeSession`.
   New fixtures `office-login-request.json`, `office-user.json`, `office-session.json`,
   `phc-password.json`, and the `office_auth_fixtures_round_trip` test in
   `proto/tests/fixtures.rs`.
3. **Test harness**: `seed_office_user`, `with_session`, `login` added to
   `host/tests/support/app.rs`; `host/tests/office_auth.rs` created with the 7 tests from
   the brief.
4. **RED**: confirmed the new test file fails to compile before any implementation
   (`hash_password` does not exist yet).
5. **Implementation**:
   - `host/src/secrets.rs`: `PASSWORD_ITERATIONS` (600 000), `Phc`, `parse_phc`,
     `hash_password`, `verify_password`, `dummy_password_phc`, plus the 4 new unit tests
     (independently-computed reference PHC, round-trip, domain fixture cross-check,
     malformed verifiers).
   - `host/src/validate.rs` (new): `office_login`, `person_name`, `password`. Not yet
     called from any handler in this task (brief: consumed by task 4); no dead-code
     warning because the module and its functions are `pub` from the crate root.
   - `host/src/rate_limit.rs` (new): `RateLimiter` — sliding per-`IpAddr` window.
   - `host/src/server.rs`: `AppState.login_limiter: Arc<RateLimiter>` (10/minute),
     built in `AppState::new` before `clock` is moved into its field; three new routes
     under `protected_routes()`.
   - `host/src/auth.rs`: `SESSION_IDLE` (30 min), `SESSION_ABSOLUTE` (12 h),
     `OfficeContext` (extractor, `actor()`, `require_admin()`), `open_session`,
     `end_session`.
   - `host/src/routes/office_auth.rs` (new): `login`, `logout`, `me` handlers.
   - `routes/mod.rs` and `lib.rs` wired up the new modules.
6. **GREEN**: full workspace test suite passes (66 tests across all binaries).
7. Formatting: `cargo fmt --all` (reformatted line-wraps in 5 files), `-- --check` clean;
   `prettier --write`/`--check` on the 4 new fixtures — already prettier-clean, no changes.

## TDD evidence

**RED** — `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test office_auth`, run before any Step-5 implementation file existed:

```
cargo test: 1 errors, 1 warnings (2 crates)
error[E0425]: cannot find function `hash_password` in module `markiro_host::secrets`
   --> host/tests/support/app.rs:115:38
    |
115 |     let phc = markiro_host::secrets::hash_password(password);
    |                                      ^^^^^^^^^^^^^ not found in `markiro_host::secrets`

warning: build failed, waiting for other jobs to finish...
```

Matches the brief's expected failure exactly ("нет `hash_password`, маршрутов офиса").

**GREEN** — after implementation:

- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --lib secrets`
  → 6 passed (0 failed), finished in 0.15s.
- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --test fixtures`
  → 10 passed, including `office_auth_fixtures_round_trip`.
- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test office_auth`
  → **7 passed, 0 failed, finished in 0.65-0.68s** (measured twice; PBKDF2 at 600 000
  iterations stays well under a second per hash thanks to the task-1 `aws-lc-sys`
  opt-level=3 profile).
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
  (run with the sandbox disabled, since `tests/hello.rs` and the lock test in
  `tests/platform.rs` bind real TCP sockets — EPERM under the sandbox, as flagged in the
  task instructions): **all green**, run twice (once before `cargo fmt`, once after) —
  markiro-host lib 9/9, markiro-host bin 3/3, `foundation.rs` 12/12, `hello.rs` 5/5,
  `office_auth.rs` 7/7, `pairing.rs` 5/5, `platform.rs` 6/6, markiro-proto fixtures
  10/10, `markiro_standalone_lib` 6/6, `host_probe.rs` 2/2, `host_probe_proxy.rs` 1/1.
  Total wall time ~10-15s for the whole workspace.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` → clean.
- `node_modules/.bin/prettier --check` on the 4 new fixtures → clean.
- `git diff --check` on `apps/standalone/proto apps/standalone/host` → clean (no
  whitespace errors).

## Files changed

Created:

- `apps/standalone/host/migrations/0003_office_auth.sql`
- `apps/standalone/host/src/rate_limit.rs`
- `apps/standalone/host/src/validate.rs`
- `apps/standalone/host/src/routes/office_auth.rs`
- `apps/standalone/host/tests/office_auth.rs`
- `apps/standalone/proto/fixtures/office-login-request.json`
- `apps/standalone/proto/fixtures/office-session.json`
- `apps/standalone/proto/fixtures/office-user.json`
- `apps/standalone/proto/fixtures/phc-password.json`

Modified:

- `apps/standalone/proto/src/lib.rs` (+47/-0)
- `apps/standalone/proto/tests/fixtures.rs` (+11/-1)
- `apps/standalone/host/src/secrets.rs` (+150/-1)
- `apps/standalone/host/src/auth.rs` (+133/-1)
- `apps/standalone/host/src/server.rs` (+12/-0)
- `apps/standalone/host/src/lib.rs` (+2/-0)
- `apps/standalone/host/src/routes/mod.rs` (+1/-0)
- `apps/standalone/host/tests/support/app.rs` (+43/-0)

No changes outside `apps/standalone/proto` and `apps/standalone/host`; no `Cargo.toml`
or `Cargo.lock` changes (both required dependencies were already present per the global
constraints).

## Deviations from the brief's code

1. **`host/src/auth.rs`, `OfficeContext::from_request_parts` SQL — dropped
   `AND s.ended_at IS NULL`.** The brief's query was:

   ```sql
   SELECT s.id, s.last_seen_at, s.expires_at, u.id, u.login, u.name, u.role, u.active
   FROM office_sessions s JOIN office_users u ON u.id = s.user_id
   WHERE s.token_hash = ? AND s.device_id = ? AND s.ended_at IS NULL
   ```

   but the `office_sessions` table (both in this brief's own Step 1 and in the source
   plan `docs/superpowers/plans/2026-09-26-standalone-1b1-host-office-api.md`) has no
   `ended_at` column — sessions are hard-deleted by `end_session`/`open_session`, and the
   constraints file states plainly: "Закрытая или истёкшая сессия удаляется" (a closed or
   expired session is deleted). Task 5's brief confirms the same model
   (`DELETE FROM office_sessions WHERE user_id = ?`, no `ended_at` anywhere). Left as
   written, the query would fail at runtime with a SQLite "no such column" error on
   every `/v1/office/me` and `/v1/office/logout` call, turning them all into 500s. I
   removed the clause; behavior is unchanged from what the tests (and the rest of the
   brief) actually specify — deleted rows already fail the `JOIN`/`WHERE token_hash`
   lookup, so the `IS NULL` guard was redundant even in a schema that had the column.

2. **`host/src/routes/office_auth.rs`, `login` — wrapped `dummy_password_phc` in a
   closure.** The brief's line
   ```rust
   let phc = stored_phc.as_deref().unwrap_or_else(dummy_password_phc);
   ```
   fails to compile with E0597 ("`stored_phc` does not live long enough" / "argument
   requires that `stored_phc` is borrowed for `'static`"). Passing the bare function
   item fixes `Option::unwrap_or_else`'s generic return type to the item's own concrete
   `&'static str` signature before the compiler considers `stored_phc.as_deref()`'s
   naturally shorter-lived `&str`, and a local, non-`'static` `Option<String>` cannot
   satisfy that. Changed to:
   ```rust
   let phc = stored_phc.as_deref().unwrap_or_else(|| dummy_password_phc());
   ```
   which lets the closure's return type be inferred from the `Option<T>` receiver
   instead of the fn item's fixed signature; the `&'static str` result still coerces to
   the shorter lifetime. Identical runtime behavior (calls `dummy_password_phc()` only
   when `stored_phc` is `None`, same as before). Note: if clippy is ever added to this
   crate's gates, `clippy::redundant_closure` will suggest removing this closure —
   don't; that reintroduces the compile error.

No other deviations. Everything else (migration DDL, proto types/fixtures, rate
limiter, validate.rs, session lifetime constants, audit entries, route wiring) was
copied verbatim from the brief and compiled/passed unchanged.

## Self-review

- Walked every new/changed file against the brief line by line after `cargo fmt`
  reformatted line-wraps in `auth.rs`, `office_auth.rs`, `server.rs`, `validate.rs`,
  `tests/support/app.rs`, and `tests/office_auth.rs` — confirmed the reflow didn't
  change semantics, and reread `git diff --stat` to confirm no file outside the
  brief's declared scope changed.
  - Confirmed `WHERE login = ?` against a column declared `COLLATE NOCASE` performs
    case-insensitive comparison in SQLite by default, matching the
    `login_opens_a_session_bound_to_the_device` test's `"IRINA"` vs. stored `"irina"`.
  - Confirmed the `match row { Some((...)) if guard => ..., other => ... }` pattern in
    `login` compiles and behaves correctly: a failing guard does not consume the
    by-value bindings, so `other` still binds the original, intact `Option<UserRow>` —
    verified by the passing `wrong_password_unknown_login_and_inactive_user_are_denied_and_audited`
    test (which exercises exactly this fallback path three times).
  - Verified `aws_lc_rs::pbkdf2` is unconditionally public in aws-lc-rs 1.18.1 (no
    extra feature needed) by inspecting the already-cached `.crate` source.
  - Verified no new dependency lines were needed: `aws-lc-rs`, `base64`, `tower`,
    `http-body-util` were already present in `host/Cargo.toml`; `time` already has the
    `parsing` feature.
- Ran the full workspace suite twice (before and after `cargo fmt`) to make sure
  reformatting didn't silently change behavior.
- Checked `git status --short` before and after: no pre-existing user changes were
  touched; nothing under `apps/station` was touched.

## Concerns

- `validate.rs`'s three functions are implemented but unused by any handler in this
  task, exactly as the brief specifies (task 4 wires them in). No compiler warning
  because they're `pub` in a `pub mod` at the crate root.
- The `ended_at` fix (deviation 1) is a correctness fix for a bug present in both the
  task brief and the source plan document; flagging it explicitly in case task 4/5's
  briefs were drafted assuming the buggy query and expect a different resolution.
- Full-workspace `cargo test` and the two socket-binding test files required
  `dangerouslyDisableSandbox: true`, as anticipated by the task's environment notes;
  the in-process router tests (`office_auth.rs`, `secrets` unit tests, `fixtures.rs`)
  ran fine inside the sandbox.

## Fix round 1

Review of commit `0944012bd` came back "Needs fixes" with one important finding and
two related items. Fixed on top of that commit in `apps/standalone/host/src/routes/office_auth.rs`
and `apps/standalone/host/tests/office_auth.rs` only.

### 1. (Important) Unbounded/raw login written to the audit log

`login` now trims `request.login` and validates it with the existing
`validate::office_login("login", ...)` **before** any database lookup or PBKDF2 call:

- Malformed (fails `validate::office_login`, e.g. too long or non-ASCII): no `SELECT`
  against `office_users`, no `spawn_blocking`/PBKDF2 at all. A `begin_write` transaction
  records exactly `actor: Device(device.id)`, `action: "office.login"`,
  `target_type: Some("office_user")`, `target_id: None`, `outcome: Denied`,
  `details: {"reason": "invalid_login"}`, commits, and returns the same
  `ApiError::unauthorized("wrong login or password")` as every other denial — so a
  client cannot distinguish "malformed" from "wrong password" from the response.
- Well-formed: the **trimmed** value is used both for the `WHERE login = ?` lookup and,
  on denial, in `details: {"login": <trimmed>}` — never the raw, untrimmed
  `request.login`.

This closes the report: no attacker-controlled string of unbounded length (up to
axum's default ~2 MB body limit) ever reaches a database column or an audit-log row,
and a value typed into the password field but sent as `login` (or vice versa) can no
longer appear verbatim in `details`, matching the constraint "в details — никаких
паролей".

Covering test: `malformed_logins_are_denied_without_recording_the_input` — sends a
10 000-character login and, separately, `"ирина"` (non-ASCII). Both get `401` with
`error.code == "unauthorized"`, and after each attempt the last audit row is exactly
`("device", Some(device_id), "office.login", None, "denied", {"reason":"invalid_login"})`.

### 2. (TOCTOU) Session opened on a since-changed password/active flag

`password_phc`/`active` were read in a plain `SELECT` before the (relatively slow,
`spawn_blocking`) PBKDF2 call, and the `BEGIN IMMEDIATE` transaction that follows only
used that stale tuple to decide whether to call `open_session`. A password change or
deactivation that committed while PBKDF2 was running would not be seen, so a session
could still be opened for a login that had just been changed or disabled — and that
session would survive a "delete this user's sessions" step a concurrent password
change already ran, since the new session is inserted afterward.

Fix: inside the `BEGIN IMMEDIATE` transaction, before deciding anything, re-select
`password_phc, active` for that user id (`SELECT password_phc, active FROM
office_users WHERE id = ?`, bound to the row's id, executed against `&mut *tx`). The
request is accepted only if the freshly-read `password_phc` equals the value that was
actually verified by PBKDF2 (captured earlier as `stored_phc`/`verify_phc`, cloned
before being moved into the `spawn_blocking` closure) **and** `active == 1`. This is
computed once into a single `accepted: bool`, and the existing `match row { Some(...)
if accepted => ..., other => ... }` branches on it exactly once — the pre-existing
"other" denial arm (unknown login / wrong password / inactive-at-first-read) now also
naturally covers "accepted, but stale by the time the transaction opened", with no
special-casing needed.

Since `BEGIN IMMEDIATE` takes SQLite's write lock up front, this re-read is
serialized against any concurrent write transaction (e.g. a password-change or
deactivation handler that itself writes inside `begin_write`), so the accept decision
is always made against a value no older than the start of this transaction, not the
value read (and abandoned to PBKDF2) up to hundreds of milliseconds earlier.

**No deterministic test was added for the race itself** — reliably interleaving another
transaction's commit inside the `spawn_blocking` PBKDF2 window from a test would
require either sleeping (flaky/slow) or a test-only hook into the handler's internals,
neither of which fits the existing in-process-router test style used throughout this
suite. The existing tests do exercise the corrected code path's non-racy behavior
(e.g. `wrong_password_unknown_login_and_inactive_user_are_denied_and_audited`'s
`active = 0` case now goes through the fresh re-select rather than the stale initial
read, and still denies correctly), which is the extent of coverage practical here, as
the task anticipated.

### 3. (Coverage) `active == 0` branch of `OfficeContext`

Added `me_is_denied_and_the_session_is_deleted_when_the_user_is_deactivated`: log in,
directly `UPDATE office_users SET active = 0`, then `GET /v1/office/me` returns `401`
and `SELECT COUNT(*) FROM office_sessions WHERE token_hash = ?` is `0` — exercising the
`active == 0` arm of `OfficeContext::from_request_parts`'s
`if now >= expires || now >= last_seen + SESSION_IDLE || active == 0 { ... }` guard,
which no earlier test reached (the earlier tests only reached the two time-based
conditions).

### Commands and output

RED/GREEN in the strict TDD sense wasn't re-run for this fix round (both the tests and
the handler change were written together against explicit reviewer-specified
behavior); instead every command below was run **after** the fix, against the final
state, as verification:

```
cargo build --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline
  -> Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.12s (clean build)

cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test office_auth
  -> running 9 tests ... test result: ok. 9 passed; 0 failed; finished in 0.66-0.68s
     (run twice, before and after `cargo fmt`; includes both new tests and all 7
     pre-existing ones, all assertions unchanged and green)

cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline   (sandbox disabled:
  tests/hello.rs and the lock test in tests/platform.rs bind real TCP sockets)
  -> all green: markiro-host lib 9/9, markiro-host bin 3/3, foundation.rs 12/12,
     hello.rs 5/5, office_auth.rs 9/9, pairing.rs 5/5, platform.rs 6/6,
     markiro-proto fixtures 10/10, markiro_standalone_lib 6/6, host_probe.rs 2/2,
     host_probe_proxy.rs 1/1 -- run twice (before/after `cargo fmt`), ~9-11s wall time
     each time.

cargo fmt --manifest-path apps/standalone/Cargo.toml --all
  -> reformatted apps/standalone/host/src/routes/office_auth.rs only (line wraps)

cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
  -> clean (exit 0)

git diff --check -- apps/standalone/proto apps/standalone/host
  -> clean (exit 0)
```

### Files changed (fix round 1)

- `apps/standalone/host/src/routes/office_auth.rs` (+58/-6): `login` rewritten as
  described above; new `use crate::validate;` import.
- `apps/standalone/host/tests/office_auth.rs` (+77/-0): two new tests.

No migration, proto, or other module changes were needed for this round.
