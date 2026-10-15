# 2a8 Task 4 report — the close summary on the work screen

Status: DONE_WITH_CONCERNS. Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `43bec1122`.
Commit: `564cffa1f` feat(standalone): the close summary on the work screen — plan, fact, boxes, the six reasons, never held (one trailer; `git status --short` empty after).
Evidence: `/tmp/claude/impl-2a8-t4/` (RED `red.txt`, GREEN `g7.txt`, mutation driver `mutate.py`, results `mut-run1.txt`, `mut-run2.txt`, snapshots `before/`).

## 1. What I did

Files: `src/floor/close/ShiftClosePanel.tsx` (new), `src/floor/work/WorkScreen.tsx`, `src/app/shell.css`, `src/i18n/ru.json`, `test/floor-work-close.test.tsx` (new, 51 tests; brief: 7), `test/floor-work-screen.test.tsx` (button count 4 -> 5: the new «Закрыть смену»).

- `Stop` += `close` (`summary | null`, `note`, `waitingSscc`) and `closed` (`record: ClosedNumbers`). Button «Закрыть смену» (`data-action="close-shift"`, disabled while any stop stands or the floor leaves).
- `openClose`: refuses while leaving or over a stop, clears the plan-reached notice, sets the `close` stop at once, and reads the summary as a QUEUED, TRACKED job (a scan pressed before is written first and counted).
- `confirmClose` (queued, tracked, one at a time via `closeRunning`, nothing once leaving): re-reads the summary in the turn and compares it with the one SHOWN (`sameSummary`); a different one is shown instead with the stale note (never closes on numbers the operator did not see — the model alone only compares with its own read); then `closeShift`. `closed` -> `onRecorded` + closed stop; `reason_required` / `stale` / non-closed `blocked` -> summary read again with its note; `blocked/closed` or a shift found `closing` in the fresh read -> closed stop (no `onRecorded`: this screen wrote nothing); a thrown write -> summary re-read: closed -> closed stop (answer lost after commit) + `onRecorded`; otherwise failed note, showing the numbers read after the failure (or the old ones when the read fails too).
- Closed stop is terminal: scans refused visibly, audibly (error tone) with their own text «Скан не принят: смена закрыта на этой станции.»; «К списку смен» and «Выйти из смены» never held (aria-disabled only while the floor leaves).
- `ShiftClosePanel`: shift number, product, plan, fact, deviation, closed boxes, average, plan result in words (met / short / over), what the press cannot take back, six reasons from buttons (`aria-pressed` plus a ✓ sign, not colour alone), confirm `disabled` until a reason when required; 400 ms view guard (injectable `clock`, the work screen's `labelClock`) on EVERY press incl. Back, reasons and «К списку смен»; guard restarts on loading -> summary and on each note; focus goes to the view, back to «Закрыть смену» after Back; Alerts `role="presentation"`; buttons 64 px; busy = `aria-disabled` (keeps focus), «Выйти из смены» outside the panel.
- Waiting label: the panel names it by SSCC («Этикетка короба … ещё ждёт решения») with «Перейти к этикетке» (settles through the queue; the label panel takes the screen); text without SSCC when the job cannot be read.
- Linked-hold: closed panel says «Связь с хостом остановлена…, данные уйдут позже» when `linkHeld`.

## 2. Anchor adaptations (mechanical)

- Executed `WorkScreen` names (`live.current`, `pairingOf`, `boxContextOf(live)`, `Stop.system_error.cause`): brief's `local`/`where`/`shift`/`context` replaced; `system_error` gets `cause: "read"`.
- `ru.json`: `close` block inserted between `exceptions` and `setup` (the brief's anchor continues with a `}` that I matched by meaning).
- `dismissSystemError` body extracted into `resumeWork` (shared with `toLabel`); behaviour unchanged.
- Brief tests: direct `fireEvent.click` replaced by `work.press` (the 400 ms guard); `fact()` scoped to the summary region (the work screen has its own «План»).

## 3. Deviations from the brief (each tested, each killed by a mutant)

1. Texts per the dispatch: «Смена … закрыта на этой станции» / «Смена закрыта на этой станции. Данные будут отправлены автоматически.» (brief: «закрыта»). Own scan refusal text for the closed stop (brief reused «работа остановлена — ответьте на сообщение»).
2. `ClosedNumbers` (`actualQty`, `closedBoxCount`) instead of a full `ShiftClosedFact` in the closed stop, because a shift found closed after a lost answer has no record in hand.
3. Back is also offered while the summary loads (waiting behind a slow write), and the summary never reappears after Back.
4. Plan result line, irreversibility sentence, ✓ sign, screen-level sameness check, label SSCC + «Перейти к этикетке», link-held note: beyond the brief (dispatch integrity list).
5. `toLabel` has no stop re-check (nothing can set another stop while the summary is up; an unreachable guard was removed).
6. The brief's M-list is subsumed (M1 = W1, M2 = P3, M3 = W10, M4 = P2, M5 = W15).

## 4. RED / GREEN

- RED: `red.txt` — `Failed to resolve import "../src/floor/close/ShiftClosePanel.js"`, no tests.
- GREEN: `vitest run test/floor-work-close.test.tsx` -> 1 file, 51 tests passed (verbose: `stderr |` count 0).
- Delayed-`setImmediate` stand (3 ms) on `floor-work-close`, `floor-work-screen`, `floor-work-exceptions`, `floor-work-print`: 4 files, 215 tests passed, stderr 0; the stand's two files deleted (`git status` clean).
- Full package (`--testTimeout=60000 --hookTimeout=60000`): 114 files, 3488 tests; 3487 passed, 1 old office timeout under load (`template-defaults-page`: "asks for the category, the purpose and the template…"), green alone (54 tests). Before the task 113 / 3437 (Task 3 fix round) -> +1 file, +51 tests; plan: file 7 tests, after Task 4 = 110 files / 2625 on the scratch copy.
- Gates: typecheck 0, lint 0 (one `no-useless-assignment` found and fixed), build 0, `git diff --check` clean, `grep -rnF '\u04'` only `pairing-code.ts:66`, no `console.*`. Prettier gate live-proved: probe `src/zz-prettier-probe.ts` flagged (exit 1) with the real files in the same command, which also showed 3 of my files unformatted -> `--write` -> all 6 files clean.

## 5. Mutants (driver `mutate.py`; each restored by `cp` from `before/`, `cmp` + sha256 compared, `touch`ed; no RESTORE-FAILED)

68 mutants; first pass left 4 survivors, tests added, re-run: all killed. Summary by group (first failing test):

| group                                                             | mutants                                                                                               | killed by                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| view guard (P1, P1b-g)                                            | guard removed; `<=`; 399 ms; closed panel unguarded; never restarts; note/loading not in view         | double tap, 399/400 ms, tap on new summary after stale, tap after a long read     |
| busy (P2, P2b, W5, W6, W6b, W27)                                  | busy not held / no aria-disabled / never busy / stuck                                                 | "holds every button while the close writes", "can try again after a failed write" |
| reasons (P3-P7)                                                   | confirm without reason; reason kept when not needed; group inverted; no ✓; no aria-pressed            | first test, "drops the reason…", 64 px/✓ test                                     |
| text/figures (P8-P10, P15, P16)                                   | result line, irreversibility, average, deviation sign                                                 | first test, unit tests                                                            |
| closed panel (P11, P12, W23, W24, W29)                            | held link, leaving, clock                                                                             | keyboard/leaving, link-held, stray-tap tests                                      |
| label (P13, P14, W16, W19, W30)                                   | no button, no SSCC, no resume, unreadable job                                                         | "names the label that waits…", "says the label waits without its SSCC…"           |
| sameness (S1-S6, W7, W25)                                         | each field of `sameSummary`, check removed, fresh read skipped                                        | unit table + "never closes on numbers the operator did not see", plan-change test |
| queue/order (W1, W4, W4b, W2, W2b)                                | summary outside queue; double close; leaving; over a stop                                             | held-write tests (scan counted in record), pending==1, race/leaving tests         |
| outcomes (W8-W13, W21, W22)                                       | fresh closed, onRecorded, closed==work, lost answer, reason note, blocked/closed, failed summary/note | named tests in "in its races"                                                     |
| screen wiring (W3, W14, W14b, W15, W15b, W17, W18, W20, W26, W28) | plan notice, scan texts, button disabled, back-race, focus, read failure                              | matching tests                                                                    |

Survivors that drove tests: P1g (summary after a long read), P19 (note alert role), W15b (button disabled by `leaving` alone), W21 (numbers after a failed write).

## 6. Dispatch checklist

- closeShift queued + tracked: yes (W1/W4 killed). Held-write test that a scan pressed before the press is in `actualQty`: "puts the scan pressed before «Закрыть смену» into the record". Panel terminal: scan after close refused; reprint on a closed shift unreachable (exceptions button disabled at the closed stop).
- Waiting label named, operator sent to the label panel; print-failure states reached via the label panel.
- N9 (track before start, nothing once leaving), N12/N13 (queue), operator always has a way out, `closing`/`closeRunning` released in `finally`.
- Leave / idle lock / removed operator / line change are FloorApp-level and wait for the gate; a closed screen has no pending work, so they proceed. `online=false` and `linkHeld` tested.

## 7. Concerns

1. A held refusal (device refused / other host) still waits until the operator leaves the closed shift: `FloorApp` is told of work only via `work_left` on leave. Releasing it at the close would need a prop/FloorApp change (Task 5/6 territory); the closed panel says the data goes later when `linkHeld`.
2. `closeShift` compares against its own read, not the shown summary; the screen-level check closes that, leaving only a millisecond window between the screen's read and the model's read (still guarded by the model's write checks).
3. A shift found `closed` with no copy at all (impossible while the screen is open) would read as closed with zeros.
4. Receipt (`closing` -> `closed`), list refresh and `officeClosed` are Tasks 5/6.
5. Not exercised: real touch/gloves, screen reader, WebView2; no Rust touched. One old office suite timed out under load in the full run (green alone).
