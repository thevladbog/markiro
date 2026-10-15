# 2a8 Task 1 report — the floor's box exceptions

Status: DONE_WITH_CONCERNS. Commit `146a58e44` on `claude/floor-2a7` (`/tmp/claude/wt/flr`), subject `feat(standalone): box exceptions on the floor — undo, clear, reprint and disassemble, each one write with its record`, one trailer line.

## What I did

Files: `apps/standalone/src/floor/exceptions/box-exceptions.ts` (new), `src/floor/facts.ts` (+`exceptionStatements`), `src/floor/print/print-resolution.ts` (reprintStatements delegates), `test/floor-box-exceptions.test.ts` (new, 41 tests), `test/floor-schema.test.ts` (Node query-plan pins for the new reads).

Produces (as the brief): `undoLastCode`, `clearOpenBox`, `disassembleBox`, `reprintBox`, `readClosedBoxes`, `reasonWords`, `ExceptionReason`, `OpenBoxResult`, `ReprintContext`, `ClosedBox`, `InvalidReasonError`, `BoxUnavailableError`, `LabelWaitingError`; plus exported SQL constants for the plan pins (`LAST_CODE_SQL`, `NEWEST_CODE_SCAN_SQL`, `CLOSED_BOXES_SQL`, `BOX_STATE_SQL`, `LAST_BOX_JOB_SQL`).

### Reprint reuses the 2a7 path (one reprint writer)

2a7's `printAgain` cannot take a decided box (`sent` without check / `verified` / `skipped`: it throws `UnresolvableJobError`; 2a7 final review table row: "2a8's reprint goes through a new job"). So `reprintBox` makes a new job through `prepareLabelJob` as the plan says, but the `floor_exceptions` row + `box_exception` record are written by ONE shared writer, `exceptionStatements` (moved to `facts.ts`), which 2a7's `reprintStatements` (the `printAgain` reprint exception) now also calls. Row/record are in the same transaction as the new job's insert (before any byte goes; `sending` is the next transaction, as for any first send). The former-printer audit gap stays accepted (documented in the JSDoc).

### Integrity decisions (beyond the plan text; each has a test and a mutant)

- Undo: the DELETE of the code row now demands `expectedChanges: 1` and matches code AND `scan_id` (the plan's DELETE had no expectation, so "clear + re-scan leaving the same count" would have decremented the counter without deleting the row read). Record carries the exact `scanned_at` text of that row (host rule: `added_at == targetScannedAt`); last code by rowid.
- Clear: `occurredAt` = the later of now and the newest cleared code's `scanned_at` (host removes items with `added_at <= occurredAt`; a corrected-back clock would have left the item on the host's box). In normal flows identical to now (the plan's expected value is unchanged).
- Disassemble: UPDATE guarded by closed and not-taken-apart, codes deleted (freed: the local mirror of the host's `registry::release`; nothing owns a code until the next scan), SSCC stays on the box row; item_count=count(floor_codes) invariant helper `expectCountsAgree` asserted after each exception.
- Reprint transaction now starts with two no-op guard UPDATEs (`expectedChanges: 1`): box still closed and not taken apart; the box's newest job is still the one read with no newer job. A lost comparison re-reads: box gone -> `BoxUnavailableError`, else `StaleJobError` (print-jobs). The plan had no in-transaction guard on reprint.
- Newest job of a box is chosen by rowid (insertion order), not `created_at` (clock can go back), same principle as undo; the guard compares rowids too.
- `commit` maps only `changes_mismatch` to `stale`; any other failure rejects (test with `failingWrites` for all four exceptions).
- Pairing scope: every read/delete carries host AND device; tests seed foreign pairings that differ in the host only and in the device only (`FOREIGN`), same shift and same box id.
- Module header documents N13: every function must run in the work queue and be handed to `track`.
- No `console.*` in the new code.

## RED / GREEN

- RED (reconstructed: I wrote the module before running the test file; module moved aside, restored byte-identical): `/tmp/claude/impl-2a8-t1-red.txt` — `Failed to resolve import "../src/floor/exceptions/box-exceptions.js"`.
- GREEN: `vitest run test/floor-box-exceptions.test.ts` -> 1 file, 41 tests passed; verbose run: exit 0, `grep -c "stderr |"` = 0. No React in this task, so the delayed-`setImmediate` stand does not apply.
- Related: `floor-schema`, `floor-print-resolution`, `floor-work-print`, `floor-print-jobs`, `floor-facts` -> 5 files, 171 tests passed after the refactor of `reprintStatements`.
- Full `vitest run`: 111 files / 3334 tests; 14 failed in 5 old suites under load (floor-setup 1, shift-edit 1, shifts-page 4, template-editor 6, templates-page 2) — all timeouts/load; rerun of those 5 files alone with `--testTimeout=120000`: 5 files, 288 tests passed. Plan counts (measured on its scratch copy): 107 files / 2596 tests after Task 1 (16 tests in this file); measured here: this file 41 tests, whole package 111 files / 3334 tests (tree differs from the scratch).
- Gates: `typecheck` 0, `lint` 0, prettier gate (live-proved with a mis-formatted scratch file -> exit 1; then 5 changed files clean), `git diff --check` clean, `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`, `git status --short` empty after commit. No Rust/Cargo touched.

## Mutants (all killed; each restored byte-identically — script asserts sha256 equal and `cmp`; copies under /tmp/claude/impl-2a8-t1/before-*; module sha256 at HEAD `76419928f06d6554966bd2cc4777b068f1437ea337ef37969a6e65a1a0888239`)

Plan's M1-M10 map to U1, U2, U3, C1, D1, D2, R1, R2, P9, P5. Runs: `/tmp/claude/impl-2a8-t1/run-<id>.txt`; driver `mutate.py`, definitions `mutants.json`. First pass left 5 survivors (U6, C3, D3, S2, P13: the foreign pairing differed only in the host, so a dropped device condition was invisible; the early box read of the reprint was unobservable) — tests strengthened (foreign pairings differ in host only / device only; render spy asserts a taken-apart box is refused before the label is rendered), re-run: killed.

| id  | file              | one-line mutant                                              | first failing test (count)                                                                             |
| --- | ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| U1  | box-exceptions.ts | undo record carries the undo's instant, not the scan's       | «Снять последний код» > takes out the code accepted last even when the clock went back bet (2 failing) |
| U2  | box-exceptions.ts | last code by clock                                           | «Снять последний код» > takes out the code accepted last even when the clock went back bet (1 failing) |
| U3  | box-exceptions.ts | undo does not compare the count                              | «Снять последний код» > writes nothing when a scan lands between its read and its write (1 failing)    |
| U4  | box-exceptions.ts | undo DELETE does not demand its row                          | «Снять последний код» > writes nothing when the code it read is gone and the count came ba (1 failing) |
| U5  | box-exceptions.ts | undo DELETE matches the code, not the scan                   | «Снять последний код» > writes nothing when the code it read is gone and the count came ba (1 failing) |
| U6  | box-exceptions.ts | last-code read drops the device (pairing scope)              | «Снять последний код» > takes the last code of this pairing, not a newer row of another's (1 failing)  |
| C1  | box-exceptions.ts | clear does not compare the count                             | «Очистить короб» > writes nothing when a scan lands between its read and its write (1 failing)         |
| C2  | box-exceptions.ts | clear stamped with the clock only                            | «Очистить короб» > is stamped no earlier than the newest code it takes out, whatever the c (1 failing) |
| C3  | box-exceptions.ts | clear DELETE drops the device                                | «Очистить короб» > takes the codes of this pairing only, though another's lie under the sa (1 failing) |
| C4  | box-exceptions.ts | clear does not zero the counter                              | «Очистить короб» > takes every code out of the open box, which stays open for the next one (3 failing) |
| D1  | box-exceptions.ts | disassemble twice                                            | «Расформировать короб» > takes a box apart once when two disassemblies of it race (1 failing)          |
| D2  | box-exceptions.ts | disassemble keeps the codes                                  | «Расформировать короб» > leaves the codes of another pairing in the same box id alone (2 failing)      |
| D3  | box-exceptions.ts | disassemble DELETE drops the device                          | «Расформировать короб» > frees the codes of this pairing only, though another's lie under (1 failing)  |
| R1  | box-exceptions.ts | words with any reason                                        | «Перепечатать этикетку» of a box whose label is done with > refuses a reason of the other (2 failing)  |
| R2  | box-exceptions.ts | UTF-16 length                                                | the words of a reason > are trimmed, at most 200 code points, and never hold a control cha (1 failing) |
| R3  | box-exceptions.ts | control characters allowed                                   | the words of a reason > are trimmed, at most 200 code points, and never hold a control cha (1 failing) |
| R4  | box-exceptions.ts | blank words kept as empty text                               | the words of a reason > are trimmed, at most 200 code points, and never hold a control cha (2 failing) |
| R5  | box-exceptions.ts | words not trimmed                                            | the words of a reason > are trimmed, at most 200 code points, and never hold a control cha (4 failing) |
| R6  | box-exceptions.ts | any reason code                                              | «Перепечатать этикетку» of a box whose label is done with > refuses a reason of the other (2 failing)  |
| R7  | box-exceptions.ts | raw words sent                                               | «Перепечатать этикетку» of a box whose label is done with > keeps the words of `other` in (3 failing)  |
| L1  | box-exceptions.ts | list shows boxes taken apart                                 | the closed boxes of a shift > are listed with the box closed last first, without a box tak (2 failing) |
| L2  | box-exceptions.ts | list oldest first                                            | the closed boxes of a shift > are listed with the box closed last first, without a box tak (1 failing) |
| L3  | box-exceptions.ts | list drops the device                                        | the closed boxes of a shift > are listed with the box closed last first, without a box tak (1 failing) |
| L4  | box-exceptions.ts | list drops the shift                                         | the closed boxes of a shift > are listed with the box closed last first, without a box tak (1 failing) |
| S1  | box-exceptions.ts | box read drops the shift                                     | «Расформировать короб» > refuses an open box, a box taken apart and another shift's box, w (1 failing) |
| S2  | box-exceptions.ts | box read drops the device                                    | «Расформировать короб» > refuses a box of another pairing, though it is closed in this ver (1 failing) |
| S3  | box-exceptions.ts | open box passes as closed                                    | «Расформировать короб» > refuses an open box, a box taken apart and another shift's box, w (1 failing) |
| S4  | box-exceptions.ts | box taken apart passes                                       | «Перепечатать этикетку» of a box whose label is done with > refuses a box taken apart, an (3 failing)  |
| P1  | box-exceptions.ts | no guards at all                                             | «Перепечатать этикетку» of a box whose label is done with > prints once when two reprints (2 failing)  |
| P2  | box-exceptions.ts | box guard of the reprint drops 'not taken apart'             | «Перепечатать этикетку» of a box whose label is done with > writes nothing when the box is (1 failing) |
| P3  | box-exceptions.ts | job guard sees no newer job                                  | «Перепечатать этикетку» of a box whose label is done with > prints once when two reprints (1 failing)  |
| P4  | box-exceptions.ts | newest job by clock                                          | «Перепечатать этикетку» of a box whose label is done with > takes the newest job of the bo (1 failing) |
| P5  | box-exceptions.ts | reprint of a waiting label                                   | «Перепечатать этикетку» of a box whose label is done with > refuses a box whose label stil (3 failing) |
| P6  | box-exceptions.ts | other revision of the template                               | «Перепечатать этикетку» of a box whose label is done with > refuses a box whose job was ma (1 failing) |
| P7  | box-exceptions.ts | reprint without the job's fields                             | «Перепечатать этикетку» of a box whose label is done with > keeps the job `failed` when no (8 failing) |
| P9  | box-exceptions.ts | exception after the send, own transaction                    | «Перепечатать этикетку» of a box whose label is done with > writes the job and the reprint (1 failing) |
| P10 | box-exceptions.ts | lost comparison on a taken-apart box reported as a stale job | «Перепечатать этикетку» of a box whose label is done with > writes nothing when the box is (1 failing) |
| P12 | box-exceptions.ts | reprint with another SSCC                                    | «Перепечатать этикетку» of a box whose label is done with > prints again a label that was (3 failing)  |
| P13 | box-exceptions.ts | reprint does not read the box                                | «Перепечатать этикетку» of a box whose label is done with > refuses a box taken apart, an (1 failing)  |
| W1  | box-exceptions.ts | every failure reported as stale                              | «Очистить короб» > rejects, rather than call it stale, when the write itself fails (4 failing)         |
| X1  | facts.ts          | row swaps code hash and instant                              | «Снять последний код» > takes out the code accepted last even when the clock went back bet (2 failing) |
| X2  | facts.ts          | row drops the words                                          | «Перепечатать этикетку» of a box whose label is done with > keeps the words of `other` in (2 failing)  |
| X3  | facts.ts          | row kind altered                                             | «Снять последний код» > frees the code: scanned again, it is accepted, not a duplicate (5 failing)     |
| U7  | box-exceptions.ts | undo does not demand an open box                             | «Снять последний код» > writes nothing when the box closes between its read and its write (1 failing)  |
| C5  | box-exceptions.ts | clear does not demand an open box                            | «Очистить короб» > writes nothing when the box closes between its read and its write (1 failing)       |

Equivalent (no test can kill; stated, not hidden): the `host_id/device_id` conditions in the `UPDATE ... WHERE id = ?` statements (the id is the table's primary key, and the preceding pairing-scoped read already refused a foreign box); the `shift_id` of the disassemble UPDATE (a box's shift never changes); state/attempts of the last job in the reprint guard (a decided job never changes, so the guard compares by rowid position instead).

## Anchor adaptations

- The plan's code used its own `exceptionStatements` local to `box-exceptions.ts`; moved to `facts.ts` (exported, row id taken before the record id, which is 2a7's order) so 2a7's `reprintStatements` shares it; `print-resolution.ts` import line changed accordingly. Everything else in the plan's step 1/3 text applied by meaning with the additions above; test file is the plan's 16 tests plus 25 more (foreign pairings, races, clock, reprint states, error mapping). No anchor mismatch in existing files (new files only; `facts.ts`, `print-resolution.ts`, `floor-schema.test.ts` edits were mine by meaning).

## Concerns / for the controller

1. **Shell query-plan list not extended** (`apps/standalone/src-tauri/tests/local_db.rs::the_floors_repeating_reads_search_an_index` and the text-parity statement list in `test/floor-schema.test.ts`): forbidden path for me. 2a6 addendum item 5 says a new repeated read gets a line in BOTH lists. Needed lines (index each plan must name, measured on node:sqlite 3.53): `LAST_CODE_SQL` and `NEWEST_CODE_SCAN_SQL` -> `floor_codes_box (host_id=? AND device_id=? AND box_id=?)`; `CLOSED_BOXES_SQL` -> `floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?`; `BOX_STATE_SQL` -> `sqlite_autoindex_floor_boxes_1 (id=?)`; `LAST_BOX_JOB_SQL` -> `floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)`. The Node list has them now; I did not add the constants to the parity test (it requires the Rust text to exist). SQLite 3.46 plan unverified.
2. `LAST_CODE_SQL` uses a temp B-tree for `ORDER BY rowid` over one box's codes (capacity-sized); the other new reads have none.
3. A job made from another template revision than the shift snapshot now holds (re-entry overwrote the snapshot) is refused with `BoxUnavailableError`, as in the plan; its message ("not a closed box of the shift") misleads in that case. Task 2 may want a dedicated error; I did not add one (screen contract lists three errors).
4. The model lets a box with a WAITING label be disassembled (host accepts `box_label` for a disassembled box); Task 2's gate ("exceptions closed while a label waits") is what keeps the panel order.
5. The clear's DELETE has no row-count expectation (it relies on the item_count compare); an inconsistent box (counter != codes) would still clear. Invariant asserted in tests, not enforced in SQL.
6. Reprint's early box read is a cheap fast path before rendering (killed by a render-spy test), the guard is the actual protection.
7. Rust/hardware/browser not exercised (none touched).
