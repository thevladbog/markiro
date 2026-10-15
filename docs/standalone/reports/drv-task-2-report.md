# ДРВ Task 2 report — driver commands, IPC contract, answer shapes (shell)

Status: DONE_WITH_CONCERNS (concerns = Windows-only verification limits).
Commit: `4aa67cb1a` feat(standalone): driver printing commands and their IPC shapes (plan ДРВ task 2), branch `claude/prt` (base 2387a2dce).

## What was done

- `printer/driver_commands.rs` (replaced stub): `supports_windows_printing`, `print_windows_raster`, `get_windows_print_job`, `await_driver` (30 s `DRIVER_WAIT`), plus helpers `unknown_print`, `print_within`, `observe_within` (see adaptation 1).
- `lib.rs` `invoke_handler`: three commands registered right after `printer::list_usb_printers`, exactly like the existing printer commands. The webview capability is `core:default` only (`capabilities/default.json`); app commands carry no per-command permission files, so nothing else to register.
- `tests/ipc.rs`: `driver_printing_answers_through_the_ipc_shapes` (verbatim).
- `tests/fixtures/hardware-shapes.json` + `tests/hardware_shapes.rs`: five new shapes, key count 7; module comment extended. The TS side (`test/hardware.test.ts`, 115 tests) reads the same file and stays green; the Zod schemas (`windowsPrintOutcomeSchema`, `windowsJobObservationSchema`) are Task 3 per the plan, so there is no Zod parity to write here.
- No logging added anywhere; no payload/label bytes are logged.

## RED / GREEN

- RED: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc driver_printing` -> `Err("Command supports_windows_printing not found")` (`/tmp/claude/impl-drv-t2/red.log`).
- GREEN: ipc `driver_printing` 1 passed; `hardware_shapes` 1 passed; `--lib printer::driver_commands` 6 passed.
- Final: `cargo test --workspace --offline --locked` (unsandboxed) exit 0, 1157 passed, 0 failed, 0 ignored, 0 warnings (Task 1 base: 1150; +1 ipc, +6 driver_commands).
- Gates: `cargo fmt --all -- --check` 0; `cargo check -p markiro-standalone --all-targets` 0 warnings; `git diff --check` clean; no `\u0` in written Rust/JSON; prettier gate proven live (scratch mis-formatted file failed, deleted) and the changed JSON passes; `git status --short` empty after commit. `pnpm ... vitest run test/hardware.test.ts` 115 passed. Webview typecheck/lint/build not run: no TS/webview file changed.

## Anchor adaptations

1. Semantic-neutral refactor beyond the brief's code: the inline `await_driver(...).unwrap_or(...)` bodies of the two async commands were extracted into `print_within(limit, job)` / `observe_within(limit, job)` and `unknown_print()`, so the timeout/panic fallbacks (`delivery_unknown` for a print, `unavailable` for a question) are testable with a short limit instead of a 30 s wait. Commands call them with `DRIVER_WAIT`; answers are identical to the brief's. Five tests added.
2. Hardware-shapes module comment re-flowed by hand after the inserted clause (brief only gave the text to append).

- No other differences; all brief anchors matched exactly once.

## Mutants (scratch one-line; `/tmp/claude/impl-drv-t2/mutate.py`, `mutate2.py`, logs `mut.log`; originals under `/tmp/claude/impl-drv-t2/orig/`; sha256 equal after every restore and files touched)

| Guard                                                                 | Mutant                                    | Killed by                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `supports_windows_printing` is `cfg!(windows)`                        | `true`                                    | ipc driver_printing_answers_through_the_ipc_shapes                                                             |
| DRIVER_WAIT > webview 20 s                                            | 30 s -> 5 s                               | the_command_waits_longer_than_the_webview_does                                                                 |
| stalled print is `delivery_unknown` (never retry-safe `before_start`) | phase -> `before_start`                   | a_print_that_does_not_answer_is_delivery_unknown_never_before_start, a_print_that_dies_is_delivery_unknown_too |
| stalled print code                                                    | `driver_failure` -> `geometry_mismatch`   | same (first)                                                                                                   |
| print fallback exists                                                 | panics instead of answering               | both print-fallback tests                                                                                      |
| question fallback `unavailable`                                       | `Absent`                                  | a_question_that_does_not_answer_or_dies_is_unavailable                                                         |
| a dead worker (join error) is mapped, not propagated                  | `result.unwrap()`                         | a_print_that_dies..., a_question_that_...dies                                                                  |
| a finished job's own answer passes through                            | always `Err`                              | a_print_that_answers_keeps_its_own_answer, question test                                                       |
| command argument order for print                                      | queue/document swapped                    | ipc driver_printing                                                                                            |
| each of the 3 commands registered                                     | line removed (x3)                         | ipc driver_printing                                                                                            |
| fixture values                                                        | statusFlags 8->9; jobId 42->43; extra key | the_hardware_shapes_are_the_ones_the_fixture_pins                                                              |

Survivors (host-unobservable, deliberately listed):

- `supports_windows_printing` -> `false`, and `get_windows_print_job` passing a mangled receipt to `driver::observe`: on the host `observe` is `unavailable` for every input, so only a Windows run distinguishes them (manual / `standalone-windows-build`).
- jobId 7 -> 0 in the ipc test: equivalent (observe is `unavailable` off Windows, and on Windows the nonexistent queue reads `unavailable` first).
- `task.abort()` removal in `await_driver`: aborting a running blocking task is a no-op, so unobservable (comment in code says so).

## Test totals

Plan: ipc 1 + commands 1. Measured: ipc 1, driver_commands 6 (+5), hardware_shapes 1 (extended); workspace 1157 passed.

## Concerns

- Windows path (`driver::native`, queue_unavailable branch of the ipc test on Windows) not executed; only Task 1's probe crate type-check plus CI `standalone-windows-build`.
- `graphify update .` not run (no `graphify-out/graph.json` in this worktree).
- The Zod parity for the new fixture keys is Task 3.
