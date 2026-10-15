# Plan 2a4, Task 4 report: table classes for «forget»

Status: DONE_WITH_CONCERNS (concerns are notes, not blockers).
BASE: ffd77c3bf. Commit: 939a2c8dc `feat(standalone): every local table has a forget class, and a forget empties only the disposable ones` (one trailer line, `git status --short` empty afterwards).

## What was done

Plan steps 1, 3 applied verbatim (all anchors matched exactly once; Cyrillic checked, no literal `\u0` in the three Rust files).

- `src-tauri/src/local_db.rs`: `TableClass { Disposable, DeviceData, Workstation }`, `TABLE_CLASSES` (11 entries, alphabetical, `sync_state` last), `table_class`; `clear_copies` deletes only the disposable entries in one `BEGIN IMMEDIATE` transaction, then the unchanged TRUNCATE checkpoint. The `PRAGMA defer_foreign_keys` and the `pragma_table_list` query are gone as the plan shows (no table has a foreign key; documented on `TABLE_CLASSES`).
- `tests/local_db.rs`: `every_table_has_a_forget_class` (both directions plus "all Disposable until 2a5"), the clearing test rewritten (kept_device_records / kept_workstation_settings stay; every `TABLE_CLASSES` table must be empty; ref_operators and ref_operator_badges rows added as the plan says), the FTS5 virtual-table test removed as the plan says.
- `tests/ipc.rs`: rollback test now uses a refusing trigger on `sync_state` (`STUCK_SYNC_STATE`), asserts `TABLE_CLASSES.last() == sync_state`, expects `n = 2` after the failed forget.

## Added beyond the plan (found by mutants)

1. Unit test `a_forget_empties_the_disposable_tables_and_keeps_the_other_classes` in `local_db.rs` `mod tests`, over a private seam `LocalDb::clear_classed(&self, classes)`; `clear_copies` is now `self.clear_classed(TABLE_CLASSES)`. Reason: while every `TABLE_CLASSES` entry is Disposable, no plan test distinguishes "delete only Disposable" from "delete every listed table" (mutant «filter dropped» passed all three plan suites). The seam is private; the public API is as the plan states. Lib count is 50 (plan says 49).
2. `clearing_the_copies_empties_the_disposable_tables_and_nothing_else` also inserts a `ref_org` and a `ref_site` row. Without them the loop `count(*) = 0` was vacuous for these two tables (the `ref_org`/`ref_site` class mutants were killed only by `every_table_has_a_forget_class`).

## Evidence

RED (`cargo test … --test local_db --test ipc --no-run`, exit 101): `error[E0432]: unresolved imports … local_db::TableClass, … TABLE_CLASSES` (ipc) and `… table_class, TableClass, TABLE_CLASSES` (local_db).

GREEN: `--lib` 50 passed (plan 49, +1 mine), `--test local_db` 12 passed (as plan), `--test ipc` 13 passed (as plan, outside the sandbox). `cargo fmt --check` clean, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings, `cargo clippy -p markiro-standalone --all-targets` 0 warnings, `git diff --check` clean. Files of the run: /tmp/claude/t4_red.txt, t4_g1..g4.txt, t4_final.txt.

### Mutants (script /tmp/claude/mut4.py; every restore verified with `cmp` against /tmp/claude/local_db.rs.pre-mut and sha256 equality)

Suites run per mutant: `--lib`, `--test local_db`, `--test ipc`. «none» means that suite passed.

| Mutant (one line in `local_db.rs`)                                                                         | Failing tests                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `floor_sign_in_failures` -> DeviceData                                                                     | local_db: clearing_the_copies_empties_the_disposable_tables_and_nothing_else, every_table_has_a_forget_class                      |
| `ref_lines` -> DeviceData                                                                                  | same two + ipc: forgetting_the_device_clears_the_local_copies_first                                                               |
| `ref_operator_badges` -> DeviceData                                                                        | same two + clearing_the_copies_leaves_no_deleted_hash_in_the_file_or_its_wal                                                      |
| `ref_operators`, `ref_products`, `ref_template_defaults`, `ref_templates`, `sync_quarantine` -> DeviceData | clearing_… (nothing_else) + every_table_has_a_forget_class                                                                        |
| `sync_state` -> DeviceData                                                                                 | clearing_… + every_table_… + ipc forgetting_the_device_…                                                                          |
| `ref_org`, `ref_site` -> DeviceData (first run, before adding rows)                                        | only every_table_has_a_forget_class (hence added the rows)                                                                        |
| `ref_org`, `ref_site` -> Workstation (after adding rows)                                                   | clearing_… + every_table_has_a_forget_class                                                                                       |
| drop the `ref_org` entry                                                                                   | every_table_has_a_forget_class (unclassified)                                                                                     |
| add phantom `ghost_table` entry                                                                            | every_table_…, clearing_…, wal-marker test, ipc forgetting_… (DELETE of a missing table)                                          |
| duplicate `ref_org` entry                                                                                  | every_table_has_a_forget_class (listed != tables)                                                                                 |
| swap `sync_state` and `sync_quarantine` (sync_state not last)                                              | ipc forgetting_the_device_… (the `last()` assertion)                                                                              |
| class filter dropped (`.filter(                                                                            | _                                                                                                                                 | true)`)                        | ONLY the new lib unit test (plan suites: none)            |
| class filter inverted (`!=`)                                                                               | new lib unit test, clearing_…, wal-marker test, ipc forgetting_…                                                                  |
| `table_class` always `None`                                                                                | every_table_has_a_forget_class                                                                                                    |
| commit after each delete (not atomic; `COMMIT; BEGIN IMMEDIATE` inside the loop)                           | ipc forgetting_the_device_… (ref_lines emptied, n=1 not 2)                                                                        |
| migration `0006_unclassified_probe.sql` adding a table (removed afterwards, tree clean)                    | every_table_has_a_forget_class: `tables without a forget class: ["unclassified_probe"]; add each to TABLE_CLASSES in local_db.rs` |
| `if busy == 0                                                                                              |                                                                                                                                   | true` in the checkpoint result | none (pre-existing, untouched by this task; see concerns) |

Note: my first «sync_state first» mutant inserted a duplicate rather than moving the entry (killed by the duplicate check for the wrong reason); the swap mutant above is the correct one.

No test can hang: the new tests have no waits, listeners or loops on external state. The ipc test needs the loopback-free in-process mock app only (run outside the sandbox per the rules).

## Classification notes

- `floor_sign_in_failures` is `Disposable`, as the plan lists it: a forget wipes the lockout counters (migration 0005 comment says the same; the sync's wipe for another pairing keeps them). Consequence worth knowing: forgetting the device clears an active station/operator lockout. This follows the plan; no discrepancy with the plan, only with the (now stale, unedited) wording of migration 0005's comment "`clear_copies` takes every table".
- Order inside `TABLE_CLASSES` is observable only through `sync_state` being last (pinned by the ipc test); with no foreign keys the rest is free.

## Concerns / notes for the controller

1. The seam `clear_classed` and one extra unit test go beyond the plan's file list (same file, private); lib total 50 vs the plan's 49.
2. Stale texts left for later tasks, not touched here: `LocalDb::remove_unopened`'s doc comment ("treated as a disposable copy, as in `clear_copies`…"; Task 5), `apps/standalone/AGENTS.md` and the spec §16 (Task 9), migration 0005's comment (applied migration, cannot be edited), `LocalDbError::StatementFailed` doc still accurate.
3. The «busy ignored» checkpoint mutant survives (pre-existing: no test holds an older reader snapshot); outside this task's scope.
4. The plan dropped `PRAGMA defer_foreign_keys = ON`; safe only while no table has a foreign key (stated in the `TABLE_CLASSES` doc). Nothing enforces "no foreign keys" mechanically.
5. I ran two `cd`-free commands but one early Bash call began with `cd /tmp/claude/wt/2a4-shell`; `find` found no stray `.cc-writes` directories in the worktree.

## Files changed

- /tmp/claude/wt/2a4-shell/apps/standalone/src-tauri/src/local_db.rs
- /tmp/claude/wt/2a4-shell/apps/standalone/src-tauri/tests/local_db.rs
- /tmp/claude/wt/2a4-shell/apps/standalone/src-tauri/tests/ipc.rs
