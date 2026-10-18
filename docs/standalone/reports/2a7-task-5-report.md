# 2a7 Task 5 report - decisions on a label

Commit `0248b0ddc` feat(standalone): decisions on a label: the scan check, a skip, «printed», printing again with a reason (branch claude/floor-2a7, base de95775b1). One Co-Authored-By line, tree clean after the commit. Scratch only under /tmp/claude/impl-2a7-t5. Webview only (no Rust, host, proto, manifests).

## Scope note

The brief's Task 5 is `print-resolution.ts` (check by scan, skip, «printed», print again, printer choice) plus `exception-reasons.ts` and the test support. The label step of the close (`boxLabelStep`) is Task 4's and already in main line; the work-screen and UI wiring (`LabelPanel`, `settleLabel`, ru.json texts, 64 px targets, live regions) are Task 6/7. Task 5 has no React, no text and no ru.json key, so the accessibility/ru.json/delayed-setImmediate items do not apply to it and were not exercised.

## What was done

- Brief applied by mechanical extraction of its code blocks (no transcription): `src/floor/exception-reasons.ts`, `src/floor/print/print-resolution.ts`, `test/floor-print-resolution.test.ts`, 4 fragments of `test/support/printing.ts`. Each fragment matched exactly once.
- Then 21 tests added beyond the brief (15 -> 36) so every guard has a killing test.

## Print integrity - how it is held

- No automatic re-send: `printAgain` is the only function here that reaches `sendLabelJob`; `checkLabel`, `skipLabel`, `confirmPrinted` never send (mutants X1/X2: both killed). Nothing retries. A reprint is an explicit operator act.
- A label that may exist (`unknown`, or `sent` whose check waits) is printed again only with a reason from `REPRINT_REASONS`; the reason is written as `floor_exceptions` `reprint` + `box_exception` `reprint` in the SAME transaction that marks the job `sending` (as `extra` of `sendLabelJob`; first statement compares state and attempts, so a stale read writes no exception and sends nothing - tested; M2 killed). A failed job (nothing left the computer) is printed again without reason or exception, even if the screen sends a reason (tested).
- `sent` with no check requested, `prepared`, `sending`, `verified`, `skipped` are refused by `printAgain` (the first send of `prepared` is Task 6's one-time auto-send; a settled box is reprinted by plan 2a8's new job). Tested for all five, K11/K11b killed.
- Two decisions on the same read: one wins, the other gets `StaleJobError`; one `box_label`, one send, one exception (tested with `Promise.allSettled`). A decision on an earlier READ of the same state but an older attempt is also stale (K29, test "does not confirm the label of a later attempt that looks the same").
- Label check: `parseScannedSscc` of the domain (bare, `(00)`, `00`, `]C1`, `]C1(00)` forms), compared with the job's 18-digit SSCC; a different SSCC is `mismatch`, anything else `not_sscc`; nothing written for either. Verified only for a `sent` job that asked for it.
- Audit accuracy: every record names the operator SIGNED IN (`context.operatorId`), not the one who closed the box (K25a/K25b/K26), the exact `box_exception` payload (shift, box, reason code, `occurredAt` = the decision's clock reading, no words) is asserted, `floor_exceptions` ids are unique per reprint (K40).
- Infrastructure failures propagate as they are (`LocalDbError`), only a lost comparison becomes `StaleJobError` (K31/K32); a decision of another pairing (host or device) touches nothing (K27/K28).
- Pallet jobs (`purpose: pallet`) are refused by all three record-writing decisions until plan ПЛ-Ц adds its records (K38/K39).

## Mandatory addenda

1. `printAgain` demands a reason for `unknown`/`sent`(verify=1): DONE (brief code + tests + M1, K11b, K12, K13).
2. Check the snapshot revision: DONE - `template.id`/`template.rev` compared with the job's, each by its own test (K14, K15), including for a job that may exist; renders again from the snapshot's spec when the printer's language or resolution differs, each tested separately (K19, K20), and when the job has no bytes (K21), and a render failure changes and sends nothing even for a job that has bytes (K22: otherwise ZPL bytes would reach a TSC).
3. **Name the former printer on a rebind: NOT done, cannot be done inside this task's allowed surface.** The rebind overwrites the job's `printer`/`bytes_base64`. The only audit records written with the reprint are `floor_exceptions` (CHECK: `reason_text` only with `reason_code = 'other'`, `code_hash`/`target_scanned_at` NULL for `reprint`; no other column) and the host's strict `box_exception` fact (no printer field; `reasonText` only with `other`, and decision-36 reasons are codes only). A printer name has no column in an applied migration (0007 is committed and not mine to rewrite) and no field in the wire fact. What exists: the trail says a second label may exist for the SSCC, with reason and operator and time, not where. Recorded in the JSDoc of `printAgain`. Options for the controller: a later migration with a `former_printer` column (or a small `floor_print_attempts` log) written in the same `extra`, or - if the owner wants it on the host - a new `box_exception` field with protocol version (stream B). I did not guess one.
4. The 2a7 T3 concern (production date from the shift copy) is left for the final review, as instructed.

## RED / GREEN

- RED (`red.txt`): with the two new sources moved away, `vitest run test/floor-print-resolution.test.ts` fails to load: `Failed to resolve import "../src/floor/print/print-resolution.js"`, Test Files 1 failed.
- GREEN, brief tests only (`green1.txt`): 1 file, 15 passed (brief expects 15). With additions: 36 passed (`green4.txt`, verbose, stderr 0 bytes).
- Brief's step-5 mutants M1-M5 killed by the brief's tests as written (table).

## Mutants (harness `mut.py`; each: one edit of `print-resolution.ts`, run of the file, restore from `base.ts`, sha256 compare)

| Mutant                                          | Result           | First failing test                                                                                             | Restored byte-identically |
| ----------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------- |
| M1 drop reason guard                            | KILLED (1 tests) | printing again > never prints a label that may exist without the operator's reason                             | True                      |
| M2 reprint after the send                       | KILLED (2 tests) | printing again > writes the reprint with its reason in the write that marks the job sending                    | True                      |
| M3 any SSCC verifies                            | KILLED (1 tests) | the check of a printed label > refuses another box's SSCC and a scan that is no SSCC, and writes nothing       | True                      |
| M4 printed for failed                           | KILLED (2 tests) | the label the operator sees printed > is not for a failed job: nothing left the computer                       | True                      |
| M5 same bytes for any printer                   | KILLED (3 tests) | printing again > renders again for a printer of another language or resolution, from the snapshot              | True                      |
| K1 awaitsCheck ignores verify                   | KILLED (5 tests) | the check of a printed label > is for a sent job that asked for it only                                        | True                      |
| K2 awaitsCheck ignores state                    | KILLED (3 tests) | what the check of a label reads > asks for the scan of a sent job that was made to be checked, and of no other | True                      |
| K3 check guard dropped                          | KILLED (2 tests) | the check of a printed label > is for a sent job that asked for it only                                        | True                      |
| K4 non-SSCC read as mismatch                    | KILLED (1 tests) | the check of a printed label > refuses another box's SSCC and a scan that is no SSCC, and writes nothing       | True                      |
| K5 exact compare of the scan                    | KILLED (2 tests) | the check of a printed label > verifies the scan of the job's SSCC, with its record, in one write              | True                      |
| K6 check writes skipped                         | KILLED (1 tests) | the check of a printed label > verifies the scan of the job's SSCC, with its record, in one write              | True                      |
| K7 skip writes verified                         | KILLED (1 tests) | going on without a label > skips a waiting check, a failed job and an unknown one, each with its record        | True                      |
| K8 skip not from failed                         | KILLED (2 tests) | going on without a label > skips a waiting check, a failed job and an unknown one, each with its record        | True                      |
| K8b skip not from unknown                       | KILLED (2 tests) | going on without a label > skips a waiting check, a failed job and an unknown one, each with its record        | True                      |
| K8c skip not from waiting check                 | KILLED (3 tests) | going on without a label > skips a waiting check, a failed job and an unknown one, each with its record        | True                      |
| K8d skip from prepared                          | KILLED (1 tests) | going on without a label > is not for a job that is done with or on its way                                    | True                      |
| K9 printed for verified                         | KILLED (2 tests) | the label the operator sees printed > is not for a failed job: nothing left the computer                       | True                      |
| K10 printed moves to verified                   | KILLED (2 tests) | the label the operator sees printed > turns an unknown job into a sent one, and the check comes next when the  | True                      |
| K11 print again state guard dropped             | KILLED (1 tests) | decisions the job's state does not allow > never print again a job that is waiting to be sent, on its way or d | True                      |
| K11b mayExist takes any sent                    | KILLED (1 tests) | decisions the job's state does not allow > never print again a job that is waiting to be sent, on its way or d | True                      |
| K12 mayExist drops unknown                      | KILLED (6 tests) | printing again > writes the reprint with its reason in the write that marks the job sending                    | True                      |
| K13 mayExist drops waiting check                | KILLED (2 tests) | printing again > reprints a sent label whose check did not read it, with a reason                              | True                      |
| K14 template id not compared                    | KILLED (1 tests) | printing again, beyond the first cases > refuses the layout of another template, by id as well as by revision  | True                      |
| K15 template rev not compared                   | KILLED (2 tests) | printing again > changes and sends nothing without a printer or a render, and refuses another template         | True                      |
| K16 chosen printer ignored                      | KILLED (6 tests) | printing again > renders again for a printer of another language or resolution, from the snapshot              | True                      |
| K17 own printer not looked up                   | KILLED (1 tests) | printing again > takes the job's printer as the settings have it now, then the purpose's printer               | True                      |
| K17b own printer from the job, not the settings | KILLED (1 tests) | printing again > takes the job's printer as the settings have it now, then the purpose's printer               | True                      |
| K18 no printer not refused                      | KILLED (1 tests) | printing again > changes and sends nothing without a printer or a render, and refuses another template         | True                      |
| K19 language ignored                            | KILLED (1 tests) | printing again, beyond the first cases > renders again when only the resolution or only the language is not th | True                      |
| K20 resolution ignored                          | KILLED (1 tests) | printing again, beyond the first cases > renders again when only the resolution or only the language is not th | True                      |
| K21 missing bytes not rendered                  | KILLED (1 tests) | printing again, beyond the first cases > renders the label of a job that never had its bytes, for its printer  | True                      |
| K22 render error swallowed                      | KILLED (2 tests) | printing again > changes and sends nothing without a printer or a render, and refuses another template         | True                      |
| K23 reprint recorded for a failed job too       | KILLED (1 tests) | printing again, beyond the first cases > writes no exception for a failed job, whatever reason the screen sent | True                      |
| K24 reprint never recorded                      | KILLED (5 tests) | printing again > writes the reprint with its reason in the write that marks the job sending                    | True                      |
| K25a record names the closing operator          | KILLED (1 tests) | whose decision it is > names the operator signed in on every record, not the one who closed the box            | True                      |
| K25b row names the closing operator             | KILLED (1 tests) | whose decision it is > names the operator signed in on every record, not the one who closed the box            | True                      |
| K26 label record names the closing operator     | KILLED (1 tests) | whose decision it is > names the operator signed in on every record, not the one who closed the box            | True                      |
| K27 move ignores host                           | KILLED (1 tests) | decisions the job's state does not allow > leave a job alone that another pairing's decision reaches for       | True                      |
| K28 move ignores device                         | KILLED (1 tests) | decisions the job's state does not allow > leave a job alone that another pairing's decision reaches for       | True                      |
| K29 move ignores attempts                       | KILLED (1 tests) | a decision on an earlier read of the job > does not confirm the label of a later attempt that looks the same 9 | True                      |
| K30 move ignores state                          | KILLED (1 tests) | decisions the job's state does not allow > let one of two decisions on the same read win, and write one record | True                      |
| K31 every database failure is a stale job       | KILLED (1 tests) | decisions the job's state does not allow > let a database failure through as it is, not as a job that changed  | True                      |
| K32 stale job not told                          | KILLED (2 tests) | decisions the job's state does not allow > leave a job alone that another pairing's decision reaches for       | True                      |
| K33 move does not expect a change               | KILLED (2 tests) | decisions the job's state does not allow > leave a job alone that another pairing's decision reaches for       | True                      |
| K35 row keeps another reason code               | KILLED (1 tests) | printing again > writes the reprint with its reason in the write that marks the job sending                    | True                      |
| K36 record keeps another reason code            | KILLED (2 tests) | printing again > writes the reprint with its reason in the write that marks the job sending                    | True                      |
| K37 record times the reprint wrongly            | KILLED (1 tests) | whose decision it is > writes the reprint exactly: the shift, the box, the reason, the moment, no words        | True                      |
| K38 reprint of a pallet recorded as a box       | KILLED (1 tests) | a pallet's label > is not decided here: the records of a pallet are the pallets' plan's                        | True                      |
| K39 pallet check recorded as a box              | KILLED (1 tests) | a pallet's label > is not decided here: the records of a pallet are the pallets' plan's                        | True                      |
| K40 record id reused                            | KILLED (1 tests) | a decision on an earlier read of the job > gives every reprint of a box its own exception                      | True                      |
| X1 «printed» sends the label again              | KILLED (1 tests) | the label the operator sees printed > turns an unknown job into a sent one, and the check comes next when the  | True                      |
| X2 a skip sends the label                       | KILLED (4 tests) | going on without a label > skips a waiting check, a failed job and an unknown one, each with its record        | True                      |

K29 and K40 SURVIVED in the first run (`mut.log`), so tests were added ("does not confirm the label of a later attempt that looks the same", "gives every reprint of a box its own exception") and both are KILLED in `mut2.log`. Final `cmp base.ts print-resolution.ts` identical (sha256 f73c285d...cd5ab) before the JSDoc paragraph was added; the JSDoc-only edit followed. Not killable by a test (unreachable): `commit`'s `after === null` branch (the compared update just wrote the row), the `labelRecord` return type exhaustiveness.

## Totals and gates

- Plan: Task 5 -> 103 files / 2491 tests (scratch copy). Measured full run (`--testTimeout=60000 --hookTimeout=60000`): 107 files / 3152 tests passed (previous round 106 / 3116; +1 file, +36 tests). Without the raised timeout the old office suites can fail by 5 s timeouts under load 70-80; not seen with the raised one.
- New file 36 tests; with `floor-print-jobs` and `floor-print-runtime`: 3 files, 91 passed, verbose run, stderr 0 bytes, no `stderr` blocks.
- typecheck, lint: exit 0. Prettier gate: a mis-formatted scratch `test/zz-probe.ts` made it exit 1 (deleted), then the 4 changed files pass with `--ignore-path .prettierignore` from the worktree root. `git diff --check` clean; `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`. Webview build not run (nothing the shell embeds changed beyond unused-by-UI modules). `graphify update .` not available (command not found, exit 127).
- Not exercised: a real printer, COM, spooler, Tauri IPC, Windows; any UI (none in this task).

## Anchor adaptations

None. All four `printing.ts` fragments matched exactly once; the brief's `enteredShift/km/OPERATOR_ID/PAIRING/PREFIX/rows/scanContext/seedBlock` imports and `openLocalDb`, `closeOpenBox`, `processScan` exist as the brief expects.

## Self-review / concerns

1. Former printer not named (addendum 3, above) - needs a decision (migration or protocol field).
2. `printerForAgain` falls back to the purpose's printer when the job's own printer was deleted from the settings, so a job whose label may exist on the deleted printer can go to another one silently. The reason and exception are recorded; Task 6's screen should show which printer will be used before the operator confirms (the brief's `printer` parameter is the explicit choice).
3. A reason is not validated at runtime against `REPRINT_REASONS` (the type does it); a cast value would reach the outbox and could be refused by the host. Task 6 builds the reason from the buttons only.
4. `printAgain` and the other decisions must run in the work queue (hard rule from Task 4's m1) - Task 6.
5. Tests use a fresh `resolveContext` per call as the brief does; a long-lived session shares one id counter (the "every reprint" test uses one session on purpose).
