# 2a8 Task 5 report — the receipt closes the shift, a refused close is shown, the list follows the outbox

Status: DONE_WITH_CONCERNS. Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `564cffa1f`.
Commit: `b5357b43e` feat(standalone): the host's receipt closes the shift on the station; the list follows the outbox and names a refused close (one trailer; `git status --short` empty after).
Evidence: `/tmp/claude/impl-2a8-t5/` (RED `/tmp/claude/impl-t5-red.txt`, GREEN `g2.txt`/`g3.txt`/`full2.txt`, driver `mutate.py`, `mut1..4.txt`, `cargo-mut.txt`, snapshots `before/`).

## 1. What I did

- `facts-sender.ts`: `receiptStatements` gets a 4th operator: `closing` -> `closed` for the shift whose `shift_closed` record got `accepted` in this batch (`alreadyClosed` is an `accepted`). Refused / receipt-less close stays `closing`. Docs of `receiptStatements`/`sendFactBatch` updated.
- `shift-close.ts`: `readRefusedCloses(local, pairing): Map<shiftId, code|null>`.
- `ShiftList`: reads copies and refusals together (`Promise.all`), re-reads on `outboxVersion`; `ShiftCard`: `refusal` prop prints `floor.shifts.closeRefused` (shown only for a shift that is `closing` here and has a refused close). `FloorApp`/`App` pass `outboxVersion`. `ru.json`: `floor.shifts.closeRefused`.
- Tests: the three brief tests (+ extra ones, below), app test uses the executed wording «Смена закрыта на этой станции. Данные будут отправлены автоматически.».
- `floor-schema.test.ts` (count 5 -> 6, plan assertions for the new statement) and `src-tauri/tests/local_db.rs` (plan pin, 36 -> 37 reads): see Deviation 1.

## 2. Anchor adaptations (mechanical)

- Dispatch note 1: the app test asserts the executed done text «Смена закрыта на этой станции. Данные будут отправлены автоматически.» (`floor.close.done.body`).
- `facts-sender.test.ts`: `SECOND` is already imported (kept in place), only `ENTERED` added; `ShiftListProps`/`Options` has `onSetup` after `enter` (outboxVersion added after `enter`); `receiptStatements` is a separate function in the executed code (the 4th operator goes into its array; the brief's anchor was `sendFactBatch`'s inline transaction).
- `floor-shift-list.test.tsx` racy-read test («shows the newest read of its copies when an older one lands last») counted every `query`; the list now issues a second query (refusals), so the wrapper counts only the `FROM floor_shifts` read. Intent unchanged.
- App test: the executed panels guard presses 400 ms after a view change (Task 4/2a7), and the confirm of «Продолжить без этикетки» needs a second view; the brief's bare `fireEvent.click`s were ignored. The test spies `performance.now` (offset moved by `afterPause` before each press; restored in `finally`), no waiting. `afterPause` returns the button and the click is the last sync step before the next `findBy*` (an awaited helper after the click gave an `act(...)` warning for `App`/`FloorApp`).

## 3. Deviations from the brief (each tested, each killed by a mutant)

1. **The brief's SQL has a performance defect; the plan-pin lists were not in the brief.** The brief's 4th statement plans as `SEARCH outbox USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)` — every accepted record of the pairing for each batch (the very defect `receiptStatements`' doc names, 9 s at 100,000 records). Fixed with the file's own convention: `+host_id`, `+device_id`, `+outcome` in the subquery -> `SEARCH outbox USING INDEX sqlite_autoindex_outbox_1 (id=?)` (Node SQLite 3.53 and the shell's 3.46). Consequences, all test-only: `test/floor-schema.test.ts` (`receiptStatements` length 5 -> 6 in the "pinned on the shell's SQLite" test and a plan check for the 4th statement incl. the "no slow index" loop) and `src-tauri/tests/local_db.rs` (new read in `the_floors_repeating_reads_search_an_index`, 36 -> 37). Without these the full Vitest run was red (`floor-schema.test.ts:910`). `src-tauri/tests/local_db.rs` is outside the brief's file list: please confirm.
2. Extra tests beyond the brief: stray receipts of other kinds in the same batch, a settled refusal of another pairing, a shift not `closing` with a `shift_closed` receipt, a refusal shown only for a `closing` shift, a refusal without a code («код —»).

## 4. RED / GREEN

- RED (`/tmp/claude/impl-t5-red.txt`, before the implementation): the 3 new tests failed — facts-sender (`closing` instead of `closed`), floor-shift-list (no refusal text), app test (failed earlier at the 400 ms guard: wrong reason, the test was then adapted as in section 2; with the implementation removed — mutant M1 — it fails on «Закрывается» staying in the list).
- GREEN: `vitest run test/app.test.tsx test/facts-sender.test.ts test/floor-shift-list.test.tsx test/floor-schema.test.ts` -> 4 files, 220 tests, `stderr |` count 0 (verbose). Brief: 3 files / 130 tests on the scratch copy; measured on the real tree 3 files / 192 tests (+ floor-schema 28).
- Delayed-`setImmediate` stand (3 ms), 3 runs of app + floor-shift-list + facts-sender: 192 passed each; 1 `stderr` each = an `act(...)` warning in the EXISTING test «shows the host's refusal of an entry and the lost link together» (floor-shift-list). Same warning with the pre-task `ShiftList.tsx` (checked), so not caused by this task. Stand files deleted.
- Full package (`--testTimeout=60000 --hookTimeout=60000`): 114 files, 3493 tests, all passed (before the task 114 / 3488 per the Task 4 report: +5 tests, +0 files; plan: 110 / 2629 on the scratch copy).
- `cargo test -p markiro-standalone --test local_db`: 27 passed (outside the sandbox); `cargo fmt --check` clean. No Rust source changed, only the test pin; full `--workspace` run NOT done (host and proto untouched).
- Gates: typecheck 0, lint 0, build 0, prettier gate live-proved (probe `src/zz-probe.ts` flagged, exit 1; real files clean, exit 0), `git diff --check` clean, `grep -rnF '\u04'` only `pairing-code.ts:66`.

## 5. Mutants (driver `mutate.py`; every file restored from `before/`, `cmp` + sha256 equal, `touch`ed; no restore failure)

| #   | Mutant                                                      | Killed by                                                                                                                                            |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | 4th operator removed                                        | facts-sender «makes the station's close closed…»; app test (list keeps «Закрывается»)                                                                |
| M2  | refusal also closes (`+outcome IS NOT NULL`)                | facts-sender «makes the station's close closed…»                                                                                                     |
| M3  | `outboxVersion` dropped from the list's effect deps         | floor-shift-list «says a close the host refused, and lets a close go…»                                                                               |
| M4  | refusal paragraph removed from `ShiftCard`                  | floor-shift-list (both refusal tests)                                                                                                                |
| M5  | `App` does not pass `outboxVersion`                         | app test                                                                                                                                             |
| M6  | `FloorApp` does not pass it on                              | app test                                                                                                                                             |
| M7  | outer UPDATE not filtered by device                         | facts-sender (other pairing's `closing` row)                                                                                                         |
| M8  | any accepted record kind closes                             | facts-sender (accepted scan of a refused-close shift)                                                                                                |
| M9  | `local_state = 'closing'` guard dropped                     | facts-sender (working shift, stray receipt)                                                                                                          |
| M10 | `readRefusedCloses`: any kind                               | facts-sender (rejected scan)                                                                                                                         |
| M11 | `readRefusedCloses`: any outcome                            | facts-sender                                                                                                                                         |
| M12 | `readRefusedCloses`: any device                             | facts-sender (other pairing's settled refusal)                                                                                                       |
| M13 | refusal shown for a shift not `closing`                     | floor-shift-list                                                                                                                                     |
| M14 | code dash dropped                                           | floor-shift-list «…without a code with a dash»                                                                                                       |
| M15 | refusal code always `null`                                  | floor-shift-list                                                                                                                                     |
| M16 | pluses dropped (planner walks `outbox_settled`)             | floor-schema «serve the reads…» and «are pinned on the shell's SQLite…»                                                                              |
| M17 | sender text changed, shell's list not                       | floor-schema «are pinned on the shell's SQLite…»                                                                                                     |
| M18 | `local_db.rs` entry without pluses (cargo, outside sandbox) | `the_floors_repeating_reads_search_an_index` («should search sqlite_autoindex_outbox_1 … its plan is … outbox_settled …»); restored, sha `4c7cf88e…` |

Equivalent today, not killed: dropping the batch restriction `id IN (SELECT value ->> 'id' FROM json_each(?))` from the 4th statement (no state in which a `closing` shift already has an accepted close).

## 6. Concerns

1. Deviation 1 touches `src-tauri/tests/local_db.rs` and `test/floor-schema.test.ts`, which the brief does not list; the SQL differs from the brief by three unary pluses. Both are required to keep the suite green and the statement off `outbox_settled`.
2. The refusal text is on the card of a `closing` shift only; a refused close stays on the list until the office closes it (ВП2 of the plan).
3. Not exercised: real WebView2, a live host. Task 6 (`officeClosed`) and 7 (retention) are untouched.
