# Task 7 report — no PIN/badge hashes on disk after a forget (plan 1d4)

**Status:** DONE (no deviation from the brief's text; notes under "Issues and concerns")
**Commit:** `5764d98bb` `fix(standalone): сброс подключения не оставляет хешей на диске` (6 files, +232/-41). `git log -1 --format=%B` shows the subject, a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` exactly once; no other `Co-Authored-By` line. Working tree clean afterwards.

## What I implemented

Everything in the brief, in its step order, verbatim.

- **`src-tauri/src/local_db.rs`**
  - The writer connection runs with `.pragma("secure_delete", "ON")`, so a deleted row is zeroed where it stood.
  - `LocalDb::clear_copies` ends with `PRAGMA wal_checkpoint(TRUNCATE)` after the commit. The row's first column (`busy`) is read; `busy != 0` (a reader with an older snapshot kept the checkpoint from finishing within the 5 s busy timeout) is `Err(LocalDbError::StatementFailed)`, so `device_forget` answers `storage` and keeps `device.json`. Its doc comment now explains this and why `VACUUM` is not needed.
  - `LocalDbState` is `{ db: Option<LocalDb>, dir: Option<PathBuf> }`; `open` remembers its directory, `unavailable()` (no database, no directory) stays for the IPC tests that need neither; new `remove_unopened(&self) -> std::io::Result<()>` removes `standalone-station.db` and its `-wal`, `-shm`, `-journal` files (`FILE_SUFFIXES`): each best effort, then all four are checked with `symlink_metadata`, and one still there is an error. It does nothing for an open database or without a directory.
- **`src-tauri/src/lib.rs`** `device_forget`: an open database is cleared (`clear_copies`), one that did not open is removed (`remove_unopened`); either failure answers `storage` before `state.forget()`, so `device.json` stays for another try.
- **Tests (Step 1, verbatim):** `tests/local_db.rs` gains `file_holds` and `clearing_the_copies_leaves_no_deleted_hash_in_the_file_or_its_wal` (one marker checkpointed into the file before the clear, one only in the WAL; after `clear_copies` neither is in the file or the WAL). `tests/ipc.rs`: the old `forgetting_the_device_without_a_local_database_still_forgets` (whose comment postponed this decision to plan 1d4) is replaced by `forgetting_the_device_removes_a_local_database_that_did_not_open` (all four files gone, `device.json` gone) and `forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays` (a directory in place of the WAL: `storage`, `device.json` stays, the main file is gone, then a second forget succeeds); helpers `save_pairing` and `database_files`; `forgetting_the_device_clears_the_local_copies_first` gets the assertion that the open database's file is still there.
- **Docs (Step 6, verbatim):** `apps/standalone/AGENTS.md` (Local database section, the sentence that ended «plan 1d4 revisits this before PIN and badge hashes land») and `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` §5.2 (line ~445, `device_forget()`; the «план 1d4 пересмотрит это» clause). No other promise of a 1d4 revisit remains outside the frozen plan files under `docs/superpowers/plans/` (`git grep` checked).

I applied the brief's items with a small script that parses the «фрагмент … заменить на …» pairs out of the brief and refuses to write unless each old fragment occurs exactly once at its turn. Step 1 I applied with a hand-written script and then cross-checked with the same parser in `verify` mode (each replacement text of the brief is present exactly once in the resulting file). All 3 + 6 + 2 anchors matched; nothing improvised.

## Tests and results

| Check                                                                                                                | Result                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (run first and again before the commit) | exit 0; only the pre-existing «chunks larger than 500 kB» notice                                                                                               |
| `cargo test -p markiro-standalone --test local_db --offline clearing_the_copies` (sandbox)                           | 3 / 3 pass                                                                                                                                                     |
| `cargo test -p markiro-standalone --test ipc --offline forgetting_the_device` (sandbox)                              | 3 / 3 pass                                                                                                                                                     |
| `cargo test --workspace --offline` (outside the sandbox, `/tmp/claude/1d4-task7-cargo.log`)                          | **36 suites / 348 tests pass** (33 test binaries + 3 doc-test suites), 0 failed, 0 ignored, 0 warnings. Baseline 36 / 346: `local_db` 10 -> 11, `ipc` 11 -> 12 |
| `cargo check --workspace --all-targets --offline`                                                                    | exit 0, 0 warnings                                                                                                                                             |
| `cargo fmt --all -- --check`                                                                                         | exit 0                                                                                                                                                         |
| `cargo clippy -p markiro-standalone --all-targets --offline` (extra; CI does not run clippy)                         | exit 0, 0 warnings                                                                                                                                             |
| `node_modules/.bin/prettier --check` (AGENTS.md, the spec)                                                           | pass                                                                                                                                                           |
| `git diff --check` (worktree and cached)                                                                             | pass                                                                                                                                                           |
| Vitest, once at the end (`pnpm … --filter @markiro/standalone test`)                                                 | **37 files / 769 tests pass**, unchanged                                                                                                                       |
| `grep -F '\u04'` over the diff                                                                                       | no literal escapes; the Cyrillic in the docs and the commit subject is real UTF-8                                                                              |

Not run: Windows (the Windows CI job `standalone-windows-build` also runs these tests, and so does `standalone-rust` on Linux; here only macOS ran), real hardware, a browser, kiosk or 1C checks. `graphify update` was not run: there is no `graphify-out/` in this worktree.

## TDD evidence

**RED**

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline clearing_the_copies` -> exit 101, `2 passed; 1 failed`:

```
test clearing_the_copies_leaves_no_deleted_hash_in_the_file_or_its_wal ... FAILED
thread '…' panicked at src-tauri/tests/local_db.rs:455:9:
pbkdf2$sha256$100000$marker-in-the-database-file stayed in the file
```

Expected (brief): the writer has no `secure_delete` and there is no checkpoint, so the marker checkpointed into the file before the clear is still in the file.

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device` -> exit 101, `1 passed; 2 failed`:

```
forgetting_the_device_removes_a_local_database_that_did_not_open
  panicked at src-tauri/tests/ipc.rs:475:9:
  /tmp/claude-501/.tmpWiknv6/standalone-station.db is still there
forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays
  panicked at src-tauri/tests/ipc.rs:497:5:
  assertion `left == right` failed
    left: Ok(Null)
   right: Err(String("storage"))
```

Expected (brief): `device_forget` still forgets without touching an unopened database. `forgetting_the_device_clears_the_local_copies_first` passes (its new assertion holds already: the open database's file is never removed).

**GREEN** (same commands after Step 3): `local_db`: `running 3 tests … test result: ok. 3 passed; 0 failed`; `ipc`: `running 3 tests … test result: ok. 3 passed; 0 failed`.

## Mutation evidence

For each: `shasum -a 256` of the file, a copy of it, the brief's scratch edit (from the brief's own fragments), the named command, the failure, the reverse edit, `shasum -a 256` again (equal) and `cmp` against the copy (identical). Files at commit time: `local_db.rs` `6ad83fc926690c4aaa80adb3f8447fe84459e979c86cea71f1b0549c67863198`, `lib.rs` `ffad2884509513195f6f19ca6429ed98bd4ee63b7b8aeccf1c37d355c91a6f94` (both equal to the pre-mutation hashes below, and to `git show HEAD:<file> | shasum`).

| #   | Mutation                                    | File / mutated sha256                                                                               | Command                                                                  | Failing output                                                                                                           | Revert                                     |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 1   | `secure_delete` removed                     | `local_db.rs` / `b1f0a813651f8d9c93ebbaf442ff4779bdb46dd06a19fa8f3fd1becae6cf1a49`                  | `… --test local_db --offline clearing_the_copies_leaves_no_deleted_hash` | exit 101, `local_db.rs:455:9: pbkdf2$sha256$100000$marker-in-the-database-file stayed in the file`                       | sha `6ad83fc9…3198` equal, `cmp` identical |
| 2   | checkpoint removed                          | `local_db.rs` / `89b0d5124df7061027ee25bbd5ff686f6e4c58197620c352198ab80a556ae0ae`                  | same                                                                     | exit 101, same message (the marker moved into the file before the clear stays there: the zeroed page is only in the WAL) | equal, identical                           |
| 3   | no «still there» check in `remove_unopened` | `local_db.rs` / `8d687c0b4e5a57030b9b1ee9fce894b7cf84deaaecfd659da220318523398691`                  | `… --test ipc --offline forgetting_the_device_keeps`                     | exit 101, `ipc.rs:497:5: left: Ok(Null)`, `right: Err(String("storage"))`                                                | equal, identical                           |
| 4   | `Err(_) => true` (old forget, no removal)   | `lib.rs` / `69426c58bd25874a0fd9af2328c79f24f82170b90c39724da62fd4c218fce1d6` (pre `ffad2884…6f94`) | `… --test ipc --offline forgetting_the_device_removes`                   | exit 101, `ipc.rs:475:9: /tmp/claude-501/.tmpN8roBX/standalone-station.db is still there`                                | `ffad2884…6f94` equal, identical           |

Notes on the run:

- Mutation 1 was run twice. My first helper reverted by swapping the fragments back and refused («matched 2 times»): the mutated text `.busy_timeout(BUSY_TIMEOUT),` occurs twice (writer and readers). The file stayed mutated for that moment; I reverted it with a context-anchored reverse edit (`.foreign_keys(true)` line above) and proved sha256 equality and `cmp`, then fixed the helper to revert at the recorded offset and re-ran mutation 1 end to end (same failure, revert proven). The table above is the second, clean run; mutations 2 to 4 used the fixed helper.
- **Extra probe, not in the brief and not committed:** `wal_checkpoint(TRUNCATE)` -> `wal_checkpoint(RESTART)` (the checkpoint moves the zeroed pages into the file but leaves the old frames in the WAL). Mutated sha `cd085d73cdd32aca7a919d2877e418201dd294e8587f51674ebc950a74df7c0b`; the trace test fails on its WAL half: `local_db.rs:456:9: pbkdf2$sha256$100000$marker-in-the-database-file stayed in the WAL`; reverted, sha `6ad83fc9…3198` equal, `cmp` identical. The brief's mutations 1 and 2 both stop at the file assertion, so this shows the WAL assertion has power of its own.

## Scratch probes (deleted, never committed)

- **Busy branch.** A reader holding an older snapshot (a raw read-only connection: `BEGIN` + `SELECT`) while `clear_copies` runs: the call returned `Err(StatementFailed)` after 5.36 s (the busy timeout), and after the reader committed a second `clear_copies` returned `Ok(())`. The temporary test file `tests/zz_scratch_busy.rs` was removed right after (`git status` showed only my six files).
- **Failed open.** With four garbage files, the shell's `LocalDbState::open` fails and SQLite deletes the stray `-shm` and `-journal` but leaves `-wal`, exactly as the brief's test comment says (the bundled SQLite in `libsqlite3-sys` 0.30.1). The temporary file `tests/zz_scratch_open.rs` was removed too.

## Files changed

```
apps/standalone/src-tauri/src/local_db.rs
apps/standalone/src-tauri/src/lib.rs
apps/standalone/src-tauri/tests/local_db.rs
apps/standalone/src-tauri/tests/ipc.rs
apps/standalone/AGENTS.md
docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
```

Not touched: `apps/station`, `apps/standalone/{proto,host,src}`, any `Cargo.toml`/lockfile, the migrations, `ru.json`.

## Self-review findings

- **Completeness:** every step of the brief (1 to 7); all four mutations shown failing plus one extra; both doc sentences rewritten (AGENTS.md ~:150, spec §5.2 ~:445); totals as expected (36 / 348, Vitest unchanged).
- **Quality:** no `unwrap`/`expect`/`panic` in the non-test code I added; errors through `LocalDbError` and `DeviceError`; the only text an error carries is a file path (never a hash, a PIN or a key) and `device_forget` drops the `io::Error` anyway (answers `storage`). No dependency added.
- **Discipline:** nothing beyond the brief was committed; the three scratch experiments (busy branch, failed open, RESTART probe) left no trace (`git status` clean, sha256 equal).
- **Tests:** the traces test finds the markers in neither the file nor the WAL after `clear_copies` and fails without `secure_delete` (mutation 1), without the checkpoint (mutation 2) and with a non-truncating checkpoint (extra probe). The ipc tests fail without `remove_unopened`'s removal (mutation 4) and without its check (mutation 3).

## Issues and concerns

1. **The busy branch has no committed test.** The brief adds none and 348 is the expected total. I checked the behavior by a scratch test (above): `Err(StatementFailed)` after the 5 s busy timeout, a retry succeeds. A committed test would cost about 5 s of wall clock; a possible follow-up if you want it pinned.
2. **Wording, left verbatim:** the `clear_copies` doc comment and AGENTS.md say a reader with an older snapshot makes «this fail as a whole». That is true of the call's result, but the delete has already committed by then; only the (idempotent) checkpoint is repeated by the retry.
3. **Windows is unverified here.** The Windows CI job runs the new tests. sqlx closes a failed connection's handle on its worker thread just after it returns the error, so on Windows a `remove_file` racing within microseconds could see a sharing violation; the command would answer `storage` and a retry works, and the tests do a lot of work between the failed open and the removal, so I expect no flake, but I could not run it.
4. **Scope of `secure_delete`:** it zeroes what this writer deletes from now on. Bytes freed earlier by a writer without it (a development database made with Task 6's build) are not scrubbed retroactively; no released build is affected.
