# Plan I1, Task 2 report: copies carry the identity (manifest, worker, second folder, rotation, `hostIdentity`)

Status: DONE_WITH_CONCERNS. Commit `1591c8eed` on `claude/m2` (BASE `a14d9ad32`).

## What was done

All brief steps 1-9, code as in the brief:

- `copy.rs`: `Manifest.identity: Option<IdentityRef>` (`default`, `skip_serializing_if`, so a manifest without one is the old bytes), `Manifest::copy()` gives `host_identity`, `make_copy_with_identity` (+ private `make_copy_in`, `Attached`), the identity is attached before the manifest (the manifest names what `attach` returned), failed-copy cleanup removes `.identity` and its `.partial`.
- `folder.rs`: `list` drops an identity the folder lacks or whose size differs from the manifest; `clean` removes a `.identity` beside no `.json`; `rotate` removes `.identity` with its copy (NotFound tolerated, other errors propagate); `replicate_guarded` (+ `replicate` with `platform_guard()`), the second folder's manifest names the identity only when it was put and closed there; failure cleanup removes the identity put by this call, never one that was there.
- `worker.rs`: `Backups.guard` + `new_with_guard`; before each copy the data folder identity is read (blocking task); it is used only when it reads and names the worker's host id, else the copy goes without it (warn log, no secret); the second folder uses the same guard.
- `proto`: `BackupCopy.host_identity` (`#[serde(default)]`), fixture, Rust test; Zod `hostIdentity: z.boolean()`, test support and test.
- Test helpers: `write_identity`, `identity: None` in the two `Manifest` literals.

## Beyond the brief (security-critical file, mutant coverage)

Eight extra `backup_copy` tests and two extra `backup_worker` tests:

1. a copy that fails after its identity was put (a guard that, as a side effect, turns the manifest's `.partial` into a folder) leaves nothing of itself, and an earlier good copy in the folder stays byte-identical;
2. a failed replication removes the identity it put into a fresh folder, and leaves the copy and identity that were already in another folder byte-identical;
3. the identity is copied only when the manifest names it (a stray file beside a manifest without one is not copied); mode 0600 in the second folder;
4. a manifest without an identity has no `identity` member (older build bytes) and reads as none; one with it round-trips;
5. the listing trusts an identity only of the manifest's size;
6. rotation keeps the identity of the fresh copy even when the rule drops it (clock set back), and copes with copies that have no identity;
7. rotation returns the error for an identity it cannot remove and keeps the copies it keeps;
8. clean removes a stale `.identity.partial` and never touches `notes.identity` (not a copy name);
9. worker: each folder is closed by the worker's own guard, a folder the guard refuses gets a copy without the identity and the run still succeeds (both directions);
10. worker: a data folder whose identity does not read (broken key) still gets its copies.

## Tests

- RED: tests were written before the production code, but I did not run the suite between; the RED is compile-level (the new symbols did not exist) and, behaviourally, every guard below was shown to fail under its mutant. No separate RED log.
- GREEN: `--test backup_copy` 28 -> 40 (plan +4, mine +8 more), `--test backup_worker` 13 -> 17 (plan +2, +2 more). Vitest `backups.test.ts` + `backup-warnings.test.ts` + `backups-page.test.tsx`: 60 passed (run with `--testTimeout=60000`; stderr clean). Proto `backup` test is part of the workspace run.
- Full `cargo test --workspace --offline --locked`, unsandboxed: 71 result lines, **1158 passed, 0 failed, 0 ignored** (Task 1 baseline 1142; +16), exit 0, 0 warnings. Log: `/tmp/claude/impl-i1-t2/workspace.txt`.
- `cargo fmt --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings; clippy shows no warning in the files touched (the warnings it prints are in old files). `tsc` typecheck and eslint clean. Prettier gate proven live (a mis-formatted scratch file failed, deleted), then clean on the 4 TS/JSON files. `git diff --check` clean, `\u04` grep only `pairing-code.ts:66`. `git status --short` empty after the commit. No React effect tests were added, so the delayed-`setImmediate` stand was not run.

## Mutants

Harness `/tmp/claude/impl-i1-t2/mutate.py`: each mutant applied to an original copy, `cargo test -p markiro-host --test backup_copy --test backup_worker --no-fail-fast`, file restored from `/tmp/claude/impl-i1-t2/orig/`. After the run the sha256 of copy.rs, folder.rs and worker.rs equalled the pre-run hashes (printed `True` x3) and the files were touched. All 23 Rust mutants KILLED, none survived.

| Id  | Mutant                                                                              | Killed by (first)                                                  |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| C01 | failed-copy cleanup keeps `.identity`                                               | a_copy_that_fails_after_its_identity_...                           |
| C02 | manifest writes `identity: null` (no skip_serializing_if)                           | a_manifest_without_an_identity_..., the_manifest_is_plain_json_... |
| C03 | `host_identity` always false                                                        | a_copy_carries_the_host_identity_... (+2)                          |
| C04 | manifest never names the identity                                                   | a_copy_carries_the_host_identity_... (+2)                          |
| C05 | local copy ignores the given guard                                                  | a_folder_that_cannot_be_closed_... (+2)                            |
| F01 | list keeps an identity the folder lacks                                             | a_copy_carries_the_host_identity_...                               |
| F02 | list ignores the identity file size                                                 | the_listing_trusts_an_identity_only_of_the_size_...                |
| F03 | clean leaves an orphan identity                                                     | rotation_and_cleaning_take_the_identity_...                        |
| F04 | clean removes identities that have a manifest                                       | rotation_and_cleaning_take_the_identity_...                        |
| F05 | rotate leaves a rotated copy's identity                                             | rotation_and_cleaning_... (+1)                                     |
| F06 | rotate fails on a copy without identity (NotFound arm gone)                         | 3 old and new tests                                                |
| F07 | rotate swallows an identity it cannot remove                                        | rotation_stops_at_an_identity_it_cannot_remove_...                 |
| F08 | rotate removes the identity of a kept copy                                          | rotation_and_cleaning_... (+2)                                     |
| F09 | rotate forgets `keep_also` (fresh copy)                                             | rotation_keeps_the_identity_of_the_fresh_copy_... (+2 old)         |
| F10 | second folder ignores the given guard                                               | the_second_folder_gets_the_identity_or_... (+2)                    |
| F11 | second folder writes the source manifest                                            | the_second_folder_gets_the_identity_or_...                         |
| F12 | failed replication leaves the identity it put                                       | a_failed_replication_removes_the_identity_it_put_...               |
| F13 | failed replication removes an identity that was there                               | a_failed_replication_removes_the_identity_it_put_...               |
| F14 | folder manifest names an identity that was not put                                  | 3 tests                                                            |
| W01 | worker takes the identity of another host                                           | an_identity_of_another_host_stays_out_of_the_copy                  |
| W02 | worker replicates with another guard                                                | each_folder_is_closed_by_the_workers_guard_...                     |
| W03 | worker copies locally with another guard                                            | each_folder_is_closed_by_the_workers_guard_...                     |
| W04 | identity that does not read stops the run                                           | a_data_folder_whose_identity_does_not_read_... (+2 old)            |
| Z01 | Zod `hostIdentity` removed (vitest, sha256 of `backups.ts` restored OK, `cmp` same) | backups.test.ts                                                    |

Equivalent, not mutated: the redundant `remove_file(partial_path(&identity_path(..)))` cleanups (`put_file` already removes its own partial on failure; kept as defence in depth); `#[serde(default)]` on the `Option` member (serde defaults a missing `Option` anyway; kept as the brief says). The brief's four mutants are covered (C-like F11, F08/F05, W01, F01).

## Anchor adaptations

- `proto/fixtures/backup-state.json`: the brief names the second copy by `…0d4f6b21.db`; I matched by the `sha256` value (the file is `…113512Z-0d4f6b21.db`), same intent.
- `proto/tests/backup.rs`, `test/backups.test.ts`, `copy.rs` module docs: matched exactly once. The copy.rs doc anchor was the lines as given. `cargo fmt` reflowed three brief fragments (the `attach` closure, `replicate_guarded` call in the worker, one line of a test); no semantic change.
- All other anchors matched exactly once. No semantic differences.

## Concerns

- "hold" in the dispatch title: I read it as `hostIdentity` (the brief has no hold work); nothing about the restore hold was touched.
- `make_copy_with_identity` generates its own tag, so the brief's early "already there" guard cannot meet an existing `.identity`; a stray orphan identity of a random tag is removed by `clean`. A pre-existing equal-named replica in the second folder is overwritten with identical bytes (same as the database).
- When replicating a copy that is already in the second folder and the identity can no longer be put (guard refuses), the old `.identity` file stays on disk but the rewritten manifest names none (listed as "no key"); the file is removed with the copy by rotation. Acceptable, not corrupted.
- `clean` is only safe when no copy is being written (existing rule); an identity put before its manifest is a leftover to `clean` for that moment, same as a `.db` without a manifest.
- Windows: `IcaclsGuard` and OWNER RIGHTS on a real NTFS/FAT32/share are still unverified (Task 1 concern); this task only exercises the guard through `OwnerOnly` and fake refusing guards.
- Task 3 still has to map `read_beside` strings to stable codes.
- Prettier/Vitest ran on the TS side only; the host/proto Rust did not have any browser or Windows check.
