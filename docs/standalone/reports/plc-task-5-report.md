# plc Task 5 report — the work screen of a shift with pallets

Status: DONE_WITH_CONCERNS. Commit `5351d835c` feat(standalone): the work screen of a shift with pallets — the pallet's boxes, its early close, its label after the box's (worktree /tmp/claude/wt/flr, BASE e033e522a). Tree clean after the commit. Evidence in `/tmp/claude/impl-plc-t5/`. No Rust touched, so no cargo run.

## What was done

- `WorkScreen.tsx`: «Паллета — N из M коробов» line; the box close carries `palletStep` (`[box label, ...props.closeSteps, palletStep]`); `settleLabel` loops over prepared jobs (box, then pallet) and stops at the first that waits; `settlePallet` (+`closeFullPallet`, `settlePalletSafely`) closes a full pallet on box close, entry, after a label decision and when serials arrive; `closePallet` (early close) with `confirm_pallet` / `pallet_no_serials {reason}` / `pallet_failed` stops; pallet serial supply (extension 1) with its own half rule on entry, link back and after each box; reprint of a pallet label from the snapshot's pallet layout; `closeSettled` made generic.
- `LabelPanel.tsx`: pallet words (SSCC, failed title, unassigned printer, check body, mismatch, not-SSCC, skip body, plus an extra reason hint «на паллете должна остаться одна»).
- `ru.json`: all brief keys plus mine (`palletWaits.invalid`, `palletNoSerials.held`, `palletsMissing.*`, `print.pallet.reasonHint`).
- `test/support/pallets.ts`: `boxCapacity` option. `test/floor-work-pallets.test.tsx`: brief's 5 + 20 more.

## Addenda duties

1. `shiftPallets` null with `palletsEnabled` = new stop `pallets_missing` from the first render (state and ref start in it), entry effect returns before recovery/close, no scan taken, no pallet line/button. Tested with a FULL open box present (it must not close without its pallet).
2. `settlePallet` runs `closePalletIfFull`; `invalid_serial` is retried (each call loses one bad serial) up to `PALLET_SERIAL_TRIES = 3`, then the pallet waits with its own message («Номер SSCC паллеты не подошёл и пропущен»), never a stop. `palletStep`'s left-open full pallet heals the same way. Early close keeps `invalid_serial` → `pallet_failed` + «Повторить» (brief).
3. Rival open pallet / any failed pallet write inside the box close surfaces as the existing `close_failed` (write) stop with «Повторить»; the box stays open, nothing written (tested with a failing `INSERT INTO floor_pallets`).
4. `ShiftClosePanel` NOT touched (Task 6's file): its non-exhaustive ternary still renders `open_pallet` as «closed»; Task 6 must fix it AND pass `openPalletGuard` to `closeShift` (today `closeShift(boxContextOf(live), reason)` has no guards).
5. A waiting pallet label is a `label` stop like a box label: «Исключения» and the early-close button are disabled while it waits (tested), and `labelWaits()` (any purpose) already refuses reprint/disassemble in `exception()`. Task 7 must call `labelWaits()`/run through `exception()` for pallet disassembly; map errors on the CLASS (`PalletTemplateChangedError` before `PalletUnavailableError`).
6. Every pallet write runs in the queue and is tracked: `closePalletNow` = `track(queue.run(...))`; link-back effect = `track(Promise.resolve().then(topUp)…track(queue.run(...)))`; `settlePallet` only inside queue turns. The early close refuses once the floor is leaving (`leavingNow`).

## Anchor adaptations (the real WorkScreen differs from the plan's scratch)

- The real screen has no `labelStep`/`palletContext` useMemo/`closeSteps` memo: `closeSteps` is a floor-supplied prop and the box label step is built in `attemptClose`; the pallet step is appended there from `live` (`palletContextOf`). `Live` gained `pallets`; `blockContextOf(live, extension)` gained an extension argument (box supply 0, pallet supply 1) instead of the plan's `createBlockSupply({…})` object.
- The brief's `settleLabel` fragments (`recoverInterruptedJobs` inside, `live.current.onRecorded()` after a send) do not match: the real one has no recovery (entry does it once) and sends write no record; loop added to the real shape, with a stale-same-job guard (`job.id === first.id` → show, never loop). The redundant `isOpenJob(job)` break of the brief was dropped (the re-read returns the same waiting job; mutant would be equivalent).
- Real code has no `closeIfFull`/`CloseResult` import cleanup to do; `closeSettled` generic is `Result extends {kind} | null`.
- Pallet/early-close/pallet-waits alerts live inside the polite region with `role="presentation"` like the other stops; the confirmation is a `work-screen__confirm` block outside it, like `confirm_close`.
- LabelPanel real alerts have no `role="alert"` on notes (fragment 5/6 adapted without it).
- Beyond the brief: decisions on a label (`check` verified, `decide`) now call `settleLabel` so the next prepared label (pallet's) goes, and `settlePalletSafely` (a pallet that waited closes once the label stops are cleared); focus handling (`palletRefocus`, confirmation focus); `linkHeld` words for pallets; `pallets_missing`; honest `invalid` waits message. I dropped my first idea of a `resumeWork` settlePallet (no test needed it).

## RED / GREEN

- RED (`red.txt`): 5 of 5 failing, first «Unable to find an element with the text: Паллета … 'dt'», as the brief predicts.
- GREEN: `floor-work-pallets.test.tsx` 25 passed (brief 5 + 20); work-screen suites (`close`, `exceptions`, `print`, `screen`, `pallets`) 226 passed before the extras. Full package: `Test Files 120 passed`, `Tests 3660 passed` (Task 4 left 119 / 3635; +1 file, +25 tests; plan scratch numbers 116 / 2700 are another tree), stderr 0; verbose run of the new file: 0 `stderr |`.
- Delayed-`setImmediate` stand (3 ms) on `floor-work-pallets`, `floor-work-print`, `floor-work-close`: 137 passed; stand files deleted.
- typecheck, lint, build clean; prettier gate live-proven (mis-formatted scratch failed, deleted; changed files pass with «Checking formatting…»); `git diff --check` clean; `grep '\u04'`: only `pairing-code.ts:66`.

## Mutants (restore: copies in `orig/`, `cmp` silent and sha256 before = after: WorkScreen `bf53342a…`, LabelPanel `1affebf0…`; `mut.py`, `mut-all.txt`, `mut-result.json`; each ran the 5 work-screen files; every row restored=True)

| Mutant                                                                                                  | Result (tests failing)                                |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| M1 (brief) re-read replaced by `break` in `settleLabel`                                                 | killed (3)                                            |
| M2 (brief) early close enabled on empty pallet                                                          | killed (1)                                            |
| M3 (brief) box close without `palletStep`                                                               | killed (19)                                           |
| M4 (brief) panel says box words for the pallet check                                                    | killed (2)                                            |
| M5 (brief) link back asks the box supply                                                                | killed (3)                                            |
| N1 no initial `pallets_missing` stop                                                                    | killed (1)                                            |
| N2 entry guard on `pallets_missing` removed                                                             | killed (1)                                            |
| N3 stale same job not shown but sent round                                                              | killed (2)                                            |
| N4a/N4b `PALLET_SERIAL_TRIES` 2 / 4                                                                     | killed (2 / 1)                                        |
| N5 invalid serial not retried                                                                           | killed (2)                                            |
| N6 entry does not settle the pallet                                                                     | killed (1)                                            |
| N7 early close keeps the waits message                                                                  | killed (1)                                            |
| N8 no-serials reason always `failed`                                                                    | killed (2)                                            |
| N9 `closeSettled` never retries stale                                                                   | killed (2)                                            |
| N10 early close ignores the leave                                                                       | killed (1)                                            |
| N11 no focus on the pallet confirmation                                                                 | killed (1)                                            |
| N12 focus not back on the pallet button                                                                 | killed (1)                                            |
| N13 reprint with the box layout                                                                         | killed (1)                                            |
| N15 verified check does not let the next label go                                                       | killed (2)                                            |
| N16 label decision does not let the next label go                                                       | killed (1)                                            |
| N17 / N17b decision / check does not settle the pallet                                                  | killed (1 / 1)                                        |
| N19 after-close skips the pallet top-up                                                                 | killed (1)                                            |
| N21a link-back asks pallet serials in any shift                                                         | killed (25)                                           |
| N21b after-close always asks pallet serials                                                             | killed (16)                                           |
| N22 closeBox tail skips `settlePallet`                                                                  | killed (4)                                            |
| N23–N29 panel: SSCC words, failed title, unassigned printer, mismatch, not-SSCC, skip body, reason hint | each killed (1–2)                                     |
| N30 waits message `invalid` body                                                                        | killed (1)                                            |
| N31 `held` words for the pallet stop                                                                    | SURVIVED → test added («…link is held off…») → killed |
| N32 open pallet never read for the line                                                                 | killed (10)                                           |

Not mutated (unreachable from the screen, defence in depth, as in the brief): `closePallet`'s «a label waits → settle, stopped» and `empty` answers (the early button is disabled while a stop stands or the pallet is empty).

## Concerns

1. **Task 6 must** pass `openPalletGuard` on every `closeShift` path and make `ShiftClosePanel`'s blocker ternary exhaustive; until then a shift with pallets can be closed with an open pallet and the panel mislabels `open_pallet`.
2. `pallets_missing` also disables «Закрыть смену» (any stop does): a shift with a broken copy can only be left, not closed here. Unreachable today (host always sends both; old snapshots are refused by the entry check).
3. `settlePallet` asks the host (up to 2 × 10 s, in the queue) on every box close while a full pallet waits for serials and the link is up, like a box close waiting for box serials.
4. After three lost serials in a row (a whole run of held SSCCs) the pallet waits with the «не подошёл» message and heals on the next close; no stop.
5. Not exercised: Windows, printers, real browser, the host. Task 7 inherits: disassembly must go through `labelWaits()`/`exception()`.

## Files

Modified: `apps/standalone/src/floor/print/LabelPanel.tsx`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/support/pallets.ts`. Created: `apps/standalone/test/floor-work-pallets.test.tsx`.

---

# plc Task 5 — fix report (review Important 1 and mutants A, B, C, H)

Status: DONE. Commit `789986485` fix(standalone): the work screen's «pallet full but not closed» message follows the pallet it speaks of (worktree /tmp/claude/wt/flr, BASE 5351d835c). Files: `apps/standalone/src/floor/work/WorkScreen.tsx` (+8/-2), `apps/standalone/test/floor-work-pallets.test.tsx` (+7 tests). No Rust. Evidence: `/tmp/claude/impl-plc-t5fix/` (red.txt, mut.py, mut-final.txt, mut-result-*.json, delay.txt, full.txt, orig/).

## Fix

`palletWaits` keeps its value but is no longer shown as such: the render derives `palletWaitsNow = pallet !== null && pallets !== null && pallet.boxCount >= pallets.capacity ? palletWaits : null`, where `pallet` is what `refresh` reads. So the alert disappears as soon as the open pallet is null (closed in the box's own transaction), or holds fewer boxes than the capacity (a box taken off). I chose derivation over keying to the pallet id: a first version with the id (and an extra read in `settlePallet`) had a guard no reachable flow can kill (a stale waits state is always overwritten by `settlePallet` before a scan could create another full pallet), so I dropped it and the extra queue read.

## RED

`red.txt`: `vitest run test/floor-work-pallets.test.tsx -t outlive` — 2 failed, 1 passed (the keep test): both on `expected <span> to be null` for «Паллета заполнена, но не закрыта», after the preceding assertions (outbox kinds, «0 из 1 коробов») held. GREEN: 28 passed, then 32 after the A/B/C/H tests.

## New tests (7)

- «the pallet-waits message cannot outlive…»: (1) block arrives, next box closes and fills the waiting pallet in its own transaction under a verify stop (kinds `box_closed, box_label, box_closed, pallet_closed`), no alert; (2) a disassembly (direct `disassembled_at` poke, as Task 7 will write) takes the waiting pallet 2 → 1 of 2, no alert; (3) the alert stays while the same pallet waits full (2 из 1).
- «the pallet's early-close button and the full pallet's retries»: A) label stop standing with a box on the pallet (1 из 40) → early close disabled; B) `rerender({ leaving: true })` → disabled; C) online host answers the pallet block a moment after the box's close (entry attempt fails) → `box_closed, pallet_closed` in the same turn; H) the first pallet-close UPDATE answers `changes_mismatch` (stale) on entry → closed on the second attempt, `moved === 2`.

## Mutants (each: copy in orig/, restore by cmp + sha256 before = after `b5fa512d…f710b` for WorkScreen.tsx; test file untouched by mutation; every row restored=True)

| Mutant (one line)                                                  | Result                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A early-close `disabled` drops `stop !== null`                     | killed (1): «keeps the early close away while a label stop stands…»                                                                                                                                                                                                                                                          |
| B early-close `disabled` drops `leaving`                           | killed (1): «…once the floor has begun to leave…»                                                                                                                                                                                                                                                                            |
| C `settlePallet`: `supplied.kind === "stored" && false` (no retry) | killed (1): «closes the full pallet in the box's own turn when the host hands the pallet serials…»                                                                                                                                                                                                                           |
| H `closeFullPallet` attempt without `closeSettled`                 | killed (1): «closes the full pallet again when its first close finds the pallet moved on»                                                                                                                                                                                                                                    |
| W0 `palletWaitsNow` = `palletWaits` (old behaviour)                | killed (2): fill-close scenario and disassembly                                                                                                                                                                                                                                                                              |
| W2 count guard `boxCount >= 0`                                     | killed (1): disassembly                                                                                                                                                                                                                                                                                                      |
| W3 shown when `pallet === null`                                    | killed (1): fill-close scenario                                                                                                                                                                                                                                                                                              |
| W6 `settlePallet` no longer clears the state when nothing waits    | SURVIVED, equivalent: the derived guard already hides it whenever the pallet is closed or below capacity; a still-full open pallet always answers closed/no_serials/invalid, and a `stale` exhaustion still describes a pallet that is full and unclosed. Kept as the explicit clear (cheap, mirrors `closePallet`'s clear). |

B and A were the reviewer's "redundant UI / untested guard" survivors; B is a real (small) guard because without it the confirmation can open while the floor is leaving.

## Gates

- Focused `floor-work-pallets` verbose: 32 passed, 0 `stderr |` lines. Delayed-`setImmediate` stand (3 ms) on pallets, print, close, screen, exceptions: 5 files, 253 passed; stand files deleted.
- typecheck, lint, build: exit 0. Prettier gate (repo root, repo-relative, `--ignore-path .prettierignore`): live-proved by a mis-formatted scratch (exit 1, deleted), changed files "All matched files use Prettier code style!". `git diff --check` clean; `grep '\u04'`: only `pairing-code.ts:66`.
- Full package Vitest: 120 files, 3667 passed (3660 + 7 new), no timeouts. `git status --short` empty after the commit.
- Not run: Rust (untouched); no browser/Windows/printer.

## Concerns

- Other Minors (in-queue pallet top-up wait, wording, title, restart sequencing test, Task 6/7 carry-overs) intentionally untouched, as asked. The Task 6 addendum (mutant that drops `guards`) still stands.
- The disassembly test pokes `floor_boxes.disassembled_at` directly, since the screen's disassembly (Task 7) does not exist yet; revisit when Task 7 lands.
