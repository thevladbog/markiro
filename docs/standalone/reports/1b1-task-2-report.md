# Task 2 report: устройства, журнал действий и подключение местной станции

Commit: `5a8711585ac4bc9030d6362a8ff57e76a27ff3f7` on `claude/autonomous-desktop-station-9e6f13`.

## What was implemented

Followed the brief's 7 steps in order (TDD for the host; proto types, fixtures
and their round-trip tests were added together as the brief specifies):

1. **Migration** `apps/standalone/host/migrations/0002_devices_lines_audit.sql`
   — `lines`, `devices`, `audit_log` tables, verbatim from the brief. Updated
   `host/tests/foundation.rs` so `migrations_apply_once_and_site_starts_uninitialized`
   compares the applied-migration count against `db::MIGRATOR.iter().count()`
   instead of the literal `1`.
2. **Proto types and fixtures**: `DeviceKind`, `LocalPairRequest`
   (`deny_unknown_fields`), `PairResponse`, `DeviceInfo` added to
   `proto/src/lib.rs` after `ErrorBody`/`impl ErrorBody`; three new fixtures
   (`local-pair-request.json`, `pair-response.json`, `device-info.json`); two
   new tests in `proto/tests/fixtures.rs` (`pairing_fixtures_round_trip`,
   `requests_reject_unknown_fields`), with the four new names merged into the
   existing `use markiro_proto::{...}` block.
3. **Host tests written first** (`host/tests/pairing.rs`, new) and the two new
   helpers `with_device`/`pair_device` appended to
   `host/tests/support/app.rs`.
4. **Confirmed RED** (see below) before touching implementation files.
5. **Implementation**: `host/src/secrets.rs` (random device keys, SHA-256
   hashing), `host/src/audit.rs` (`Actor`/`Outcome`/`Entry`/`record`),
   `host/src/auth.rs` (`AuthDevice` extractor, `require_loopback`),
   `host/src/routes/mod.rs` + `host/src/routes/pairing.rs`
   (`POST /v1/local-pair`, `GET /v1/device`). Wired `audit`, `auth`, `routes`,
   `secrets` into `host/src/lib.rs`; added `protected_routes()` behind
   `middleware::from_fn(protocol_guard)` in `host/src/server.rs`. Added the
   "Local pairing trust" and "Audit" sections to `apps/standalone/AGENTS.md`
   after "Three identities".
6. **Confirmed GREEN** for the focused pairing test, then the full workspace
   suite (below).
7. **Committed** with the exact trailer required by the constraints
   (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), matching the
   convention already used by every prior commit on this branch.

No changes were needed to `apps/standalone/Cargo.toml`: `aws-lc-rs = "=1.18.1"`
and `base64 = "=0.22.1"` were already direct dependencies of `markiro-host`
from Task 1 (added there in preparation, unused until now), and
`http-body-util`/`tower` dev-dependencies were already present too, exactly
matching the global constraints.

## TDD evidence

**RED** — `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test pairing`
(run before any of Step 5's implementation files existed), exit code 101:

```
   Compiling markiro-host v0.1.0 (.../apps/standalone/host)
error[E0432]: unresolved import `markiro_host::secrets`
 --> host/tests/pairing.rs:4:19
  |
4 | use markiro_host::secrets::key_hash;
  |                   ^^^^^^^ could not find `secrets` in `markiro_host`

For more information about this error, try `rustc --explain E0432`.
error: could not compile `markiro-host` (test "pairing") due to 1 previous error
```

(The proto fixtures test was not RED: Step 2 adds the proto types, the
fixtures and their tests together, per the brief's own structure, so
`cargo test -p markiro-proto --test fixtures` passed immediately with 9/9
tests including the 2 new ones.)

**GREEN** — `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test pairing`, exit code 0:

```
running 5 tests
test protected_routes_require_the_protocol_header ... ok
test invalid_local_pair_requests_are_validation_errors ... ok
test local_pairing_from_the_network_is_refused ... ok
test a_local_station_pairs_and_only_the_key_hash_is_stored ... ok
test a_device_reads_itself_with_its_key_until_revoked ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

**Full workspace** — `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
(sandbox disabled, since `tests/hello.rs` and the lock test in
`tests/platform.rs` bind `127.0.0.1`), exit code 0, run twice (once before
`cargo fmt`, once after, to confirm reformatting changed nothing
behaviorally). All suites green, 0 failed in every binary:

- `markiro-host` lib unit tests: 5 (incl. 2 new `secrets::tests::*`)
- `markiro-host` main unit tests: 3
- `host/tests/foundation.rs`: 12 (incl. the updated migration-count assertion)
- `host/tests/hello.rs`: 5
- `host/tests/pairing.rs`: 5 (all new)
- `host/tests/platform.rs`: 6
- `markiro-proto` lib: 0; `proto/tests/fixtures.rs`: 9 (incl. 2 new)
- `markiro-standalone` (src-tauri) lib: 6, main: 0, `host_probe.rs`: 2,
  `host_probe_proxy.rs`: 1
- Doc-tests: 0/0/0

Also ran, both exit code 0:

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` (reformatted
  `host/tests/pairing.rs`, `host/src/routes/pairing.rs`, `host/src/auth.rs` —
  purely mechanical line-wrapping; tests re-run green after) then
  `... --all -- --check`.
- `node_modules/.bin/prettier --write` then `--check` on the three new fixture
  JSON files and `apps/standalone/AGENTS.md` — all reported "unchanged"/passed.
- `git diff --check` — clean.

## Files changed

Created:

- `apps/standalone/host/migrations/0002_devices_lines_audit.sql`
- `apps/standalone/host/src/secrets.rs`
- `apps/standalone/host/src/audit.rs`
- `apps/standalone/host/src/auth.rs`
- `apps/standalone/host/src/routes/mod.rs`
- `apps/standalone/host/src/routes/pairing.rs`
- `apps/standalone/host/tests/pairing.rs`
- `apps/standalone/proto/fixtures/local-pair-request.json`
- `apps/standalone/proto/fixtures/pair-response.json`
- `apps/standalone/proto/fixtures/device-info.json`

Modified:

- `apps/standalone/proto/src/lib.rs`
- `apps/standalone/proto/tests/fixtures.rs`
- `apps/standalone/host/src/lib.rs`
- `apps/standalone/host/src/server.rs`
- `apps/standalone/host/tests/support/app.rs`
- `apps/standalone/host/tests/foundation.rs`
- `apps/standalone/AGENTS.md`

## Deviations from the brief's code

1. **`server.rs` import mechanics.** The brief said to "add import
   `use axum::routing::post;` (next to `get`)" and "import `axum::middleware`
   at the top level." Instead of adding two new, separate `use` lines, I
   merged them into the existing imports: `use axum::routing::get;` became
   `use axum::routing::{get, post};`, and `use axum::middleware::Next;` became
   `use axum::middleware::{self, Next};` (the `self` brings the `middleware`
   module itself into scope for `middleware::from_fn`). Behaviorally
   identical to what the brief asked for; chosen to avoid a redundant second
   `use axum::middleware;` line. As anticipated by the brief, `mod tests`'s
   own `use axum::{middleware, Router};` needed no change — nested modules in
   Rust don't inherit the parent module's `use` declarations, so there was no
   duplicate-import conflict and the compiler did not complain.
2. **`lib.rs` module insertion order.** The brief listed the four new modules
   to add (`audit`, `auth`, `routes`, `secrets`) without specifying exact
   placement. I inserted each alphabetically among the existing `pub mod`
   lines (matching the file's existing alphabetical convention:
   `audit, auth, clock, config, db, error, logging, routes, secrets, server,
service, tls`).

No other deviations; the migration SQL, proto types, fixtures, test files,
`secrets.rs`, `audit.rs`, `auth.rs`, `routes/mod.rs`, `routes/pairing.rs`,
the `router`/`protected_routes` bodies, and the `AGENTS.md` additions were
copied verbatim from the brief (rustfmt subsequently reformatted line-wrapping
in `pairing.rs`/`auth.rs`/`tests/pairing.rs`, with no semantic change, as
shown by the unchanged green test run afterward).

## Self-review findings

- Confirmed `devices` intentionally has no `rev` column and `local_pair` does
  not call `db::next_revision`: the global revision counter (spec §4.4) is
  for syncable reference data (today just `lines`, which does have `rev`),
  not for device/audit bookkeeping. This matches the brief's given handler
  code exactly, so it's a confirmation, not a change.
- Verified no secret material (device key, key hash) is ever passed to
  `tracing::*` in the new code; `ApiError::internal` only logs the `sqlx`
  error `Display`, never request bodies or keys.
- Verified extractor ordering compiles under axum's `FromRequestParts`
  (all-but-last) / `FromRequest` (last only) rule: `local_pair` ends with
  `ApiJson<LocalPairRequest>`; `device_info` uses only `FromRequestParts`
  extractors (`State`, `AuthDevice`).
- Verified `random_key()` produces 43-character unpadded base64url (32 bytes
  → 43 chars), matching both the brief's unit test and the pairing test's
  `assert_eq!(key.len(), 43)`.
- Verified `apps/standalone/Cargo.toml` needed no edits (dependencies were
  already present from Task 1) and confirmed `apps/station` was untouched.
- Full workspace build (`cargo build --workspace --tests --offline`) has zero
  warnings.
- `git status --short` is clean after the commit; only the 17 files listed
  above were staged and committed (verified via `git status --short` both
  before staging and via the commit's own file list).

## Concerns

None blocking. One minor observation for later tasks: `AuthDevice`'s
"touch `last_seen_at` at most once a minute" throttle reads `state.now()`
once and uses it for both the comparison and the write in the same query, so
it is race-free under SQLite's single-writer model, but it does mean two
requests within the same minute after a revocation race would still both see
the pre-revocation key until the `UPDATE devices SET revoked_at = ...`
transaction commits — expected and inherent to the design, not a defect.

Reported per the caller's instructions as: **DONE**.
