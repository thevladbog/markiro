# 2a8 Task 7 report — a shift's records leave the station 30 days after the host took its close

Status: DONE_WITH_CONCERNS. Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `489874b19`.
Commit: `e78616575` feat(standalone): a shift's records leave the station 30 days after the host took its close (one trailer; `git status --short` empty after).
Evidence dir: `/tmp/claude/impl-2a8-t7/` (driver `mutate.py`, results `mut.txt`/`all.out`, snapshots `before/`, RED `red.txt`, GREEN `green1.txt`, `g2.txt`, verbose `verbose.txt`, delay stand `delay.txt`, full `full-vitest.txt`, `cargo-full.txt`).

## 1. What I did

- `src/local/retention.ts` (new): brief verbatim (`RETENTION_DAYS/MS`, `RETENTION_INTERVAL_MS`, `RETAINED_TABLES` incl. `floor_print_jobs`, `DONE_WITH`, `purgeAcknowledged`, `Every`, `scheduleRetention`). Beyond the brief: the three statement texts are exported (`DUE_SHIFTS_SQL`, `PURGE_COPY_SQL`, `purgeTableSql(table)`) so the plan pins use the real text; `purgeAcknowledged` uses them (same SQL, same values, same `expectedChanges: 1`; brief mutant fragments M1-M7 still apply textually).
- `App.tsx`: the retention effect, brief verbatim.
- Tests: `test/retention.test.ts` (brief's 8 tests verbatim + 15 more), `test/app.test.tsx` (brief test, adapted; + 3), plan pins in `test/floor-schema.test.ts` and `src-tauri/tests/local_db.rs`.

## 2. Anchor adaptations

1. `app.test.tsx` fragment 2: the executed tail of the "operator on the floor" describe is a `try/finally` test, not the brief's `waitFor(...Закрывается...)` + `});` pair; the new test was inserted by meaning before the describe's closing `});`. `OPENED` is in scope there.
2. The brief's app test was strengthened: it also seeds a `rejected` scan record so the status bar shows «Отклонено хостом» = 1, gates the purge (the `DELETE FROM floor_shifts` transaction) until the bar has counted, then requires the bar to drop to 0 (proves `outbox_changed` was dispatched), and mounts the floor with the people feed (`feedPage(42, PEOPLE)`, `PROMPT`).

## 3. RED / GREEN

- RED (`red.txt`, `retention.ts` moved away): `test/app.test.tsx` and `test/retention.test.ts` both `Failed to resolve import ".../retention.js"`, 2 files failed, no tests.
- GREEN with the brief's tests only: `app.test.tsx` + `retention.test.ts` → 2 files, 134 passed (brief: 111 on the scratch copy). Final: retention 23, app 129 (with the 4 new/changed), floor-schema 28.
- Verbose (`app`, `retention`, `floor-schema`): 3 files, 180 passed, `stderr |` count 0. Delayed-`setImmediate` stand (3 ms) on app + retention: 2 files, 152 passed; the two stand files deleted.
- Full package (`--testTimeout=60000 --hookTimeout=60000`): 115 files, 3522 passed (before: 114 / 3495 at Task 6; plan 111 / 2641 on the scratch copy).
- Gates: typecheck 0, lint 0, build 0, prettier gate (live proof: probe `src/zz-probe.ts` flagged, exit 1, deleted; the 5 changed TS/TSX files clean), `git diff --check` clean, `grep -rnF '\u04'` only `pairing-code.ts:66`.
- Rust (touched: `src-tauri/tests/local_db.rs`): `cargo fmt --check` clean, `cargo check --workspace --all-targets` 0 warnings, FINAL FULL `cargo test --offline --locked --workspace` run unsandboxed: exit 0, 53 test-result lines, 813 passed, 0 failed.

## 4. Plan pins (Node SQLite 3.53 AND shell SQLite 3.46)

New statements: `DUE_SHIFTS_SQL`, `PURGE_COPY_SQL`, six per-table deletes. Measured plans (identical on both SQLite versions, no unary-plus forcing needed):

- Due select / copy delete: `floor_shifts` by its key (`host_id, device_id[, id]`), `outbox_unsent` (host, device), `outbox_settled` (host, device, outcome), `floor_print_jobs_shift` (host, device, shift); no `SCAN`, no TEMP B-TREE.
- Deletes: `floor_scans_shift`, `floor_codes_shift`, `floor_print_jobs_shift`, `floor_boxes_shift` use the shift index. **`outbox` and `floor_exceptions` have no index by shift: `SCAN outbox` / `SCAN floor_exceptions`.** Pinned as exactly that one scan (a concern, below).
- `test/floor-schema.test.ts`: plan test extended (both statements, each table's delete, the two known scans); the "pinned on the shell" test also requires the Rust file to contain the six texts word for word (two as `const DUE_SHIFTS`/`PURGE_COPY`, four as literals) and the `for table in ["outbox", "floor_exceptions"]` format string. `local_db.rs`: `reads` 37 → 49 entries (`DUE_SHIFTS` ×4 indexes, `PURGE_COPY` ×4, four indexed deletes) plus a separate loop pinning the two whole-table reads.

## 5. Mutant table (driver `mutate.py`; each restored from `before/`, `cmp` + sha256 equal, `touch`ed; all `restore True`)

| Guard             | Mutant (one line)                                                                                                       | Killed by (key test)                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| age cutoff        | M1 `cutoff = now`; M1b `<=` → `<`; M1c 31 days                                                                          | "deletes a shift 30 days after…" (M1b/M1c: 4 tests)                                                                                                                                                                                              |
| closed-only       | M2 `outcome IS NOT NULL`; M2b drop `kind='shift_closed'`; M2c EXISTS drops shift link; M2d/M2e EXISTS drops device/host | "keeps a shift whose close the host refused…"; "does not take a shift that has no close of its own…" (M2b, added); "takes only the shift that is done with…" (M2c, added); "is not made due by another pairing's accepted close…" (M2d/e, added) |
| unanswered record | M3 guard removed; M3b/M3c/M3d drop shift link/device/host                                                               | "keeps a shift with a record not yet answered…"; "takes only the shift…" (M3b); "is not held back by another pairing's unanswered record…" (M3c/d, added)                                                                                        |
| waiting label     | M4 guard removed; M4b/M4c/M4d drop shift/device/host; M4e only `unknown`                                                | 7 failing incl. the `it.each` label states (M4, M4e); "takes only the shift…" (M4b); "is not held back by another pairing's…" (M4c, M4d — M4d first SURVIVED, test strengthened: other-host label now set too)                                   |
| tables            | M5 each of the 6 tables missing from `RETAINED_TABLES`                                                                  | 21 failing each (`WHOLE`/`NONE` counts, schema test)                                                                                                                                                                                             |
| delete scope      | M5b no shift; M5c no device; M5d no host                                                                                | "deletes only its own pairing's rows…" (c, d: added), M5b: 4 tests                                                                                                                                                                               |
| outer scope       | M7f no host; M7g no device                                                                                              | same + "leaves another pairing's rows alone"                                                                                                                                                                                                     |
| guarded copy      | M7 no `expectedChanges`; M7e copy delete unguarded                                                                      | "keeps a shift that took a record between its reading and its delete"                                                                                                                                                                            |
| error handling    | M7b swallow any error; M7c swallow any `LocalDbError`; M7d count before the transaction                                 | "passes on a failure that is not a shift taking a record meanwhile…" (added); M7d: 9 tests                                                                                                                                                       |
| cascade order     | M7h copy deleted last; M7i tables in an earlier transaction                                                             | 9 failing each (H: the guard sees no close → never purged; I: the race test)                                                                                                                                                                     |
| scheduler         | M6 no running guard; M6b/M6c running stuck after failure/success; M6d no first pass; M6e interval 2 h                   | "runs at once and then every hour…", "runs again after a pass that failed"                                                                                                                                                                       |
| App               | M8 not run; M8b no cleanup; M8c no `outbox_changed`; M8d runs unpaired; M8e dispatches on 0; M8f frozen clock           | app tests (M8c, M8e via the gated status-bar test; M8b via the `setInterval/clearInterval` spy; M8d "not paired"); M8e first SURVIVED, test added                                                                                                |
| plan pins         | P1 `NOT INDEXED` in `DUE_SHIFTS_SQL`; Rust: scan-pin loop gets `floor_codes`; Rust: expected index renamed              | `floor-schema` (2 failed), cargo `the_floors_repeating_reads_search_an_index` ×2                                                                                                                                                                 |

Not killed: dropping `ORDER BY s.id` (output order only, no behaviour to assert); `acked_at IS NULL` ↔ `outcome IS NULL` (equivalent by the table CHECK).

## 6. Test totals

Plan: 111 files, 2641 (scratch copy). Measured: 115 files, 3522 (this tree has more files). This task added: retention 23 tests (brief 8 + 15), app +3 (brief 1 + 3 added incl. hourly/cleanup, not-paired, gated no-change), floor-schema pins in 2 existing tests.

## 7. Files changed

`apps/standalone/src/local/retention.ts` (new), `src/app/App.tsx`, `test/retention.test.ts` (new), `test/app.test.tsx`, `test/floor-schema.test.ts`, `src-tauri/tests/local_db.rs`.

## 8. Concerns

1. **Cost of the brief's SQL on a large outbox (measured plans, not timed).** `DONE_WITH`'s accepted-close `EXISTS` walks `outbox_settled` (every accepted record of the pairing) per shift (stops at the shift's close, the last record), and the two `DELETE … shift_id` statements on `outbox` and `floor_exceptions` read the whole table; there is no index by shift and migrations are out of scope. With ~30 days of history (hundreds of thousands of rows) the hourly select costs shifts × rows; a purged shift costs a full `outbox` read inside a write transaction. Left as in the brief and pinned honestly; a later migration with an `outbox (host_id, device_id, shift_id)` index (or restructuring the close lookup as one `IN (SELECT shift_id …)`) would fix it. Needs an owner decision.
2. `RETENTION_MS` is a fixed 30×24 h (DST-free UTC instants, as `acked_at` is).
3. Not exercised: the real Tauri shell executing the delete on a station with a large history; real WebView2.
4. `graphify update .` not run.

---

# Fix report (review Important 1: the hourly due reading cost shifts x records)

Status: DONE. Commit `c765f9890` fix(standalone): the hourly retention reading walks the accepted records once, not once per shift (base `e78616575`, one trailer, `git status --short` empty). Evidence dir `/tmp/claude/impl-2a8-t7/fix/` (`mutate.py`, `mut.txt`/`mut2.txt`/`mut3.txt`, `timing.txt`, `v.txt`, `full.txt`, `cargo-final.txt`).

## Deviation from the plan (plan-mandated SQL replaced)

The brief's `DUE_SHIFTS_SQL` (`SELECT s.id FROM floor_shifts s WHERE ${DONE_WITH} ORDER BY s.id`) is replaced; `DONE_WITH` and `PURGE_COPY_SQL` are untouched (the delete of one already-due shift stops early at its close). New text, same parameters (host, device, cutoff) and the same conditions:
`SELECT DISTINCT o.shift_id AS id FROM outbox o WHERE o.host_id = ? AND o.device_id = ? AND o.outcome = 'accepted' AND o.kind = 'shift_closed' AND o.acked_at <= ? AND EXISTS (copy by host/device/id) AND NOT EXISTS (unanswered record of the shift, `u`) AND NOT EXISTS (open job of the shift, `OPEN_JOB_SQL`)`.
`ORDER BY` dropped (nothing relied on it; `DISTINCT` uses `USE TEMP B-TREE FOR DISTINCT`); `DISTINCT` is needed because a shift may hold more than one accepted close. Record this in the plan's «Отклонения при исполнении» (Task 9) together with the two pins edited earlier.

## Measured

Same shape as the reviewer's (node:sqlite 3.53, real 0006/0007 schema via the test support, 600 000 outbox rows, 70 shifts, 67 due): **60 ms** (`timing.txt`; old shape 6.5 s per the review). Plan, both SQLite versions, identical:

```
SEARCH o USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)
CORRELATED SCALAR SUBQUERY … SEARCH u USING INDEX outbox_unsent (host_id=? AND device_id=?)
CORRELATED SCALAR SUBQUERY … SEARCH j USING INDEX floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)
SEARCH s EXISTS USING COVERING INDEX sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)
USE TEMP B-TREE FOR DISTINCT
```

## Pins (both lists)

- `test/floor-schema.test.ts` (Node 3.53): the due select's plan must START with `SEARCH o USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)`, contain `outbox_settled` exactly once, no `SCAN`, and the only `TEMP` line is `USE TEMP B-TREE FOR DISTINCT`. The loop over `DUE_SHIFTS_SQL`/`PURGE_COPY_SQL` keeps the index keys (the copy key is now `... AND id=?` for both) and no SCAN; `PURGE_COPY_SQL` must have no TEMP. The shell-text pin finds the new text in the Rust file word for word.
- `src-tauri/tests/local_db.rs` (shell 3.46): `DUE_SHIFTS` const replaced by the new text; the `reads` list entries updated; a new block after the loop asserts the same three things (first step, one `outbox_settled`, only the DISTINCT temp) on the shell's SQLite.

## Tests added (beyond the 23 + the earlier pins)

`test/retention.test.ts` +12 tests (23 -> 35 incl. 8 `it.each` rows) in a new describe «the reading of the shifts that are done with», reading `DUE_SHIFTS_SQL` DIRECTLY (helper `dueIds`): because the guarded `PURGE_COPY` re-checks everything, a reading that is too wide would otherwise be invisible (the purged count stays the same, `changes_mismatch` swallowed). Cases: mixed neighbours (refused close, unanswered record, unknown label); 30-day boundary inclusive / +1 ms / close of another kind; a shift with two accepted closes answered once and a close whose copy is gone; other pairings' copies, unanswered records, labels and accepted closes (outer scope and every subquery's host/device link); the eight label states (five open, three not).

## Mutants (one line each; file copied first, restored from the copy, `cmp` + sha256 equal for all, `touch`ed for Rust)

Run 1 with retention + floor-schema, run 2 (`mut3.txt`) with `retention.test.ts` ALONE to show the behavioural kill; P* only by the pins.

| Mutant                                                                                                                                                                              | Killed by (behaviour test, retention.test.ts)                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 `<=` -> `<`                                                                                                                                                                      | «holds the 30 days inclusive…» (+ 3 pass tests)                                                                                                                        |
| D1b drop the age bound                                                                                                                                                              | «answers a shift once…», «answers exactly the shifts…»                                                                                                                 |
| D2 any receipt instead of `accepted`                                                                                                                                                | «answers exactly the shifts…», «looks for the copy, the records…»                                                                                                      |
| D3 drop `kind = 'shift_closed'`                                                                                                                                                     | «holds the 30 days inclusive, and takes only a record of the close's own kind»                                                                                         |
| D4 copy: no shift link / D4b no device / D4c no host / D4d no copy guard                                                                                                            | «answers a shift once…and only a shift whose copy is here», «looks for the copy…»                                                                                      |
| D5 unanswered guard removed / D5b no shift link / D5c no device / D5d no host                                                                                                       | «answers exactly…», «takes only the shift…», «looks for the copy…», «is not held back by another pairing's…»                                                           |
| D6 label guard removed / D6b no shift link / D6c no device / D6d no host                                                                                                            | same set                                                                                                                                                               |
| D6e labels: only `unknown` (FIRST SURVIVED -> the 8 label-state `it.each` rows added)                                                                                               | «reads a shift whose label is prepared/sending/failed/sent and waiting… as due: false»                                                                                 |
| D7 outer no host / D7b no device (FIRST killed only by the plan pin; test data fixed: other pairings' unanswered/label edits had also blocked the refused shift -> now behavioural) | «looks for the copy, the records and the labels of the pairing only»                                                                                                   |
| D8 no `DISTINCT`                                                                                                                                                                    | «answers a shift once…», plan pins                                                                                                                                     |
| P1 `+o.outcome` (steered off `outbox_settled`)                                                                                                                                      | floor-schema «serve the reads…» and shell-text pin                                                                                                                     |
| P2 `NOT INDEXED` on the walk                                                                                                                                                        | same two                                                                                                                                                               |
| P3 the old per-copy shape as `DUE_SHIFTS_SQL`                                                                                                                                       | same two                                                                                                                                                               |
| R1 (Rust) expected first step renamed                                                                                                                                               | cargo `the_floors_repeating_reads_search_an_index`: «the due select should start from the settled records»                                                             |
| R2 (Rust only) `+o.outcome` in the const                                                                                                                                            | cargo «should search outbox_settled (host_id=? AND device_id=? AND outcome=?), its plan is [… outbox_settled (host_id=? AND device_id=?)]» AND the Node shell-text pin |
| R4 (Rust only) const without `DISTINCT`                                                                                                                                             | cargo «left: []» (temp assertion) AND the Node shell-text pin                                                                                                          |

All 21 DUE mutants plus the 3 pin mutants and 3 Rust mutants killed; the old M1-M8 mutants of the first report that touch only `DONE_WITH`/`PURGE_COPY_SQL`/the pass are unchanged (the 23 original tests still pass untouched).

## Gates

typecheck 0; lint 0; prettier gate live (probe flagged, exit 1, deleted; 3 changed TS files clean); `cargo fmt --check` 0; `git diff --check` clean; `grep '\u04'` only `pairing-code.ts:66`; verbose `retention` + `floor-schema`: 2 files, 63 passed, stderr empty (0 bytes); `cargo test -p markiro-standalone --test local_db` (unsandboxed): 27 passed; `cargo check --workspace --all-targets`: 0 warnings; final full Vitest (`--testTimeout=60000 --hookTimeout=60000`): 115 files, 3534 passed (was 3522: +12).

## Concerns

1. The carried Minors (full-scan deletes on `outbox`/`floor_exceptions`, `secure_delete` WAL cost, refused records purged after 30 days, wrong clock, silent failures, forgotten pairing, nits) are untouched, as instructed.
2. Not exercised: the real Tauri shell on a large history; the 60 ms is Node SQLite on this Mac (shell 3.46 gives the identical plan, not timed). `graphify update .` not run.
