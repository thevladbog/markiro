# Plan 2a5, Task 4 — report

Status: DONE_WITH_CONCERNS (concerns are open items for Task 7, not defects of this task).
BASE e81e6b15da9ef9d32daed28a56136ac2d9b4a9eb, commit `d209d57f8` (branch claude/2a5-floor):
`feat(standalone): an operator's session has a number, the shift's work holds back a refusal and a new line, and the link reads the station's shifts` (one trailer, Opus 5.5 as the repository pins).

## What was done

- `src/app/shell.ts`: `FloorSession`, `FloorWork`, `lastSessionId`, `floorWork`, `pendingRejection`, `pendingDevice`, `shiftReads`, `deviceNotSaved`; actions `operator_signed_out{sessionId}`, `operator_refreshed`, `work_entered`, `work_left`, `shifts_read`, `device_not_saved`; helpers `changeLine`, `endWork`, `reject`; `NO_FLOOR_SESSION` replaces every `operator: null`; `device_refreshed` same-line branch (new name, undo of a held move); plan code applied verbatim.
- `src/app/host-link.ts`: shift reader (one at a time, own retry counter 2/4/8/16/32 s then 60 s, only online), `stopAll`, `everything`, `deviceShifts` option, `device_not_saved` on a `storage` failure.
- `src/app/App.tsx`: `linked` also off on `pendingRejection`; `deviceShifts: hostApi.getDeviceShifts`; sign-out bound to the session number; `currentOperator`/`useLayoutEffect`/`useRef` removed.
- Tests: `shell.test.ts` (plan fragments + new describe + 10 extra tests), new `host-link-shifts.test.ts` (plan 7 + 8 extra), `app.test.tsx` (one argument).

Anchor adaptations: none that changed intent. Plan test fragments for `shell.test.ts` were applied as exact mechanical substitutions (script, then prettier "unchanged"), not retyped one by one; the result is the plan's text. Everything matched on the first try.

## RED / GREEN

- RED: `vitest run test/shell.test.ts test/host-link-shifts.test.ts test/app.test.tsx` → `Test Files 2 failed | 1 passed (3)`, `Tests 66 failed | 161 passed (227)` — identical to the plan's number.
- GREEN (plan tests only, before my extras): `3 passed`, `227 passed (227)` — identical to the plan.
- After my 20 extra tests: `247 passed (247)` (shell 141+, host-link-shifts 15 +, app 91). Delayed-`setImmediate` stand (3 ms): `3 passed, 247 passed`; stand files removed, `git status` clean afterwards. `--reporter=verbose`: stderr 0 bytes, no `act(`/unhandled in stdout.
- typecheck 0, lint 0, build 0, prettier clean, `git diff --check` clean, `\u04` grep finds only `pairing-code.ts:66`.
- Full `test` run: 82 files / 2307 tests, 10 failed — all 5 s timeouts in `shift-edit`, `shifts-page`, `template-editor` (the known load-induced office tests; machine load average 54). Re-run of those 3 files with `--testTimeout=60000`: 171/171 pass. No failure touches this task's files. (Plan counts 77/1988 are from the scratch base; real tree differs.)

## Mutants (every one: the covering test fails; file restored, `cmp` silent and sha256 equal — `restored True` in the harness output)

Plan mutants 1–7:

| Mutant                                                | Failing tests (key)                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 drop `floorWork` branch in `reject`                | "keeps the operator in the shift when the link/a call refuses the key…", my "holds one refusal…", "keeps the work… through everything" (4) |
| M2 drop `pendingDevice` line                          | "keeps the station on its line…", "forgets a waiting move…", my "holds the latest of several moves…" (4)                                   |
| M3 `operator_signed_out` compares `operator === null` | "ignores a late sign-out…", table row `sessionId:2`, my "numbers the sessions…", "lets nothing of an earlier session…" (4)                 |
| M4 `operator_refreshed` compares `operator === null`  | table row `sessionId:2`, "refreshes the name… running session only", my "numbers…" (3)                                                     |
| M5 drop `if (!active)` after `await deviceShifts()`   | "write nothing when the answer lands after the pairing changed": copies `[…2 rows]` vs `[]`                                                |
| M6 drop `shiftReader.stop()` from `stopAll`           | "refuse the device on a refused key, and nothing more is read" + my 3 refusal-path tests (4)                                               |
| M7 drop `dispatch device_not_saved`                   | "says so when the office's change could not be saved"                                                                                      |

My mutants (items hunted beyond the plan):

| Mutant                                                                                 | Failing test                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| M8p/M8f reset `lastSessionId` on `paired` / `forgotten`                                | "numbers the sessions strictly upward, through a forget and a new pairing…" (2 each)                                      |
| M9 `work_left` checks `floorWork === null` instead of the session                      | "enters the work… once", my "lets nothing of an earlier session touch the work…" (3)                                      |
| M10 `operator_signed_out` does not `endWork`                                           | "ends the work with a sign-out…", my "lets the operator leave a shift under a held refusal" x3 (4)                        |
| M11 `endWork` applies another line before the refusal                                  | "lets a refused device win over another line…"                                                                            |
| M12 `work_entered` allowed while work is set                                           | "enters the work… once" + table (2)                                                                                       |
| M13 same-line `device_refreshed` keeps `pendingDevice`                                 | "forgets a waiting move when the office moves the station back"                                                           |
| M14a/b/c `NO_FLOOR_SESSION` without `floorWork` / `pendingRejection` / `pendingDevice` | "drops the work and what waits for it with the operator…" (+1 other for floorWork)                                        |
| M15 refresher's rejection branch stops only scheduler+refresher                        | my "is a refused key on the device read"                                                                                  |
| M16 sync's rejection branch likewise                                                   | my "is a refused key on the reference sync"                                                                               |
| M16b sync's `other_host` branch likewise                                               | my "is another host on the reference sync"                                                                                |
| M17 `await replaceShiftCopies` → `void`                                                | my "count as a failed read and keep the copies the station has"                                                           |
| M18 `device_not_saved` for any `DeviceError`                                           | my "says nothing of the disk when the read of the device fails for another reason" (uses `DeviceError("request_failed")`) |
| M19 offline branch does not cancel the shift retry                                     | "drop the retry while the link is down…"                                                                                  |
| M20 online branch does not re-trigger a failed shift read                              | same test (second half) + "keep the copies and are tried again…"                                                          |
| M21 `shiftFailures` never incremented                                                  | "keep the copies and are tried again after 2 s, then 4 s" (2)                                                             |
| M22 `everything()` without `shiftReader.trigger()`                                     | 13 of 15 host-link tests                                                                                                  |
| M22c watch-failed branch does not read shifts                                          | my "are read once on their own, and again on request" (link without events)                                               |
| M23 failed read zeroes `done`                                                          | "counts the reads…"                                                                                                       |
| M24 same-line refresh keeps `deviceNotSaved`                                           | "says the office's change was not saved until a read lands"                                                               |
| M25 `paired` does not reset `shiftReads`                                               | "counts the reads…" (I added the `paired` assertion)                                                                      |
| M26 drop the identical-value shortcut of `operator_refreshed`                          | "refreshes the name and role… without a new session" (`toBe`)                                                             |
| M29 `changeLine` loses `line_changed` notice                                           | 4 tests                                                                                                                   |
| M32/M33 `link_status` / `device_rejected` bypass `reject`                              | both it.each rows of "keeps the operator in the shift…"                                                                   |
| M34 `device_refreshed` of another line bypasses `changeLine`                           | "signs the operator out when the office moves the station…"                                                               |
| M35 `device_not_saved` always returns a new state                                      | "says the office's change was not saved…" (`toBe(failed)`)                                                                |
| M28 (App) sign-out dispatches a constant session number                                | `app.test.tsx` "ends only its own session: an earlier session's late sign-out leaves the next one"                        |
| **M30 (App) drop `pendingRejection === null` from `linked`**                           | **SURVIVES** — see concerns                                                                                               |

## Extra tests I added (not in the plan)

Shell: strict session numbering across forget and re-pair with late calls of sessions 1 and 2; nothing of an earlier session touches the next session's work (`work_left`, `work_entered`, sign-out); the operator can always leave a shift under a held refusal (notice idle/removed/null) and the refusal then comes at once; recovery after a released refusal (nothing signs in under it, forget + pair + sign in = session 2, work can start again); one held refusal at a time (a second, even of another reason, replaces it, the shift goes on, `host_changed` via `link_status`); latest of several held line moves wins; line change and refusal apply at once after `work_left`; a 16-action list of unrelated actions keeps `floorWork`, `pendingRejection`, `pendingDevice`, session; `other_host` drops the work at once (documents the plan's decision); `shifts_read` touches neither session nor work; `paired` resets `shiftReads`.
Host link: refusal on the device read / on the sync / `other_host` on the sync stops the shift reads too; certificate mismatch on the shifts' own read; failed local write counts as a failed read and keeps the copies; no retry after unmount; no-events link reads shifts once and on request; `device_not_saved` not for non-storage errors.

## Self-review against the lessons

- Trap states: the operator can always leave (`operator_signed_out` ends work first, tests for all three notices); the released refusal leaves a state from which forget/pair/sign-in recover; `work_left` clears `floorWork` so later refusals/moves apply at once; no flag lives past `NO_FLOOR_SESSION`. A held state is never lost by unrelated actions (16-action test).
- Link stop on held rejection: `useHostLink` stops all three schedulers on any rejection path (4 mutants above); `App` also removes `linked` on `pendingRejection` — only structurally, see concern 1.
- No `any`/casts/`!` in the sources. Immutability and exhaustive switch kept (TS `switch` has no default; typecheck passes).

## Concerns / open items

1. M30 survives: nothing in `App` can set `floorWork` until Task 7 (`FloorApp` sends `work_entered`), so the `state.pendingRejection === null` clause of `linked` has no test. The brief already assigns that mutant to Task 7. Task 7 must add an App-level test: under a held refusal, a revision/`syncNow` reaches neither `changes`, `refresh` nor `getDeviceShifts`, and the `useHostLink` effect is torn down.
2. A second held refusal REPLACES the first (latest wins; both lead to a refusal screen, `host_changed` text differs). Plan code kept; pinned by a test.
3. `sync_finished other_host` still drops the operator and the work immediately (plan decision, "Перенесено"); pinned by a test so Task 7's `FloorApp` owner knows work can vanish under it in that rare case.
4. `shifts_read` from a read of the old pairing landing between a `forgotten`/`paired` dispatch and the effect cleanup can bump `shiftReads.done` of the new pairing by one (same window `sync_finished` has); harmless (one extra re-read), not guarded.
5. Full-suite timeouts under load average ~54 (see above); none in this task's files.
6. The in-flight refresh/shifts promise of a stopped link can still dispatch `device_refreshed` into a state holding a refusal (`pendingDevice` then set; the refusal still wins at release; tested by "lets a refused device win…").

## Files changed

- /tmp/claude/wt/2a5-floor/apps/standalone/src/app/shell.ts, host-link.ts, App.tsx
- /tmp/claude/wt/2a5-floor/apps/standalone/test/shell.test.ts, host-link-shifts.test.ts (new), app.test.tsx
