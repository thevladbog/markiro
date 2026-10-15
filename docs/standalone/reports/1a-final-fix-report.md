# Plan 1a final review — fix report

Worktree: `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`
Branch: `claude/autonomous-desktop-station-9e6f13`
Base HEAD before this pass: `6bda2dfae` (docs(standalone): план 1a — отклонения при исполнении)

## F1 — No proxy, no redirects for host traffic

Files changed:

- `apps/standalone/src-tauri/src/host_probe.rs` — `.no_proxy()` and
  `.redirect(reqwest::redirect::Policy::none())` added to the `reqwest::Client::builder()`
  chain in `observe_hello`.
- `apps/standalone/host/tests/support/mod.rs` — same two calls added to `pinned_client`.
- `apps/standalone/src-tauri/tests/host_probe_proxy.rs` (new file) — its own test binary,
  `proxy_environment_variables_are_ignored`.

TDD evidence (run before `.no_proxy()`/`.redirect()` were added):

```
$ rtk proxy cargo test --manifest-path apps/standalone/Cargo.toml --offline -p markiro-standalone --test host_probe_proxy -- --nocapture
running 1 test

thread 'proxy_environment_variables_are_ignored' (185609468) panicked at src-tauri/tests/host_probe_proxy.rs:21:78:
called `Result::unwrap()` on an `Err` value: Unreachable
test proxy_environment_variables_are_ignored ... FAILED

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
error: test failed, to rerun pass `-p markiro-standalone --test host_probe_proxy`
```

This confirms the client was routing through the (closed-port) proxy set via
`HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy`/`ALL_PROXY`/`all_proxy` and failing to
connect, before the fix. After adding `.no_proxy()` and `.redirect(...)` to both client
builders, the same test passed:

```
$ rtk proxy cargo test --manifest-path apps/standalone/Cargo.toml --offline -p markiro-standalone --test host_probe_proxy -- --nocapture
test proxy_environment_variables_are_ignored ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s
```

## F2 — Protocol evolution: frozen hello envelope, lenient responses

Files changed:

- `apps/standalone/proto/src/lib.rs` — removed `deny_unknown_fields` from `Hello`, `ErrorBody`,
  `ErrorDetail` (kept `rename_all = "camelCase"`); extended the module doc comment; added
  `HelloEnvelope`, `Compatibility`, `compatibility_for`, `compatibility`, `display_fingerprint`.
- `apps/standalone/proto/fixtures/hello-future.json` (new) — protocol 3/minProtocol 2 fixture
  with an unknown `features` field.
- `apps/standalone/proto/tests/fixtures.rs` — replaced `unknown_fields_are_rejected` with
  `hello_ignores_fields_added_by_newer_hosts`, `envelope_decides_compatibility_before_the_rest`,
  `display_fingerprint_groups_the_first_32_characters`; updated the `use` line.
- `apps/standalone/src-tauri/src/host_probe.rs` — added `ProbeError::HostTooOld`/`AppTooOld`
  (+ `code()` arms); extracted `pub fn classify_hello`, used from `observe_hello`; added a
  `#[cfg(test)] mod tests` with 6 unit tests covering foreign body, wrong product, host-too-old,
  app-too-old, compatible-but-unreadable, and a fully compatible `hello`.
- `apps/standalone/src/host/probe.ts` — `HostProbeErrorCode`/`ERROR_CODES` extended with
  `"host_too_old"`/`"app_too_old"`.
- `apps/standalone/src/i18n/ru.json` — new `shell.version` section (`title`, `hostTooOld`,
  `appTooOld`).
- `apps/standalone/src/app/App.tsx` — `REASON_KEY` extended; `versionMismatch` computed in the
  `missing` branch to switch the card title and suppress the `hostMissing.body` paragraph.
- `apps/standalone/test/probe.test.ts` — `it.each` list extended with the two new codes.
- `apps/standalone/test/app.test.tsx` — new case asserting the version-mismatch screen for
  `app_too_old`.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (section 6) and
  `apps/standalone/AGENTS.md` ("Protocol") — updated to describe the lenient-response /
  strict-request rule and the `HelloEnvelope` compatibility gate.

## F3 — print-fingerprint reads, never creates; dev data dir never committed

Files changed:

- `apps/standalone/host/src/config.rs` — added `ConfigError::Missing { path }` and
  `HostConfig::load` (read + validate an existing `host.json`, never writes); extracted shared
  `validate()` (UUID `hostId`, non-zero port) used by both `load` and `load_or_create`.
- `apps/standalone/host/src/tls.rs` — added `TlsError::Missing { dir }` and `TlsIdentity::load`
  (both files → load then validate via `server_config()`; neither → `Missing`; one → `Incomplete`;
  never writes).
- `apps/standalone/host/src/main.rs` — `print_fingerprint` no longer calls `paths.ensure()`; uses
  `HostConfig::load` + `TlsIdentity::load`; prints the full hex fingerprint, then
  `markiro_proto::display_fingerprint(...)`. Added
  `print_fingerprint_on_an_empty_dir_is_an_error_and_writes_nothing`.
- `.gitignore` (root) — appended `.markiro-host/` (unanchored) with the required comment.
- `.prettierignore` — `apps/standalone/.markiro-host/` replaced with `.markiro-host/`.
- `apps/standalone/.gitignore` — removed the now-redundant `/.markiro-host/` line and its
  comment.

Verified:

```
$ git check-ignore -v .markiro-host/tls/key.der apps/standalone/.markiro-host/host.db
.gitignore:76:.markiro-host/	.markiro-host/tls/key.der
.gitignore:76:.markiro-host/	apps/standalone/.markiro-host/host.db
```

## F4 — Never regenerate the host id over existing data

Files changed:

- `apps/standalone/host/src/config.rs` `load_or_create` — when `host.json` is missing but
  `database_file()`, `tls_dir()/cert.der` or `tls_dir()/key.der` exists, returns
  `ConfigError::Invalid` instead of minting a new `hostId`; tracks a `changed` flag and only
  rewrites `host.json` when it was just created or the port actually changed.
- `apps/standalone/host/tests/foundation.rs` — added
  `deleting_host_json_does_not_get_recreated_by_load_or_create` (a),
  `host_config_load_on_an_empty_dir_is_missing` (b),
  `tls_identity_load_is_missing_on_an_empty_dir_and_matches_load_or_create_when_present` (c),
  `load_or_create_without_an_override_does_not_rewrite_an_existing_file` (d, hand-formatted
  `host.json` with extra whitespace, byte-compared before/after).

## F5 — Windows service reports failures

File changed: `apps/standalone/host/src/service.rs` (full rewrite).

- `service_main` builds `HostPaths` from `default_data_dir()`, computes
  `log_guard = paths.ensure().ok().and_then(|()| logging::init(...).ok())`, calls `run(&paths)`,
  logs any error, then `drop(log_guard)` — the guard is held across the whole run.
- `run(&paths)` registers the control handler, reports `StartPending` (wait hint 30s), starts the
  host, reports `Running`, waits for the stop signal, reports `StopPending` (wait hint 30s)
  **before** `host.stop()`, then reports `Stopped` with `ServiceExitCode::Win32(0)` on success or
  `ServiceExitCode::ServiceSpecific(FAILURE_EXIT_CODE)` (`FAILURE_EXIT_CODE: u32 = 1`, documented)
  on error.
- `status()` now takes `exit_code` and `wait_hint` parameters.

### F5 cross-check (mandatory — `service.rs` is `#[cfg(windows)]` and cannot be compiled on this

host as part of the workspace)

Created `$TMPDIR/service-check` (`/tmp/claude-501/service-check`) with `Cargo.toml`
(`windows-service = "=0.8.1"`, `tokio = { version = "=1.53.1", features = ["rt-multi-thread",
"macros"] }`, `tracing = "0.1"`), a `src/lib.rs` with minimal local stubs for
`config::HostPaths::{new, default_data_dir, ensure, logs_dir}`, `logging::init`, `start`,
`StartOptions`, `RunningHost::stop`, `BoxError`, plus `mod service;`, and an exact copy of the
real `apps/standalone/host/src/service.rs` as `src/service.rs`.

```
$ cd /tmp/claude-501/service-check && cargo check --target x86_64-pc-windows-msvc --offline
    Checking service-check v0.1.0 (/private/tmp/claude-501/service-check)
warning: `service-check` (lib) generated 7 warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.31s
```

Result: **0 errors.** The 7 warnings are all `dead_code` (nothing in the throwaway crate calls
the public `service` API) plus one `dropping_copy_types` warning caused solely by the stub
(`logging::init` stubbed to return `Result<(), BoxError>`, making `Option<()>` `Copy`; the real
`WorkerGuard` is not `Copy`, so `drop(log_guard)` is meaningful in the real crate). None of the
warnings indicate a defect in `service.rs` itself.

The throwaway crate was deleted afterward: `rm -rf /tmp/claude-501/service-check` (confirmed
removed).

## Small fixes

- `apps/standalone/host/tests/foundation.rs` — `migrations_apply_once_and_site_starts_uninitialized`
  now also asserts `PRAGMA synchronous` = 2 and `PRAGMA busy_timeout` = 5000 (matches
  `SqliteSynchronous::Full` and `busy_timeout(Duration::from_secs(5))` in `db.rs`).
- `apps/standalone/host/src/server.rs` `TlsListener::bind` — bind error now wrapped with the
  address: `cannot listen on {addr}: {error}`.
- `apps/standalone/host/src/tls.rs` `write_private` — unified to
  `OpenOptions::new().write(true).create_new(true)` on every platform, `.mode(0o600)` only under
  `cfg(unix)`, then `write_all` + `sync_all` (previously the non-Unix branch used plain
  `fs::write`, without `create_new` exclusivity).
- `apps/standalone/AGENTS.md` — "Network and TLS" now says authenticated calls (plan 1c) verify
  the pinned fingerprint and that today only `host_probe` exists and observes without trusting;
  "Verification" now says the Windows service is only compiled by CI and needs a manual check on
  Windows.
- `docs/superpowers/plans/2026-09-26-standalone-1a-skeleton.md` — one bullet appended to
  "Отклонения при исполнении" summarizing the final-review fixes.

## Verification (final HEAD, all green)

```
$ cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
(exit 0, no output)

$ cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline
markiro_host (lib):        0 passed
markiro_host (main.rs):    3 passed  (incl. print_fingerprint_on_an_empty_dir_is_an_error_and_writes_nothing)
tests/foundation.rs:      12 passed  (incl. the 4 new F4 tests + pragma additions)
tests/hello.rs:            5 passed
markiro_proto (lib):       0 passed
tests/fixtures.rs:         7 passed  (incl. the 3 new F2 tests)
markiro_standalone_lib:    6 passed  (host_probe::tests, F2 unit tests)
markiro_standalone (main): 0 passed
tests/host_probe.rs:       2 passed
tests/host_probe_proxy.rs: 1 passed  (F1 TDD test)
doc-tests:                 0/0/0 passed
TOTAL: 36 passed, 0 failed, 0 ignored

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
Test Files  4 passed (4)
     Tests  16 passed (16)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
(exit 0, no output — tsc -p tsconfig.json --noEmit)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
(exit 0, no output — eslint clean)

$ node_modules/.bin/prettier --check .gitignore .prettierignore apps/standalone docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md docs/superpowers/plans/2026-09-26-standalone-1a-skeleton.md
[error] No parser could be inferred for file ".gitignore".
[error] No parser could be inferred for file ".prettierignore".
```

Per the task's documented exception, re-ran dropping the two ignore files:

```
$ node_modules/.bin/prettier --check apps/standalone docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md docs/superpowers/plans/2026-09-26-standalone-1a-skeleton.md
[warn] apps/standalone/src/app/App.tsx
[warn] apps/standalone/src/host/probe.ts
[warn] apps/standalone/test/probe.test.ts
Code style issues found in 3 files.
```

Fixed with `prettier --write` on exactly those 3 files (pure reformatting: a union type onto one
line, an `it.each` array wrapped, one `const` line rewrapped — no semantic change), then
re-verified test/typecheck/lint (all still green, shown above) and re-ran prettier --check:

```
$ node_modules/.bin/prettier --check apps/standalone docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md docs/superpowers/plans/2026-09-26-standalone-1a-skeleton.md
All matched files use Prettier code style!

$ git diff --check
(exit 0, no output)
```

## Commands run outside the sandbox, and why

The following used `dangerouslyDisableSandbox: true` because they bind `127.0.0.1` sockets,
which this sandbox refuses with EPERM by default:

- `cargo test ... --test host_probe_proxy` (both the pre-fix red run and the post-fix green run):
  the test itself binds a throwaway `TcpListener` on `127.0.0.1:0` to obtain a closed port, and
  `start(...)` binds the host's HTTPS listener on `127.0.0.1:0`.
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (both runs): the
  `foundation.rs`/`hello.rs`/`host_probe.rs` integration tests all start a real host bound to
  `127.0.0.1:0`.

All other commands (fmt, fmt --check, the Windows cross-check, pnpm test/typecheck/lint,
prettier, git diff --check, git add/commit) ran inside the normal sandbox.

## Commits

1. `9bb18f82f` — fix(standalone): клиент хоста без прокси, print-fingerprint только читает,
   hostId не пересоздаётся (F1, F3, F4, small host fixes: pragma assertions, `bind()` error
   wrapping, `write_private`, `.gitignore`/`.prettierignore`).
2. `7d7b8326a` — feat(standalone): конверт hello и совместимость версий протокола (F2: proto,
   host_probe classification, webview, tests, spec section 6, AGENTS.md "Protocol").
3. `01edafff2` — fix(standalone): служба Windows сообщает об ошибке (F5).
4. `da40e64ea` — docs(standalone): итоговое ревью плана 1a (remaining AGENTS.md wording, plan
   bullet).

`apps/standalone/AGENTS.md` and `apps/standalone/src-tauri/src/host_probe.rs` each carry changes
belonging to two different commits (AGENTS.md: Protocol → commit 2, Network-and-TLS/Verification
→ commit 4; host_probe.rs: the two proxy/redirect calls → commit 1, the rest of F2 → commit 2).
Both were split cleanly by resetting to HEAD and re-applying the intended hunks incrementally
between commits (verified with `git diff <path>` before each `git add`), rather than committing a
mixed diff.

### Known limitation of the requested grouping

Commit 1 alone does not compile: `apps/standalone/host/src/main.rs`'s `print_fingerprint` (F3,
commit 1) calls `markiro_proto::display_fingerprint(...)`, which is only added to the `proto`
crate in commit 2 (F2). This is inherent to the task's own F-item/commit mapping (F3 explicitly
requires calling `display_fingerprint`; the suggested grouping explicitly puts F3 in commit 1 and
F2 in commit 2), not an error introduced while splitting files. Confirmed directly:

```
$ git show 9bb18f82f:apps/standalone/host/src/main.rs | grep display_fingerprint
        markiro_proto::display_fingerprint(&identity.fingerprint)
$ git show 9bb18f82f:apps/standalone/proto/src/lib.rs | grep display_fingerprint
(no output — not present at commit 1)
```

Commits 2, 3 and 4 build on top of a working commit 2, and final HEAD (`da40e64ea`) builds and
passes every check above. Commit 1 is the only non-bisectable point in this range.
