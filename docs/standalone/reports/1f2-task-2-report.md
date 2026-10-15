# Plan 1f2, Task 2 report: kiosk mode in the shell (Rust)

Status: DONE_WITH_CONCERNS (concern: Windows-only code not compiled here; Task 1 manifest step still the owner's).

BASE: 7bb33fcf872d4d8061177306fd10a59d1b68421d. Commit: 26a997efb `feat(standalone): kiosk-mode commands and the close guard in the shell` (trailer: exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified with `git log -1 --format=%B`).

## What was done

Plan steps 1-7 applied verbatim, in order; every lib.rs anchor matched exactly once.

- Created `apps/standalone/src-tauri/tests/lockdown.rs` (4 tests on Linux/macOS; 3 on Windows).
- Created `apps/standalone/src-tauri/src/lockdown.rs` (module + 4 unit tests).
- `apps/standalone/src-tauri/src/lib.rs`: `pub mod lockdown;`, the two commands in `invoke_handler`, `.manage(LockdownState::default())` and `.on_window_event(lockdown::refuse_close_while_locked)` in `run`.
- `src-tauri/Cargo.toml` and `Cargo.lock` untouched (Task 1 is the owner's).

## RED / GREEN

- RED: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test lockdown` (outside sandbox) -> exit 101, `error[E0432]: unresolved imports markiro_standalone_lib::lockdown` (tests/lockdown.rs:14).
- GREEN: same command with `--lib --test lockdown` -> lib 47 passed (was 43; +4 `lockdown::tests`), `lockdown` 4 passed (1.01 s). Matches the plan's numbers exactly.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` -> exit 0.
- `cargo test --offline --locked ... --workspace --no-run` -> exit 0, 0 warnings.
- `cargo check ... -p markiro-host -p markiro-proto --all-targets --offline` -> exit 0, 0 warnings.
- `git diff --check` clean; no literal `\u0` in the written Rust files; `git status --short` empty after commit.

The workspace-wide `cargo test` was not run (only `--no-run`), per the plan; the new total of 461 cargo tests is therefore not measured by me, only the shell crate parts (lib 47, lockdown 4).

## Mutants

| Mutant                                                            | Test that failed                                                                                      | Key line                                                                 | Restore proof                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| M1: `api.prevent_close();` -> `let _ = api;`                      | `a_close_request_is_refused_while_kiosk_mode_is_on`                                                   | `assertion left == right failed, left: 1, right: 2` (3 passed, 1 failed) | `cmp` silent; sha256 d46132431dc663fceda66abf885028724c094bbc017e8eaedfbc0534ca328df3 before and after |
| M2: `unlock` reads `main_window(app)?` before `state.set(false)`  | `lockdown::tests::leaving_kiosk_mode_clears_the_flag_even_without_a_window`                           | panicked at lockdown.rs:212 (3 passed, 1 failed)                         | same sha, `cmp` silent                                                                                 |
| M3 (extra): `lock` ends with `state.set(false)` instead of `true` | `the_kiosk_commands_turn_the_flag_on_and_off` and `a_close_request_is_refused_while_kiosk_mode_is_on` | 2 failed                                                                 | same sha, `cmp` silent                                                                                 |

## Not verified here

- `cfg(windows)` `cover_current_monitor` (`MonitorFromWindow`, `GetMonitorInfoW`, `SetWindowPos`) is not compiled on macOS and needs the Task 1 `windows-sys` features (`Win32_Graphics_Gdi`, `Win32_UI_WindowsAndMessaging`): verified only by the owner's `standalone-windows-build` CI. Likewise `on_windows_a_refused_enter_leaves_the_flag_off`, and real-window behaviour (frame, taskbar, topmost, close refusal).
- That `run` actually installs `.on_window_event(...)` is not covered by any test (mock runtime never calls the builder's handler; the test drives the guard itself). Manual Windows check.
- Rollback on a refused `lock` (properties restored, flag off) is only reachable on Windows with a mock handle; not exercised on macOS.

## Concerns

- Task 1 (manifest features) must land before Windows CI can compile `lockdown.rs`.
- Test panic line numbers in my run (tests/lockdown.rs:152 etc.) differ from the plan's quoted lines; the file content is byte-for-byte the plan's block.

## Fix: the close-guard test fails instead of hanging (review Important 1)

Commit subject `test(standalone): the close-guard test fails instead of hanging when the guard never lets go`, base 26a997efb. Only `apps/standalone/src-tauri/tests/lockdown.rs` changed: after the first unlock the loop keeps calling `window.close()` while `count < 3`, then `window.destroy()`, so a guard that never lets go ends with a count of 3 and fails the assertion. The passing path is unchanged (counts 2 and 1). Production code untouched (`lockdown.rs` sha256 d4613243...28df3 before and after, `cmp` clean against `/tmp/claude/t2fix-prod.rs`).

- GREEN: `cargo test --offline --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test lockdown` (outside the sandbox, via a 900 s kill wrapper): 4 passed, 0 failed, 1.01 s.
- Mutant (inverted guard, `lockdown.rs:182` `if !window.state::<LockdownState>().is_locked()`): 2 passed, 2 FAILED in 3.03 s, no hang. `a_close_request_is_refused_while_kiosk_mode_is_on`: left 1, right 2. `a_close_request_goes_through_while_kiosk_mode_is_off`: left 3, right 1.
- Restore proof: file copied to `/tmp/claude/t2fix-prod.rs` before, `cmp` silent and sha256 identical after; `git status` showed only the test file modified.
- `cargo fmt --all -- --check` passes; `git diff --check` clean.
- Note: the plan document's test block still carries the old loop; the plan was not edited (out of scope of this fixer).
