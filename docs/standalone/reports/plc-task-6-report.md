# plc Task 6 report — the close of a shift with an open pallet

Status: DONE_WITH_CONCERNS. Commit `16ea9530d` feat(standalone): the close of a shift with an open pallet — «Закрыть паллету и смену» (worktree /tmp/claude/wt/flr, BASE 789986485). Tree clean after the commit. Evidence in `/tmp/claude/impl-plc-t6/` (red.txt, red-final.txt, green*.txt, mut.py, mut-result-all.json, n2-typecheck.txt, delay.txt, verbose.txt, full.txt, orig/, final/). No Rust touched, so no cargo run.

## What was done

- `ShiftClosePanel.tsx`: props `palletCapacity?`, `onClosePallet?`; the `open_pallet` blocker with a way to close it shows the whole summary and, under it, an Alert «На паллете N из M коробов — закрыть?» with a line on what the press does («…её этикетка уйдёт на печать, а смена закроется. Отменить это нельзя.»); the button is «Закрыть паллету и смену» (`size="floor"`, same press guard/busy handling as the others); busy line «Закрываем паллету и смену…». Without `onClosePallet` (or with `palletCapacity` null) the blocked view says «На открытой паллете N коробов. Сначала закройте её.» The blocked-view text is now `blockerText()`: an exhaustive `switch` with `const unsaid: never = blocker` (the old ternary rendered `open_pallet` as «closed»). `sameSummary` now compares the open pallet's box count.
- `WorkScreen.tsx`: the shift's close is ONE path `finishClose(reason, shown)` for «Подтвердить закрытие», «Закрыть паллету и смену» and the continuation after a pallet label; it always passes `[openPalletGuard(...)]` to `closeShift`. `confirmClose` re-reads the summary in the queue's turn and compares (sameSummary) as before; new `confirmPalletClose` is the same discipline (queued, tracked, `closeRunning`, `leavingNow`) then `closePallet()` (Task 3/5 early-close machinery) then `finishClose`. A pallet label stop → `pendingClose` (ref + mirrored state for the words «Паллета закрыта. Смена закроется, как только вы решите по этикетке паллеты.»); `afterLabel()` (called from `check` and `decide`) runs the pending close (unless the leave began; shows a loading `close` stop + busy) or else closes a full box / settles a full pallet. `closePallet` stop results (`pallet_no_serials`, `pallet_failed` — invalid_serial = «Повторить») leave the shift open; focus goes to the last-scan line (safe place) when they replace the summary. The summary helpers (`waitingLabel`, `showClosed`, `foundClosed`, `showSummary`, `closeFailed`, `readSummaryNow`) became `useCallback`s hoisted above `afterLabel` (stable identities; no effect restarts).
- `ru.json`: `floor.close.palletOpen`, `palletIrreversible`, `confirmPallet`, `closingPallet`, `afterLabel`, `blocked.open_pallet`.
- `test/floor-work-close-pallets.test.tsx`: brief's 4 (adapted) + 24 more = 28.

## Binding duties

1. `guards` reaches `closeShift` on every path: mutant G1 (`.slice(1)` drops the guard) is killed by 4 tests where ONLY the transaction guard can refuse: a test executor that, just before the close's transaction (`SET local_state = 'closing'`), reopens the closed pallet with its boxes (`UPDATE floor_pallets SET closed_at = NULL, sscc/block_id/serial = NULL`) — codes, closed boxes, labels, open boxes all unchanged, so no other statement can refuse. Covers «Подтвердить закрытие», «Закрыть паллету и смену» and the after-label-check path, plus the "no intention kept" test.
2. Panel: exhaustive `blockerText`; mutant N1 (old «closed» words) killed; deleting `case "open_pallet"` fails typecheck (`n2-typecheck.txt`: TS2322 `'{ kind: "open_pallet"; boxes: number; }' is not assignable to type 'never'`). The test table `BLOCKED_WORDS: Record<CloseBlocker["kind"], …>` is exhaustive at type level too.
3. 2a8 discipline: queued/tracked (C3 not tracked, C4 not queued, C2 no `closeRunning`, C2b ignores the leave — all killed); re-read + `sameSummary` (C1, N3 killed; the screen test changes the pallet's boxes with `pallet_id = NULL` so only the open-pallet count differs); closed stop terminal (a scan queued behind the close meets the closed shift: REFUSED line, codes unchanged); done texts «…закрыта на этой станции»; shift closes only with a settled pallet state (guard + blocker); early-closed pallet's label job exists before the shift can close (test asserts the `purpose='pallet'` job row `failed` while `shift_closed` is absent, then skip → `pallet_closed, pallet_label, shift_closed`).

## RED / GREEN

- RED (`red.txt`): 4 of 4 failing on the brief's tests as written (the brief's tests expect «Смена OCT26-004 закрыта» and click reasons raw; see adaptations). RED of the final 28 against the pre-change sources (`red-final.txt`): 22 failed, 6 passed (the 6 pass by design: no-pallet panel table rows, `sameSummary` equalities, brief test 3 "empty pallet does not hold the close" that the brief itself says passes before).
- GREEN: new file 28/28; delayed-`setImmediate` stand (3 ms) on close-pallets, close, pallets, print, screen, exceptions: 6 files, 281 passed (stand files deleted); verbose run of the new file: 0 `stderr |`.
- Full package: `Test Files 121 passed`, `Tests 3695 passed` (Task 5 fix left 120 / 3667; +1 file, +28 tests; plan scratch numbers 117 / 2704 belong to another tree). typecheck, lint, build clean. Prettier gate live-proved by a mis-formatted scratch file (exit 1, deleted); changed files "All matched files use Prettier code style!". `git diff --check` clean; `grep '\u04'` only `pairing-code.ts:66`.

## Mutants (one line each; originals in `final/`, restore = copy back + `touch`, `cmp` silent, sha256 before = after for every row: ShiftClosePanel `508d329f…`, WorkScreen `f9b5d3a8…`; every `restored` True in `mut-result-all.json`; each ran the new file)

| Mutant                                                    | Killed by (count)                                       |
| --------------------------------------------------------- | ------------------------------------------------------- |
| G1 finishClose drops `guards`                             | 4: the three guard-only refusals + "keeps no intention" |
| P1 pending close never set (brief M1)                     | 5                                                       |
| P2 afterLabel ignores the leave                           | 1: leave began while the pallet label was decided       |
| P3 pending not cleared                                    | 1: later box label's decision must not close            |
| P4 afterLabel sets no close stop                          | 3                                                       |
| P5 afterLabel not busy                                    | 1: «Закрываем смену…» during the held close             |
| C1 pallet close skips sameSummary                         | 1                                                       |
| C2 no `closeRunning`                                      | 1 (double press, `gate.pending() == 1`)                 |
| C2b ignores the leave                                     | 1                                                       |
| C3 not tracked                                            | 1                                                       |
| C4 not queued                                             | 1 (queued scan meets the closed shift)                  |
| F2 label stop does not set pending                        | 5                                                       |
| T1 / T2 / T3 afterLabel words never shown / set / cleared | 1 / 1 / 1                                               |
| R1 no refocus after a pallet stop                         | 2                                                       |
| N1 open_pallet said as closed                             | 2                                                       |
| N2 delete `case "open_pallet"`                            | typecheck fails (TS2322 to `never`)                     |
| N3 sameSummary ignores pallet boxes                       | 2                                                       |
| N4 capacity null not a fallback                           | 1                                                       |
| N5 button closes the shift only (brief M2)                | 13                                                      |
| N6 button keeps the plain label                           | 18                                                      |
| N7 busy words always the shift                            | 1                                                       |
| N9 no «what the press does» line                          | 1                                                       |
| N10 open pallet always blocked view                       | 19                                                      |
| N11 confirm button not floor size                         | 1                                                       |
| N13 question swaps the counts                             | 18                                                      |

Equivalent / not killed: dropping `if (closed === "stopped") return;` in `confirmPalletClose` — the following `finishClose` is refused by `closeShift`'s own blocker and the resulting summary is not shown (stop is not `close`), so it is observably the same; kept as the explicit stop.

## Anchor adaptations (the real tree differs from the plan's scratch)

- Brief tests expect `findByText("Смена OCT26-004 закрыта")`; the real closed title is «Смена OCT26-004 закрыта на этой станции» (addendum). Brief tests click the reason with raw `fireEvent` right after the summary appears; the real panel ignores a press for `VIEW_GUARD_MS` after a view change, so the reason is chosen with `work.press(...)` (advances the label clock).
- Brief WorkScreen fragments 3–9 do not match: the real screen has no `labelStep`/`closeSteps` memo, `check`/`decide` call `settleSafely` then `closeBox`/`settlePalletSafely` (replaced by `afterLabel()` after that `settleSafely`), `confirmClose` has its own read-back catch (now `closeFailed`), and the `Stop` `close` has `waitingSscc`/`attempt` (brief's `finishClose` set a stop without them; the real one goes through `showSummary`). `finishClose` passes the guard unconditionally (not only when `pallets !== null`): harmless for a shift without pallets and removes a branch the guard test would have to kill.
- Brief panel fragment 6 (`)}` before the actions) does not exist; the question Alert sits just above the actions. The brief's `<p role="status">` became an `Alert role="presentation"` (the panel lives in the work screen's polite region).
- Beyond the brief: `closeAfterLabel` words, busy words «Закрываем паллету и смену…», `sameSummary` open-pallet boxes, refocus after pallet stops, `closeFailed`/`readSummaryNow` extraction.

## Self-review / concerns

1. The intention to close is not kept after a pallet stop (no serial, invalid serial then «Повторить», label error dismissed to a system error): the operator presses «Закрыть смену» again (ВЦ3). After `pallet_failed` → «Повторить» the pallet closes but the shift stays open (tested).
2. `invalid_serial` in the early close remains the Task 5 `pallet_failed` stop with «Повторить» (it does not auto-retry like the full-pallet path); it is a recoverable stop, not a system error. If "never a stop of the line" was meant literally for this flow, `closePallet` needs the `PALLET_SERIAL_TRIES` loop — a Task 5 behaviour change I did not make.
3. `pendingClose` lives in the screen (ref): leaving the shift with the pallet label waiting drops it, by design.
4. Not exercised: Windows, printers, real browser/touch (64 px only checked as the `mk-btn--floor` class), the host.
5. Old office suites time out under load only in other runs; none did in the final full run.

## Files

Modified: `apps/standalone/src/floor/close/ShiftClosePanel.tsx`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`. Created: `apps/standalone/test/floor-work-close-pallets.test.tsx`.

---

# plc Task 6 — fix report (review Important 1 + Minor 1 / R13)

Status: DONE_WITH_CONCERNS. Commit `22d65cb09` fix(standalone): an intention to close the shift ends with its pallet's label (worktree /tmp/claude/wt/flr, on top of 16ea9530d). Tree clean. Evidence in `/tmp/claude/impl-plc-t6fix/` (red.txt, red-all.txt, green1/2.txt, mut.py, mut-result.json, verbose.txt + verbose-stderr.txt (0 bytes), delay.txt, full.txt, typecheck*/lint*/build/prettier*.txt, orig/, final/). No Rust touched.

## The fix (WorkScreen.tsx only)

- `pendingClose` is `{ reason, shown, jobId }`; `confirmPalletClose` sets `jobId` from the label stop that `closePallet` left (the pallet's own new job).
- `setStop` drops the intention whenever the next stop is non-null and is not the label stop of `jobId`: a system error (any, including one after a write that committed but lost its answer), another label (another pallet's, a box's), a close/exceptions stop. `null` keeps it: that is the decision of the label, which `afterLabel` reads next. The same label shown again (e.g. «Напечатать снова» that failed again) keeps it.
- The `check` and `decide` stale/unresolvable branches drop it explicitly (the label may be shown again with the same id, still waiting).
- `afterLabel`'s pending path re-reads the summary and compares `sameSummary({ ...shown, blocker: null }, fresh)` before `finishClose`; a difference shows the summary with «stale» (a shift found closed is the closed stop, via `showSummary`). A failed re-read goes to `closeFailed(shown)` (mirrors `confirmClose`).
- «Смена закроется…» shows only while the intention stands, which now means only over its own label.

## RED / GREEN

- RED (`red.txt`): the reproduction test (review's scenario: capacity 2, box 1, verify on; pallet job moved to `verified` under the screen → check stale → another pallet fills, its label fails → skip ×2) failed on 16ea9530d with `AssertionError: expected [ 'box_closed', 'pallet_closed', …(5) ] to not include 'shift_closed'`.
- All new tests against the pre-fix WorkScreen (`red-all.txt`): 7 failed / 31 passed of 38 (the 3 new ones that pass pre-fix pin existing guards or are mutant killers: leave, read-failure, R13).
- GREEN: new file 39/39; close-pallets + close 96/96; verbose run 0 bytes stderr, 0 `stderr |`; delayed-`setImmediate` stand (3 ms) on close-pallets, close, pallets, print, screen, exceptions: 6 files, 292 passed (stand files deleted); full package `Test Files 121 passed`, `Tests 3706 passed` (was 121 / 3695: +11 tests). Load average ~100.
- typecheck, lint, build clean (re-run after prettier). Prettier gate from the worktree root: «Checking formatting… All matched files use Prettier code style!» on both files; proved live with a mis-formatted `apps/standalone/test/zz-probe.ts` (exit 1, deleted). `git diff --check` clean; `grep '\u04'` only `pairing-code.ts:66`.

## New tests (11, `test/floor-work-close-pallets.test.tsx`)

Describe «an intention to close that outlives its pallet's label never closes the shift»:

1. the reproduction (another pallet's label after a stale pallet check): no `shift_closed`, «Смена закроется…» never said over the other label;
2. stale check, label still waiting (job failed under the screen) → shown again without the words; its skip closes nothing;
3. unresolvable check (`checkLabel` wrapped by a file-level `vi.mock` that throws `UnresolvableJobError` once when armed) → same check shown without the words; its verification closes nothing;
4. stale decision (attempts bumped under the screen) → «Состояние этикетки изменилось…», no words; the next skip closes nothing;
5. system error on the decision with nothing written → «Понятно» → same label, no words; its skip closes nothing;
6. system error after the decision was written and its answer lost → «Понятно» → work resumes; a later box label's check closes nothing;
7. another label takes the screen after the pallet's decision (a box job failed under the screen) → no words over it; its skip closes nothing;
8. leave begun while the pallet's label stands → nothing decided or closed;
9. numbers changed while the label waited (a code deleted under the screen) → «stale» summary with «Подтвердить закрытие», nothing closed;
10. the summary cannot be read again after the label → «Не удалось записать закрытие…», no system error, nothing closed;
11. Minor 1 / R13: «Напечатать снова» fails again → the label panel and «Смена закроется…» stay, nothing closes; then the skip closes the shift (happy path still closes).
    The happy paths (existing «waits for the pallet's label to be checked…», «…closes the shift once the label is skipped», «says the shift is being closed…») still pass.

## Mutants (one line each on the committed WorkScreen; `mut.py`; run against close-pallets + close (96 tests); after each: copy back + touch, `cmp` equal, sha256 `011ad892…1a74` before = after, every `restored` true in `mut-result.json`)

| Mutant                                                                                                                                                                                            | Killed by                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| K1 `setStop` keeps the intention over any other stop (line removed)                                                                                                                               | 3: system error nothing written; system error answer lost; another label after the decision |
| K1b `setStop` drops only on a non-label stop (ignores the job id)                                                                                                                                 | 1: another label after the decision                                                         |
| K1c `setStop` drops on `null` too                                                                                                                                                                 | 32 (every pending-close path)                                                               |
| K0 intention keyed to no job (`jobId: ""`)                                                                                                                                                        | 1: R13 test (re-shown same label)                                                           |
| K2a check's moved branch keeps the intention                                                                                                                                                      | 2: stale check, unresolvable check                                                          |
| K2b decision's moved branch keeps the intention                                                                                                                                                   | 1: stale decision                                                                           |
| K4 `afterLabel` skips the re-read comparison                                                                                                                                                      | 1: numbers changed while the label waited                                                   |
| K4b compares with the pallet blocker kept (`sameSummary(shown, fresh)`)                                                                                                                           | 30                                                                                          |
| K5 failed re-read thrown (system error) instead of `closeFailed`                                                                                                                                  | 1: summary cannot be read again                                                             |
| R13 (review Minor 1) `afterLabel` runs over a standing stop                                                                                                                                       | 1: R13 test                                                                                 |
| None survived. Note: under K1c/K4b some panel-only tests at the end of the file also fail (cascade from failed screen tests left running); irrelevant to the kill, the suite is clean when green. |

## Self-review / concerns

1. The intention is dropped also when the pallet's label was decided but another label then takes the screen (test 7): the operator presses «Закрыть смену» again. Conservative by design (ВЦ3: the intention is not kept across stops).
2. Test 3 uses a file-level `vi.mock` of `print-resolution.js` (a pass-through wrapper of `checkLabel`, armed per test) because an unresolvable check is unreachable through the real flow (the scan routes to the check only when the stop's job awaits a check).
3. Tests 2, 4, 6, 7, 9 change rows under the screen (job state/attempts, a code) to stand for a moved label or changed numbers, as earlier tests of this file do.
4. Other review Minors (2–5) untouched as instructed. Not exercised: Windows, real printers, browser/touch.

## Files

Modified: `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/test/floor-work-close-pallets.test.tsx`.
