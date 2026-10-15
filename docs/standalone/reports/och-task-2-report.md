# Plan ОЧ, Task 2 — report

Status: DONE (with the concerns below). Commit `06df8e6d4` on `claude/m1` (/tmp/claude/wt/m1), base `1a3bb1874`. Tree clean.

## What was done

- `outbox-status.ts`: `REJECTED_COUNT_SQL`/`CONFLICT_COUNT_SQL` take `AND resolved_at IS NULL`.
- `shift-close.ts`: `REFUSED_CLOSES_SQL` takes `AND resolved_at IS NULL` (doc line added).
- `restore-reconcile.ts`: `REOPEN_SQL` takes `AND resolved_at IS NULL` (doc: a resolved record stays settled, no double send).
- `retention.ts`: `DUE_SHIFTS_SQL` and `DONE_WITH` (-> `PURGE_COPY_SQL`) take `NOT EXISTS (SELECT 1 FROM outbox r … r.outcome IN ('rejected','conflict') AND r.resolved_at IS NULL)` keyed by host/device/shift. The guard is in BOTH the hourly reading and the guarded delete, so a refusal that lands between them also keeps the shift (tested).
- `facts-sender.ts`: `receiptStatements` has six operators; the new 4th (scan `conflict = 0` on an `accepted` of a scan) and 5th (box `needs_fix = 0` when the box has an accepted scan in the batch and no scan of it is still in conflict).
- Plans pinned in BOTH `test/floor-schema.test.ts` (Node 3.53) and `src-tauri/tests/local_db.rs` (shell 3.46): 3 new `reads` (unmark by scan key; unfix by box key; unfix's `c` by `floor_scans_shift`), `r` of DUE_SHIFTS and PURGE_COPY via `outbox_shift (shift_id=? AND host_id=? AND device_id=?)`; `reads` 87 -> 92 (+3 receipt, +2 r). Rust constants DUE_SHIFTS, PURGE_COPY, REFUSED_CLOSES, RESTORE_REOPEN and the two count texts rewritten word for word; text-agreement test counts updated (sender statements 6 -> 8).

## Actual plans (measured)

- DUE_SHIFTS: step 0 `SEARCH o USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)` kept (ХП cheap shape not re-planned, still one `outbox_settled` step, no SCAN, only the DISTINCT temp b-tree); `r` -> `SEARCH r USING INDEX outbox_shift (shift_id=? AND host_id=? AND device_id=?)` (not covering).
- PURGE_COPY: same `r` step. REOPEN/REFUSED_CLOSES/counts: unchanged first step on `outbox_settled`.
- Unfix: `SEARCH floor_boxes … (id=?)`, `SEARCH floor_scans … (id=?)`, correlated `SEARCH c USING INDEX floor_scans_shift (host_id=? AND device_id=? AND shift_id=?)`.

## RED / GREEN

- RED (`/tmp/claude/impl-och-t2-red.txt`): the 4 brief files, 8 failing tests with exactly the brief's expected symptoms (`rejected: 3, conflicts: 2`; conflict not cleared; resolved close named; reopen reopened resolved; shift purged with an unresolved refusal).
- GREEN: focused 6 Vitest files 150 passed, verbose stderr 0. Full package Vitest (`--testTimeout=60000 --hookTimeout=60000`): 150 files / 4630 passed / 0 failed. app.test.tsx (151) also green under the delayed-`setImmediate` stand (setup/config kept outside the tree, `/tmp/claude/impl-och-t2/delay.*`), stderr 0. typecheck 0, lint 0, `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto -p markiro-standalone --all-targets` 0 warnings. cargo `--test local_db` 32 passed. ONE final `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed after the commit: exit 0, 71 binaries, 1130 passed, 0 failed.
- Prettier gate live-proved (scratch `const  x = 1` -> `[warn]`, rc 1, deleted); all changed TS/TSX clean. `git diff --check` clean. `grep '\u04'`: only `pairing-code.ts:66`.

## Tests added (beyond the brief's five)

- facts-sender: two-boxes-in-one-shift test (box marked by its own conflict only; another box of the shift clears) — needed to kill the `c.box_id` mutant; two-shifts-two-boxes test.
- retention: refusal of another kind than scan (`rejected`) holds, and a refusal resolved by `resent` with its new unanswered record still holds; resolved-only-in-one-shift (`holds only the shift a refusal belongs to`); refusal landing between reading and delete keeps the shift; foreign-pairing (other device, other host) refusal inserted before the reading and between reading and delete holds nothing; `dueIds` asserted directly (the guarded delete would hide a too-wide reading).
- schema: unfix text must appear exactly twice in the Rust source (both pins keep the text).

## Mutants (restore proof: sha256 before == after for every file, `cmp` vs backups in /tmp/claude/impl-och-t2, touched `.rs` after restore; logs `mutants1.log`, `mutants2.log`, `mutants3.log`)

| #       | one-line mutant                                                                                   | killed by                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1      | REJECTED count without `resolved_at IS NULL`                                                      | outbox-status "count neither as refused…"                                                                                                               |
| M2      | CONFLICT count without it                                                                         | same                                                                                                                                                    |
| M3      | REFUSED_CLOSES without it                                                                         | facts-sender "names no refused close a person resolved"                                                                                                 |
| M4      | REOPEN without it                                                                                 | restore-reconcile "leaves a record a person resolved settled"                                                                                           |
| M5      | DUE_SHIFTS without the `r` clause                                                                 | retention x3, schema plan pin, text-agreement                                                                                                           |
| M6      | PURGE_COPY without the `r` clause                                                                 | retention race test, schema plan pin, text-agreement                                                                                                    |
| M7      | DUE r only `'conflict'`                                                                           | retention (other-kind, only-the-shift)                                                                                                                  |
| M8      | DUE r only `'rejected'`                                                                           | retention "keeps a shift while…"                                                                                                                        |
| M9      | DUE r ignores resolution                                                                          | retention "keeps a shift while…"                                                                                                                        |
| M10     | PURGE r only `'conflict'`                                                                         | retention race test                                                                                                                                     |
| M11     | PURGE r ignores resolution                                                                        | retention "keeps a shift while…"                                                                                                                        |
| M12     | DUE r drops the shift term                                                                        | retention, schema, 3 older due tests                                                                                                                    |
| M13     | DUE r drops the device term                                                                       | retention foreign-pairing, schema                                                                                                                       |
| M14     | DUE r drops the host term                                                                         | retention foreign-pairing, schema                                                                                                                       |
| M15     | PURGE r drops the device term                                                                     | retention "not held by another pairing between reading and delete" (SURVIVED first; test added)                                                         |
| M16     | PURGE r drops the shift term                                                                      | retention x3                                                                                                                                            |
| M17     | PURGE r drops the host term                                                                       | same new test (SURVIVED first; test added)                                                                                                              |
| M18     | unmark clears on `'rejected'`                                                                     | facts-sender x3                                                                                                                                         |
| M19     | unmark without id filter                                                                          | facts-sender x6                                                                                                                                         |
| M20     | unfix without NOT EXISTS                                                                          | facts-sender x4                                                                                                                                         |
| M21     | unfix NOT EXISTS ignores the box                                                                  | two-boxes-in-a-shift test (SURVIVED in the brief's tests; test added)                                                                                   |
| M22     | unfix NOT EXISTS ignores the shift                                                                | schema plan pins (index on the box's shift)                                                                                                             |
| M23     | unfix/unmark without `kind = 'scan'`                                                              | SURVIVES: equivalent (outbox ids are unique across kinds, so a non-scan id never equals a scan id; the same holds for the existing conflict statements) |
| M24–M26 | unary plus dropped in unmark / unfix / unfix inner                                                | schema plan pins                                                                                                                                        |
| R1–R5   | Rust DUE_SHIFTS / PURGE_COPY / REFUSED_CLOSES / REOPEN / rejected-count text without the new term | text-agreement tests                                                                                                                                    |
| R6      | one of two Rust unfix copies without NOT EXISTS                                                   | SURVIVED first (the other copy satisfied `toContain`); strengthened: text must occur twice                                                              |
| R7      | Rust pin of DUE r names `outbox_settled`                                                          | cargo `the_floors_repeating_reads_search_an_index`                                                                                                      |
| R8      | Rust PURGE_COPY without r                                                                         | cargo plan pin                                                                                                                                          |
| R9      | Rust unmark without unary plus                                                                    | cargo plan pin                                                                                                                                          |
| R10     | Rust unfix scans-by-shift pin renamed                                                             | cargo plan pin                                                                                                                                          |
| A1      | App no longer bumps the outbox after a purge                                                      | rewritten app.test "deletes at its start…"                                                                                                              |

## Anchor adaptations

- All brief fragments matched. The brief says `closeShift(context, null)` may need a reason: used `"production_order_changed"` (as the neighbouring test does).
- The brief's retention test needed no change in `finished`; second refusal taken from the shift's second scan.
- Task 1's `test/floor-outbox-recovery-migration.test.ts` planned the (now changed) retention/status reads on a 0010 database BEFORE migration 0013, which cannot work any more for statements naming `resolved_at`: the before/after plan-equality check now covers only the statements that do not name the new column (the changed ones are pinned in floor-schema and local_db.rs).
- `test/app.test.tsx` "deletes at its start the records of a shift whose close the host took 30 days ago" (not in the brief's file list) seeded an UNRESOLVED `rejected` scan and expected the purge: by design (task goal) it now stays. The record is now seeded as resolved (`dismissed`), and the test's observable changed from the refused counter (which can never change by a purge any more: a purge never removes a counted refusal) to the status bar re-reading its unsent count after the purge (gated; mutant A1 shows it still kills "no outbox_changed after a purge").

## Self-review

- Data integrity: unresolved `rejected`/`conflict` records keep the shift in both the reading and the guarded delete; resolved records follow the usual 30-day rule; reopen skips resolved; refused-close list skips resolved; the 4th/5th receipt operators only clear marks for ids the same transaction's first operator just accepted (receipts for a record that already has an outcome are never overwritten: `+outbox.acked_at IS NULL`), and `needs_fix` is only ever set by the conflict statement.
- The guard uses `resolved_at IS NULL` (as the brief). Migration 0013 does not constrain `resolved_at` to be set together with `resolution`; Tasks 3+ must write both, or the queue screen shows what counts disagree.

## Concerns

- `r` in the retention statements walks the shift's own outbox rows (index `outbox_shift (shift_id, host_id, device_id)` is not covering, so payload rows are read). It costs O(records of one due shift) per hourly pass, and a shift held forever by an unresolved refusal pays it every hour (tens of ms for tens of thousands of records). A partial covering index on refused/conflict records would need a new migration; not done (out of scope, 0013 exists). Not measured at 600 000 rows.
- Disk growth: a shift with an unresolved refusal is never purged until a person resolves it (intended, O4).
- `floor_block_drops` is still never purged (task 1 concern).
- Not exercised: Windows shell, real host, a real restore of a host with resolved records (covered at SQL level only).
