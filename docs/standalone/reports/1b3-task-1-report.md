# Plan 1b3, Task 1 — report

Contract IPC на мок-среде Tauri и тесты смены пароля на хосте.

Worktree: `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`
Branch: `claude/autonomous-desktop-station-9e6f13`
Commit: `9ff45a03c526c9bae2ea70388ec96570ce5b435c`

## What changed

1. `apps/standalone/src-tauri/Cargo.toml` — added `tauri = { version = "2.11",
features = ["test"] }` to `[dev-dependencies]` (one line, nothing else
   touched). This feature is empty in tauri 2.11.6 (`test = []`) and pulls no
   new crates.

2. `apps/standalone/src-tauri/src/lib.rs` — extracted the shell's command list
   into a new public function:

   ```rust
   pub fn invoke_handler<R: tauri::Runtime>(
   ) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
       tauri::generate_handler![
           host_hello,
           device_status,
           host_local_pair,
           host_request,
           device_forget
       ]
   }
   ```

   `run()` now calls `.invoke_handler(invoke_handler())` instead of inlining
   `tauri::generate_handler![...]`. Runtime behavior of the shipped app is
   unchanged; this only makes the command list reusable from a test.

3. `apps/standalone/src-tauri/tests/ipc.rs` (new) — drives that exact command
   list through Tauri's mock runtime (`tauri::test`), exercising two
   scenarios verbatim from the brief:
   - `an_unpaired_device_reports_null_and_refuses_host_requests`: an unpaired
     device's `device_status` is `null`; `host_request` on an allowed route
     rejects with `"not_paired"`; a pairing route (`/v1/local-pair`) is
     refused with `"invalid_request"` even though the route check runs before
     the pairing-state check.
   - `a_paired_device_reaches_the_host_through_the_ipc_shapes`: starts a real
     `markiro-host` on `127.0.0.1:0`, pairs through `DeviceState` directly,
     reloads the pairing from disk (mirroring app start), then drives
     `host_hello`, `device_status`, and `host_request` (bootstrap, an
     authenticated `GET /v1/office/me` via `officeToken`, an anonymous 401,
     an unsupported `PATCH`, and a 204 logout) through the mock IPC dispatcher
     exactly as the webview's `invoke()` would call them.

4. `apps/standalone/AGENTS.md` — appended one paragraph to the end of the
   "Protocol" section documenting that `src-tauri/tests/ipc.rs` pins the
   webview IPC contract and must change together with `src/host/client.ts`,
   `src/host/device.ts`, and `src/host/probe.ts`.

5. `apps/standalone/host/tests/office_auth.rs` — closed three gaps from the
   1b2 review, exactly as specified in the brief:
   - `a_wrong_current_password_changes_nothing`: now also pairs a second
     device, logs the same user in on it, and after the refused password
     change asserts that the _other_ device's session is still `OK` — proving
     a denied change ends no session (previously only the _same_ device's
     session was checked).
   - `the_new_password_is_validated`: rewritten to also read
     `password_phc` and the host revision before the two `400` attempts, and
     assert afterward that the stored hash and the revision counter are
     unchanged and that no `office_user.password` audit row (`ok` or
     `denied`) was written — proving a `400` is a true no-op.
   - `password_change_attempts_are_rate_limited_and_shared_with_login`: the
     first 10-iteration loop and the final post-`clock.advance` assertion now
     both destructure `(status, body)` and additionally assert
     `body["error"]["details"]["credential"] == "password"` for every
     `UNAUTHORIZED` response — proving the limiter's own rejections are
     password-credential rejections, not something that happens to reuse the
     session's expiry path.

   No host production code changed; all three assertions passed against the
   existing implementation on the first run, confirming the brief's claim
   that this step pins already-correct behavior.

## TDD evidence

Step 3 (RED) — before `invoke_handler` existed in `markiro_standalone_lib`,
compiling the new test failed exactly as predicted:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline
error[E0425]: cannot find function `invoke_handler` in crate `markiro_standalone_lib`
  --> src-tauri/tests/ipc.rs:65:49
   |
65 |         .invoke_handler(markiro_standalone_lib::invoke_handler())
   |                                                 ^^^^^^^^^^^^^^ not found in `markiro_standalone_lib`
error: could not compile `markiro-standalone` (test "ipc") due to 1 previous error
```

`git diff --stat apps/standalone/Cargo.lock` was empty at this point (verified
per Step 1's own check).

Step 5 (GREEN) — after adding `invoke_handler` to `lib.rs` and wiring it into
`run()`:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline
running 2 tests
test an_unpaired_device_reports_null_and_refuses_host_requests ... ok
test a_paired_device_reaches_the_host_through_the_ipc_shapes ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.14s
```

`mock_context(noop_assets())` worked on the first try — `get_ipc_response`
never returned an ACL/permission rejection, so the brief's fallback
(`tauri::generate_context!()`) was never needed. `git diff --stat
apps/standalone/Cargo.lock` remained empty.

Step 7 (host password tests) — ran directly against the unmodified host and
passed immediately (no red phase expected or observed, per the brief):

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_auth --offline
running 15 tests
... (all 15) ... ok
test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.76s
```

## Verification commands and results

All commands below were run outside the sandbox
(`dangerouslyDisableSandbox: true`) because they bind or exercise
`127.0.0.1`, per the plan's constraints.

| Command                                                                                                                       | Result                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline` (RED, before Step 4)       | Compile error `E0425`, as expected                                                                                                                                                                                                                                                                                                            |
| `git diff --stat apps/standalone/Cargo.lock` (after RED build)                                                                | empty                                                                                                                                                                                                                                                                                                                                         |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline` (GREEN, after Step 4)      | `test result: ok. 2 passed; 0 failed`                                                                                                                                                                                                                                                                                                         |
| `git diff --stat apps/standalone/Cargo.lock` (after GREEN build)                                                              | empty                                                                                                                                                                                                                                                                                                                                         |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_auth --offline`                          | `test result: ok. 15 passed; 0 failed`                                                                                                                                                                                                                                                                                                        |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (before `cargo fmt`)                            | 21 test binaries/suites, all `ok`, 0 failed anywhere (host lib 10, host bin 3, `bootstrap` 6, `foundation` 12, `hello` 5, `no_secrets_in_logs` 1, `office_admin` 8, `office_auth` 15, `pairing` 5, `platform` 7, proto lib 0, `fixtures` 14, standalone lib 21, standalone bin 0, `device` 13, `host_probe` 2, `host_probe_proxy` 1, `ipc` 2) |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all`                                                                  | reformatted only `src-tauri/tests/ipc.rs` (wrapped long lines the brief's snippet contained); no semantic change                                                                                                                                                                                                                              |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline` (re-run after `cargo fmt`) | `test result: ok. 2 passed; 0 failed`                                                                                                                                                                                                                                                                                                         |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                       | exit 0, no diff                                                                                                                                                                                                                                                                                                                               |
| `node_modules/.bin/prettier --check apps/standalone/AGENTS.md`                                                                | "All matched files use Prettier code style!"                                                                                                                                                                                                                                                                                                  |
| `git diff --check`                                                                                                            | exit 0, no output                                                                                                                                                                                                                                                                                                                             |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (final, after formatting)                       | same 21 suites, all `ok`, 0 failed                                                                                                                                                                                                                                                                                                            |
| `git diff --stat apps/standalone/Cargo.lock` (final)                                                                          | empty                                                                                                                                                                                                                                                                                                                                         |

## Deviations from the brief

- None of substance. The only brief-anticipated fallback (switching to
  `tauri::generate_context!()` because `mock_context(noop_assets())` hits an
  ACL rejection) was not needed — both `ipc.rs` tests passed against
  `mock_context(noop_assets())` on the first green run.
- `cargo fmt --all` reformatted the pasted `ipc.rs` test file (wrapped a few
  lines the brief's markdown had at >100 columns, e.g. the `invoke` helper's
  signature and two multi-line `assert_eq!` calls). This is exactly the
  "run cargo fmt before checking" step the plan's own constraints require,
  not a deviation in behavior — the file was re-tested after formatting and
  still passes.

## Concerns

None. `Cargo.lock` is untouched, the workspace test suite is fully green
(including `src-tauri/tests/device.rs`, unaffected by the `invoke_handler`
refactor), `apps/standalone/dist` already existed so no build step was
needed for the embedded webview assets, and the three host password-test
gaps closed without needing any host production-code change, matching the
brief's expectation that this step only pins existing behavior.

## Files changed

- `apps/standalone/src-tauri/Cargo.toml`
- `apps/standalone/src-tauri/src/lib.rs`
- `apps/standalone/src-tauri/tests/ipc.rs` (new)
- `apps/standalone/AGENTS.md`
- `apps/standalone/host/tests/office_auth.rs`

Commit `9ff45a03c` — `test(standalone): контракт IPC на мок-среде Tauri и
тесты смены пароля на хосте`, trailer `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>` (verified with `git log -1 --format=%B`).
