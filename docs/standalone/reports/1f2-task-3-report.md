# Plan 1f2, Task 3 — report

Status: DONE_WITH_CONCERNS (two tests added beyond the plan; counts differ from the plan by +2, see below).
BASE d31df772a, commit `954232ced feat(standalone): the webview locks the window whenever the office is closed` (trailer verified: exactly one `Co-Authored-By: Claude Opus 5.5` line).

## What was done

- `src/app/lockdown.ts` created verbatim from the brief (`LockdownCommand`, `LockdownSnapshot`, `LockdownLifecycle`, `createLockdownLifecycle`).
- `src/app/App.tsx`: 5 anchored edits (import, `lockdown?` prop, destructure, `kiosk` memo, `officeOpen` + effect). Every anchor matched exactly once.
- `test/lockdown.test.ts` created; `test/app.test.tsx` 3 anchored edits (import, `Services.lockdown`, `recordingLockdown` + `describe("kiosk mode")`). Every anchor matched once.
- Rust, `src-tauri/Cargo.toml`, host, proto untouched. Task 1 (owner step) remains open, as expected.

## RED / GREEN

- RED 1 (step 2): `vitest run test/lockdown.test.ts test/app.test.tsx -t "kiosk|lifecycle"` -> both files `Failed to resolve import "../src/app/lockdown.js"`.
- RED 2 (step 3 state, reproduced by temporarily restoring HEAD's `App.tsx` with lockdown.ts present): 2 failed | 8 passed | 82 skipped; both failures `AssertionError: expected [] to deeply equal [ 'enter_lockdown' ]` (the two `kiosk mode` tests named in the plan). `App.tsx` restored, `cmp` silent, sha256 `921be5e1d50021ef073105518f4a915cc12c5a495bbea56f2b42e10bbcd4d351` before and after.
- GREEN (step 5): same command -> 10 passed | 82 skipped (as the plan says). Full `test`: 64 files, 1672 tests (as the plan says) before my two extra tests; 1674 with them.
- `typecheck` 0, `lint` 0 (no warnings), prettier clean, `git diff --check` clean, `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`.
- `--reporter=verbose` on `test/lockdown.test.ts test/app.test.tsx`: exit 0, `stderr |` count 0 (92 tests; 94 after the extras).
- Delayed-`setImmediate` stand (3 ms) on the same two files: 94 passed; the two stand files were removed; `git status --short` empty after the commit.
- `build` not run: the task does not touch the shell or the dist it embeds.

## Mutants (runner: `/tmp/claude/mut.py`, each restored byte-identically; sha256 compared before/after, `restored=True` for all)

| Mutant                                                    | Test that failed                                                                                  | Key line                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| M1 plan: `[kiosk, officeOpen]` -> `[kiosk]` (App.tsx)     | app `kiosk mode > tries a lock that failed again when the office closes`                          | `expected [ 'enter_lockdown' ] to deeply equal [ 'enter_lockdown', 'enter_lockdown' ]` |
| M2 plan: drop `if (requested === next) requested = null;` | lockdown `sends the same command again after it failed, …`                                        | `expected [ 'enter_lockdown', …(2) ] to deeply equal [ 'enter_lockdown', …(3) ]`       |
| M3 drop `if (requested === next) return settled;`         | NEW lockdown `sends one command for a mode asked for twice at once, even when that command fails` | `expected [ 'enter_lockdown', 'enter_lockdown' ] to deeply equal [ 'enter_lockdown' ]` |
| M4 drop `if (applied === next) return;`                   | NEW lockdown `sends nothing to leave a mode the window is already in`                             | `expected "vi.fn()" to not be called at all, but actually been called 1 times`         |
| M5 drop `applied = null;` in catch                        | lockdown `sends the same command again after it failed…`                                          | `…(2) to deeply equal …(3)`                                                            |
| M6 `enabled = true` (ignore dev)                          | lockdown `sends nothing in development`                                                           | `expected true to be false`                                                            |
| M7 also `logError(String(e))` in catch                    | lockdown `keeps the confirmed mode after a failure and names only its direction`                  | `expected [ …(2) ] to deeply equal [ Array(1) ]`                                       |
| M8 `settled = Promise.resolve().then(…)` (not serialised) | lockdown `runs an exit asked for during an enter after it, never alongside`                       | `expected "vi.fn()" to be called 2 times, but got 1 times`                             |
| M9 swap error direction                                   | lockdown `keeps the confirmed mode after a failure…`                                              | snapshot `error` mismatch                                                              |
| M10 `clearError` no-op                                    | same test                                                                                         | snapshot `error` not cleared                                                           |
| M11 `unsubscribe` no-op                                   | lockdown `stops telling a listener once it unsubscribed`                                          | `expected "vi.fn()" to not be called at all, but actually been called 2 times`         |
| M12 App: `void kiosk.enter()` regardless of `officeOpen`  | app `tries a lock that failed again when the office closes`                                       | `expected [ 'enter_lockdown', 'enter_lockdown' ] to deeply equal [ 'enter_lockdown' ]` |
| M13 success does not publish `locked/windowed`            | lockdown `publishes the pending and the confirmed mode…` (+ one more)                             | mode `windowed` instead of `locked`                                                    |
| M14 drop the `pending: true` publish                      | lockdown `publishes the pending and the confirmed mode…`                                          | snapshot list is one entry short                                                       |

First pass: M3, M4 and a no-op "M7" (`catch (e)` with unused `e`, equivalent) survived. M3 and M4 are each redundant with the other as a dedupe, so the plan's tests did not isolate them; I strengthened the tests (two new cases in `test/lockdown.test.ts`) and re-ran: both now fail on their mutant. The equivalent M7 was replaced by a real one (logging the thrown text).

## Counts

- Plan, after whole plan: Vitest 66 files / 1703 tests. Task 3 per plan: 64 files / 1672 tests. Measured: 64 files / 1672 before my extras; 64 files / 1674 with the two extra tests in `test/lockdown.test.ts` (`sends nothing to leave a mode the window is already in`, `sends one command for a mode asked for twice at once, even when that command fails`). The later tasks' counts shift by +2.
- Cargo not run (no Rust change).

## Files changed

- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/app/lockdown.ts` (new)
- `.../apps/standalone/src/app/App.tsx`
- `.../apps/standalone/test/lockdown.test.ts` (new)
- `.../apps/standalone/test/app.test.tsx`

## Self-review / concerns

- `kiosk` is a `const` in `App` as the brief requires; today it is used only by the effect, task 4 will read its snapshot.
- Behaviour not exercised by automation: real window lock in the Tauri shell (needs Windows, Task 1 owner step still open for the Windows build).
- The extra tests are my addition; if the controller wants plan counts exact, drop them, but M3 and M4 then survive.
