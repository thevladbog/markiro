# Plan ОЧ, Task 1 — report

Status: DONE. Commit `a85a5106e` on `claude/m1` (/tmp/claude/wt/m1), base `fdb8ee569`. Tree clean.

## What was done

- `src-tauri/migrations/0013_outbox_recovery.sql` (verbatim from the brief): `outbox.resolution` (CHECK NULL | resent | dismissed), `resent_as`, `resolved_at`, `resolved_by`; table `floor_block_drops` (PK host_id, device_id, block_id; reason CHECK overlap | mismatch; no CHECK on serials). No index added.
- `src/local_db.rs`: `("floor_block_drops", TableClass::DeviceData)` first in `TABLE_CLASSES`.
- Tests: brief's two Vitest tests (extended with `''`, `'Resent'`, resolution back to NULL, a new record written with the four columns, `''` reason), `DEVICE_TABLES`/`COLUMNS` (floor_block_drops + outbox's four columns), pin of the table's key reach in BOTH `floor-schema.test.ts` (Node 3.53) and `tests/local_db.rs` reads (shell 3.46; `reads` 86 -> 87; text-agreement set 28 -> 29), `local-executor.test.ts` table list, new `test/floor-outbox-recovery-migration.test.ts` (upgrade from 0010: waiting/accepted/rejected/conflict rows keep every column, new columns NULL, columns appended last, table empty, query plans of 14 retention/status/sender/reopen statements identical before and after, 0013 applied with 0011/0012 absent), Rust `migration_0013_keeps_the_outbox_and_adds_its_resolution` (brief's test, expanded: four-state rows, 4 invalid words, drops table PK/reason/NOT NULL, journal), Rust `a_lower_migration_that_arrives_after_a_higher_one_is_applied` (DB with 0013 but without 0009 opened by the full list: 0009 applied, rows kept, journal complete), `device_records()` + both device-data lists + table list in `opening_creates…` extended with floor_block_drops.
- Adapted existing assertion: `migration_0009_…` journal check was `1..=MIGRATOR.count()` (breaks with gaps 11/12) -> now the actual MIGRATOR versions.

## RED / GREEN

- RED (`/tmp/claude/impl-och-t1/red-vitest.txt`): 6 failed (new migration test, "tag every row", "fixes every column", "serve the reads", both brief tests) before the SQL/class existed. Rust RED was not captured separately; every Rust assertion is shown failing by the mutant runs below.
- GREEN: vitest floor-schema, floor-outbox-recovery-migration, floor-shift-indexes, floor-pallet-schema, local-executor, retention, restore-reconcile: 170 (after local-executor fix: all pass). Verbose run of the 3 changed files: 90 passed, `stderr |` count 0 (no React in changed tests: delayed-setImmediate stand not applicable). cargo `--test local_db`: 32 passed.
- Full package Vitest (`--testTimeout=60000 --hookTimeout=60000`): 4616 passed / 3 failed, all `forms-parity.test.ts` placard-a4 / placard-a5-disassembled / shift-placards-a5 (the known base ПАЛЕТА failures, fixed on integration). typecheck 0, lint 0.
- ONE final `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed after the commit: exit 0, 71 binaries, 1130 passed, 0 failed, 0 warnings. `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto -p markiro-standalone --all-targets` 0 warnings.
- Prettier gate live-proved (scratch file -> `[warn]`, exit 1, deleted); changed TS files clean. `git diff --check` clean. `grep '\u04'`: only `pairing-code.ts:66`.

## Mutants (restore proof: sha256 of `0013_outbox_recovery.sql` a7a8a753… and `local_db.rs` 457cb964… identical before/after, `cmp` against copies in /tmp/claude/impl-och-t1/bk; local_db.rs touched after each; log in mutants.log)

| #   | one-line mutant                                         | killed by (vitest / cargo)                                                                                         |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| M1  | CHECK `IN ('resent')` (drops dismissed)                 | resolution test / `migration_0013_…`                                                                               |
| M2  | CHECK also takes `'forgotten'`                          | resolution test / `migration_0013_…` (strengthened: was surviving on Rust)                                         |
| M3  | no CHECK on resolution                                  | resolution test / `migration_0013_…`                                                                               |
| M4  | reason CHECK without `mismatch`                         | block-drops test / `migration_0013_…`                                                                              |
| M5  | no CHECK on reason                                      | block-drops test / `migration_0013_…` (was surviving on Rust: the "lost" row collided with an existing key; fixed) |
| M6  | PK without device_id                                    | block-drops, columns, plan pin / `migration_0013_…`, `the_floors_…`                                                |
| M7  | PK without block_id                                     | block-drops, columns / `migration_0013_…` (strengthened: was surviving on Rust)                                    |
| M8  | CHECK from_serial <= to_serial                          | block-drops (inverted range) / `migration_0013_…`                                                                  |
| M9  | `resolved_by DEFAULT ''`                                | upgrade test, resolution test, columns / `migration_0013_…`                                                        |
| M10 | `resolution DEFAULT 'dismissed'`                        | same three / `migration_0013_…`                                                                                    |
| M11 | no `resent_as` column                                   | same three / `migration_0013_…`                                                                                    |
| M12 | `request_id` nullable                                   | columns / `migration_0013_…` (NULL request_id insert)                                                              |
| M13 | extra index on outbox (host, device, outcome, acked_at) | upgrade test (plans), index list, "serve the reads", reconciliation plans / `the_floors_…`                         |
| M14 | PK order device_id, host_id, block_id                   | columns, plan pin / `the_floors_…`                                                                                 |
| M15 | class Disposable                                        | none in vitest (Rust-only list) / `clearing_the_copies…`, `every_table_has_a_forget_class`, `migration_0013_…`     |
| M16 | class Workstation                                       | / `every_table_has_a_forget_class`, `migration_0013_…`                                                             |
| M17 | class entry dropped                                     | / `every_table_has_a_forget_class`, `migration_0013_…`                                                             |
| M18 | `resolved_at NOT NULL DEFAULT ''`                       | upgrade test, resolution test, columns / `migration_0013_…`                                                        |
| M19 | migration file renamed 0013 -> 0012                     | / `migration_0013_…` and `a_lower_migration_…`                                                                     |

## Migrator with gaps

sqlx 0.8.6 `Migrator::run` applies every version not in the journal regardless of order, and only fails (`VersionMissing`) if the journal holds a version the binary does not know. Proven: `migration_0013_…` applies 0013 over a 0001–0010 database (0011/0012 absent); `a_lower_migration_…` applies a lower version after a higher one. Node's test helper has no journal (`db.exec` of files sorted by name), so gaps are harmless there.

## Anchor adaptations

- Brief's `expecting(sql, n)` has three arguments here (`sql, values, changes`): used `expecting(sql, json!([...]), n)`.
- `count`, `table_class`, `TableClass` imports exist as the brief assumed (`table_class`/`TableClass` imported at the top of the test file).
- `migration_0009` journal assertion made gap-tolerant (see above); `test/local-executor.test.ts` and the Rust table/device-data lists updated by meaning (not in the brief's file list).
- Index test lists only `origin='c'` indexes, so no autoindex entry was added there.

## Concerns

- Integration: a database that already holds migration 0011/0012 (from another stream's build) cannot be opened by a binary without those files (`VersionMissing`), and vice versa nothing breaks; fine once the streams are merged.
- `floor_block_drops` has no `shift_id`, so retention never purges it (by design per the brief); a forget keeps it (DeviceData).
- The pinned statement `SELECT count(*) AS n FROM floor_block_drops WHERE host_id = ? AND device_id = ?` is a test-local text; the status bar's real statement comes with a later task and must reuse the same text or add its own pin.
- Not exercised: a real Windows shell upgrade of a production database.
