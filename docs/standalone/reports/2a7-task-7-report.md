# 2a7 Task 7 report - the workstation setup (printers, purposes, test print)

Commit `1fe375ad2` feat(standalone): the workstation setup: printers, their purposes and a test print, from the shifts and from a label's recovery (branch claude/floor-2a7, base d70161311). One Co-Authored-By line; tree clean after the commit. Webview only (no Rust, host, proto, manifests). Scratch under /tmp/claude/impl-2a7-t7 (harness `mut.py`, logs `mut_*.log`, `red.txt`, `full.txt`, `delay.txt`, `verbose.txt`).

## Scope note

The brief's Task 7 is the PRINTERS part of the setup: printer list/form, purposes, test print, entry points. The dispatch text mentions scanners and sound screens; those are the plan's Task 8 (no Task 8 brief exists yet, the plan's file map says Task 8 = `WorkstationSetup.tsx`, `FloorApp.tsx`, `ru.json`). I did NOT build scanner/sound/verify-label screens. I DID do the one sound item the dispatch names for this task: the sound LEVEL wiring (FloorApp -> work screen's tones), see below.

## What was done

- `src/floor/setup/WorkstationSetup.tsx`, `printer-draft.ts`, `test-label.ts` (from the brief, then hardened, see "Beyond the brief").
- `FloorApp.tsx`: `hardware` prop; views `setup` (from the list: no work events; from the work: `Leave {kind:"setup"}` waits for the tracked work like any leave, `work_left`, then the screen; back = `work_entered`); `onSetup` for the work screen and the list; sound level wiring.
- `ShiftList.tsx` `onSetup` («Рабочее место»), `App.tsx` passes `hardware`, `shell.css`, `ru.json` (`floor.setup.*`, `floor.shifts.setup`, plus `usbAsking`).

## Safety points of the dispatch

- Test print is a clearly marked sample: ASCII `MARKIRO TEST` + random `MKR-xxxxxx` Code 128; no element reads a field of `sampleLabelData()`. Test: the sent bytes contain `^FDMKR-`, not the sample SSCC, and no 14-digit run (mutant: barcode data `"sscc"` -> killed). Same send path as jobs: `printing.send(null, ...)`, per-address queue, 20 s limit, `settleOutcome` (`unknown` for timeout/outcome_unknown, `failed` for not_sent/busy). Tests: unknown after the limit, `printer_busy` for a send that never started (shell receives one send only), render failure sends nothing.
- A test print never takes a job's `inFlight` slot (`jobId` null), so recovery of interrupted jobs is unaffected; it queues behind a real send on the same address and never interleaves.
- Purpose mapping change does not reroute a pending job: test closes a box (job `prepared`, printer ZEBRA), reassigns "box" to TSC through the screen, saves; `floor_print_jobs` rows are byte-identical and `printerForAgain(job, newSettings, null)` is still ZEBRA. (Task 5/6 behaviour; the setup writes nothing to the jobs table.) Known limit, unchanged from Task 5: EDITING the profile of the job's printer (same id, new address/language) changes where "print again" goes, because `printerForAgain` takes the job's own printer "as the settings have it now"; the panel names the printer before the operator confirms. Deleting it falls back to the purpose's printer (also named).
- Who may open it: any signed-in operator (В10 А), no admin gate, as the plan says. The floor is reachable only after an operator sign-in.
- Kiosk: the setup is a normal screen inside the same window (no links, no window controls, no file dialogs); `lockdown` lives in `App` and is untouched. Idle lock keeps running in the setup (tests: idle sign-out from the list's setup at once; from a setup opened from the work after the work).
- USB printer listing failures are shown ("Служба печати Windows не ответила."), a pending ask is shown ("Спрашиваем у Windows список принтеров…"), "no printers" is shown, and only the newest answer is heard (stale success and stale failure both dropped). A COM port is typed (the brief has no serial-port listing in Task 7; `listSerialPorts` is for Task 8).
- Settings saved by the existing `saveWorkstationSettings` (one transaction of 4 statements; test pins `[4]`); `InvalidSettingsError` is mapped to its own message and the changes stay on screen; a failed save keeps the changes.
- No secrets: a scan that is not the test code is never shown (test with a badge-like value), nothing is logged.
- A11y: all buttons `size="floor"` (test), selects at `--control-floor` (test); persistent polite live regions with `role="presentation"` Alerts (tests: regions exist and are empty at start, Alerts have no alert role); focus on the section heading at open and when the form opens/closes (test); busy buttons use `aria-disabled` so the focus stays; «Назад» never held by a save or test.

## Beyond the brief (defects found by my own tests/review of the brief's code)

1. **Double Save**: the brief guarded with `saving` state; two presses in one render both saved. Fixed with a ref (test "once while a save runs", mutant killed).
2. Save with nothing to save / while the form is open is ignored (aria-disabled / disabled).
3. Test print: second press while one is on its way did nothing visible but, once `disabled` was replaced by `aria-disabled`, would have queued a second label: ref guard + test (render spy and send count after release).
4. Returning to the shift: the brief re-enters the STALE `WorkShift` object. A shift the office closed while the setup was open would be entered. Now `readStoredWork` runs on the way back; closed -> list with the office-closed notice; unreadable -> list; a double «Назад» enters once (ref). Office close that arrives while the setup leave still waits for the work outranks it (like list/line change).
5. Stale USB answers (above) and the "asking" hint.
6. Sound level: `FloorApp` reads the saved sound level at open and takes it from `onSaved`; passes `signal` to the work screen (`playSignalTone(tone, undefined, level)`); muted = 0 plays nothing. Tests (with `playSignalTone` mocked in `floor-app.test.tsx`): default 0.8, stored 0.3, muted 0, and a level stored by the setup is heard at once on return. Caveat: there is no sound control in the setup yet (Task 8); the wiring takes `settings.sound` of whatever the setup saved.
7. Extra tests in `floor-shift-list.test.tsx` (no button without `onSetup`; floor size; held while an entry runs; sign-out not held).

## RED / GREEN

- RED (`red.txt`): `vitest run test/floor-app.test.tsx test/floor-setup.test.tsx` with the new tests and no implementation: floor-setup fails to load (`Failed to resolve import "../src/floor/setup/printer-draft.js"`), floor-app: "opens from the list of shifts and comes back to it" and "opens from a label's recovery once the work settled, and comes back to the same shift" failed.
- GREEN with the brief's code (before hardening): 2 files, 85 passed (brief says 34 on its copy; the real floor-app file has more tests). Final: floor-app 84, floor-setup 28, floor-shift-list 48 (verbose: 3 files, 160 passed, 0 `stderr |` blocks).
- Delayed-`setImmediate` stand (3 ms): floor-app, floor-setup, floor-shift-list, app, floor-work-print, floor-work-screen: 6 files, 393 passed. Stand files deleted.
- Full Vitest (`--testTimeout=60000 --hookTimeout=60000`): 110 files, 3253 tests passed (before: 109 / 3211; +1 file, +42 tests). Plan's copy numbers (106 / 2524) are not comparable.
- typecheck, lint, webview `build`: clean. Prettier gate proven live (mis-formatted scratch file reported `[warn]`, deleted), then 11 changed files pass with `--ignore-path`. `git diff --check` clean. `grep -rnF '\u04'`: only `src/host/pairing-code.ts:66`.

## Mutants (harness mut.py; each: one edit, run of covering file(s), restore from copy, sha256 + cmp equal; all restored=True)

| Mutant                                            | Result                                                                                                                                                   | Killing test                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| M1 brief: one wrong scan closes the check         | killed                                                                                                                                                   | prints a test label and checks its code ...                           |
| M2 brief: duplicate address allowed               | killed                                                                                                                                                   | refuses a form with a mistake, and a second profile                   |
| M3 brief: setup opens without the leave           | killed                                                                                                                                                   | opens from a label's recovery once the work settled ...               |
| M4 brief: assignment kept at a removed printer    | killed                                                                                                                                                   | edits a printer, and a removed printer prints nothing                 |
| M5 return enters the stale shift                  | killed                                                                                                                                                   | reads the shift again on the way back ...                             |
| M6 unreadable shift on return still entered       | killed                                                                                                                                                   | goes back to the list when the shift cannot be read again             |
| M7 no double-return guard                         | killed                                                                                                                                                   | enters the shift once however many times «Назад» ...                  |
| M8 office close does not outrank a waiting setup  | killed                                                                                                                                                   | lets the office's close of the shift outrank a setup that still waits |
| M9a `signal` not passed                           | killed                                                                                                                                                   | plays at the default level ...                                        |
| M9b mount read ignored                            | killed                                                                                                                                                   | plays at the stored level, and none when muted                        |
| M9c `onSaved` level ignored                       | killed                                                                                                                                                   | takes the level the setup stored ...                                  |
| M9d level not passed to the tone                  | killed                                                                                                                                                   | plays at the default level ...                                        |
| M10 save guarded by state (double press)          | killed                                                                                                                                                   | does nothing with nothing to save, and once while a save runs ...     |
| M11 save with nothing to save runs                | killed                                                                                                                                                   | same                                                                  |
| M12 test-print guard removed                      | SURVIVED the first tests (second label queued behind the first never reached the shell) -> test now counts renders and sends after the release -> killed | does not start a second test label ...                                |
| M13 `aria-disabled` dropped from the test button  | killed                                                                                                                                                   | same                                                                  |
| M14 stale USB success heard                       | killed                                                                                                                                                   | says it is asking, and hears only the newest answer                   |
| M15 stale USB failure heard                       | SURVIVED -> test "does not let an old failure undo a newer list" -> killed                                                                               |                                                                       |
| M16 "asking" hint removed                         | killed                                                                                                                                                   | says it is asking ...                                                 |
| M17 focus effect removed                          | killed                                                                                                                                                   | puts the focus on the section it shows ...                            |
| M18a/b Alerts keep their role in the live regions | killed                                                                                                                                                   | keeps its live regions in the page ...                                |
| M20 test label reads the SSCC field               | SURVIVED with an invalid `data: {field}` (my mistake: field data is the bare name) -> corrected mutant `data: "sscc"` killed                             | holds no SSCC, GTIN or code of a product ...                          |
| M21-M23 port lower/upper bound, baud bound        | killed                                                                                                                                                   | describes a profile, or names the first thing wrong                   |
| M24 host not trimmed in `profileOf`               | SURVIVED, equivalent: `parsePrintTarget` trims it again                                                                                                  |                                                                       |
| M25 AIM prefix not stripped                       | killed                                                                                                                                                   | is a random code of unmistakable letters ...                          |
| M26 button shown without `onSetup`                | killed                                                                                                                                                   | has no button when the floor gives no setup                           |
| M27 setup button not held by an entry             | killed                                                                                                                                                   | opens the setup at the floor's size, and waits ...                    |
| M28 InvalidSettingsError mapping dropped          | killed                                                                                                                                                   | says settings the build would not read back are refused               |
| M30 stored copy not updated after save            | killed                                                                                                                                                   | adds a network printer ...                                            |
| M31 `onSaved` not called                          | killed                                                                                                                                                   | adds a network printer ... (+ M9c)                                    |
| M32 test result "sent" for unknown                | killed                                                                                                                                                   | says a send that did not answer in time is unknown ...                |
| M33 «Назад без сохранения» always «Назад»         | killed                                                                                                                                                   | adds a network printer ...                                            |
| M34 saved message not cleared by a new change     | killed                                                                                                                                                   | takes «Настройки сохранены» back ...                                  |
| M35 Save not disabled while the form is open      | killed                                                                                                                                                   | does nothing with nothing to save ...                                 |

## Anchor adaptations (mechanical)

- `FloorApp.tsx` fragment 6: the real `finish` is `setView({ kind: "list", notice: leave.kind === "list" ? ... })` (no `if (leave.kind === "list")` line); added `if (leave.kind === "setup") {...; return;}` before it. Fragment 7/8/9 applied as written (plus the `view.shift` closure instead of destructured `shift`).
- `floor-app.test.tsx`: a second `<FloorApp>` literal (test "shows the operator's name as text") also needed `hardware={handlers.hardware}`.
- `ru.json`, `shell.css`, `ShiftList.tsx`, `App.tsx` fragments matched exactly.

## Concerns / for the reviewer

1. Scanner, sound and verify-label controls are not in this task (Task 8). `onSaved` in the work-return path assumes Task 8 will not need more than `soundLevel(settings.sound)`; scanners applied on save (`applySavedScanners`) are Task 8's.
2. Edit of the printer of a waiting job changes where the reprint goes (see safety point); only visible in the panel's "Печать пойдёт на принтер" line.
3. A test print to a printer whose real label send is stuck waits up to 20 s and ends `busy`/`unknown` (queue semantics, honest text).
4. Leaving the setup while a test label is in flight does not cancel it (it prints; the result is dropped). Nothing tracks it with the work gate: the setup is not a work screen.
5. Not exercised: real printers, COM/spooler, Tauri, Windows/WebView2, a browser, screen readers, touch.
