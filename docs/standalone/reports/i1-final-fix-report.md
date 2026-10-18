# Plan I1 — final fix wave report

Worktree `/tmp/claude/wt/m2`, branch `claude/m2`, base `9942dcf7c`. Source: `.superpowers/sdd/i1-final-review-report.md` (fix wave of 4 commits). Status: **DONE_WITH_CONCERNS**. The concerns are Windows-only behaviour that cannot run on macOS.

## Commits

| #   | SHA         | Subject                                                                                         |
| --- | ----------- | ----------------------------------------------------------------------------------------------- |
| 1   | `110efa811` | fix(standalone): the host identity is written through the handle the guard closed               |
| 2   | `dc6b8d424` | fix(standalone): an identity the service cannot delete never stops rotation or cleaning         |
| 3   | `2f554933b` | fix(standalone): restore texts name the real button and what a finished interrupted restore did |
| 4   | `9632d9194` | docs(standalone): a device revoked after the copy returns to a new-PC restore by itself         |

Every commit message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git status --short` is empty.

## What was done

### I-1 (security): the key goes through the handle the guard closed (commit 1)

- **New module `host/src/backup/key_file.rs`.** It uses `std` only, so a probe crate can type-check it for Windows.
  - `create(path)` opens the file with `create_new` and `write`. On Unix the mode is `0600`. On Windows it uses `OpenOptionsExt::share_mode(0)`.
  - `still_named(file, path)` on Unix compares device and inode of the open handle with `symlink_metadata(path)`. That call does not follow links, and a link has its own inode. On other systems it returns `true`, because the unshared handle forbids any rename or delete.
- **`identity.rs` `put_file`:**
  - removes a stale `.partial` as before;
  - `key_file::create`, then `guard.protect(&partial)`, then `write_all` and `sync_all` through the same handle. Nothing reopens the file by path.
  - On Unix, before the rename, `still_named` must hold. If it does not, the key is wiped from the file that was moved away (`set_len(0)` and `sync_all`), the call fails, the copy goes without an identity, and the planted thing under the partial name is removed. The target name is never given to what was planted.
  - The module doc says the same.
- **The trait seam is unchanged.** Tests inject guards through `KeyFileGuard`. `share_mode(0)` lives behind `#[cfg(windows)]` in `key_file.rs`.
- **Docs:**
  - runbook §2: a new bullet on the handle and that nobody can open, delete or rename the file while the host writes it;
  - runbook §10 item 11: `share_mode(0)` with `icacls` must pass, and the second-folder copy must show «есть»;
  - spec §26 «Защита ключа» and «Не проверено»;
  - AGENTS.

### I-3 (Windows continuity): rotation and cleaning never stop on an undeletable identity (commit 2)

- **`folder.rs`:**
  - `is_identity(name)` matches `.identity` and `.identity.partial`.
  - `remove_identity(path) -> bool`. NotFound returns `false` silently. Any other error is a `tracing::warn!` with the path and the io error only, then `false`.
  - `rotate` removes the manifest, then the database, then the identity last, through `remove_identity`.
  - `clean` sends identity names through `remove_identity` and counts only removed files. Any other leftover that cannot be removed still returns `Err`.
- **Tests:**
  - `rotation_stops_at_an_identity_it_cannot_remove_and_keeps_the_copies_it_keeps` is replaced by `rotation_goes_on_past_an_identity_it_cannot_remove`. The database and manifest go. The next dropped copy's identity still goes. The undeletable identity stays. A second `rotate` and `clean` are not stopped.
  - New: `cleaning_goes_on_past_an_identity_it_cannot_remove_and_still_fails_on_anything_else`.
  - New: `backup_worker::an_identity_the_host_cannot_delete_never_fails_the_second_folder`. The second folder's report is `Ok`, and its attempt has no failure code.
  - In all three, «Cannot be deleted» is simulated by a non-empty directory under the identity's name: `remove_file` refuses it on every OS. This was the existing fixture's approach.
- **Docs:**
  - runbook §2: after a service-account change or a new PC on the same share, older `.identity` files may stay; the log line is quoted; an administrator deletes them;
  - runbook §10 item 11;
  - AGENTS rotation text.

### Minors FIX m-1, m-2, m-3 (commit 3)

- **m-1.** The `restore.rs` summary now ends with `… change the host address on each device («Сменить адрес хоста»)`. The wrong screen «Офис →» is gone. The unit test `the_summary_says_what_became_of_the_identity_and_which_port_to_open` now compares the whole line, not only the prefix. Docs already used «Сменить адрес хоста»; no other code or doc names «Изменить адрес хоста». The plan document still does, and it is not edited by rule.
- **m-2.** `Made::unchanged` for `Interrupted::Finished` now reads «… had finished: it was completed (its marker removed).» The doc of `Interrupted::Finished` is updated. New unit test: `a_refusal_after_an_interrupted_restore_was_finished_says_it_was_completed`.
- **m-3 / K05.** New test `tests/restore.rs::a_swap_undone_whole_leaves_no_staged_identity_behind` (`cfg(unix)`). A new PC (installer state) restores a copy with an identity. A dangling symlink stands at `restore-20261009T150000Z`: `aside_dir`'s `exists()` follows it and finds nothing, so `create_dir` fails with EEXIST and the swap is undone whole.
  - The test asserts the refusal text, and that `identity.partial`, the marker and `host.db.partial` are all absent.
  - It also asserts the database bytes are unchanged and the installer's identity is still in place.

### I-2 and Minors DOC m-5, m-6, m-7 (commit 4)

- **I-2, runbook §6 step 7.** A new first bullet, before «Лучше всего»:
  - the condition: something was revoked after the copy, or nobody knows;
  - the reason: copy keys are valid again, revocations are not carried, the certificate is the same, so the device reconnects as soon as the service answers at the old address and pulls the references;
  - the order: give the new PC another address; start the service (step 8); on one office PC use «Сменить адрес хоста» to that address and re-revoke (check 3); only then give the new PC the old IP and use «Сменить адрес хоста» on that office PC again.
- **I-2, other places:**
  - «Что теряется и на новом ПК с ключом хоста» gets the same point.
  - Check 3: «до запуска станций» becomes «до того, как станции увидят хост: на новом ПК — до перевода его на адрес старого (раздел 6, шаг 7)», with the reason the old wording is impossible.
  - The same rewording is applied to the PIN/badge sentence below it, which also said «до запуска станций».
  - Spec §26 «Что теряется и с ключом».
  - AGENTS: one sentence, so it does not contradict the runbook.
- **m-5.** Runbook §6 step 6 and spec §26 now say «повреждение или обрезка … подмена без правки манифеста». The spec adds that the manifest is unsigned, and that a rewritten manifest yields a host the stations reject (a DoS, not impersonation).
- **m-6.** Runbook §2: NTFS rights on a flash drive do not protect against whoever holds it, so any flash drive with a copy, let alone with `.identity`, goes to the safe or is fully encrypted. The weekly flash-drive step says the same for FAT32, exFAT and NTFS.
- **m-7.** Runbook §5 step 10 and spec §26: cancelling a new-PC restore with the copy's key puts back the installer's database but not its identity. That identity is in `restore-<время>\identity`; call support.

Not implemented, as triaged: CARRY m-4, m-8, items 12, 19, 26, 29, 31, 33; DROP items.

## RED / GREEN evidence

| Step                                   | Command (from `/tmp/claude/wt/m2`, cargo `--offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host`) | Result                                                                                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-1 RED (tests on the old `put_file`)  | `--lib backup::` → `/tmp/claude/impl-i1-fix/red1.log`                                                                     | exit 101; 21 passed, 2 FAILED: `a_partial_swapped_while_it_is_closed_never_gets_the_key_nor_the_identitys_name` (identity.rs:1018, `reference` was `Some`), `a_partial_swapped_for_a_link_while_it_is_closed_writes_nothing_through_it` (identity.rs:1071) |
| I-1 GREEN                              | `--lib backup::` → `green1.log`, `green1b.log`                                                                            | 23 passed, 0 failed                                                                                                                                                                                                                                        |
| I-3 RED (tests on the old `folder.rs`) | `--test backup_copy past_an_identity` → `red3.log`                                                                        | exit 101; both new tests FAILED (backup_copy.rs:1154 rotate `Err`, :1190 clean `Err`)                                                                                                                                                                      |
| I-3 GREEN                              | `--test backup_copy` → `green3.log`; `--test backup_worker` → `green3w.log`                                               | 41 passed; 18 passed                                                                                                                                                                                                                                       |
| m-1/m-2 RED                            | `--lib restore::` → `red4.log`                                                                                            | exit 101; 27 passed, 2 FAILED (the new text test and the whole-line summary assertion)                                                                                                                                                                     |
| m-1/m-2/m-3 GREEN                      | `--lib --test restore` → `green4.log`                                                                                     | lib 119 passed; restore 51 passed                                                                                                                                                                                                                          |
| m-3 RED                                | K05 mutant below: the new test fails with `remove_identity_staging` removed from the swap-undone branch                   | KILLED                                                                                                                                                                                                                                                     |

## Mutant table

Harness: `/tmp/claude/impl-i1-fix/mut/mutate.py`.

- Each run copies the file first, applies the one-line mutant, runs the named target and restores from the copy.
- It then checks sha256 before and after plus `cmp`, and touches the restored file so cargo rebuilds.
- Logs: `/tmp/claude/impl-i1-fix/mut/<id>.log`; summaries: `run-i1.txt`, `run-i1b.txt`, `run-i3.txt`, `run-r.txt`.
- No log contains `privateKey` or `PRIVATE KEY`.
- The new swap tests compare planted or victim bytes with `assert!(… == …)`, not `assert_eq!`, so a failure never prints key bytes.

| Id    | File                        | One-line mutant                                                                                          | Killed by                                                                                                      | Restore proof (sha256 after restore)                                       |
| ----- | --------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| I1-A1 | identity.rs                 | reopen `&partial` by path (`OpenOptions::write().truncate().open`) before `write_all`: the old behaviour | both swap tests                                                                                                | restored ✓, `518a46d45599…` (re-run as A1b on the committed post-fmt file) |
| I1-A2 | identity.rs                 | `if false && !key_file::still_named(…)` (no name check before rename)                                    | both swap tests                                                                                                | ✓ `518a46d45599…`                                                          |
| I1-A3 | identity.rs                 | `file.set_len(0)` wipe dropped                                                                           | both swap tests (the moved-away file still holds the key)                                                      | ✓ `518a46d45599…`                                                          |
| I1-A4 | key_file.rs                 | `still_named` compares the device only (no inode)                                                        | both swap tests + `a_name_moved_away_or_replaced_no_longer_names_the_open_file`                                | ✓ `83d9c4da8d2a…`                                                          |
| I1-A5 | key_file.rs                 | `options.mode(0o600)` dropped                                                                            | `the_file_is_born_owner_only_and_writable_through_its_handle`                                                  | ✓ `83d9c4da8d2a…`                                                          |
| I1-A6 | key_file.rs                 | `create_new(true)` → `create(true)`                                                                      | `a_name_moved_away_or_replaced_no_longer_names_the_open_file` (`create` twice must fail)                       | ✓ `83d9c4da8d2a…`                                                          |
| I1-A7 | key_file.rs                 | `symlink_metadata` → `metadata` (follows a link)                                                         | `a_name_moved_away_or_replaced_no_longer_names_the_open_file`                                                  | ✓ `83d9c4da8d2a…`                                                          |
| W1    | key_file.rs (Windows probe) | `use std::os::windows::fs::OpenOptionsExt;` removed                                                      | probe `cargo check --target x86_64-pc-windows-msvc`: E0599                                                     | ✓ `83d9c4da8d2a…`                                                          |
| W2    | key_file.rs (Windows probe) | `SHARING_VIOLATION: i32` → `u32` in the Windows test                                                     | probe `--tests`: E0308 (the Windows test module is compiled)                                                   | ✓ `83d9c4da8d2a…`                                                          |
| I3-a  | folder.rs                   | `rotate` propagates an identity removal error again                                                      | `rotation_goes_on_past_an_identity_it_cannot_remove`                                                           | ✓ `4ef509740dfb…`                                                          |
| I3-b  | folder.rs                   | `clean` uses `fs::remove_file(&path)?` for identities                                                    | the clean test + the rotation test (cargo stopped before `backup_worker`, whose new test covers the same path) | ✓                                                                          |
| I3-c  | folder.rs                   | `if true \|\| is_identity(name)` (tolerate every leftover)                                               | the clean test (an undeletable `.db.partial` must still fail)                                                  | ✓                                                                          |
| I3-d  | folder.rs                   | `is_identity` misses `.identity.partial`                                                                 | the clean test                                                                                                 | ✓                                                                          |
| I3-e  | folder.rs                   | `rotate` never removes the identity                                                                      | `rotation_and_cleaning_take_the_identity_with_its_copy` + the new rotation test                                | ✓                                                                          |
| I3-f  | folder.rs                   | `remove_identity` reports a failed removal as removed                                                    | the clean test (count 2) + the rotation test (`clean == 0`)                                                    | ✓                                                                          |
| I3-g  | folder.rs                   | identity removed before the database                                                                     | **SURVIVED — equivalent**                                                                                      | ✓ `4ef509740dfb…`                                                          |
| K05   | restore.rs                  | `remove_identity_staging(paths)` dropped in the swap-undone branch (the review's survivor)               | `a_swap_undone_whole_leaves_no_staged_identity_behind`                                                         | ✓ `8b253be93627…`                                                          |
| M1    | restore.rs                  | summary back to «(Офис → «Изменить адрес хоста»)»                                                        | `the_summary_says_what_became_of_the_identity_and_which_port_to_open`                                          | ✓ `8b253be93627…`                                                          |
| M2    | restore.rs                  | Finished text back to «only its marker was removed»                                                      | `a_refusal_after_an_interrupted_restore_was_finished_says_it_was_completed`                                    | ✓ `8b253be93627…`                                                          |

**Why I3-g is equivalent.** The identity's removal can no longer fail the call, so the order is visible only on a cut between the two removals. Either order then leaves one file without a manifest that `clean` removes (a `.db`, or an `.identity`). A database that `list` shows but `remove_file` refuses cannot be built on Unix without refusing the manifest's removal first. The identity-last order is kept as the review asked.

**Windows-only code.** The `share_mode(0)` branch of `key_file::create` (mutant: drop `share_mode(0)`) can only be killed on Windows, by the `cfg(all(test, windows))` test `while_the_host_holds_the_key_file_nobody_else_can_open_move_or_delete_it`. That test asserts that read and write opens fail with ERROR_SHARING_VIOLATION (32), that rename and delete fail, and that the handle still writes. It runs in CI job `standalone-windows-build` (`cargo test --workspace` on Windows). On macOS it was only type-checked by the probe crate `/tmp/claude/impl-i1-fix/probe`, which is not committed: `#![deny(warnings)]`, the real `key_file.rs` via `#[path]`, `cargo check --offline --target x86_64-pc-windows-msvc --lib --tests` exit 0, and W1/W2 show the probe is live. The Swapping test also has a Windows branch: the move must fail and the identity must be written.

**Earlier mutant discipline.** The earlier 35 + 15 mutants were not weakened, with one deliberate exception. Task 2's F07 pinned «rotation stops at an identity it cannot remove». That behaviour is now inverted by the review's decision, and its test was replaced by one that pins the new behaviour (I3-a kills the old behaviour). No other existing assertion was loosened. One existing test was strengthened from a prefix check to a whole-line check (m-1).

## Test totals

| Suite                                                                                                                           | Before (review baseline) | After                                                  | Delta                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ | ----------------------------------------- |
| `markiro-host --lib`                                                                                                            | 114                      | 119                                                    | +5 (identity +2, key_file +2, restore +1) |
| `--test backup_copy`                                                                                                            | 40                       | 41                                                     | +1 (−1 replaced, +2)                      |
| `--test backup_worker`                                                                                                          | 17                       | 18                                                     | +1                                        |
| `--test restore`                                                                                                                | 50                       | 51                                                     | +1                                        |
| **Final full run** `cargo test --workspace --offline --locked --no-fail-fast` (unsandboxed, `/tmp/claude/impl-i1-fix/full.log`) | ≥ 1189 expected          | **1197 passed, 0 failed, 0 ignored** (72 result lines) | +8                                        |

- Vitest parity `test/backups.test.ts` (Zod side of `proto/fixtures/backup-state.json`): 7 passed, stderr empty.
- Rust parity `markiro-proto --test backup` is in the full run, green.
- The webview and proto were not touched.

## Gates

- `cargo fmt --all -- --check` was clean before each commit. `cargo fmt` reflowed two test assertions in commit 1 and one in commit 2; I-1 mutants A1–A3 were re-run on the formatted, committed file (A1b–A3b, all killed).
- `cargo check -p markiro-host -p markiro-proto --all-targets`: 0 warnings, each commit.
- **Prettier gate:**
  - proven live: a mis-formatted `apps/standalone/zz-scratch-prettier.md` gave «Checking formatting… [warn]», exit 1, and the scratch file was deleted;
  - the three markdown files (`apps/standalone/AGENTS.md`, `docs/runbooks/standalone-backup-restore.md`, the pilot spec) pass, run from inside the worktree with repo-relative paths.
- `git diff --check` is clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` → only `src/host/pairing-code.ts:66`. No `\u0` in the changed Rust files.
- Clean tree after the last commit; no scratch files in the tree.

## Files changed

- `apps/standalone/host/src/backup/key_file.rs` (new)
- `apps/standalone/host/src/backup/identity.rs`
- `apps/standalone/host/src/backup/mod.rs`
- `apps/standalone/host/src/backup/folder.rs`
- `apps/standalone/host/src/restore.rs`
- `apps/standalone/host/tests/backup_copy.rs`
- `apps/standalone/host/tests/backup_worker.rs`
- `apps/standalone/host/tests/restore.rs`
- `apps/standalone/AGENTS.md`
- `docs/runbooks/standalone-backup-restore.md`
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`

## Deviations / anchor adaptations

- **A new file, `key_file.rs`, which the review did not name.** It lets a probe crate type-check the Windows branch and its test, which a cfg-gated block inside `identity.rs` (many dependencies) would not allow.
- **The Unix name check plus wipe goes beyond the review's «write through the handle».** With only the handle, a swapped partial would leave a planted file or link under `<name>.identity` and an orphan key file elsewhere in the folder. With the check, the identity is left out («нет») and no key stays at an unknown name.
- **The second «до запуска станций»** (the PIN/badge sentence of check 3) was reworded too.
- **One AGENTS sentence for I-2** was added for consistency, although AGENTS did not contradict the runbook.
- **The deleted draft test `rotation_removes_the_identity_last`** could not be built (see I3-g); it is not in any commit.

## Not verified (external)

- Windows, not run:
  - `icacls` succeeding on a file held open with `share_mode(0)`. The review expects `READ_CONTROL|WRITE_DAC` to be outside sharing; if it fails, every identity is left out and the office shows «нет».
  - The sharing-violation test, which runs only in Windows CI.
  - An undeletable `.identity` under a changed service account or on a domain share. The runbook's §10 item 11 now lists these checks.
- The Windows CI job `standalone-windows-build` is the first place the `cfg(windows)` test runs. The restore tests there also use `platform_guard()` (real `icacls` with the unshared handle), so they exercise the combination on the runner's NTFS temp folder.
- No browser, WebView2, station, printer or shell e2e beyond the full cargo workspace (which includes `restore_identity`).

## Concerns

1. `icacls` under `share_mode(0)` is unconfirmed on real Windows (reasoned, plus CI on the next push). If it fails, the effect is visible at once (every copy «нет»), not silent.
2. On Windows a window remains between closing the handle and the rename: someone with delete-child rights could swap the closed file then. The key is not exposed by that; their file just gets the identity's name and reads as damaged. The Unix name check runs before the rename, but a swap after it is the same non-leaking case.
3. F07's old intent is reversed by design, per the review.
