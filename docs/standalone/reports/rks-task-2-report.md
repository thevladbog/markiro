# Plan РК-С, Task 2 — report

Status: DONE_WITH_CONCERNS (concerns are design notes for later tasks, none blocks). Commit `91a49c1f4` on `claude/floor-2a7` at /tmp/claude/wt/flr, base `0b2bb9c0c`. Tree clean after the commit.

## What was done

- Shell migration `0009_restore_epochs.sql` (verbatim from the brief): `floor_restore_epochs(host_id, device_id, epoch, seen_at, reconciled_at, refused)`, PK `(host_id, device_id)`, `TableClass::Disposable` in `TABLE_CLASSES`. `0007`/`0008` were taken (2a7/ПЛ-Ц), `0009` was free. The runtime "list/journal" is `sqlx::migrate!("./migrations")` (no separate list): the journal is checked by the new upgrade test.
- `src/local/restore-reconcile.ts` (brief code, one refactor: the SQL texts are exported constants `NOTE_SQL`, `DUE_SQL`, `STATUS_SQL`, `BLOCKS_SQL`, `RETIRE_SQL`, `REOPEN_SQL`, `SETTLE_SQL` so the plans can be pinned), `FROM_ZERO_SQL` and the `from_zero` branch in `reference-sync.ts`, `HostApi.registerKnownBlocks`, fake in `test/support/office.tsx`.
- Deviation (semantically neutral): `REOPEN_SQL` has `AND outcome IS NOT NULL`. `outbox` has `CHECK ((outcome IS NULL) = (acked_at IS NULL))`, so no row differs, but the planner can then search the partial `outbox_settled` index (`SEARCH outbox USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome>?)`) instead of scanning the whole outbox. Pinned on both SQLites.

## Data-integrity analysis (blocks, resend, feed)

- Blocks: read once per run from the pairing's own rows, used up and pallet ones included, `ORDER BY received_at, block_id`, chunks of 64 disjoint (a test sends 130 blocks as 64+64+2 and proves each id once and the set equal to the table). Fields are sent as stored; nothing is invented (only DB rows) and nothing is moved by sending. The answer is checked by count (both too short and too long) and by id of each result before anything is written.
- Refused blocks: retired only after the answer, in their own transaction: `next_serial = to_serial + 1` (monotonic, the row stays, never deleted, never reused). Retired blocks stay visible: `refused` count in `floor_restore_epochs` (status bar in Task 3), rows intact for support. A box already closed with a serial of such a block keeps its SSCC; its fact is later rejected `sscc_not_issued` and shows in the existing rejected count (no silent loss). A partial run (a later chunk fails) leaves earlier refusals retired and the obligation open; the next run asks again.
- Resend: one transaction `FROM_ZERO` + reopen + settle with `expectedChanges: 1` on the epoch read and `reconciled_at IS NULL`. A later epoch noted meanwhile, or a second run that settled first, fails the whole batch (`changes_mismatch`) and rolls back mark and reopen, so records are never reopened twice after being resent (test: second run settles and the record comes back acknowledged; the first run must not reopen it). Reopen is scoped to the pairing, window `acked_at >= now - 30 days` (inclusive at the first instant, tested at -1 ms), keeps `attempts`/`sent_at`, resets rejected/conflict outcomes; the host answers a known record with its kept receipt.
- Feed from zero: the mark is read only in the continuing branch, the first page wipes (guard first) and deletes the mark with `sync_state` in the same transaction as the page; a later page failure resumes after the pages that landed instead of wiping again (test); a failed first fetch keeps the mark and the copies (brief test); another pairing's wipe takes the mark with the state (test).
- Retention interplay (explicit): `RETAINED_TABLES` is not extended (`floor_restore_epochs` has no `shift_id`; the existing "every table with shift_id" test still passes) and SSCC blocks + obligation survive a pass that takes every shift (test). `RESEND_WINDOW_MS === RETENTION_MS` (test). A shift whose records the restore reopened is not due (`u.acked_at IS NULL`) and is kept whole until the host answers, then 30 days from the new receipts (test, through `purgeAcknowledged` and `DUE_SHIFTS_SQL`). A shift that retention already took is gone, one at the window's first instant is reopened.
- New-PC restore (rk-minors 11): BLOCKS_SQL is by the CURRENT pairing, so a station re-paired under a new device id has no rows to send: the route is not called (brief), the obligation is settled, the feed restarts from zero, and nothing is lost. The old device id's blocks, boxes and unsent records stay as `DeviceData` for support, never sent under the new id. Blocks of the same device that the host holds under another shape answer `block_mismatch` and are retired and counted. This task cannot make the old device's facts valid; see concerns.

## RED / GREEN

- RED vitest (impl removed): `Test Files 5 failed (5)`, `Tests 4 failed | 228 passed (232)`: restore-reconcile did not resolve, `registerKnownBlocks is not a function`, `FROM_ZERO_SQL` undefined (`reading 'trim'`), `has exactly the shell's tables`, `tag every row` (log /tmp/claude/impl-rks-t2/red-vitest.txt). Plan: 4 failed | 221 passed (225).
- RED cargo `--test local_db`: `27 passed; 1 failed` (`opening_creates_the_reference_tables…`; plan 26+1; two later tests exist at this base).
- GREEN vitest (5 files of the brief): `Test Files 5 passed`, `Tests 243 passed` (plan 236; the base has more tests). GREEN cargo `local_db`: `29 passed` (28 at base + my upgrade test; the plan said 27).
- Plans: Node 3.53 `serve the reconciliation after a restore from an index` (new) and shell 3.46 six new entries in `the_floors_repeating_reads_search_an_index` (76 -> 82) + text agreement test between TS and Rust for the six statements. DUE/STATUS/SETTLE: PK autoindex; BLOCKS: `floor_sscc_blocks_prefix (host_id=? AND device_id=?)` + exactly one `TEMP B-TREE FOR ORDER BY`; RETIRE: same index, only the `json_each` scan; REOPEN: `outbox_settled`, no SCAN, no TEMP.

## Tests beyond the brief

`restore-reconcile.test.ts` +17 tests (26 total: order, used up and pallet blocks, 130 blocks once each, refused count per request, longer answer, later epoch resets, pairings isolation, window edge, other pairings' records, mark/reopen rolled back, double settle, `no_restore` kinds, no more requests after `no_restore`); `floor-schema` +4 (columns, constraints, plans, text agreement); `reference-sync` +2; `retention` +4; shell `migration_0009_keeps_the_rows_of_a_database_of_0008` (blocks, acked and waiting outbox, sync state intact, no epoch, journal 1..N once each) and a `floor_restore_epochs` row in the forget test.

## Mutants (all restored: `cmp` silent, sha256 identical, Rust/SQL files touched; backups and outputs in /tmp/claude/impl-rks-t2/mut/)

| #               | one-line mutant                                                                                                 | killed by (first)                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| M01             | delete the retire transaction (brief R1)                                                                        | stops using every block the host refused; keeps owing…; 2 more                       |
| M02             | window dropped, `? IS NOT NULL` (R2)                                                                            | asks the next sync to start from zero…; takes the records of the window…             |
| M03             | delete `expectedChanges: 1` (R3)                                                                                | does not settle a later epoch…; applies none of it…; settled once                    |
| M04             | `no_restore` as failure (R4)                                                                                    | owes nothing more…; owes nothing after the first request                             |
| M05             | result id unchecked (R5)                                                                                        | keeps nothing of an answer that does not answer…                                     |
| M06             | same epoch is new (R6, `WHERE true`)                                                                            | is noted once per pairing…; starts over…; settles when the same epoch is noted again |
| M07             | retire to `to_serial` (not +1)                                                                                  | 4 behaviour tests + text agreement                                                   |
| M08 / M09       | chunk 65 / step 1                                                                                               | 3 / 5 tests (requests of 64)                                                         |
| M10 / M11 / M12 | no ORDER BY / no tie-break / skip used up                                                                       | order test (+ plan pin for M10) / order test / used-up test                          |
| M13             | blocks of any device                                                                                            | pairings isolation; sends every block…                                               |
| M14 / M15 / M16 | note keeps `refused` / keeps `reconciled_at` / keeps `seen_at`                                                  | starts over with a later epoch… (M15 also the brief test)                            |
| M17 / M18       | DUE ignores settled / any device                                                                                | many (6 / 4)                                                                         |
| M19 / M20       | STATUS any device / inverted `due`                                                                              | pairings isolation / many                                                            |
| M21             | SETTLE without `reconciled_at IS NULL`                                                                          | settled once (double settle)                                                         |
| M22 / M23       | SETTLE any epoch / any device                                                                                   | later-epoch tests / pairings isolation                                               |
| M24 / M25       | REOPEN any device / `>` instead of `>=`                                                                         | other pairing's records / window edge                                                |
| M26             | REOPEN without `outcome IS NOT NULL`                                                                            | plan pins only (neutral in behaviour by the CHECK)                                   |
| M27             | `refused += 1`                                                                                                  | stops using every block the host refused (2 in one request)                          |
| M28             | length check `<`                                                                                                | longer answer test                                                                   |
| M29             | registered/known counters swapped                                                                               | 4 tests                                                                              |
| M30             | stranger status `due: true`                                                                                     | pairings isolation                                                                   |
| M31 / M32 / M33 | `neverRestored` without kind / code / constraint                                                                | one test each (it.each)                                                              |
| M34 / M35 / M36 | end batch without FROM_ZERO / wrong mark value / without reopen                                                 | 4 / 4 / 6 tests                                                                      |
| M37 / M38       | window 7 days / one second wider                                                                                | retention interplay / window edge                                                    |
| M39 / M40       | RETIRE any device / only by id                                                                                  | plan pins only (neutral in behaviour)                                                |
| M41             | settle writes `refused` 0                                                                                       | 5 tests                                                                              |
| M42             | mismatched id swallowed                                                                                         | does not answer the blocks sent                                                      |
| M43-M47         | sent `fromSerial+1`, `toSerial-1`, extension 0, prefix fixed, id changed                                        | order/fields test, brief fixture test                                                |
| M48-M53         | mark not read / R7 no wipe / R8 since / wipe only / wrong column / wipe always                                  | brief test + multi-page test; M53 breaks 6 old tests                                 |
| M56-M61         | migration: no refused CHECK / PK device only / epoch nullable / default 1 / seen_at nullable / settled NOT NULL | new schema tests (+ column shape)                                                    |
| M63-M65         | API path / no response schema / office token                                                                    | `gives the host back…`                                                               |
| M54             | `TABLE_CLASSES` DeviceData                                                                                      | shell `every_table_has_a_forget_class`                                               |
| M55 / M67       | Rust REOPEN const without guard / wrong index text                                                              | shell plan test                                                                      |
| M62 / M66       | migration `DELETE FROM outbox` / move block cursors                                                             | shell upgrade tests (0008->0009; M62 also the 0007->0008 one)                        |

Equivalent in behaviour, killed only by plan pins: M26, M39, M40.

## Totals (plan vs measured)

- Package Vitest: 147 files, 4559 tests: 4557 passed, 2 failed (`template-editor.test.tsx` 5 s timeouts under load; alone `97 passed`, also with `--testTimeout=60000`). Base at Task 1: 4522 -> +37 tests here.
- Cargo `--workspace` (unsandboxed, once, after the last code change): exit 0, 71 `test result` lines, 1122 passed, 0 failed (Task 1: 1121; +1 is the upgrade test; expectation was >=1121).
- Parity: `test/protocol.test.ts` passed in the full run; `proto/tests/fixtures.rs` passed in the workspace run.
- typecheck, lint, build: 0. `cargo fmt --check` clean; `cargo check --workspace --all-targets`: 0 warnings. Prettier gate (live proof: scratch `zz.ts` gave `[warn]`, deleted) clean on 13 files; `git diff --check` clean; `\u04` only `pairing-code.ts:66`. The delayed-`setImmediate` stand was not used: no React or effects here.

## Anchor adaptations

1. `src-tauri/tests/local_db.rs` and `test/local-executor.test.ts` lists: the brief's fragment (`floor_exceptions` then `floor_scans`) no longer matches (pallet and print-job tables sit between); `floor_restore_epochs` was inserted alphabetically after `floor_print_jobs`, in the Disposable-table list only.
2. `src-tauri/src/local_db.rs` `TABLE_CLASSES`: same, inserted after `floor_print_jobs`.
3. `test/support/office.tsx`: the anchor lines differ; `registerKnownBlocks` was put after `sendFacts`.
4. Spec section number is not touched here (Task 5 writes §24).

## Files

New: `src-tauri/migrations/0009_restore_epochs.sql`, `src/local/restore-reconcile.ts`, `test/restore-reconcile.test.ts`. Changed: `src-tauri/src/local_db.rs`, `src-tauri/tests/local_db.rs`, `src/host/api.ts`, `src/local/reference-sync.ts`, `test/{api,floor-schema,local-executor,reference-sync,retention}.test.ts`, `test/support/office.tsx`.

## Concerns / notes for later tasks

1. A station with NO block never calls the route (hosts require 1-64). The host then never marks it as having sent its blocks, so Task 4's office shows it "Не вернула" for ever and the resume dialog count is wrong for such stations (already in "Контракт для других планов"; decision for the host stream: allow an empty list).
2. New-PC restore: the old device id's blocks, boxes and unsent records are never sent under the new id (existing DeviceData behaviour). That is not a loss in the DB but those facts stay unsent; the runbook (Task 5/8) should say: finish and drain the old pairing on the old host, or ask support. A retired block cannot be un-retired by the station (safe direction: at most a block's worth of capacity; the half rule asks for a new block).
3. Visibility is a count only (`refused`): the codes are not kept; if the owner wants them in the status bar or for support, add a column to `0009` BEFORE it ships (it is unreleased).
4. The window edge can split a shift's records (scans acked just before it, the close just after); the host would then get a close without the scans it lost. Only records within the clock skew of the boundary; accepted by the plan (decision C1).
5. Task 3 must: write the epoch before asking `restoreDue`, gate the sender on `restoreDue`, and expect the unsent count to jump by up to 30 days of records after a reconcile (and rejected closes to vanish until resent).
6. The reopening is one `UPDATE` over the pairing's settled records (index search); at hundreds of thousands of rows it is a single long write transaction once per restore. Not measured on a large database.
7. Not exercised: Windows, WebView2, a real `markiro-host restore`, two stations, a real full disk.
