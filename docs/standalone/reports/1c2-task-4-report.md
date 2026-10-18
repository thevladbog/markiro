# Task 4 report — связь с хостом: фоновый поток изменений

Plan: `1c2-task-4-brief.md` / `1c2-constraints.md`. Branch:
`claude/autonomous-desktop-station-9e6f13`. Commit: `1a865a363` — `feat(standalone):
связь с хостом — фоновый поток изменений и статус`.

## What was implemented

1. **`apps/standalone/src-tauri/Cargo.toml`** — `tokio` gained `macros` and
   `time` features (`sync` kept). `Cargo.lock` unchanged (verified below).

2. **`apps/standalone/src-tauri/src/host_client.rs`**:
   - `STREAM_SILENCE_LIMIT` (45 s) constant.
   - `PinnedClient::new` refactored onto a new private `pinned_builder`
     (fingerprint pin, connect timeout, no proxy, HTTPS-only, no redirects);
     `send` unchanged.
   - New `StreamClient` (a long-lived pinned client with `read_timeout` set to
     `STREAM_SILENCE_LIMIT` instead of a total `timeout`), `StreamOpen`
     (`Open(HostStream)` / `Refused(HostResponse)`), and `HostStream::chunk`
     that yields raw bytes or `None` on a clean end.
   - Module doc comment mentions `StreamClient`.

3. **`apps/standalone/src-tauri/src/device.rs`**:
   - New `HostLink { pub address, pub fingerprint, key: Secret }` with
     `HostLink::new` and `key()`; derives only `Debug, Clone` — `Secret`'s own
     `Debug` redacts the value (`Secret(***)`), and `HostLink` is never
     `Serialize`, so it cannot cross IPC.
   - `PairedDevice::link()` builds an `Arc<HostLink>` from the current config
     and key.
   - `DeviceState` gained a `link: watch::Sender<Option<Arc<HostLink>>>`
     field, seeded in `load` from the current pairing (`None` if unpaired or
     unreadable), and a public `watch_link()` that subscribes.
   - `remember` (pairing) and `forget` now call `self.link.send_replace(...)`
     with `Some(link)` / `None` respectively, right after the `current` mutex
     is updated. `select_line` intentionally does not touch the link (address,
     fingerprint and key are unchanged by a line change).
   - Two documentation-only additions for the Task 3 review leftovers (below).

4. **`apps/standalone/src-tauri/src/connection.rs`** (new) — created verbatim
   from the brief: `LinkState`, `LinkError`, `HostStatus`, `HostRevision`,
   `LinkEvents` trait, `ConnectionState` (Tauri state backing
   `connection_status`), `Backoff` (1 s → 30 s doubling), `supervise` (follows
   the `watch::Receiver<Option<Arc<HostLink>>>`: offline-and-idle while `None`,
   holds the stream via `hold`/`follow` while `Some`, returns when the
   `DeviceState` drops), `SseParser`/`SseItem` (splits `text/event-stream` into
   `rev` events vs. everything else, LF/CRLF-tolerant, capped at 64 KiB per
   event), and 7 unit tests. Wired into `lib.rs` as `pub mod connection;`
   (first, alphabetically).

5. **`apps/standalone/src-tauri/src/lib.rs`**:
   - `TauriLinkEvents<R: Runtime>` emits `standalone://host-status` /
     `standalone://host-revision` via `AppHandle::emit`, ignoring the result
     (a closed window just misses events; the next status replaces the
     snapshot).
   - `connection_status` command returns `ConnectionState::snapshot()`.
   - `run()`'s `setup` now: loads `DeviceState`, captures `watch_link()`
     _before_ moving the state into `app.manage`, opens the local DB (as
     before), then creates a `ConnectionState`, manages a clone of it, and
     spawns `connection::supervise(link, Arc::new(TauriLinkEvents(...)),
status, Backoff::default())` on Tauri's async runtime.
   - `invoke_handler!` gained `connection_status` at the end of the list.

6. **Tests**:
   - `apps/standalone/src-tauri/tests/connection.rs` (new) — the 6 scenarios
     from the brief, run against a real `markiro-host` on `127.0.0.1:0`
     (unpaired stays idle; paired comes online and hears every revision
     starting with the current one; the link follows the host down and back up
     on the same address; forgetting stops the link with no further attempts;
     pairing after the task started brings it online; a rejected device key
     and a certificate mismatch are reported as distinct `LinkError`s).
   - `apps/standalone/src-tauri/tests/ipc.rs` — added the
     `ConnectionState::default()` state and the
     `the_connection_status_has_the_webview_shape` test (offline snapshot with
     `seq: 0` before any event).

7. **Docs**:
   - `apps/standalone/AGENTS.md` — new "## Connection to the host" section
     right after "## Network and TLS" (task 4 content, verbatim from the
     brief).
   - `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
     §5.2 — the "Поток изменений" bullet rewritten to describe the silence
     limit, the backoff, the exact `standalone://host-status` shape and error
     codes, `standalone://host-revision`, and `connection_status()`.

8. **Task 3 review leftovers** (same files edited for task 4, so folded into
   this commit per the brief):
   - `apps/standalone/AGENTS.md`, "Network and TLS": the path-rule sentence
     now reads "…paths of `[A-Za-z0-9/_.~?=&-]` without `..`, `//` or a `.`
     segment…", and a clause was added beside the `%` sentence: "`%` is
     refused because an encoded `..` would slip past the route check; a `.`
     segment is refused for the same reason, since the URL parser would
     normalize it past the route checks."
   - `apps/standalone/src-tauri/src/device.rs`: `webview_may_reach`'s doc
     comment gained a note that the string-level `LINE_ROUTE` exclusion only
     holds because `host_client::validate_path` separately refuses a `.`
     path segment.
   - `apps/standalone/src-tauri/src/host_client.rs::tests::only_host_api_paths_pass`:
     added `"/v1/device?x=/."` to the allowed cases and reworded the comment to
     explain that the query part is never split into path segments, so a `.`
     there — alone or forming what looks like a `/.` segment — is unaffected
     by the `.`-segment check.

## TDD evidence

### RED — Step 2 (before `connection.rs`/`HostLink` existed)

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test connection --offline
cargo test: 2 errors, 0 warnings (1 crates)
error[E0432]: unresolved imports `markiro_standalone_lib::connection`, `markiro_standalone_lib::connection`
  --> src-tauri/tests/connection.rs:11:29
   |
11 | use markiro_standalone_lib::connection::{
   |                             ^^^^^^^^^^ could not find `connection` in `markiro_standalone_lib`
12 |     self, Backoff, ConnectionState, HostRevision, HostStatus, LinkError, LinkEvents, LinkState,
   |     ^^^^ no `connection` in the root

error[E0432]: unresolved import `markiro_standalone_lib::device::HostLink`
  --> src-tauri/tests/connection.rs:14:51
   |
14 | use markiro_standalone_lib::device::{DeviceState, HostLink};
   |                                                   ^^^^^^^^ no `HostLink` in `device`
```

Matches the brief's expected RED exactly (no `connection` module, no `HostLink`
type).

### RED — sandbox evidence for "outside the sandbox" requirement

Before disabling the sandbox, ran the same test inside it to confirm _why_ it
would fail there (not just take the brief's word for it):

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test connection --offline
thread 'a_paired_device_comes_online_and_hears_every_revision' panicked at src-tauri/tests/connection.rs:101:6:
called `Result::unwrap()` on an `Err` value: Custom { kind: PermissionDenied, error: "cannot listen on 127.0.0.1:0: Operation not permitted (os error 1)" }
...
test result: FAILED. 1 passed; 5 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s
```

(`an_unpaired_device_stays_offline_without_trying` passed even in-sandbox,
since it never starts a host.) This is the documented sandbox local-bind
restriction, so all further host-backed test runs below used
`dangerouslyDisableSandbox: true`.

### GREEN — after Steps 3–6 (host_client.rs, device.rs, connection.rs, lib.rs)

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test connection --offline   # outside sandbox
running 6 tests
test a_rejected_key_and_a_changed_certificate_are_reported ... ok
test pairing_later_starts_the_link ... ok
test a_paired_device_comes_online_and_hears_every_revision ... ok
test the_link_goes_offline_with_the_host_and_returns_with_it ... ok
test an_unpaired_device_stays_offline_without_trying ... ok
test forgetting_the_device_stops_the_link ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.62s
EXIT_CONNECTION:0
```

`the_link_goes_offline_with_the_host_and_returns_with_it` (the one flagged as
possibly flaky, since it rebinds the stopped host's exact address) passed on
the first attempt, every time it was run in this session — no retries or
sleeps were added to the test, and no flake was observed to report.

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline   # outside sandbox
running 7 tests
test the_connection_status_has_the_webview_shape ... ok
test without_a_local_database_the_local_commands_say_so ... ok
test an_unpaired_device_reports_null_and_refuses_host_requests ... ok
test the_local_database_answers_through_the_ipc_shapes ... ok
test a_station_selects_its_line_through_the_ipc_shapes ... ok
test a_device_claims_a_code_through_the_ipc_shapes ... ok
test a_paired_device_reaches_the_host_through_the_ipc_shapes ... ok
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.15s
EXIT_IPC:0
```

Unit tests (lib), including the 7 new `connection::tests::*`:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib --offline
running 37 tests
test connection::tests::a_rejected_device_key_is_told_apart_from_other_refusals ... ok
test connection::tests::heartbeats_crlf_and_several_events_in_one_chunk ... ok
test connection::tests::unknown_or_unreadable_events_are_other ... ok
test connection::tests::pauses_double_up_to_the_limit ... ok
test connection::tests::statuses_and_revisions_serialize_to_the_webview_shape ... ok
test connection::tests::a_revision_event_is_read_whole_or_in_pieces ... ok
test connection::tests::an_endless_event_is_refused ... ok
... (30 pre-existing device_config/device/host_client/host_probe/local_db/secret_store tests, all ok)
test result: ok. 37 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s
```

## Every verification command and result

All run from the worktree root, `--manifest-path apps/standalone/Cargo.toml`.

| Command                                                                                                                             | Result                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo check -p markiro-standalone --offline` (Step 1, sandboxed)                                                                   | OK, 15 crates compiled                                                                                                                                     |
| `git diff apps/standalone/Cargo.lock` (after Step 1)                                                                                | empty                                                                                                                                                      |
| `cargo test -p markiro-standalone --test connection --offline` (Step 2, sandboxed)                                                  | 2 compile errors, as expected (RED)                                                                                                                        |
| `cargo check -p markiro-standalone --lib --offline` (after Step 3)                                                                  | OK, no warnings                                                                                                                                            |
| `cargo check -p markiro-standalone --lib --offline` (after Step 4)                                                                  | OK, no warnings                                                                                                                                            |
| `cargo check -p markiro-standalone --all-targets --offline` (after Step 5–6)                                                        | OK, no warnings                                                                                                                                            |
| `cargo test -p markiro-standalone --lib --offline`                                                                                  | `37 passed`, exit 0                                                                                                                                        |
| `cargo test -p markiro-standalone --test connection --offline` (sandboxed)                                                          | 1 passed, 5 failed with `PermissionDenied … Operation not permitted` (expected sandbox limit)                                                              |
| `cargo test -p markiro-standalone --test connection --offline` (unsandboxed)                                                        | `6 passed`, exit 0                                                                                                                                         |
| `cargo test -p markiro-standalone --test ipc --offline` (unsandboxed)                                                               | `7 passed`, exit 0                                                                                                                                         |
| `cargo test -p markiro-standalone --offline` (unsandboxed)                                                                          | `83 passed` (11 suites: lib 37, main 0, claim 4, connection 6, device 13, host_probe 2, host_probe_proxy 1, ipc 7, line 5, local_db 8, doctests 0), exit 0 |
| `cargo fmt --all -- --check` (first pass)                                                                                           | diff in `connection.rs`/`tests/connection.rs` (brief's example lines exceed the 100-col limit)                                                             |
| `cargo fmt --all`                                                                                                                   | reformatted those two files (wrapping only)                                                                                                                |
| `cargo fmt --all -- --check` (second pass)                                                                                          | clean                                                                                                                                                      |
| `cargo test --workspace --offline` (unsandboxed)                                                                                    | `215 passed` (30 suites), exit 0 — reran post-commit, still `215 passed`, exit 0                                                                           |
| `cargo check --workspace --all-targets --offline`                                                                                   | clean, no warnings — reran after `touch`-ing every changed `.rs` file to defeat the diagnostic cache; still clean                                          |
| `git diff apps/standalone/Cargo.lock` (final)                                                                                       | empty                                                                                                                                                      |
| `node_modules/.bin/prettier --write apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` | both "(unchanged)"                                                                                                                                         |
| `node_modules/.bin/prettier --check` (same two files)                                                                               | "All matched files use Prettier code style!"                                                                                                               |
| `git diff --check`                                                                                                                  | clean, exit 0                                                                                                                                              |
| `git log -1 --format=%B`                                                                                                            | subject + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified                                                                              |

## Files changed

Staged and committed explicitly (no `git add -A`):

- `apps/standalone/src-tauri/Cargo.toml`
- `apps/standalone/src-tauri/src/host_client.rs`
- `apps/standalone/src-tauri/src/device.rs`
- `apps/standalone/src-tauri/src/connection.rs` (new)
- `apps/standalone/src-tauri/src/lib.rs`
- `apps/standalone/src-tauri/tests/connection.rs` (new)
- `apps/standalone/src-tauri/tests/ipc.rs`
- `apps/standalone/AGENTS.md`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Nothing under `apps/station` or `apps/standalone/host` was touched. `git
status --short` showed a clean tree before starting and shows a clean tree
(fully committed) now.

## Deviations from the brief

1. **rustfmt reformatting of the brief's literal code.** The brief's Rust
   snippets for `connection.rs` and `tests/connection.rs`, typed in verbatim,
   contain a handful of lines past the workspace's 100-column `rustfmt` limit
   (e.g. multi-arg `assert_eq!` calls, one function signature). `cargo fmt
--check` failed on exactly those lines; `cargo fmt` reformatted them
   (wrapping only — no semantic change, reconfirmed green afterwards). This is
   the "smallest fix that keeps the behaviour and every assertion" the brief
   pre-authorized for compile/lint friction, applied to formatting instead of
   compilation since that's what actually broke.
2. No other deviations. The `tokio::select!` arm with `match never {}`, the
   `Infallible` return of `hold`, the `emit` payload types and the `&dyn
LinkEvents` lifetimes all compiled as written, so none of the
   pre-authorized fallbacks for those were needed. The reconnect test
   (`the_link_goes_offline_with_the_host_and_returns_with_it`) did not flake,
   so no bounded wait-and-retry was added.

## Self-review

- **Matches the brief verbatim** where it gave exact code: diffed every
  brief-specified file against the working tree section by section
  (`git diff` shown above) and confirmed `connection.rs`, the `host_client.rs`
  additions, the `device.rs` additions, and the `lib.rs` wiring all match,
  modulo the rustfmt wrapping noted above.
- **Ordering invariants preserved**: `remember` computes `device.link()`
  before moving `device` into the `Current::Paired(device)` assignment (can't
  clone `Arc<HostLink>` after the move), then `send_replace`s it — matches the
  brief's ordering rationale exactly. `DeviceState::load` seeds the watch
  channel from `current` before it's moved into the `Mutex`.
  `select_line` intentionally leaves `self.link` untouched, matching the
  brief's note that address/fingerprint/key don't change.
- **Secrecy**: `HostLink` derives only `Debug`/`Clone` (no `Serialize`), so it
  cannot cross IPC even by accident; its `Debug` impl leans on `Secret`'s own
  redacting `Debug`. `connection_status` returns `HostStatus`, which carries
  no key material. Checked by reading the type definitions, not just trusting
  the brief's comment.
- **Race protection (`seq`)**: `ConnectionState::publish` increments `seq`
  before cloning the snapshot it hands to `events.status`, and
  `connection_status` reads the same `Mutex`-guarded state — so a webview that
  subscribes first and then calls `connection_status` always sees a `seq` at
  least as high as what it already received. The new IPC test pins the
  pre-first-event shape (`seq: 0`).
- **Unpaired device never attempts a connection**: verified both by the
  `an_unpaired_device_stays_offline_without_trying` integration test (300 ms
  of silence after the single offline status) and by inspecting `supervise`:
  the `None` arm only awaits `link.changed()`, it never calls `hold`.
  `forgetting_the_device_stops_the_link` confirms the same for a
  previously-paired device (500 ms of silence after forgetting).
  `a_rejected_key_and_a_changed_certificate_are_reported` confirms these two
  specific `LinkError` variants are distinguished, not folded into a generic
  `Unreachable`.
  `a_paired_device_comes_online_and_hears_every_revision` confirms the very
  first revision event (0, before any bootstrap) is delivered, then the
  bootstrap's commit (1) — the "first event carries the current revision"
  contract plan 1c3 depends on.
- **Verification honesty**: every host-backed test run above was executed
  with `dangerouslyDisableSandbox: true`, explicitly justified beforehand by
  reproducing the sandbox's `EPERM`/`PermissionDenied` failure on
  `127.0.0.1:0` first, per this session's sandbox policy, rather than assumed
  from the brief's note alone. No test output was piped through `tail` or
  `grep` when the exit code mattered — the final workspace test run and the
  two host-backed suites were captured with explicit `echo EXIT:$?` (or read
  as cargo's own unpiped `test result: ok` / `FAILED` lines) rather than
  inferred from truncated output. `cargo check --all-targets` for warnings was
  re-run after `touch`-ing every changed source file, specifically to rule out
  a cached-diagnostic false negative.
- **Scope**: no `apps/station` or `apps/standalone/host` files touched, no
  `git stash`, no `pnpm install`/`pnpm add`, no unrelated files staged. This
  worktree had no other in-flight changes to preserve (`git status --short`
  was clean at the start).
- **Known non-verification**: this task is Rust/CLI-only; no browser, Windows,
  printer, or hardware surface is implicated, so none was exercised — none was
  claimed either. Plan 1c2 Task 5 (the TypeScript bindings that actually
  consume these events from the webview) is explicitly out of scope here and
  was not touched.
