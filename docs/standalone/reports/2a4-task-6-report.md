# Plan 2a4, Task 6 report: `set_system_awake`

BASE `dd352f166`, commit `c0db63cd6` (`feat(standalone): set_system_awake keeps the computer awake, and letting go never fails`), branch `claude/2a4-shell`, one trailer (Opus 5.5, pinned by the repository rules). `git status --short` is empty after the commit. Nothing pushed. No `Cargo.toml`, `Cargo.lock` or CI change (`git diff --stat` on them is empty).

## Status: DONE_WITH_CONCERNS (concerns at the end)

## What was done

The plan's Task 6, plus four test and surface additions beyond the plan (explained below).

- `src-tauri/src/power.rs`: `PowerError::RequestFailed` (code `power_request_failed`), a private `PowerRequestBackend` trait, `PowerRequestState<B>` (one lease behind a `Mutex<Option<Lease>>`), `SystemAwakeState` (`Default`), command `set_system_awake`.
  - `false` drops the lease even after a poisoned lock.
  - The refusal (`power_request_failed`) comes only from `true`.
  - A refusal stores no lease, so the next `true` tries again.
- `src-tauri/src/power/windows.rs`: the plan's file, verbatim. It uses `std` and `windows-sys` only.
- `lib.rs`: `pub mod power`, `power::set_system_awake` in `invoke_handler`, `.manage(power::SystemAwakeState::default())` in `run`.
- `tests/ipc.rs`: `keeping_the_computer_awake_answers_through_the_ipc_shape`, and `SystemAwakeState` managed in `mock_app_with`.

## Anchor adaptations

The brief predates the Task 2 to 5 fix rounds. I stopped on none, and applied the intent by hand in these places:

1. `ipc.rs` imports: the `local_db` import is now multi-line (it contains `MIGRATOR`). The new `use markiro_standalone_lib::power::SystemAwakeState;` line went between it and the `secret_store` import. I also added `Manager` to `use tauri::{App, Manager, WebviewWindow}` (needed for `app.state::<_>()`, see addition 1).
2. `ipc.rs` fragment 2 (the `.manage(...)` list) sits in `mock_app_with(device, local)`, not in a single `mock_app`. `mock_app` delegates to it, so one `.manage(SystemAwakeState::default())` serves all.
3. `ipc.rs` fragment 3: the anchor line `/// src/host/connection.ts reads this snapshot...` followed by `#[test]` matched exactly once, so no change was needed. The new test sits before `the_connection_status_has_the_webview_shape`.
4. `lib.rs` fragments 1 to 3 matched as written.

## Additions beyond the plan (and why)

1. `SystemAwakeState::is_awake()` (pub) and `PowerRequestState::is_awake()`. The plan's IPC test asserts only that the answer is `null`, so on macOS and Linux (where the backend is a no-op) the command's `awake` argument is unobservable. A mutant that ignores `awake` (`answer(true)`) survived it. The IPC test now reads `app.state::<SystemAwakeState>().is_awake()` after each call. On Windows a CI session that refuses the request must also hold nothing.
2. `PowerRequestState::answer(awake)`: the command body (`set_awake(..).map_err(code)`), so the mapping to the bare code is covered by a unit test. The plan's tests call `code()` directly, so a mapping mutant (`format!("{error:?}")`, which would send `RequestFailed` to the webview) survived: the IPC test cannot produce a refusal on macOS. The command is now `state.0.answer(awake)`.
3. `dropping_the_state_lets_the_computer_sleep`: the lease dies with the state (app exit, a dropped `App`), so a closed app cannot leave a request held. On Windows the handle is also released by process exit regardless.
4. `the_webview_reads_the_bare_code_of_a_refusal` (the unit test for addition 2), and `is_awake` assertions in the first and poison tests (a poisoned lock still reads what it holds).

Unit totals: lib 56 measured (51 before this task, plan 52 = 49 + 3; I add 5: the plan's 3 plus 2). `ipc` 22 measured (21 before, plan 16 on its older base, +1). The plan's absolute numbers (52 and 16) are from a base that no longer exists after the Task 4 to 5 additions.

## RED

`cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --no-run` (log `/tmp/claude/t6/red.log`):

- `error[E0432]: unresolved import 'markiro_standalone_lib::power'` at `tests/ipc.rs:21`.
- Plus `E0599 no method named 'state' found for struct 'App<R>'` until `Manager` was imported (an artefact of my extra `is_awake` assertion).

## GREEN

- `--lib`: 56 passed (`power::tests` 5). `--test ipc`: 22 passed, outside the sandbox. Also `lockdown` 4, `local_db` 26, `line` 16, `device` 15: all pass. Logs in `/tmp/claude/t6/`.
- `cargo fmt --all -- --check`: clean. `cargo clippy -p markiro-standalone --all-targets`: 0 warnings. `cargo check -p markiro-host -p markiro-proto --all-targets`: 0 warnings. `git diff --check`: clean. No `\u0` text in the new Rust files.
- The only compiler warning is an `xcrun` cache message under the sandbox (`errno=Operation not permitted`); it does not appear outside the sandbox and is unrelated to this task.
- The poison test prints its thread's panic to stderr, as the plan says.
- I did not run the full `cargo test --workspace` (not required for this task).

## Windows: what was and was not verified

Verified by two probe crates, outside the sandbox, `--target x86_64-pc-windows-msvc`, with `#![deny(warnings)]`:

1. The plan's probe (`/tmp/claude/p2a4-probe`), which includes the real `power/windows.rs` through `#[path]` with the windows-sys features of Task 1: `Finished`, no warnings. The plan's probe mutation (drop `"Win32_System_Threading",`) fails with `E0432: unresolved imports windows_sys::Win32::System::Power::PowerCreateRequest, windows_sys::Win32::System::Threading`; the file was restored (`cmp` clean) and the check passes again.
2. A second probe that I added (`/tmp/claude/p2a4-probe2`): the whole real `power.rs` (including the `cfg(windows)` `impl PowerRequestBackend for PlatformBackend`, the `mod windows;` link and the `tauri::command`) with `tauri 2.11` as a dependency, via symlinks to the real files. `cargo check` and `cargo check --tests` both finish clean. Tauri itself type-checks for Windows from the local cache, so this covers what the plan's probe cannot: the glue between `power.rs` and `windows.rs`, and `Lease: Send` for `OwnedHandle`.

Not verified: any runtime behaviour on Windows. The real `PowerCreateRequest` and `PowerSetRequest` calls, the reason string visible in `powercfg /requests`, the release on `Drop`, and `acquire` failing on a restricted session were not exercised. The IPC test's Windows branch (real request, accepting `power_request_failed`) has never run. `run()` registering the state in the real (non-mock) app is covered only by compilation, not by a test: forgetting the `.manage(...)` line in `run` would compile and pass every automated test. The manual list (stage 2a spec §7) should include `powercfg /requests` while the work screen is open.

Neither probe is committed; they live outside the repository.

## Mutants

All mutants are one-line (M7 adds a small `Drop` impl) and were restored byte-identically (`shasum -a 256` before and after equal, `cmp` clean; the harness script `/tmp/claude/t6/mut.py` checks the hash for each). "lib" is `--lib power`, "ipc" is `--test ipc keeping`.

| #   | Mutant                                                                                                   | Test that failed                                                                                                  | Restore    |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| M1  | the lock: `unwrap_or_else(PoisonError::into_inner)` becomes `map_err(.. RequestFailed)?` (plan mutant 1) | `letting_go_works_even_after_a_poisoned_lock`                                                                     | hash equal |
| M2  | `if lease.is_none()` becomes `if true` (plan mutant 2)                                                   | `a_shift_holds_exactly_one_request_until_it_ends` (counts `(1,0)` expected)                                       | hash equal |
| M3  | `false` returns without dropping the lease                                                               | `a_shift_holds_exactly_one_request_until_it_ends` and `letting_go_works_even_after_a_poisoned_lock`               | hash equal |
| M4  | a refusal answers `Ok(())`                                                                               | `a_refused_request_holds_nothing_and_the_next_one_tries_again` and `the_webview_reads_the_bare_code_of_a_refusal` | hash equal |
| M5  | the code string becomes `"power_failed"`                                                                 | `the_webview_reads_the_bare_code_of_a_refusal` and `a_refused_request_...`                                        | hash equal |
| M6  | `false` with nothing held returns an error                                                               | `a_shift_holds_exactly_one_request_until_it_ends` (second `false`), plus two more                                 | hash equal |
| M7  | `Drop for PowerRequestState` forgets the lease (contrived leak)                                          | `dropping_the_state_lets_the_computer_sleep`                                                                      | hash equal |
| M8  | the command calls `answer(true)` instead of `answer(awake)` (ipc)                                        | `keeping_the_computer_awake_answers_through_the_ipc_shape` (the `false` step: still held)                         | hash equal |
| M9  | `answer` maps the error to `format!("{error:?}")`                                                        | `the_webview_reads_the_bare_code_of_a_refusal`                                                                    | hash equal |
| M11 | `is_awake` always `false` (ipc)                                                                          | `keeping_the_computer_awake_answers_through_the_ipc_shape`                                                        | hash equal |

Findings from the mutation runs (each fixed by the additions above): without addition 1, M8 survived the plan's IPC test; without addition 2, M9 survived all of the plan's tests. A mutant that stores a lease after a refusal is equivalent (the lease is already `None` there), so it is not listed.

## Self-review

- Safety property: releasing never fails (poison covered by M1/M3), a refused request leaves nothing held and the next `true` retries, the lease cannot outlive the state (M7), and on Windows `Drop` clears both requests before the `OwnedHandle` closes the handle; a half-built request (display set, system failed) is dropped by `acquire`'s early return, so no request leaks.
- No test can hang: the poison test joins a thread that panics at once; no sockets or sleeps in the new tests.
- The refusal text goes to stderr only (`standalone: set_system_awake power_request_failed: <detail>`); the webview gets the bare code.
- `windows.rs` differs from the cloud station's file only in the reason string, the error texts and the `SAFETY` comments.

## Concerns

1. Windows runtime behaviour is unverified (above); `run()`'s `.manage(SystemAwakeState)` is untested.
2. `is_awake()` and `answer()` are small additions to the plan's surface. `is_awake` is `pub` because `tests/ipc.rs` is an integration test; it reads state only.
3. Plan counts (lib 52, `ipc` 16) are lower than measured (56 and 22) because the base grew in Tasks 4 and 5.

## Files

- `/tmp/claude/wt/2a4-shell/apps/standalone/src-tauri/src/power.rs` (new)
- `/tmp/claude/wt/2a4-shell/apps/standalone/src-tauri/src/power/windows.rs` (new)
- `/tmp/claude/wt/2a4-shell/apps/standalone/src-tauri/src/lib.rs`
- `/tmp/claude/wt/2a4-shell/apps/standalone/src-tauri/tests/ipc.rs`
