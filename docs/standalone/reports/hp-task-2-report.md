# Plan ХП, Task 2 — report

Status: DONE. Commit `093297a7f` on `claude/m1` (/tmp/claude/wt/m1), base `32146bb07`. Tree clean.

## What was done

- `src-tauri/migrations/0010_shift_indexes.sql`: `outbox_shift (shift_id, host_id, device_id, acked_at)`, `floor_exceptions_shift (shift_id, host_id, device_id)`, `floor_pallet_exceptions_shift (shift_id, host_id, device_id)`; additive, no row changes.
- `test/floor-shift-indexes.test.ts` (new): upgrade from 0009 with rows in all three tables, index names/tables/column order, rows intact.
- `test/floor-schema.test.ts` (Node SQLite 3.53): index list, due-select first step still `outbox_settled` (walk-once shape kept), `outbox_shift` in due/purge plans, every `RETAINED_TABLES` delete pinned to its shift index with no SCAN, text-agreement test now covers all 11 retention statements as literals.
- `src-tauri/tests/local_db.rs` (shell SQLite 3.46): new upgrade test `migration_0010_adds_the_shift_indexes_and_keeps_every_row`, `reads` 83 -> 86, DUE_SHIFTS/PURGE_COPY pins by `outbox_shift`, three new delete pins, the old "SCAN <table>" tail removed.

## RED / GREEN

- RED (`/tmp/claude/impl-hp-t2/red-vitest.txt`, `red-cargo.txt`): vitest 3 failed (fixes the indexes…, serve the reads…, adds the indexes by shift…); cargo `--test local_db` 2 failed (`migration_0010_…`, `the_floors_repeating_reads_search_an_index`).
- GREEN: vitest floor-shift-indexes, floor-schema, floor-pallet-schema, retention, restore-reconcile 113 passed; facts-sender/retention/schema verbose 93 passed, `stderr |` count 0; cargo `--test local_db` 30 passed. Plans on SQLite 3.46 matched the brief's strings exactly (no `acked_at<=?` deviation).
- Full package `run test`: 4611 passed / 2 failed, both `template-editor.test.tsx` 5 s timeouts under load; alone 97 passed, with `--testTimeout=60000` 97 passed.
- typecheck 0, lint 0, `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings, `git diff --check` clean, `grep '\u04'` only `pairing-code.ts:66`.
- ONE final `cargo test --workspace --offline --locked` (unsandboxed, after the commit): exit 0, 71 binaries, 1127 passed, 0 failed, 0 warnings.
- Prettier gate live-proved (scratch file -> `[warn]`, exit 1, deleted); changed TS files clean.
- No React in changed tests, so the delayed-`setImmediate` stand does not apply.

## Mutants (migration file restored: sha256 `1ccb2d40…b434` before and after, `cmp` silent; `local_db.rs` sha `e4d2bc0c…7454` before/after; Rust sources touched after restore)

| #        | one-line mutant                                                | killed by (vitest / cargo)                                                                                                                                          |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1       | `outbox_shift` led by `host_id, device_id, shift_id, acked_at` | floor-schema "serve the reads" (outbox_unsent no longer used; first step re-planned) + floor-shift-indexes (columns) / `the_floors_repeating_reads_search_an_index` |
| M2       | drop `floor_pallet_exceptions_shift`                           | "fixes the indexes", "serve the reads", upgrade test / `migration_0010_…` + `the_floors_…`                                                                          |
| M3       | drop `acked_at` from `outbox_shift`                            | "serve the reads" (`acked_at=?` missing), upgrade test (columns) / `the_floors_…`                                                                                   |
| M4       | drop `floor_exceptions_shift`                                  | same three tests (vitest only)                                                                                                                                      |
| M5       | drop `outbox_shift`                                            | same three / `migration_0010_…` + `the_floors_…`                                                                                                                    |
| M6       | `floor_exceptions_shift` led by `host_id, device_id, shift_id` | "serve the reads" + columns / `the_floors_…`                                                                                                                        |
| M7       | `floor_pallet_exceptions_shift` led by `host_id, …`            | same / `the_floors_…`                                                                                                                                               |
| M8       | `outbox_shift (shift_id, acked_at, host_id, device_id)`        | "serve the reads" + columns (vitest only)                                                                                                                           |
| M9       | rename `outbox_shift` -> `outbox_by_shift`                     | all three (vitest only)                                                                                                                                             |
| M10      | `outbox_shift` UNIQUE                                          | "fixes the indexes" + upgrade test (vitest only)                                                                                                                    |
| M11      | `outbox_shift` partial `WHERE acked_at IS NULL`                | "fixes the indexes" + "serve the reads" (vitest only)                                                                                                               |
| M12      | migration appends `DELETE FROM floor_exceptions`               | upgrade test (vitest) and `migration_0010_…` (cargo)                                                                                                                |
| M13      | Rust delete literal differs by one space from `purgeTableSql`  | text-agreement test ("are pinned on the shell's SQLite…")                                                                                                           |
| M7 cargo | also run: M6, M7                                               | `the_floors_…`                                                                                                                                                      |

## Anchor adaptations

None: every brief fragment matched exactly once.

## Index creation time

Measured on `node:sqlite` with 600 000 outbox rows (70 shifts): the three `CREATE INDEX` statements ran in about 0.37 s. On the shell's first start after update the migration runs once inside startup; acceptable.

## Concerns

- Cost noted in the plan (Д1): one more index entry per outbox row and an update on receipt.
- 2 `template-editor` timeouts in the full package run under load (pre-existing flake class).
- Not exercised: Windows shell upgrade of a real station database; only 0009 -> 0010 on host SQLite (3.46 in cargo, 3.53 in Node).
