# 2a7 Task 6 report - the work screen's printing

Commit `4957ff967` feat(standalone): the work screen prints each box's label, stops at a label that waits and checks it by a scan; awake while open (branch claude/floor-2a7, base 0248b0ddc). One Co-Authored-By line, tree clean after the commit. Scratch only under /tmp/claude/impl-2a7-t6. Webview only (no Rust, host, proto, manifests).

## What was done

- `src/hardware/awake.ts` (verbatim from the brief): `createSystemAwake`, hold with generation, calls in order, reset at start.
- `src/floor/print/LabelPanel.tsx` (rewritten from the brief's, see below), `WorkScreen.tsx` (adapted by meaning to the executed 2a6 screen), `FloorApp.tsx`, `App.tsx` (one print runtime and one awake per app; `awake.reset()` at start), `shell.css`, `ru.json` (`floor.print.*`, `floor.work.systemError.label`).
- Tests: `awake.test.ts` (4, brief), `floor-work-print.test.tsx` (brief's 15 + 29 more = 44), one test in `app.test.tsx`, prop plumbing in `floor-app.test.tsx` and `floor-work-screen.test.tsx`.

## How the work screen holds print integrity

- The box's label job is a close step: `attemptClose` passes `[boxLabelStep(...), ...props.closeSteps]` to `closeOpenBox`, so the job is written by the box's own transaction (later plans' steps still follow, tested).
- `settleLabel` (only from the work queue, after every close, on entry and after a dismissed message): reads the shift's open job; a job still `prepared` is sent once (its first send, N9: the whole turn is already `track`ed because every `closeBox` caller is a tracked queue job); `unknown`/`failed`/`sent`+verify stop the line with the panel. Nothing sends an `unknown` job: only `printAgain` (operator, reason when the label may exist) does.
- App restart mid-print: `recoverInterruptedJobs` runs ONCE, on entry, in the entry job before `settleLabel` and before anything of the screen sends (N13). Not in `settleLabel`. A recovery failure stops the line (label message) and sends nothing.
- N12: (a) a box read back after a thrown close (existing `unsure`) now has its label settled in the same turn; (b) `attemptClose`'s `empty` case re-reads the closed box (`readClosedBox`) and goes on as `closed`, so a close committed but reported as lost/stale does not skip the label. Both tested with a one-line mutant.
- N13: every decision (`checkLabel` happens inside the queued scan job; skip/printed/print again via `decide`) runs `track(queue.run(...))`; `settleLabel` is serialised through the queue; a second press while one runs, and any press after the leave began (`leavingNow()`), do nothing. A scan arriving during a held decision is queued behind it.
- A rejection of the first send: a stale one re-reads the job; any other failure stops the line with "Состояние этикетки не прочитано" and its dismissal re-reads the job (a job left `sending` shows a neutral "отправляется" panel with no actions; the next entry reads it as `unknown`). The program never sends it again.
- The next box does not close while a label waits: `attemptClose` reads the open job before closing (`label_waits`); scans are refused while any label stop stands. A pending label is visibly flagged by the panel (title, SSCC, reason in words, and the printer a reprint will use). After a decision (skip/verified/printed→sent without check/reprint) a box left full by a stopped station closes.
- Check scan: intercepted first in `scan`, never reaches `processScan`/the journal; mismatch/not-SSCC = words under the label + error tone + a flash that lets taps through; verified = ok tone + lit line only (no overlay, no announcement).
- `shiftLabelsSettled` is Task 4's; the screen needs nothing extra (the stop is the visible flag).

## Addenda from the dispatch

- Printer shown before a reprint is confirmed: the panel reads the settings on open and says "Печать пойдёт на принтер: …"; for a job whose own printer was deleted it says so and names the fallback (tests: chosen printer, deleted printer).
- Reason built from the buttons only: the reason view is exactly the five `REPRINT_REASONS` buttons plus "Назад" (test lists them; mutant P6).
- `printer_busy` text: "…Выберите другой принтер или перезапустите программу." (test).
- Accessibility: all panel buttons `size="floor"`; the panel sits in the screen's existing polite region with `role="presentation"` Alerts (test: no alert ancestor); notes are plain paragraphs (no nested `role="alert"`); while a decision runs buttons are `aria-disabled` (keep focus, presses do nothing, text "Этикетка отправлена на принтер…" in the region); focus moves into a new view of the panel and, after a decision, `refocus()`; no overlay for accepted/verified; refusal flashes keep `pointer-events: none` (test).

## Anchor adaptations (all mechanical or by meaning; none semantic)

The brief's WorkScreen fragments 4-14 did not match the executed 2a6 screen (no `closeBox`/`settle` text as in the brief, `Stop` has causes, `closeSteps`/`onClosed` props, `attemptClose`/`afterClosed`, `show(tone,title,detail)`, `unsure`). Applied by meaning:

1. Label step: brief put `labelStep` into `closeIfFull/closeOpenBox` args; real screen builds it in `attemptClose` and prepends it to `live.current.closeSteps` (kept as the later plans' extension point; JSDoc of `closeSteps`/`onClosed` updated: printing is NOT started from `onClosed`).
2. `settleLabel` is called from `closeBox` (after `afterClosed`) instead of the brief's `closeBox` fragments; recovery moved out of `settleLabel` into the entry job (dispatch N13).
3. Waiting-label check moved into `attemptClose` as outcome `label_waits`; `empty` re-read added (N12).
4. `Stop.system_error` got a third cause `label` (texts `floor.work.systemError.label.*`); `showLabel` leaves other stops alone.
5. `LabelPanel`: brief's panel replaced (printer line, aria-disabled buttons, focus, no nested alert roles, `loadSettings` instead of `loadPrinters`, pending/sending view for `prepared`/`sending` jobs); `FloorApp` passes `printing`, `awake`, `render` (no `onSetup`: Task 7).
6. The brief's `live.current.onRecorded()` after the first send was dropped (a send writes nothing for the host; it would have changed the 2a6 count in "tells the shell of the block that came while a close waited for it"). Decisions still call it.
7. `ru.json`: brief's print block plus `pending`, `target.*`, `printer_busy` advice; `floor.work.systemError.label`.
8. Three 2a6 tests adapted (reasons stated in comments): "stops the line when a close finds no box that was just read" (its adjacency trick now ignores the new `floor_print_jobs` read between the two reads of the open box), "goes on when the totals cannot be read after a close" (the totals' reads still fail; the label's read is allowed because an unreadable label state now rightly stops the line), and the "focus after a message" test awaits the dismissal's queued re-read (`settled()`, otherwise an un-`act`ed state update).

## RED / GREEN

- RED: the brief's tests were applied first with `awake.ts` absent: floor-app/floor-work-* failed to load (`Failed to resolve import "../src/hardware/awake.js"`), `app.test.tsx` new test failed. After writing the code everything passed first time except 3 old 2a6 tests (adaptations 6, 8 above).
- GREEN: 5 files, 299 passed (brief's 154 plus the real tree's older tests). Full Vitest (`--testTimeout=60000 --hookTimeout=60000`): 109 files / 3201 tests passed (before: 107 / 3152; +2 files, +49 tests: awake 4, work-print 44, app 1). Plan's scratch numbers (105 files / 2511) are not comparable.
- Verbose run of app/floor-app/floor-work-print/floor-work-screen/awake: stderr blocks 0 after fixing one `act` warning (see 8); delayed-`setImmediate` stand (3 ms) run of the same files: 299 passed; stand files deleted, tree clean.
- typecheck, lint, webview build: clean. Prettier gate proven live (a mis-formatted scratch file made it exit 1, deleted), then the 12 changed files pass. `git diff --check` clean. `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`.

## Mutants (harness /tmp/claude/impl-2a7-t6/mut.py; each one edit, run of the covering file, restore from copy, cmp + sha256; all `restored=True`)

All 42 killed: W1 (brief M1) auto-resend of unknown; W2 (M2) check does not take the scan; W3 (M3) next box closes while a label waits; W4 (M4) computer may sleep; W5 (M5) reset forgotten; W6 (M6) leave held at a label; W7 (M7) release ignores reset; W8 `empty` not read back (N12); W9 recovered box's label not settled (N12); W10 closed box's label not settled; W11 recovery on every settle (N13); W12 no recovery at entry; W13 decision after the leave began; W14 second press runs; W15 decision outside the queue (N13); W16 decision not handed to the gate (N9); W17 rejected send swallowed; W17b stale first send rethrown; W19 label step missing / W19b later plan steps dropped; W20 check does not close a left-full box; W21 decision does not; W22 dismissal does not re-read; W23 dismissal ignores the leave; W24 decision failure swallowed; W25 stale decision is a system error; W26 label error lost in `closeBox`; W27 recovery failure goes on; W28/W28b `showLabel` never clears / clears every stop (W28b SURVIVED the brief-style tests; test "leaves the message of the failed retry standing" added, then killed); W29 done job stops the line; W30 check error swallowed; W31 sending line missing; W32 verified scan flashes; P1 reprint without reason; P2 busy buttons act; P3 no focus move; P4 alert role kept; P5 target ignores the chosen printer; P6 reason always `other`; P7 deleted printer not told; P8 «напечаталась» offered for failed. Logs: mut1.log, mut2.log.

## Concerns

1. A job this build cannot read (`UnreadableJobError`: damaged fields/printer JSON) makes every read of the open job throw: the line shows the label system message forever (the shift is unsettled, `shiftLabelsSettled` counts it). Only leaving does not help; Task 4 chose this. Needs an owner/2b decision (quarantine or an operator-visible "damaged label" skip).
2. A job left `sending` after a rejected final write shows the neutral pending panel until the next ENTRY (recovery runs only on entry by the N13 rule); the operator must leave and return to decide. Rare (double failure).
3. A stale first send (unreachable inside the single queue; tested by injection) leaves a `prepared` job on the pending panel; the next entry sends it.
4. Leaving during a send waits up to the 20 s limit (the gate tracks the send); the "leaving…" text covers it; JSDoc bound updated.
5. `skipConfirm.body` (brief text) says the label can be reprinted «в Исключениях» - plan 2a8's screen does not exist yet.
6. Sound level is not wired (not in this task's brief; constraints mention FloorApp rereading it after settings are saved). `FloorApp` has no `onSetup` (Task 7).
7. AGENTS.md/spec notes for N25-style items (`closeSteps` after the screen's own step, recovery-on-entry rule) are Task 9.
8. The audit still does not name the former printer of a rebind (Task 5 decision); the operator sees the printer before confirming.
9. Not exercised: real printer, COM, spooler, Tauri shell, Windows/WebView2, a browser (jsdom only), screen readers.

## Fix round

Base 4957ff967 (branch claude/floor-2a7, worktree /tmp/claude/wt/flr). Commits: `def7a290d` (I1, m1), `d70161311` (m2, m3, m4; m5 and the owner/2a8/ПЛ-Ц notes). One Co-Authored-By each, tree clean after. Scratch only under /tmp/claude/fix-2a7-t6 (harness `mut.py`, `m1.py`, `m1b.py`, `m2.py`, `m2b.py`; per-mutant logs in `mut/`; originals in `orig/` and `new/`).

### What changed

- **I1** (`LabelPanel.tsx`, `WorkScreen.tsx`): every change of the panel's view goes through `show()` which stamps an injectable clock (`clock` prop, default `performance.now()`; `WorkScreen` prop `labelClock` passes it). Every press (`press()`) is ignored for `VIEW_GUARD_MS = 400` after a view change (a clock that went back does not hold the panel: `since >= 0` is required). Focus after a view change goes to «Назад» (`data-panel-back`) for reason, printers and skip views, and to the panel root (`tabIndex=-1`, `data-label-panel`) when back at the first view, so neither a reason, a printer, «Этикетка напечаталась» nor the skip confirmation sits under a second Space press. The guard covers all views, not only reason/printers: the same defect existed for «Назад» landing a second tap on «Этикетка напечаталась» or, for a failed job, on «Напечатать снова» (which sends at once), and for the skip confirmation.
- **m1**: tests for the printer line on the failed job's first view and, before any press, for the deleted-printer text.
- **m2**: a job `sending` that no send of this app holds (`!printing.isInFlight`) gets the panel «Итог отправки этикетки не записан» with the single floor button «Проверить, вышла ли этикетка» (`floor.print.stalled.*`). The button is `decide(recoverStalled, false)`: tracked by the gate, run in the work queue, `recoverInterruptedJobs` then a re-read of the job (so it turns `unknown/interrupted`, and the unknown label's decisions apply). Never automatic, sends nothing. The `interrupted` text is now «Печать прервалась. Посмотрите, вышла ли этикетка.». Note: `recoverInterruptedJobs` is pairing-wide (it also moves any other dead `sending` job, as the entry does); a send the runtime holds is skipped by it.
- **m3**: no bypass; JSDoc on `UnreadableJobError` and `settleLabel` records the limit and the proposal; line in `2a7-minors.md`.
- **m4**: skip body is now «Короб уже закрыт. Без этикетки его нужно будет промаркировать позже.»; `2a7-minors.md` tells the 2a8 dispatch to restore the «Исключения» reference with a test.
- **m5**: no code; `settleLabel` JSDoc and `2a7-minors.md` (for the ПЛ-Ц dispatch).

### RED / GREEN

- RED 1 (tests first): `vitest run test/floor-work-print.test.tsx` with the new tests and the old sources: 6 failed (the changed focus test, double activation, guard run-out, printer tap, skip tap, «Назад» tap), 44 passed (`red1.txt`). m1 tests passed at once (they pin existing code; R8b below shows they bite).
- RED 2: m2/m4 tests against the HEAD sources of `LabelPanel.tsx`, `WorkScreen.tsx`, `ru.json` (swapped in, restored, `cmp` identical): 4 failed (`red2.txt`).
- GREEN: 54 passed in the file (44 before + 10 new).

### Mutants (each: one-line edit, run of `test/floor-work-print.test.tsx`, restore from a copy; all `restored=True` by sha256, and `cmp` of the three src files against `new/` copies)

| Mutant                                                | Result                                                                                                            | Killing test                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| I1a focus goes to the first button of a view          | killed                                                                                                            | moves the focus ... onto a control that sends nothing                                                                    |
| I1b first view focuses its first button               | killed                                                                                                            | same                                                                                                                     |
| I1c guard 0 ms                                        | killed (5)                                                                                                        | double activation / printer tap / skip tap / «Назад» tap                                                                 |
| I1d guard 399 ms                                      | killed                                                                                                            | takes a press again once the guard has run out, and not before                                                           |
| I1e guard never ends                                  | killed (23)                                                                                                       | most panel tests                                                                                                         |
| I1f return to the first view not stamped              | killed (2)                                                                                                        | printer tap ... decision the view before it hid; «Назад» tap                                                             |
| I1g reason view not stamped                           | killed (2)                                                                                                        | double activation                                                                                                        |
| I1h printers view not stamped                         | killed                                                                                                            | printer tap                                                                                                              |
| I1i skip view not stamped                             | killed                                                                                                            | skip tap                                                                                                                 |
| I1j «Назад» not guarded                               | killed                                                                                                            | double activation                                                                                                        |
| I1k negative elapsed (clock back) blocks              | SURVIVED first, test "is not held by a clock that went back" added, then killed                                   |                                                                                                                          |
| R8b printer line removed from the failed/unknown view | killed (2)                                                                                                        | warns that the printer of the label is gone ... (before the press); names the printer on the view of a label that failed |
| M2a stalled view for `prepared` (panel alone)         | survived, equivalent; the panel's condition was simplified to `onRecover !== undefined` so the redundancy is gone |                                                                                                                          |
| M2b check never offered                               | killed (2)                                                                                                        | reads the job again after ...; lets the operator check ...                                                               |
| M2c offered while the app still holds the send        | killed                                                                                                            | offers no check for a send this app still holds ...                                                                      |
| M2d offered for any job but `unknown`                 | killed (24)                                                                                                       | panel tests of failed/prepared labels                                                                                    |
| M2d2 offered for `failed` only                        | killed (20)                                                                                                       | same                                                                                                                     |
| M2e recovery not run                                  | killed                                                                                                            | lets the operator check ...                                                                                              |
| M2f check not handed to the gate/queue                | killed                                                                                                            | same (gate pending count recorded at the recovery)                                                                       |
| M2g check runs by itself on dismissal                 | killed (2)                                                                                                        | reads the job again ... never sends twice                                                                                |
| M2h check also sends                                  | killed                                                                                                            | lets the operator check ... (send count)                                                                                 |
| M2i old restart wording of `interrupted`              | killed (2)                                                                                                        | shows on entry as unknown ...; lets the operator check ...                                                               |
| M2j button label changed                              | killed                                                                                                            | lets the operator check ...                                                                                              |
| M2k stalled title says «напечатана»                   | killed (2)                                                                                                        | reads the job again ...                                                                                                  |
| M2l `labelClock` not passed to the panel              | killed (14)                                                                                                       | reason-view tests                                                                                                        |
| M4 old skip text restored                             | killed                                                                                                            | promises nothing the screen does not have ...                                                                            |

### Gates

`typecheck`, `lint`, `build` clean; prettier gate proven live (scratch file exited 1, deleted) and passes on the 5 changed files; `git diff --check` clean; `grep -rnF '\u04'` only `pairing-code.ts:66`; verbose run of floor-work-print/floor-work-screen/floor-app/app/awake: empty stderr, 0 `stderr |` blocks; same 5 files under the delayed-`setImmediate` (3 ms) stand: 309 passed (stand files deleted); full Vitest `--testTimeout=60000 --hookTimeout=60000`: 109 files, 3211 tests passed (before this round 3201: +10 tests, no new file). Not exercised: real printer, WebView2 touch double-tap, screen readers (the I1 tests use synchronous click events and a manual clock).

### Concerns

- The 400 ms guard also delays a legitimate fast operator's second press after a view change (e.g. «Напечатать снова» then a reason within 400 ms); accepted per the decision.
- The check button's recovery is pairing-wide (also other shifts' dead `sending` jobs), as at entry.
- m3 (unreadable job) remains an owner/2b item; m5 for ПЛ-Ц; m4 reference must be restored by the 2a8 dispatch.
