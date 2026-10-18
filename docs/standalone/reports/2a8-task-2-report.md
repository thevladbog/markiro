# 2a8 Task 2 report — the work screen's exceptions screen

Status: DONE_WITH_CONCERNS. Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `146a58e44`.

Commits (one trailer line each):

- `425e08b10` test(standalone): pin the box exceptions' reads in the shell's query-plan list and the text-parity list (the PREP commit)
- `68ba3310a` feat(standalone): the work screen's exceptions — a box by its label or the last digits, reasons, confirmations

## 1. Prep commit (2a6 addendum item 5, BOTH lists)

- `src-tauri/tests/local_db.rs::the_floors_repeating_reads_search_an_index`: array 30 -> 35, five new lines with the EXACT texts of `LAST_CODE_SQL`, `NEWEST_CODE_SCAN_SQL`, `CLOSED_BOXES_SQL`, `BOX_STATE_SQL`, `LAST_BOX_JOB_SQL` and the index each plan must name (same as Task 1's Node list). Only that test list was touched in `src-tauri`.
- `test/floor-schema.test.ts` text-parity test ("are pinned on the shell's SQLite with the status bar's and the work screen's own statements"): five constants added, `Set.size` 8 -> 13 (it requires the Rust source to hold `"<sql>"` after joining `\` line continuations).
- Shell SQLite 3.46 gave the intended plans on the first try, so no `+` trick was needed.
- Evidence: `cargo test --offline --locked ... --test local_db` 27 passed and `--test ipc` 26 passed (unsandboxed); `cargo fmt --check` clean; `floor-schema` 28 passed.
- Mutants (restored, `cmp` + shasum equal, `touch`ed): (a) Rust text `ORDER BY rowid DESC LIMIT 1` -> `ORDER BY rowid LIMIT 1` -> `floor-schema.test.ts > are pinned on the shell's SQLite with the status bar's...` FAILS; (b) Rust expected index `floor_print_jobs_shift` -> `floor_print_jobs_nothing` -> `local_db the_floors_repeating_reads_search_an_index` FAILS ("should search floor_print_jobs_nothing ...").

## 2. What I did (Task 2)

Files: `src/floor/exceptions/ExceptionFlow.tsx` (new), `src/floor/work/WorkScreen.tsx`, `src/app/shell.css`, `src/i18n/ru.json`, `src/floor/exceptions/box-exceptions.ts` (the template error only), `test/floor-work-exceptions.test.tsx` (new, 41 tests), `test/support/work-screen.tsx` (new), `test/floor-work-print.test.tsx`, `test/floor-work-screen.test.tsx`, `test/floor-box-exceptions.test.ts`.

Beyond the brief (all in the dispatch's EXTRAS or required by a rule there):

- **Own error for a newer template revision** (Task 1 concern 4): `TemplateChangedError` (box-exceptions.ts), outcome `template_changed`, own text. Task 1's test now expects it (`floor-box-exceptions.test.ts`).
- **Exceptions stay closed while a label waits**: the button is disabled at any stop; in addition `openExceptions` is the queue's next job and settles the label first (the label panel takes the screen if a label waits); `reprint` and `disassemble` re-read "does a label of the shift wait" in the queue's turn and answer `label_waiting` (and the post-step settles it into the panel) — the model of Task 1 lets a box with a waiting label be disassembled, this is the rule that keeps the order. The stops of a job started by the entry (`closeBox(true)`) overriding the loading exceptions stop are tolerated (boxes are shown only while the stop is still `exceptions`).
- **Skip text restored** (2a7 minors item 6): «…напечатать этикетку снова можно в «Исключениях».»; test "promises nothing…" in `floor-work-print.test.tsx` renamed/changed to expect the reference and that the «Исключения» button is reachable afterwards; reachability proven by a test that skips a label and then reprints it from the exceptions (`can print again, from the exceptions, the label of a box the operator went on without`).
- **400 ms press guard** after every change of view (`VIEW_GUARD_MS` from LabelPanel, injectable `clock` = `labelClock`), including the first view (a double tap on «Исключения» would otherwise land on «Снять последний код», which has no confirmation). View identity = stage kind/action/box, so typing digits or words does not restart the guard.
- **One action at a time** (`running` ref): two presses in one tick start one write.
- **Focus**: a `role="group"` view container (`tabIndex=-1`) named by the stage heading takes the focus on every view change (never a button); «Назад»/«Вернуться к работе» returns the focus to the «Исключения» button.
- **Keyboard returns to the scanner when the words field goes away without a blur** (Enter -> confirmation): the brief only released it on blur/unmount; a stage-keyed effect cleanup now does it (otherwise a later box scan would be swallowed as typing).
- **Leaving**: `exception()` starts nothing once `leavingNow()` (outcome `leaving`, own text); `openExceptions` returns at once.
- **`StaleJobError` -> `stale`** (not "failed write": nothing is wrong with the computer when another reprint of the box landed).
- **`onRecorded` also after `failed`** (a failed reprint may have written the record before the send threw).
- **Live-region/ARIA**: all Alerts `role="presentation"`; the flow sits in the work screen's polite region; no inner `aria-live`; notes of a wrong scan keep `role="alert"`.
- **CSS**: `.exceptions__choices` (own grid; `work-screen__reasons` is only styled inside `.work-screen__label`), `.exceptions__confirm` (destroying button at the far end, apart from «Назад»).
- **Loading/none texts**: "Читаем закрытые короба…" in the actions view while the boxes are read (the reprint/disassemble buttons are disabled then), "nothing" only when the boxes are known.
- `test/floor-work-screen.test.tsx` "gives every button of the screen the floor's size": button count 3 -> 4 (the new «Исключения» button in the confirm-close view).

## 3. Anchor adaptations

- `WorkScreen.tsx` (executed code differs from the plan, names per the 2a7 final review): `local`/`where`/`shift`/`printContext`/`track` -> `live.current.local`, `pairingOf(now)`, `now.shift`, `printContextOf(live)`, `live.current.track`; `boxContextOf(live)` instead of a `context` variable; `system_error` stop gets `cause: "read"`; the `ExceptionFlow` JSX goes before `LabelPanel` inside `.work-screen__alerts`; the button before the leave button and `data-action="exceptions"`.
- `ru.json`: the plan's anchor (`"notSscc"` closing `print`) does not exist; the `exceptions` block was inserted as a sibling of `print` under `floor` (mechanical). `target.loading` moved to a top-level `exceptions.loading`.
- `shell.css`: the plan's `.exceptions__pad`/`.exceptions` kept, `work-screen__reasons` replaced by `exceptions__choices` (mechanical, see above).
- `test/support/work-screen.tsx`: added `labelClock` + `clock` + `pause()` (the plan's version had no clock, so the panel's own 400 ms guard would have swallowed the second press of "Продолжить без этикетки" twice in a row); `press()` advances the clock like the existing helper in `floor-work-print.test.tsx`.
- Brief tests applied with `work.pause()` before direct `fireEvent` clicks (the guard).

## 4. RED / GREEN

- RED (reconstructed: I wrote the module before the tests; `ExceptionFlow.tsx` moved aside, restored byte-identical, sha256 `4595a7bb...2691c`): `/tmp/claude/impl-2a8-t2/red-final.txt` — `Failed to resolve import "../src/floor/exceptions/ExceptionFlow.js"`, `Tests no tests`. Then the first full run of the new file (after wiring the flow) showed two real failures I fixed (regex with parentheses in the HRI, `Input` height lives on `minHeight`).
- GREEN: `vitest run test/floor-work-exceptions.test.tsx` -> 1 file, 41 tests passed. Verbose run: exit 0, `grep -c "stderr |"` = 0 (a first verbose run showed one act() warning in my boundary test; fixed by wrapping the click in `act`). Delayed-`setImmediate` stand (3 ms) on `floor-work-exceptions`, `floor-work-print`, `floor-work-screen`: 3 files, 151 tests passed, stderr count 0; the two temporary files deleted, `git status` clean of them.
- Related files (`floor-work-print`, `floor-work-screen`, `floor-schema`, `floor-box-exceptions`, `floor-work-exceptions`): 5 files, 220 passed (verbose run).
- Plan counts (scratch copy): Task 2 = 108 files / 2606 tests (brief: 10 tests in the new file). Measured: new file 41 tests; whole package 112 files / 3375 tests (Task 1 reported 111 / 3334, so +1 file, +41 tests). First full run: 4 old office files timed out at 5 s under load ~65–70 (`shifts-page` 4, `template-editor` 11, `templates-page` 3, `shift-delete-close` 1: 19 timeouts in total); re-run of those 4 files alone with `--testTimeout=60000`: 4 files, 231 passed.
- Gates: `typecheck` 0, `lint` 0, `build` 0, prettier gate on the 10 changed files (and live-proved in the prep step with a mis-formatted scratch file -> exit 1), `git diff --check` clean, `grep -rnF '\u04' src test` only `src/host/pairing-code.ts:66`, no `console.*` in the new code, `git status --short` empty after the commit. No Rust changed in the task commit (the prep commit's Rust: `cargo fmt --check` clean; `local_db` 27 + `ipc` 26 passed).

## 5. Mutants (driver `/tmp/claude/impl-2a8-t2/mutate.py`, definitions `mutants.py`; results `mutation-results-pass1.txt` + `mutation-results.txt`; each restored and checked by `cmp` and sha256, no RESTORE-FAILED)

First pass left 3 survivors and 2 anchors that did not match the formatted code; tests strengthened/anchors fixed, re-run: all killed.

| id   | file           | one-line mutant                                           | first failing test (count)                                                                                              |
| ---- | -------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| W1   | WorkScreen     | scan at the box choice not routed to the flow             | takes apart a box chosen by a scan of its label... (3)                                                                  |
| W2   | WorkScreen     | exception not handed to the gate (`Promise.resolve`)      | hands its write to the floor's work gate (1)                                                                            |
| W3   | WorkScreen     | button enabled at a stop                                  | opens neither at a label that waits nor while the operator leaves (1)                                                   |
| W3b  | WorkScreen     | button enabled while leaving                              | same (1)                                                                                                                |
| W4   | WorkScreen     | `openExceptions` does not ask `leavingNow()`              | starts nothing once the operator is leaving (1)                                                                         |
| W4b  | WorkScreen     | `openExceptions` opens over a stop that came a moment ago | does not open over a stop that came a moment ago, before the screen showed it (1) — survived the first pass, test added |
| W5   | WorkScreen     | opening does not settle a waiting label                   | lets the label's panel take the screen when a label waits as the exceptions open (1)                                    |
| W6   | WorkScreen     | exception starts once the leave began                     | starts nothing once the operator is leaving (1)                                                                         |
| W7   | WorkScreen     | no label settling after an exception                      | stops at a reprinted label that waits for its check (3)                                                                 |
| W8   | WorkScreen     | reprint ignores another box's waiting label               | refuses a reprint of a box while another box's label began to wait (1)                                                  |
| W9   | WorkScreen     | disassembly ignores a waiting label                       | refuses a disassembly of a box while another box's label began to wait (1)                                              |
| W10a | WorkScreen     | template error said as a failed write                     | says the label cannot be printed here when the shift holds a newer revision (1)                                         |
| W10b | WorkScreen     | `StaleJobError` said as a failed write                    | says the box changed when another reprint of it landed (1)                                                              |
| W10c | WorkScreen     | vanished box said as a failed write                       | says that the box is no longer a closed one when a reprint/disassembly finds it taken apart (2)                         |
| W11  | WorkScreen     | no `onRecorded` after an exception                        | says a failed write as an error, and a done one as done / undo test (1)                                                 |
| W11b | WorkScreen     | no `onRecorded` after `failed`                            | says a failed write as an error... (1)                                                                                  |
| W12  | WorkScreen     | open-box exception always `done`                          | says an open box with no code in it as nothing to take out (2)                                                          |
| W12b | WorkScreen     | disassembly always `done`                                 | says the box changed when it was taken apart between the read and the write of a disassembly (1)                        |
| W13  | WorkScreen     | `showClosedBoxes` sets nothing                            | takes apart a box chosen by a scan... (15)                                                                              |
| W13b | WorkScreen     | boxes not read again after an exception                   | leaves the boxes already taken apart out of the list that follows (1)                                                   |
| W14  | WorkScreen     | focus does not return to the button                       | puts the focus on the view, never on a button, and returns it... (1)                                                    |
| W15  | WorkScreen     | text entry not told to the scanner                        | prints a box's label again chosen by the last digits... (2)                                                             |
| W16  | WorkScreen     | numbers not read again                                    | takes the last code out of the open box, and the work goes on (1)                                                       |
| W17  | WorkScreen     | failed read of the closed boxes swallowed                 | stops the line with the shift unread when the closed boxes cannot be read (1)                                           |
| E1   | ExceptionFlow  | no press guard                                            | ignores a press just after the view changed (2)                                                                         |
| E2   | ExceptionFlow  | guard `<=` 400                                            | ignores a press for 400 ms after a view opened, and takes it at 400 (1)                                                 |
| E3   | ExceptionFlow  | change of view not noted                                  | ignores a press just after the view changed (2)                                                                         |
| E4   | ExceptionFlow  | typing a digit restarts the guard                         | prints a box's label again chosen by the last digits (1) — survived the first pass, tail text assertion added           |
| E5   | ExceptionFlow  | action may run twice                                      | does an action once however many times it is pressed (1)                                                                |
| E6   | ExceptionFlow  | words view keeps the keyboard                             | gives the keyboard back to the scanner when the words are done with by Enter (2)                                        |
| E7   | ExceptionFlow  | destroying button not set apart                           | keeps every button on 64 px... (1)                                                                                      |
| E9   | ExceptionFlow  | pad takes 19 digits                                       | takes no more digits than an SSCC has (1)                                                                               |
| E10  | ExceptionFlow  | `startsWith`                                              | the list of closed boxes by the last digits (2)                                                                         |
| E11  | ExceptionFlow  | rest counted wrong                                        | same (2)                                                                                                                |
| E12  | ExceptionFlow  | words skip `reasonWords`                                  | prints a box's label again chosen by the last digits (1)                                                                |
| E13  | ExceptionFlow  | Enter does not finish the words                           | gives the keyboard back... Enter (1)                                                                                    |
| E14  | ExceptionFlow  | not-SSCC said as unknown box                              | takes apart a box chosen by a scan... (1)                                                                               |
| E15  | ExceptionFlow  | scan reads the first view's stage                         | takes apart a box chosen by a scan... (3)                                                                               |
| E16  | ExceptionFlow  | focus does not go to the view                             | puts the focus on the view (1)                                                                                          |
| E17  | ExceptionFlow  | box choice keeps listening                                | does not let a scan change the box once it is chosen (2)                                                                |
| E18  | ExceptionFlow  | failed write is a warning                                 | says a failed write as an error (1)                                                                                     |
| E19  | ExceptionFlow  | disassembly confirmed with an ordinary button             | keeps every button on 64 px... (1) — survived the first pass, class assertion added                                     |
| E19b | ExceptionFlow  | clear confirmed with an ordinary button                   | ignores a press just after the view changed (1)                                                                         |
| E20  | ExceptionFlow  | undo offered with an empty box                            | says there is nothing to do... (1)                                                                                      |
| E21  | ExceptionFlow  | reprint offered without a closed box                      | same (2)                                                                                                                |
| E22  | ExceptionFlow  | "nothing to do" while boxes are read                      | does not call the work done while the closed boxes are read (1)                                                         |
| E23  | ExceptionFlow  | the reading of boxes not said                             | same (2)                                                                                                                |
| B1   | box-exceptions | template change = missing box                             | refuses a box whose job was made from another revision (2)                                                              |
| J1   | ru.json        | skip text sends nowhere                                   | promises only what the screen has when it asks to go on without a label (1)                                             |

Equivalent / not observable (stated, not hidden):

- The `label` outcome and the `LabelWaitingError` -> `label_waiting` mapping: the settling that follows every exception replaces the flow by the label panel, so the result texts `result.label` and `result.label_waiting` are never on the screen (they stay for the contract the plan gives to ПЛ-Ц). Removing the in-queue `labelWaits()` check of the SAME box's reprint is likewise masked by `LabelWaitingError`; the check is tested for the case it matters for — another box's waiting label.
- The `host_id`/`device_id` of the Task 1 statements are not touched here.

## 6. Self-review

- Every scan source route: the box scan goes to the flow only at the `target` view; at every other view of the exceptions a scan is refused in words (`paused`), never `processScan`, never journalled; test counts `floor_scans` stays 24 after three stray scans and no exception row.
- Accessibility: 64 px (`size="floor"` asserted for every button of five views and the words field's `minHeight`), focus on the view, polite region with `role="presentation"` Alerts (asserted), notes with `role="alert"`, texts via `ru.json`.
- Offline: no host call anywhere in the flow.
- N9/N13: `openExceptions`, `exception` are queue jobs handed to `track` before they start; nothing starts once leaving.

## 7. Concerns

1. **Reprint's printer is not named in the confirmation** (2a7 minors item 4 asked this for the label panel's reprint, which does it; the exception reprint goes to the purpose «Короб» printer from the current settings and the confirmation only names the box and the reason). If the owner wants it, the flow needs the workstation settings loaded (same `printerForAgain` text as the panel).
2. Task 1 concern 5 (clear's `DELETE` has no row-count check) left as is on purpose: a count check would make an inconsistent box impossible to clear — the case where «Очистить короб» is most needed.
3. `exceptions.result.label` / `label_waiting` texts are unreachable on screen (see section 5); kept for the ПЛ-Ц contract.
4. `Исключения` stays visible (disabled) in the confirm-close view, so that view has 4 buttons now (the old test counted 3).
5. Not exercised: a real touch screen/gloves (the 400 ms guard is tested on an injected clock), a screen reader, WebView2, a real printer; no Rust in the task commit; the prep commit's Rust ran on the shell SQLite 3.46 on this machine only.
6. Full Vitest run: 19 timeouts of old office suites under load (listed in section 4), all green alone with a 60 s timeout.

## Fix round

Commit `05716ce71` fix(standalone): the exceptions name the reprint's printer and never run unseen behind a label (on `68ba3310a`; one trailer; `git status` empty after). Files: `src/floor/exceptions/ExceptionFlow.tsx`, `src/floor/work/WorkScreen.tsx`, `src/i18n/ru.json`, `test/floor-work-exceptions.test.tsx`.

### What changed, per finding

- **I1 (printer named).** `ExceptionFlow` takes `loadSettings` (WorkScreen passes its existing `loadLabelSettings`) and optional `onSetup` (the screen's `props.onSetup`). It reads the settings once when it mounts and takes the printer with `resolvePrinter(settings, "box")`, the same call `prepareLabelJob` makes inside `reprintBox` (NOT `printerForAgain`: that prefers the job's own printer, which a reprint does not use). In the reprint confirmation: the existing `floor.print.target.label` line («Печать пойдёт на принтер: имя · ZPL · 203 dpi.»); when none is assigned, the new plain-words `floor.exceptions.confirm.reprint.noPrinter` («…она не напечатается. Исключение всё равно будет записано, а этикетка останется на экране работы: напечатайте её, когда принтер будет настроен.») plus a «Настроить принтер» button when `onSetup` exists; `floor.print.target.unknown` when the read fails. The confirm button is disabled only while the settings are still loading (a failed read or no printer stays confirmable: the exception and its record are written, the label panel takes over). A disassembly shows none of this.
- **I2 (unseen undo/clear).** In the `exception` queue job, before `work()`: if `stopRef.current?.kind !== "exceptions"` the action is refused (nothing runs, nothing is written) and the operator is told over whatever stands now: `show("error", «ИСКЛЮЧЕНИЕ НЕ ВЫПОЛНЕНО», «Сначала ответьте на сообщение на экране.»)` (flash + tone; the outcome returned, `label_waiting`, is never drawn because the flow is gone). I chose flash+tone over a `LabelNote` because it shows over every kind of stop, not only over a label panel with a note slot. Stale quantity: «Очистить короб» is disabled while `boxes === null` (the closed boxes arrive after the numbers were read in the queue), so the confirmation can only name a quantity that was read; undo stays pressable (it names no number) and is covered by the queue check. «Исключения» is NOT disabled while `sending` (optional in the review): the queue check makes it safe and a disabled button would not say why.
- **m1.** The box-choice listener writes the next stage into `current.current` synchronously and answers `null` when the choice is no longer open; WorkScreen then falls through to its ordinary refusal («Скан не принят…»), so nothing is dropped silently and a second quick scan cannot replace the pick.
- **m2.** The listener answers a `BoxScanVerdict` (`taken | not_sscc | not_found`, exported); WorkScreen gives it `show("ok"|"error", …)`: «КОРОБ ВЫБРАН» (ok tone), «НЕ SSCC» (the existing `floor.print.signal.notSscc`), «НЕТ ТАКОГО КОРОБА».
- **m3.** `failed`: «…Возможно, оно всё же записалось: проверьте числа короба, прежде чем повторять.»; `stale`: «…Проверьте числа короба и повторите, если ещё нужно.» «Ничего не сделано» stays only where it is certain (`unavailable`, `label_waiting`, `template_changed`).
- **m4.** Disassembly confirmation gains «Отменить это нельзя: снимите этикетку с короба.» (own paragraph); the undo result gains «Если сняли по ошибке — отсканируйте этот код снова.» (own paragraph, so the result titles are unchanged).
- **m5.** The never-failing `hasAttribute("disabled")` assertion is replaced: the leave button has no `aria-disabled` while the exceptions are open and is outside the exceptions region, and it gets `aria-disabled="true"` once leaving.
- **m6.** Judgement, no change: the `label` / `label_waiting` result texts stay for the ПЛ-Ц contract (and `label_waiting` is also what the I2 refusal returns, unseen).
- Test-side: flow-level tests now mount through an `act`-wrapped `mount()` (the settings read resolves after render); the old flow test that expected «Очистить короб» enabled while the boxes load now expects it disabled (named in the test title).

### RED / GREEN

- RED (`/tmp/claude/fix-2a8-t2/red.txt`): the new/changed tests against the old code: 13 failed | 41 passed (54): the three I1 WorkScreen tests, four flow-level printer/verdict tests, the I2 refusal, the clear-while-reading test (WorkScreen and flow), the two m1/m2 tests, the m4 test. (The m3 texts were already in `ru.json` when this run was taken; their RED is the D1/D2 mutants below.)
- GREEN: `floor-work-exceptions` 54 passed (was 41; +13).

### Mutants (driver `/tmp/claude/fix-2a8-t2/mutate.py`, results `mut-run2.txt` on the final test file; pre-mutation copies in `/tmp/claude/fix-2a8-t2/snap/`; every file restored, `cmp` + sha256 equal, touched; all 24 killed, restore=ok for all)

| id  | one-line mutant                                                          | first failing test(s)                                                                                                                |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | printer line dropped from the reprint confirmation ("printer not named") | the three I1 WorkScreen tests + flow tests (6)                                                                                       |
| A2  | names `settings.printers[0]`                                             | «names the printer «Короб» has now…» (+2)                                                                                            |
| A3  | purpose `pallet` instead of `box`                                        | «names the printer the new label will go to…» (+2)                                                                                   |
| A4  | no-printer words replaced by `""`                                        | «says before the confirmation that no printer is assigned…» (+1)                                                                     |
| A5  | setup button never offered                                               | same (+1)                                                                                                                            |
| A6  | setup button offered although a printer is assigned                      | «names the printer the new label will go to…»                                                                                        |
| A7  | confirm live while the settings load                                     | «waits for the printer's name before a reprint can be confirmed»                                                                     |
| A8  | read failure not said                                                    | «says that the printers could not be read…»                                                                                          |
| A9  | printer line also on the disassembly                                     | «names no printer for a disassembly…»                                                                                                |
| B1  | no re-check in the queue's turn (I2)                                     | «refuses an undo pressed before the opening was settled…»                                                                            |
| B2  | refusal not said (no `show`)                                             | same                                                                                                                                 |
| B3  | «Очистить короб» live while the boxes are read                           | «does not offer «Очистить короб» before the numbers were read…» (+1)                                                                 |
| C1  | next stage not written into the ref at once (m1)                         | «answers a scan of the box choice with its verdict…», «takes the first of two scans…»                                                |
| C2  | closed choice answers `taken` instead of `null`                          | same two                                                                                                                             |
| C3  | not-found tone `ok`                                                      | «gives every verdict on a scan of the box choice its tone and its words…»                                                            |
| C4  | taken tone `error`                                                       | same                                                                                                                                 |
| C5  | not-SSCC verdict unsaid                                                  | same                                                                                                                                 |
| C6  | WorkScreen swallows a `null` verdict                                     | «takes the first of two scans…»                                                                                                      |
| D1  | `failed` text back to «Ничего не сделано»                                | «says a failed write…» (+2)                                                                                                          |
| D2  | `stale` text back to «Ничего не сделано — повторите»                     | three stale tests                                                                                                                    |
| D3  | disassembly irreversibility paragraph empty                              | disassembly tests (9)                                                                                                                |
| D4  | undo hint empty                                                          | undo tests (6)                                                                                                                       |
| D5  | no-printer words lose the consequence sentence                           | «says before the confirmation that no printer is assigned…»                                                                          |
| E1  | leave button `aria-disabled` while exceptions are open (m5)              | «opens neither at a label that waits nor while the operator leaves…» (the old `hasAttribute("disabled")` assertion could not see it) |

### Gates

typecheck 0; lint 0; build 0; prettier gate over the 4 changed files via an array in zsh (printed "Checking formatting…", "All matched files use Prettier code style!"; live proof: a scratch `src/zz-prettier-probe.ts` added to the same list was flagged, exit 1, then deleted); `git diff --check` clean; `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`. Verbose run of `floor-work-exceptions` + `floor-work-print` + `floor-work-screen`: 3 files, 164 passed, `stderr |` count 0, stderr file empty (a first verbose run showed `act(...)` warnings from the flow-level tests; fixed by `mount()`). Delayed-`setImmediate` stand (3 ms) on the same three files: 164 passed, stderr empty; the stand's two files deleted. One full Vitest at `--testTimeout=60000 --hookTimeout=60000` (load ~90): 112 files, 3388 tests passed (before this round 112 / 3375; +13), no failures, no timeouts.

### Not exercised / concerns

- The I2 refusal is shown as a 700 ms flash + error tone (the existing `show`); the label panel carries no persistent note that an exception was refused. The consequence is safe (nothing ran) but the notice is brief by design of the floor's signals.
- The reprint's printer is read once when the exceptions open; the setup is another screen, so nothing changes it while the flow is up. A printer changed elsewhere between opening and sending (not possible from this station) would differ.
- A reprint with no printer assigned remains confirmable by design (the dispatch asked to say so and offer the setup, not to block); the job is kept `failed` and the label panel takes over.
- «Очистить короб» is unavailable during the (millisecond-long, normally) read of the closed boxes; if a held scan write keeps the queue busy, the exceptions screen shows «Читаем закрытые короба…» until it ends.
- No real touch screen, gloves, screen reader, WebView2 or printer; no Rust touched.
