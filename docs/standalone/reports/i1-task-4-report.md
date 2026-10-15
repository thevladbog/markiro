# Plan I1, Task 4 report: the restore puts the copy's identity in place (marker, interruption, flags, summary)

Status: **DONE_WITH_CONCERNS**. Commit `3e49763f6` on `claude/m2` (BASE `9a480e6a5`). `git status --short` is empty after the commit. The commit has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

## What was done

- `host/src/restore.rs`:
  - Added `RestoreOptions`, `IdentityOutcome` and `RestoreReport.identity`. `Intent.identity` is `#[serde(default)]`, so markers from older builds still read.
  - Added `restore_with` and `restore_now`. `restore` and `restore_crashing` keep their signatures and use `Auto`.
  - Added `stage_identity`, `install_identity` and `remove_identity_staging`, plus `keep_replaced` and `private_dir_builder` (see Deviations).
  - `finish_interrupted` now runs before `host.json` is read. On a rollback it removes the staged identity. When the database had finished, it installs the identity before it removes the marker.
  - `restore_until` follows the brief. `foreign` is still computed from the folder's `host.json` as it was before the restore (Д7).
  - `established = current == Unreadable || (current == Read && initialized)`.
  - The audit word goes into `host.restore` details as `"identity"`.
  - Added the summary lines.
  - The three `#[cfg_attr(not(test), allow(dead_code))]` attributes from Task 3 are removed.
  - The module doc and its crash table now describe the identity steps.
- `host/src/main.rs`:
  - Added `--keep-identity` and `--take-identity`. They exclude each other, a repeated flag is allowed, and they are accepted only with `restore`.
  - Updated `USAGE` and the module doc line.
  - `restore()` now calls `restore_now`.
  - Added the brief's CLI test.
- `host/tests/restore.rs`: the brief's 5 tests, the `"identity": "kept"` audit expectation, and 8 more tests (listed below).

## C1 and crash-safety invariants

These are kept as they were:

- the intent marker;
- counter floors and margins: `history_known = Read && initialized && !foreign`, with `foreign` taken from the identity the folder had before the restore;
- revision = copy + 1;
- revocations carried only when the history is known;
- the WAL fold.

The table test checks across every cut that the revision equals copy+1 and that every counter is ≥ 110 000. The C1 regression mutants M30–M32 are still killed.

Every cut is recoverable. The cases are:

- **Cut before the marker (`IdentityStaged`):** the host may start, and it starts on the installer's whole database and identity. The orphan `identity.partial/` is 0700 with 0600 files, and the next restore removes it.
- **Cut while the marker is there:** the host refuses to start.
  - Rollback cuts (`DatabaseAside`): the database is put back, the staged identity is removed, and the identity is unchanged.
  - Cuts after the swap (`NewDatabaseInPlace`, `IdentityKeySaving`, `IdentityPartly`, `IdentityCertificate`, `IdentityInPlace`): the next run finishes the remaining renames. A file that was already moved is skipped.
- **The replaced identity is always kept whole.** It goes to `restore-<time>/identity/` through a synced `.partial` before its file is replaced, so a half-copied key is never taken for the saved one.
- **The identity in place must read whole before the marker goes.** That means the key matches the certificate, so the host never runs with the database of one identity and the key of another. A lost staged file keeps the marker in place, and the host waits.
- **No key file under the data folder is ever open to others.** Tests assert mode `& 0o077 == 0` on Unix after every cut and after every finish.
- **No line prints key material.** The summary, the error texts and the real binary's stdout and stderr are checked for a 24-character key fragment.

## RED / GREEN (logs in `/tmp/claude/impl-i1-t4/`)

- Baseline before the task: `--lib` 112, `--bin` 8, `--test restore` 37 (`baseline.txt`).
- RED (`red1.txt`): `--test restore` does not compile. Errors: E0432 (`restore_with`, `IdentityOutcome`, `RestoreOptions`), E0599 (`CrashPoint::IdentityPartly`) ×2, E0609 (no field `identity`) ×6, E0282.
- First GREEN (`green1.txt`): 41/42 passed. `a_damaged_identity_is_refused_and_keep_identity_restores_without_it` failed with "the data folder changed … this run only created the lock file". The brief's `installed()` helper does not take the lock that `start` takes. I fixed the helper (Anchor adaptation 1), and the next run was 42/42 (`green2.txt`).
- Final focused runs (`step7.txt`, `green4.txt`), with plan increments vs measured:

| Suite                  | Plan | Measured                                           |
| ---------------------- | ---- | -------------------------------------------------- |
| `--test restore`       | +5   | 50 passed (37 → 50, +13: the brief's 5 + 8 more)   |
| `--bin markiro-host`   | +1   | 9 passed (+1)                                      |
| `--lib`                | 0    | 114 passed (+2: the marker and summary unit tests) |
| `--test restore_hold`  | —    | 9 passed                                           |
| `--test backup_routes` | —    | 14 passed                                          |

- **ONE full `cargo test --workspace --offline --locked`, unsandboxed** (`workspace.txt`): 71 result lines, **1182 passed, 0 failed, 0 ignored**, exit 0, 0 warnings. Task 3 left 1166, so this is +16 (13 + 2 + 1). `no_secrets_in_logs` runs inside it.

## Tests added beyond the brief

1. `every_cut_of_a_restore_that_takes_the_identity_is_finished_by_the_next_one`: a new PC with the installer. It cuts at `DatabaseAside`, `IdentityStaged`, `NewDatabaseInPlace`, `IdentityKeySaving`, `IdentityPartly`, `IdentityCertificate` and `IdentityInPlace`, and checks after each cut:
   - the state before and after the next restore;
   - the interrupted kind (RolledBack, none or Finished);
   - the outcome (Restored or Same);
   - the installer's key, certificate and `host.json` kept once, with nothing half-copied left;
   - key modes;
   - counters ≥ 110 000 and the revision equal to copy+1;
   - no key in the summary.

   `WalAside` is not in the table: the installer's closed database has no WAL. It rolls back the same way `DatabaseAside` does, and the older tests cover it.

2. `a_restore_cut_off_twice_inside_the_identity_is_finished_by_the_third_run`: with and without the installer. The first run is cut after the key, and the second is cut again after the certificate, inside `finish_interrupted`. The test checks the exact files on disk (key first, then certificate, `host.json` last) and that the third run finishes.
3. `an_identity_that_would_not_read_whole_keeps_the_marker`: a staged certificate goes missing after the database swap. The restore fails with "does not read whole", the marker stays and the host refuses to start.
4. `a_restore_cut_off_after_its_identity_was_in_place_is_finished_by_the_next_one`: the marker is left after the staging folder was removed.
5. `an_identity_staged_before_a_cut_goes_with_the_next_restore`: after a cut, a run with `--keep-identity` still removes `identity.partial/`.
6. `over_an_unreadable_database_of_another_identity_the_copys_identity_waits`: an unreadable database counts as an established host.
7. `an_identity_without_a_database_is_kept_aside_when_the_copys_replaces_it`: see Deviation 2.
8. `the_restore_command_takes_the_copys_identity_only_when_told`: the real binary, run without a flag and with `--take-identity`. No key appears in its output.
9. Unit tests: `a_marker_of_an_older_build_reads_and_stages_no_identity` and `the_summary_says_what_became_of_the_identity_and_which_port_to_open`.

## Mutants (harness `/tmp/claude/impl-i1-t4/mutate.py`, logs in `mut/`)

Each mutant is applied to a pristine copy, the suite is run, and the file is restored and touched. After the runs, `shasum -a 256` gave `c41ea3aa…` (`restore.rs`), `9bf4c45b…` (`main.rs`) and `f9be781c…` (`tests/restore.rs`), equal to the pristine copies, and `cmp` reported all three the same. The workspace run came after the restore.

| Id  | One-line mutant                                                                | Result                                                                                                                      | Killed by (first)                                     |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| M01 | `foreign` judged after the identity (`!matches!(copy.identity, Present) && …`) | KILLED                                                                                                                      | over_a_working_host… (110 000 vs 9500)                |
| M02 | install order reversed (`host.json` first)                                     | KILLED                                                                                                                      | cut_off_inside_the_identity, cut_off_twice, …in_place |
| M03 | finish never installs (`if false && intent.identity`)                          | KILLED                                                                                                                      | 4 tests                                               |
| M04 | `finish_interrupted` moved after `host.json` is read                           | KILLED                                                                                                                      | 7 tests (no-installer case)                           |
| M05 | `established = false`                                                          | KILLED                                                                                                                      | over_a_working_host…, unreadable, CLI                 |
| M06 | `established` without `Unreadable`                                             | KILLED                                                                                                                      | over_an_unreadable_database…                          |
| M07 | `established` without the wizard check                                         | KILLED                                                                                                                      | new_computer… and 6 more                              |
| M08 | marker `identity: false`                                                       | KILLED                                                                                                                      | 4 tests                                               |
| M09 | `#[serde(default)]` dropped                                                    | KILLED                                                                                                                      | a_marker_of_an_older_build…                           |
| M10 | `keep_replaced` re-copies when the kept file exists                            | SURVIVED, **equivalent**: while the staged file exists, the target is still the original, so a re-copy gives the same bytes | —                                                     |
| M11 | `keep_replaced` without `.partial` (`partial = saved`)                         | KILLED                                                                                                                      | every_cut… (half key at `IdentityKeySaving`)          |
| M12 | identity folders 0755                                                          | KILLED                                                                                                                      | every_cut…, cut_off_twice                             |
| M13 | staged files `File::create` (0644)                                             | KILLED                                                                                                                      | same                                                  |
| M14 | kept files `File::create` (0644)                                               | KILLED                                                                                                                      | same                                                  |
| M15 | post-install `HostIdentity::read` check ignored                                | KILLED                                                                                                                      | an_identity_that_would_not_read_whole…                |
| M16 | no skip of a file already moved                                                | KILLED                                                                                                                      | 5 tests                                               |
| M17 | staging folder gone treated as an error                                        | KILLED                                                                                                                      | …identity_was_in_place…                               |
| M18 | no `create_dir_all(tls)`                                                       | KILLED                                                                                                                      | no-installer cases                                    |
| M19 | no `remove_identity_staging` after finish                                      | KILLED                                                                                                                      | an_identity_staged_before_a_cut…                      |
| M20 | rollback keeps the staged identity                                             | SURVIVED, **equivalent**: `restore_until` removes it straight after `finish_interrupted`, with nothing in between           | —                                                     |
| M21 | no aside folder for an identity without a database                             | KILLED                                                                                                                      | an_identity_without_a_database…                       |
| M22 | `saved_as` not filtered to a database aside                                    | KILLED                                                                                                                      | same                                                  |
| M23 | audit word fixed to "kept"                                                     | KILLED                                                                                                                      | new_computer…                                         |
| M24 | `copy_had_one` always false                                                    | KILLED                                                                                                                      | damaged…keep, staged…keep                             |
| M25 | `new_identity` true when installing                                            | KILLED                                                                                                                      | new_computer…                                         |
| M26 | port line inverted                                                             | KILLED                                                                                                                      | summary unit test                                     |
| M27 | default port taken from the identity itself                                    | KILLED                                                                                                                      | summary unit test                                     |
| M28 | "Same" line removed                                                            | KILLED                                                                                                                      | on_the_same_computer…                                 |
| M29 | staged identity removed before the marker (staging not before the marker)      | KILLED                                                                                                                      | 10 tests                                              |
| M30 | C1: drop `!foreign`                                                            | KILLED                                                                                                                      | another_host…, over_a_working_host…                   |
| M31 | C1: drop `initialized`                                                         | KILLED                                                                                                                      | made_again_by_a_start…                                |
| M32 | C1: carry revocations always                                                   | KILLED                                                                                                                      | 5 tests                                               |
| C01 | flag conflict allowed                                                          | KILLED                                                                                                                      | restore_takes_one_identity_flag…                      |
| C02 | identity flags accepted on other commands                                      | KILLED                                                                                                                      | same                                                  |
| C03 | `--keep-identity` read as Take                                                 | KILLED                                                                                                                      | same                                                  |
| C04 | the CLI passes `Auto` instead of the flag                                      | KILLED                                                                                                                      | the_restore_command_takes…                            |

The brief's five step-8 mutants are M01, M02, M03, M04 and M05; all are killed. Not mutated: `sync_all` and `sync_dir`, because durability cannot be observed by a host test.

## Anchor adaptations / deviations

1. **`installed()` helper.** I added `drop(paths.lock().unwrap())`. `start` takes the lock, so its file exists. Without it, `refused()` saw the lock file that the refusal created as a change. This is mechanical, and the doc comment of the helper already says "as `start` leaves them".
2. **An aside folder is made when an identity is replaced and there is no database to set aside.** `replacing = installing && host.json existed`, so the folder's own identity is never overwritten without being kept. This is the dispatch's "never delete the only good identity". Д8 keeps it only "if `restore-<time>` exists". `saved_as`, the audit `savedAs` and the summary "there was no previous database" stay keyed to a real database aside. The reviewer may judge this a semantic extension; it is purely additive.
3. **Extra `CrashPoint` variants** (`#[doc(hidden)]`, additive): `IdentityStaged`, `IdentityKeySaving` (it writes half the key into the `.partial`, like a power cut mid-copy), `IdentityCertificate` and `IdentityInPlace`. `finish_interrupted` now takes `crash`, so a cut inside the finishing run can be tested.
4. **`keep_replaced` copies through a synced `.partial` and then renames.** The brief used `copy_private` straight to the final name, unsynced; a cut there could leave a half key that a later run would take as already kept (M11).
5. **The post-install check is new:** `HostIdentity::read` must succeed, or the run fails and the marker stays.
6. **Order of removals.** The staged identity is removed before the marker in both the `finish_interrupted` rollback and the swap-failure rollback, so no key copy outlives the marker (the brief removed it after). Both orders are crash-safe.
7. **Other small changes:**
   - `remove_identity_staging` uses `symlink_metadata` rather than `exists`;
   - the error from a finish that cannot install is wrapped with a "run the same command again" text;
   - the `main.rs` module doc line names the flags;
   - the `restore.rs` module doc and its table describe the identity steps.
8. **Anchors.** All the brief's anchors matched exactly once.

## Process note

Partway through, my harness's pristine folder held `src/restore.rs` and `tests/restore.rs` under the same base name. The first mutant run therefore overwrote `src/restore.rs` with the tests file. I rebuilt `src/restore.rs` from `HEAD` by replaying every recorded edit (`replay.py`), and after `cargo fmt` its sha256 equalled the hash I had recorded before the mutants (`c41ea3aa…`), byte for byte. I then fixed the harness to use path-keyed pristine copies and re-ran every mutant. All results above come from the corrected run, and the workspace run came afterwards.

## Gates

- `cargo fmt --check` is clean.
- `cargo check -p markiro-host -p markiro-proto --all-targets` gives 0 warnings.
- `git diff --check` is clean.
- `grep -nF '\u0'` finds nothing in the three Rust files.
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test` finds only `pairing-code.ts:66`.
- Prettier gate: proven live (a scratch `.ts` failed with exit 1 and was deleted). No prettier-covered file changed.
- No proto, Zod or TS shape changed, so the parity tests and Vitest were not needed. The proto test is green inside the workspace run.
- There is no `graphify-out` in the worktree, so no graph update was run.

## Concerns

1. **The summary of a run that finishes after a cut.** After a cut once the database is in place on a new PC, the re-run reads the first run's restored database. Since the identity is now in place, the folder's `host.json` is the copy's host, and the re-run reports `history_known = true`.
   - Counters stay safe: the first restored database already holds the +100 000 floors, and the test checks ≥ 110 000.
   - But the re-run's summary says "revocations carried over: 0 …" where the lost first run would have said "revoked after the copy are active again: check them in the office". The first run's audit row records `carried: null`.
   - The same loss of the first summary exists for every older "Finished" case.
   - The runbook (Task 7) could tell engineers to check revocations after any "interrupted restore was found: it had finished" line.
2. **An orphan key copy after a cut before the marker.** After `IdentityStaged`, `identity.partial/` (0700/0600, inherited ACL on Windows) stays in the data folder until the next restore, because `start` does not remove it. It is as protected as `tls/key.der`.
3. **Windows is not verified:**
   - inherited ACLs on `identity.partial/` and `restore-*/identity/`;
   - rename over `tls/key.der` and `host.json` under an antivirus (the retries are those of the database swap);
   - folder sync through `FlushFileBuffers`.
4. **Equivalent mutants.** M10 and M20 survive as equivalent (defence in depth, kept as the brief has them).
5. **Rules file.** `i1-implementer-rules.md` still describes a floor plan; I followed the dispatch standard and the brief.
