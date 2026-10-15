# Plan 2a4, Task 5 report: a forget waits for unsent records; an unreadable database is set aside

BASE `939a2c8dc`, commit `a799cb101` (`feat(standalone): a forget waits for unsent records, and an unreadable database is set aside, not deleted`), branch `claude/2a4-shell`, one trailer (Opus 5.5, pinned by the repository rules). `git status --short` is empty after the commit. Nothing pushed.

## Status: DONE_WITH_CONCERNS (concerns at the end)

## What was done

Plan Task 5 as briefed, plus the controller's Task 4 Minor 1 item, plus extra tests where the plan's let one-line mutants survive.

- `local_db.rs`:
  - `UnsentGuard { Pairing, AnyPairing, Ignore }`
  - `LocalDbError::UnsentRecords { count }` with code `unsent_facts`
  - `clear_copies(guard)`: the unsent count runs inside the same `BEGIN IMMEDIATE` transaction, before the first delete
  - `LocalDbState.db` is now a `OnceLock`, with a `setting_aside` mutex
  - `set_aside_unopened()` and `set_aside_unopened_at(stamp)` replace `remove_unopened`
  - The doc wording at the table-class comment is corrected: a plain key fails at the `DELETE` statement, and `ON DELETE CASCADE`/`SET NULL` silently changes kept rows.
- `lib.rs`: `device_forget(keepUnsent?)`. The guard follows the brief: `Some(true)` or unpaired gives `Ignore`; paired gives `Pairing`; unreadable `device.json` gives `AnyPairing`. A refusal logs the count to stderr and answers the bare code.
- Webview: `forget(options?)` sends `{keepUnsent:true}` only for `true`. `unsent_facts` is added to `DEVICE_ERROR_CODES`, and `errors.device.unsent_facts` to `ru.json`.
- Foreign-key guard (Task 4 Minor 1): `no_table_has_a_foreign_key` in `tests/local_db.rs`. It walks every table of the real migrated schema with `pragma_foreign_key_list` and forbids foreign keys altogether (the review's recommended fix). It names the child, the parent and the `ON DELETE` action.

## Deviations from the brief

1. The anchor for `clear_copies` in `local_db.rs` differs from the brief's. Task 4's review added the private seam `clear_classed(classes)`, and the brief predates it. I applied the same change to the seam: `clear_copies(guard)` calls `clear_classed(TABLE_CLASSES, guard)`, and the count goes into `clear_classed`'s transaction. The Task 4 unit test now passes `UnsentGuard::Ignore`. I stopped on no other anchor; every other fragment matched.
2. Fragment 6 of the `ipc.rs` edit, as written, consumed the old test's closing lines. I restored the closing `assert!(!config.exists()); }` of `with_an_unreadable_pairing_any_unsent_record_stops_a_forget`.
3. The brief's Unix permission test (`forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays`) put `device.json` and the database in one 0o500 directory. A mutant that ignores a failed move (`set_aside_unopened().await.is_ok() || true`) survived it: `device.json` could not be removed in that read-only directory either, so `storage` came back anyway. I split it: the database lives in its own read-only directory and `device.json` in a writable one. The mutant now fails.
4. I added a guard in `set_aside_unopened_at`: a target name that already exists is refused, with rollback. A plain `rename` would silently replace an earlier set-aside with the same stamp on Unix, which breaks "nothing deleted". This is beyond the plan.

## Tests added beyond the plan

In `tests/local_db.rs` (16 planned, 21 measured):

- The plan's `a_forget_refuses_while_unsent_records_remain` now also holds a record with a different host and the same device. Without it, a mutant that ignores the host survived.
- `sent_records_and_other_pairings_do_not_stop_a_forget` is extended. It now checks `AnyPairing` with an acked and an unsent row (counts 1), and then Ok once all are acked. Without that, a mutant counting acked rows survived.
- `an_outbox_that_cannot_be_counted_stops_a_forget`: an outbox without the columns gives `StatementFailed` and clears nothing (it fails closed instead of counting 0).
- `a_record_arriving_while_a_forget_waits_is_counted_not_wiped`: deterministic and bounded.
  - A raw connection holds `BEGIN IMMEDIATE`.
  - The forget is spawned, and the test sleeps 400 ms and asserts it is still waiting.
  - The test then commits an unsent record, and the forget must answer `UnsentRecords{1}`.
  - The wait is bounded by `timeout(10 s)`.
- `a_forget_fails_while_a_reader_keeps_the_wal_and_succeeds_after`: this is Task 4's Minor 3, which was queued for this task. A reader holds an older snapshot, so the checkpoint is busy and the call fails with `StatementFailed` while the delete stays. A retry after the reader ends succeeds. It costs one busy timeout (5 s) and is bounded by `timeout(30 s)`.
- `no_table_has_a_foreign_key` (see above).
- `an_earlier_set_aside_is_never_overwritten`.
- The plan's `a_file_that_cannot_be_set_aside_puts_the_others_back` also asserts the blocking directory's content is untouched.

In `tests/ipc.rs` (15 planned, 16 measured): `without_a_pairing_unsent_records_do_not_stop_a_forget`. With no pairing there is nothing to wait for, so the forget clears the copies and keeps the outbox.

## RED

- Vitest, with `device.ts` and `ru.json` reverted for the run: `Tests 2 failed | 32 passed (34)`. The two failures are the planned ones: "forgets despite unsent records only when asked to keep them" and "keeps the shell's refusal while unsent records remain".
- `cargo test --test local_db --no-run`:
  - E0432 `UnsentGuard` unresolved
  - 15 x E0061 (`clear_copies` takes 0 arguments)
  - E0599 `UnsentRecords` missing, 2x
  - E0599 `set_aside_unopened_at` missing, 4x
  - E0282 type annotations, 3x (plan expected 8 E0061, 3 E0599 and 2 E0599; the counts are higher because of my added tests)

## GREEN (`rtk` not used; logs in `/tmp/claude/t5/`)

- Lib 50 (brief 49 plus the Task 4 seam test). `local_db` 21. `ipc` 16, outside the sandbox. No "skipped: the permissions do not stop this user" in the output.
- `cargo test -p markiro-standalone` as a whole, outside the sandbox: all suites pass, 141 tests in 12 targets (`claim` 5, `connection` 6, `device` 15, `host_probe` 2, `host_probe_proxy` 1, `host_request_timeout` 5, `line` 16, `lockdown` 4, and the three above).
- Vitest: `device.test.ts` 35 tests (brief 35). The three files, `device`, `errors` and `app`, show 131 tests and no `stderr |`. The full package suite is 67 files, 1754 tests, passing (the plan says 1752 after Task 5; the 2 more are not from this task, I did not trace them).
- `typecheck` and `lint` clean. Prettier clean. `cargo fmt --check` clean. `cargo clippy -p markiro-standalone --all-targets` has 0 warnings. `cargo check -p markiro-host -p markiro-proto --all-targets` has 0 warnings. `git diff --check` clean.
- `grep -rnF '\u04'` finds only `pairing-code.ts:66`. `\u0` in the four Rust files: nothing.
- The delayed-`setImmediate` stand was not run: the new TS tests render no React.

## Mutants (all restored; `cmp` identical and sha256 before and after equal; logs in `/tmp/claude/t5/mut/`)

Each Rust mutant ran `--lib --test local_db --test ipc --no-fail-fast`. `local_db.rs` sha256 `1491d259ef60…` before and after each of its mutants.

| Mutant                                                                                                                                     | Failed tests (key ones)                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1 rollback block deleted (brief 1)                                                                                                        | `a_file_that_cannot_be_set_aside_puts_the_others_back`                                                                                                                                                                                                                                                                                 |
| m2 `device_id = ?` becomes `? <> ''` (brief 2)                                                                                             | `a_forget_refuses_while_unsent_records_remain`, `sent_records_and_other_pairings_do_not_stop_a_forget`                                                                                                                                                                                                                                 |
| m3 `AnyPairing` becomes `Ignore` (brief 3)                                                                                                 | `with_an_unreadable_pairing_any_unsent_record_stops_a_forget`                                                                                                                                                                                                                                                                          |
| m4 refusal off (`count > 99`)                                                                                                              | 5 tests, among them `a_record_arriving_while_a_forget_waits_is_counted_not_wiped`                                                                                                                                                                                                                                                      |
| m5 host ignored                                                                                                                            | `a_forget_refuses_while_unsent_records_remain` (only because of my extra row)                                                                                                                                                                                                                                                          |
| m6 `acked_at IS NULL` dropped from `AnyPairing`                                                                                            | `sent_records_and_other_pairings_do_not_stop_a_forget` (only because of my extension)                                                                                                                                                                                                                                                  |
| m6b same, `Pairing` branch                                                                                                                 | `sent_records_and_other_pairings_do_not_stop_a_forget`                                                                                                                                                                                                                                                                                 |
| m7 `keepUnsent: false` also confirms                                                                                                       | `forgetting_the_device_waits_for_this_pairings_unsent_records`                                                                                                                                                                                                                                                                         |
| m8 unpaired counts `AnyPairing`                                                                                                            | `without_a_pairing_unsent_records_do_not_stop_a_forget` (mine)                                                                                                                                                                                                                                                                         |
| m9 count made outside the transaction                                                                                                      | `a_record_arriving_while_a_forget_waits_is_counted_not_wiped` (mine)                                                                                                                                                                                                                                                                   |
| m10 count error becomes 0                                                                                                                  | `an_outbox_that_cannot_be_counted_stops_a_forget` (mine)                                                                                                                                                                                                                                                                               |
| m11 outbox-exists check dropped                                                                                                            | `sent_records_and_other_pairings_do_not_stop_a_forget`, `forgetting_the_device_clears_the_local_copies_first`                                                                                                                                                                                                                          |
| m12 open database not protected from being set aside                                                                                       | `an_unopened_database_is_set_aside_and_a_new_one_opens`                                                                                                                                                                                                                                                                                |
| m13 same-stamp guard off                                                                                                                   | `an_earlier_set_aside_is_never_overwritten` (mine)                                                                                                                                                                                                                                                                                     |
| m14 `-journal` not moved                                                                                                                   | `forgetting_the_device_sets_aside_a_local_database_that_did_not_open`                                                                                                                                                                                                                                                                  |
| m15 checkpoint busy ignored (Task 4 Minor 3)                                                                                               | `a_forget_fails_while_a_reader_keeps_the_wal_and_succeeds_after` (mine)                                                                                                                                                                                                                                                                |
| m16 code `unsent_facts` renamed                                                                                                            | `local_db::tests::error_codes_are_stable` and 2 ipc tests                                                                                                                                                                                                                                                                              |
| m21 new database not kept after the move                                                                                                   | `an_unopened_database_is_set_aside_and_a_new_one_opens`, `forgetting_the_device_sets_aside_…`                                                                                                                                                                                                                                          |
| m24 failed move ignored in `device_forget`                                                                                                 | survived the brief's test; after deviation 3, `forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays` fails it                                                                                                                                                                                                      |
| m25 refusal answered as `storage`                                                                                                          | the `waits_for_this_pairings_unsent_records` and `with_an_unreadable_pairing…` tests                                                                                                                                                                                                                                                   |
| m19 (foreign key) scratch migration `0006_scratch_fk.sql`: `fk_probe(line_id REFERENCES ref_lines ON DELETE CASCADE)` classed `Disposable` | `no_table_has_a_foreign_key` with the message `foreign keys are not allowed between local tables: ["\"fk_probe\" -> \"ref_lines\" (ON DELETE \"CASCADE\")"]`. The hand-written table pin in `opening_creates_…` also failed. The migration was removed, `local_db.rs` is byte-identical (`cmp`), and `git status` shows only my files. |

TypeScript mutants (`device.ts` sha256 `623432c4999f…`, `ru.json` `8c832a44e9bc…`, restored):

| Mutant                                               | Failed tests                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| t1: sends `keepUnsent` for `false` as well           | "forgets despite unsent records only when asked to keep them"             |
| t1b: always forwards `options.keepUnsent`            | same                                                                      |
| t2: `unsent_facts` dropped from `DEVICE_ERROR_CODES` | "keeps the shell's refusal while unsent records remain"                   |
| t3: `errors.device.unsent_facts` text removed        | `errors.test.ts` "have a text for every code the shell and the host send" |

## Concerns

1. The mutex that serialises two concurrent `set_aside_unopened` calls has no test that kills a "drop the lock" mutant. The two forgets would both return a correct result and differ only in a double `LocalDb::open`, which no assertion can see. The lock rests on reasoning alone.
2. `a_record_arriving_while_a_forget_waits_…` relies on a 400 ms sleep to let the forget start waiting for the write lock. A scheduler stall longer than that would make it pass vacuously on a wrong implementation. It cannot produce a false failure.
3. `apps/standalone/AGENTS.md` ("Local database") still describes the old behaviour: removal of an unopened database, "every table disposable", keys failing at commit. Task 9 rewrites it, including the stale comments of migrations 0001/0005 and the new foreign-key rule. The full workspace `cargo test --workspace` was not run, only the shell crate.
4. Windows: nothing here is exercised on Windows. The cross-OS rollback is covered only by the `local_db` integration test with a non-empty directory (now partly through the same-name guard); the real `rename` failure only by the Unix permission test.
5. The brief's Vitest count after Task 5 (1752) differs from the 1754 I measured; I did not edit the plan.

---

# Fix section: review findings Important 1 and Minors 1–4

BASE `a799cb101`. Commits (branch `claude/2a4-shell`, nothing pushed, one trailer each):

- `62ad27674` fix(standalone): only a corrupt database is set aside; any other open failure keeps everything
- `6205e2a9a` test(standalone): a wider race detector margin and a test for concurrent set-asides
- `dd352f166` fix(standalone): set-aside failures leave a trace, and a split set is not added to

The Minor 3 documentation is in the doc comment of `device_forget` (commit 1); the 2a5 requirements are in `.superpowers/sdd/2a4-minors.md` (items 5–10). Logs are in `/tmp/claude/t5fix/` (`red1-ipc.txt`, `red2.txt`, `mut/*.txt`, `full.txt`).

## What changed

- **Important 1.** `LocalDbState` keeps why `open` failed (`OpenFailure::Corrupt` | `Other`, `open_failure()`). `Corrupt` is a sqlx `Database` error whose primary SQLite code (low byte of the extended code) is 11 (`SQLITE_CORRUPT`) or 26 (`SQLITE_NOTADB`), also when it comes out of a migration (`MigrateError::Execute` / `ExecuteMigration`). Everything else (`VersionMissing`, checksum mismatch, busy, I/O, `create_dir_all`) is `Other`.
  - `device_forget`, open database: unchanged (guard, then clear).
  - Not open, `Other`: answers `storage`, moves nothing, keeps `device.json`, **with or without `keepUnsent`**.
  - Not open, `Corrupt` (or no failure recorded, i.e. the no-directory shell): `unopened_unsent_records(guard)` reads the file on a read-only connection without migrations. Unreadable at all (garbage, no file) gives 0 and the file is moved. An `outbox` with unsent records for the guard answers `unsent_facts` unless `keepUnsent: true`; an `outbox` that exists but cannot be counted answers `unsent_facts` too (count unknown, fail closed, confirmable). Then `set_aside_unopened()`; a failure of it answers `storage`.
  - `unsent_records` was split into `outbox_exists` + `count_unsent` so the open and the read-only paths share the predicate.
- **Minor 1.** The race test runs on `multi_thread` (2 workers), waits 1000 ms instead of 400 ms, and its doc says it is a detector only under that margin.
- **Minor 2.** `two_set_asides_at_once_move_the_files_once`: 20 rounds, 4 workers, two `set_aside_unopened_at` calls spawned together; exactly one moves, one database plus its `-wal` stay aside, and a write through the state is visible in the file at `FILE_NAME`.
- **Minor 3.** Documented at `device_forget`; 2a5 requirements queued (below).
- **Minor 4.** `eprintln!` of the error kind and the part of the set (database, `-wal`, ...; no path) for a failed move and for each failed put-back, and in `device_forget` for a failed set-aside. Cheap refusal implemented: `set_is_split(dir)` refuses (`InvalidData`, nothing moved, no new database) when a side file has no database file beside it, under the original names or under any `.unreadable-<stamp>`. Doc nit fixed (`std::fs::rename` replaces an existing file on Windows too).

## RED

- Commit 1 (ipc tests first, run outside the sandbox): `cargo test --test ipc -- a_database_that a_corrupt with_an_unreadable_pairing_a_corrupt` gave 4 tests, 3 failed (`/tmp/claude/t5fix/red1-ipc.txt`):
  - `a_database_that_fails_to_open_for_another_reason_is_never_set_aside`: `left: Ok(Null)`, `right: Err("storage")`
  - `a_corrupt_database_with_unsent_records_waits_for_a_confirmation`: `left: Ok(Null)`, `right: Err("unsent_facts")`
  - `with_an_unreadable_pairing_a_corrupt_database_with_any_unsent_record_waits`: same
  - The fourth (`a_corrupt_database_without_this_pairings_unsent_records_is_set_aside`) passes before the fix by design (it is the baseline; its mutants are below).
- `tests/local_db.rs` new tests: `cargo test --test local_db --no-run` gave 19 errors, `E0432 OpenFailure` unresolved, `E0599 open_failure` / `unopened_unsent_records` missing (`red2.txt`).
- Commit 2 and 3 tests (concurrent set-asides, split set) were written against code that already had the lock; their evidence is the mutants `m14`, `m10`–`m12` below, which fail them.

## GREEN (final tree, outside the sandbox, `cargo test -p markiro-standalone`, 0 skipped lines)

lib 51 (was 50, +`only_corruption_codes_make_an_open_failure_corrupt`), `ipc` 21 (was 16: +5), `local_db` 26 (was 21: +5: `only_a_corrupt_file_is_recorded_as_corrupt`, `setting_a_corrupt_database_aside_clears_its_recorded_failure`, `a_database_that_did_not_open_is_counted_without_being_changed`, `two_set_asides_at_once_move_the_files_once`, `a_split_set_aside_is_not_added_to`), the other suites unchanged (claim 5, connection 6, device 15, host_probe 2, host_probe_proxy 1, host_request_timeout 5, line 16, lockdown 4): 152 tests in 12 targets (was 141). `cargo fmt --check` 0, `cargo clippy -p markiro-standalone --all-targets` 0 warnings, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings, `git diff --check` clean, no `\u0` literals in the four Rust files, `git status --short` empty. Vitest was not rerun: no TS/JSON file changed.

## Mutants

Each ran `--lib --test local_db --test ipc --no-fail-fast`. Restore proof: the four files were copied to `/tmp/claude/t5fix/orig/` before, the driver wrote the original text back after each run, `sha256` before equals after for every mutant (`restored True` in the driver output), and a final byte compare of all four files against the copies printed `cmp-identical True` (`run_all.out`, `run_rest.out`). The first sweep (m1–m8) ran before the unit test `only_corruption_codes_make_an_open_failure_corrupt` existed; m5 survived it and caused the test.

| #   | Mutant (one change)                                                                  | Killed by                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1  | `device_forget`: `Other` check disabled (`&& false`)                                 | `a_database_that_fails_to_open_for_another_reason_is_never_set_aside` (`unsent_facts` instead of `storage`)                                                                                                                                   |
| m2  | `SQLITE_NOTADB` dropped from the corruption codes                                    | `forgetting_the_device_sets_aside_a_local_database_that_did_not_open`, `..._keeps_the_pairing_while_an_unopened_database_stays`, `setting_a_corrupt_database_aside_clears_its_recorded_failure`, `only_a_corrupt_file_is_recorded_as_corrupt` |
| m3  | `SQLITE_CORRUPT` dropped                                                             | 4 ipc tests (`a_corrupt_database_*`, `with_an_unreadable_pairing_a_corrupt_*`), `a_database_that_did_not_open_is_counted_without_being_changed`, `only_a_corrupt_file_is_recorded_as_corrupt`                                                 |
| m4  | migration errors never corrupt (`open_failure_of(inner) == Corrupt` becomes `false`) | the same 6                                                                                                                                                                                                                                    |
| m5  | no `& 0xff` mask                                                                     | first sweep: SURVIVED. After the new unit test: `local_db::tests::only_corruption_codes_make_an_open_failure_corrupt` (extended codes 267, 779)                                                                                               |
| m6  | `unopened_unsent_records` answers 0 for every guard                                  | 3 ipc tests + `a_database_that_did_not_open_is_counted_without_being_changed`                                                                                                                                                                 |
| m7  | an unreadable file is an error instead of 0                                          | `forgetting_the_device_sets_aside_a_local_database_that_did_not_open`, `..._keeps_the_pairing_while_an_unopened_database_stays`, `a_database_that_did_not_open_is_counted_without_being_changed`                                              |
| m8  | `device_forget` proceeds after a positive count                                      | `a_corrupt_database_with_unsent_records_waits_for_a_confirmation`, `with_an_unreadable_pairing_a_corrupt_database_with_any_unsent_record_waits`                                                                                               |
| m9  | `device_forget` proceeds after an uncountable outbox                                 | `a_corrupt_database_whose_outbox_cannot_be_counted_waits_for_a_confirmation`                                                                                                                                                                  |
| m10 | split check disabled                                                                 | `a_split_set_aside_is_not_added_to`                                                                                                                                                                                                           |
| m11 | split check: side files at the original names ignored                                | `a_split_set_aside_is_not_added_to`                                                                                                                                                                                                           |
| m12 | split check: side files under a stamp ignored                                        | `a_split_set_aside_is_not_added_to`                                                                                                                                                                                                           |
| m13 | recorded failure not cleared after a set-aside                                       | `setting_a_corrupt_database_aside_clears_its_recorded_failure`                                                                                                                                                                                |
| m14 | the set-aside lock removed (`let _setting_aside = ();`)                              | `two_set_asides_at_once_move_the_files_once`: `round 0: No such file or directory (os error 2)`                                                                                                                                               |
| m15 | `keepUnsent` no longer maps to `Ignore`                                              | `forgetting_the_device_waits_for_this_pairings_unsent_records`, 2 corrupt-database ipc tests, `with_an_unreadable_pairing_any_unsent_record_stops_a_forget`, `with_an_unreadable_pairing_a_corrupt_database_with_any_unsent_record_waits`     |
| r1  | the unsent count made on a reader before `BEGIN IMMEDIATE`                           | `a_record_arriving_while_a_forget_waits_is_counted_not_wiped`: `left: Ok(())`, `right: Err(UnsentRecords { count: 1 })`                                                                                                                       |
| r1b | r1 plus the test's wait set to 0 ms (the reviewer's survivor)                        | now killed too, same assertion; the multi-thread runtime is what widened it                                                                                                                                                                   |

Not covered by a mutant: the `eprintln!` traces (stderr is not captured; the m14 log shows one: `standalone: setting the local database aside failed at its ` file: NotFound``, later reworded to "its database file"). No test makes a real put-back fail; the split refusal is tested on hand-built leftover states.

## Concerns / decisions to confirm

1. **`keepUnsent: true` does not unlock a non-corrupt database that fails to open** (controller decision 1: only corruption is set aside; the dispatch text also said "with `keepUnsent: true` it follows the plan's path" for the newer-migration test, which I read as the corrupt-but-readable case). A station rolled back to an older app version therefore answers `storage` to every forget until the app is updated. If the owner wants a confirmed forget for that case too, it is a one-line extension of the `Other` branch (set it aside when `keepUnsent`); not done.
2. The read-only probe may create the `-shm` index beside a corrupt file that has a `-wal` (the main file is asserted byte-identical). The `-shm` moves with the set; `forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays` now accepts it.
3. A split set makes every later forget answer `storage` until support puts the files together (by design: nothing is deleted or parted).
4. **Environment:** midway through the mutant sweep macOS reported `You have not agreed to the Xcode license agreements`, which broke `cc`, `rustc` linking and `/usr/bin/git`. I did not accept the license. I exported `DEVELOPER_DIR=/Library/Developer/CommandLineTools` (the installed Command Line Tools, clang 21) for cargo and git for the rest of the run. The owner needs to run `sudo xcodebuild -license` on this machine before the controller's shell builds again without that variable. The mutants m9 onward from the first sweep failed to link and were re-run after the switch (`run_rest.out`).
5. Windows is still not exercised (locked files, `rename` semantics); the new tests are platform-neutral file operations.
