# Task 1 report: платформа хоста (коды ошибок, охрана протокола, часы, транзакции, блокировка каталога)

## What was implemented

Followed `.superpowers/sdd/1b1-task-1-brief.md` Steps 1–7 in order, using the
brief's code verbatim except where noted under "Deviations".

1. **Dependencies and dev profile** (`apps/standalone/Cargo.toml`,
   `apps/standalone/host/Cargo.toml`): added the `[profile.dev.package.aws-lc-sys]`
   and `[profile.dev.package.aws-lc-rs]` `opt-level = 3` overrides to the
   workspace manifest; added `aws-lc-rs = "=1.18.1"` and `base64 = "=0.22.1"` to
   `markiro-host`'s `[dependencies]`; changed `time`'s features to
   `["formatting", "parsing"]`; added `http-body-util = "0.1"` and
   `tower = { version = "0.5", features = ["util"] }` to `[dev-dependencies]`.
2. **Protocol error codes** (`apps/standalone/proto/src/lib.rs`): replaced the
   `codes` module with the full set from the brief (`METHOD_NOT_ALLOWED`,
   `VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `STALE_REVISION`,
   `CONFLICT`, `LAST_ADMIN`, `SSCC_BELOW_FLOOR`, `ALREADY_INITIALIZED`,
   `LOOPBACK_ONLY`, `RATE_LIMITED`, plus the existing `NOT_FOUND`,
   `PROTOCOL_UNSUPPORTED`, `INTERNAL`).
3. **Clock** (new `apps/standalone/host/src/clock.rs`): `Clock` trait,
   `SystemClock`, `ManualClock` (mutex-guarded, `new`/`advance`),
   `format_timestamp` (UTC RFC 3339, whole seconds), `parse_timestamp`.
4. **Errors and extractors** (`apps/standalone/host/src/error.rs`, replaced
   wholesale): `ApiError` gained `with_details`, `status`, `code`,
   `method_not_allowed`, `protocol_unsupported`, `validation`, `malformed`,
   `unauthorized`, `forbidden`, `conflict`, `stale_revision`; added the
   `ApiJson<T>` / `ApiPath<T>` extractors whose rejections become
   `400 validation_failed`.
5. **Write transactions and revision counter** (`apps/standalone/host/src/db.rs`):
   `begin_write` (`BEGIN IMMEDIATE`) and `next_revision`
   (`UPDATE host_revision SET rev = rev + 1 ... RETURNING rev`).
6. **Data-directory lock** (`apps/standalone/host/src/config.rs`):
   `ConfigError::Locked { path }`, `HostPaths::lock_file`, `HostPaths::lock`
   (exclusive `try_lock` on `host.lock`, created if missing).
7. **Server** (`apps/standalone/host/src/server.rs`): `AppState` gained `clock:
Arc<dyn Clock>`, `AppState::new`, `now()`, `timestamp()`; added
   `protocol_guard` middleware (checks `x-markiro-protocol` against
   `MIN_PROTOCOL_VERSION..=PROTOCOL_VERSION`); `router` now installs
   `method_not_allowed_fallback`; `hello` uses `state.timestamp()`; removed
   `now_rfc3339`; added 3 unit tests for the guard.
8. **Lifecycle** (`apps/standalone/host/src/lib.rs`): registered `pub mod
clock;`; added `SHUTDOWN_DEADLINE` (10s); `RunningHost` gained `_lock:
std::fs::File`; `stop()` now races the serve task against the deadline and
   aborts it on timeout; `start()` acquires the directory lock right after
   `paths.ensure()?` and builds `AppState` via `AppState::new(..,
Arc::new(clock::SystemClock))`.
9. **Test harness** (`apps/standalone/host/tests/support/mod.rs`,
   new `apps/standalone/host/tests/support/app.rs`): `mod.rs` gained
   `#![allow(dead_code)]` and `pub mod app;` right after the module doc
   comment; `app.rs` provides `TestApp` (in-process router over a real
   temp-dir SQLite pool and a `ManualClock`), `send`/`send_from` (with
   `MockConnectInfo`), `request`/`json`/`empty` builders, and the `LOOPBACK` /
   `LAN` / `START` constants.
10. **New integration tests** (new `apps/standalone/host/tests/platform.rs`):
    6 tests — `hello` needs no protocol header, wrong method gets the
    protocol-shaped `405`, unknown routes stay `404` without a protocol
    header, revisions increase by one per call and roll back correctly,
    timestamps are whole-second UTC and round-trip, and a second host on the
    same data directory is refused (`host.lock`).

## TDD evidence

**RED** — `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline`
(run before `protocol_guard` existed):

```
error[E0425]: cannot find value `protocol_guard` in module `super`
   --> host/src/server.rs:172:53
    |
172 |             .route_layer(middleware::from_fn(super::protocol_guard));
    |                                                     ^^^^^^^^^^^^^^ not found in `super`

error: could not compile `markiro-host` (lib test) due to 1 previous error; 1 warning emitted
EXIT_CODE=101
```

See "Deviations" below for a caveat on how this capture overlapped with
implementation edits.

**GREEN** — `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
(sandbox disabled; run twice, before and after `cargo fmt`, both clean):

```
     Running unittests src/lib.rs (…markiro_host-…)
test server::tests::a_supported_version_passes ... ok
test server::tests::a_missing_header_is_refused_with_details ... ok
test server::tests::an_out_of_range_or_garbled_version_is_refused ... ok
test result: ok. 3 passed; 0 failed …

     Running tests/hello.rs (…)
test result: ok. 5 passed; 0 failed …

     Running tests/platform.rs (…)
test timestamps_are_utc_whole_seconds_and_round_trip ... ok
test unknown_routes_stay_not_found_without_a_protocol_header ... ok
test a_wrong_method_gets_the_protocol_error_body ... ok
test hello_needs_no_protocol_header ... ok
test revisions_increase_by_one_per_call ... ok
test a_second_host_on_the_same_data_directory_is_refused ... ok
test result: ok. 6 passed; 0 failed …

     Running tests/fixtures.rs (markiro-proto)
test result: ok. 7 passed; 0 failed …

     (markiro-standalone-lib / host_probe / host_probe_proxy, unaffected by this task)
test result: ok. 6 passed; 0 failed …
test result: ok. 2 passed; 0 failed …
test result: ok. 1 passed; 0 failed …

EXIT_CODE=0
```

Full tally across the workspace: 45 tests passed, 0 failed, 0 ignored, in both
runs. `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`
and `git diff --check` are both clean.

## Files changed

Modified: `apps/standalone/Cargo.toml`, `apps/standalone/Cargo.lock` (4-line
diff: adds `aws-lc-rs`, `base64 0.22.1`, `http-body-util`, `tower` as
`markiro-host` dependency edges only — no version bumps elsewhere),
`apps/standalone/proto/src/lib.rs`, `apps/standalone/host/Cargo.toml`,
`apps/standalone/host/src/config.rs`, `apps/standalone/host/src/db.rs`,
`apps/standalone/host/src/error.rs`, `apps/standalone/host/src/lib.rs`,
`apps/standalone/host/src/server.rs`, `apps/standalone/host/tests/support/mod.rs`.

Created: `apps/standalone/host/src/clock.rs`,
`apps/standalone/host/tests/support/app.rs`,
`apps/standalone/host/tests/platform.rs`.

## Deviations from the brief's code

None in the code itself — every file was written or edited using the brief's
snippets verbatim (imports, signatures, bodies, doc comments). Two process
notes, not content deviations:

1. **RED capture is not a single pristine snapshot.** I ran Step 4's `cargo
test` in the background and, while it was queued/compiling, went on to
   write the Step 5 files in sequence (clock.rs, error.rs, db.rs, …). Cargo
   picks up the file contents at the moment it actually parses each file, not
   at process start, so by the time the compiler reached `db.rs` its import
   line had already landed (hence the log's "unused imports" warning for
   `Sqlite`/`SqliteConnection`/`Transaction`, added but not yet used) while
   `server.rs`'s test module (added earlier, in Step 3) still failed on the
   not-yet-defined `protocol_guard`. The captured failure is genuine and
   matches the brief's expectation ("FAIL — no clock, AppState::new,
   db::begin_write, protocol_guard"), but it stopped at the first error
   (`protocol_guard`) rather than enumerating all four simultaneously. I
   judged re-running a from-scratch RED not worth reverting finished,
   verbatim-brief work to reproduce; the GREEN run afterwards fully exercises
   every new symbol.
2. **Sandbox.** `tests/hello.rs` and `platform.rs`'s
   `a_second_host_on_the_same_data_directory_is_refused` bind `127.0.0.1`,
   which the Bash sandbox refuses (EPERM). Per the task's own environment
   notes, I ran the full-workspace `cargo test` with the sandbox disabled;
   the in-sandbox run of `-p markiro-host` alone showed the same 5 EPERM
   failures in `hello.rs` (pre-existing tests, unrelated to this task's
   changes) and otherwise passed.

## Self-review against the brief

- All "Produces" interfaces are present with the exact names and signatures
  listed: `markiro_proto::codes::*` (11 new + 3 existing), `clock::{Clock,
SystemClock, ManualClock, format_timestamp, parse_timestamp}` plus
  `ManualClock::new`/`advance`; `error::ApiError::*` (all 14 listed
  constructors/methods) and `ApiJson<T>`/`ApiPath<T>`; `server::AppState`
  with `pool`/`host_id`/`clock`, `new`, `now`, `timestamp`; `server::
protocol_guard`; `server::router`; `db::begin_write`/`next_revision`;
  `config::HostPaths::{lock_file, lock}`/`ConfigError::Locked`; the full
  `tests/support/app.rs` harness (`TestApp`, `send`, `send_from`, `request`,
  `json`, `empty`, `LOOPBACK`, `LAN`).
- Grepped the crate for other `AppState` / `now_rfc3339` construction sites
  before editing; only `server.rs` (definition) and `lib.rs` (construction)
  referenced either, both updated. `main.rs` and `service.rs` need no
  changes.
- Grepped for other `match`/`matches!` sites over `ConfigError` before adding
  the `Locked` variant; the one existing site uses `matches!` on a different
  variant, so exhaustiveness is unaffected.
- Confirmed `aws-lc-rs`, `base64 0.22.1`, `http-body-util 0.1.5`, `tower
0.5.3` were already present in `Cargo.lock` (transitively, via `rustls`'s
  `aws_lc_rs` feature and other existing dev-dependencies) before adding them
  as direct edges, so `--offline` resolved without downloading anything new.
- `apps/standalone/dist` already existed (from plan 1a), so the
  `markiro-standalone` (`src-tauri`) crate built and its existing tests ran
  as part of the full-workspace gate without extra setup.
- Re-ran the full workspace suite a second time after `cargo fmt` reformatted
  4 files (line-wrapping only, confirmed by reading the diffs it produced);
  still 45/45 passing.

## Concerns

- `aws-lc-rs` is now a direct `markiro-host` dependency but nothing in this
  task's code calls it yet (it's consumed indirectly via `rustls`/`rcgen`
  today); per the brief and plan constraints this is intentional groundwork
  for tasks 2–3 (device keys, session tokens, PBKDF2). Flagging only so a
  reviewer doesn't read it as dead weight.
- This was verified on macOS only. Per `apps/standalone/AGENTS.md`, the
  Windows service path is not exercised by any of these tests; nothing in
  this task touches `service.rs`, so that limitation is unchanged from
  before this task.
- No `apps/standalone` TypeScript/webview changes were needed or made (this
  task is Rust-only); `pnpm --filter @markiro/standalone` gates were not run
  since nothing under `src/` or `proto`'s TS mirror changed.
