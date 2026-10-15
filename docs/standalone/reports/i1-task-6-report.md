# Plan I1, Task 6 report: the station keeps its pairing, an end-to-end check with real hosts

Status: **DONE**. Commit `0907811c0` on `claude/m2` (BASE `3a1afe3fd`). Only `apps/standalone/src-tauri/tests/restore_identity.rs` was added. `git status --short` is empty after the commit. The commit has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line. No host or shell source changed.

## What the file does

The file runs real `markiro-host`s on 127.0.0.1 and a real shell `DeviceState` for the station and the office PC. The old host runs the wizard and pairs a station by code. The office makes a template, a product and a shift, and the station enters the shift. The station takes SSCC block 1. The office makes a manual copy through the API. Then the station takes block 2, which the copy never saw. The old host is stopped.

Each host binds `127.0.0.1:0`, so the new host always has a new address (a new PC has a new address).

### Tests (7)

| Test                                                                                | What it proves                                                                                      |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `a_station_keeps_its_pairing_with_its_host_restored_on_a_new_computer`              | The positive path, end to end.                                                                      |
| `with_keep_identity_the_new_computer_is_another_host`                               | The brief's second test: `--keep-identity` gives `AddressOtherHost` and `device.json` is unchanged. |
| `a_copy_without_the_identity_leaves_the_pairing_lost_as_before`                     | The older copy: the pairing is lost, as before.                                                     |
| `a_copy_of_another_host_does_not_replace_a_working_host_unless_told`                | A copy of another host is refused over a working host, and `--take-identity` takes it.              |
| `an_identity_changed_beside_its_copy_is_refused_and_the_station_is_not_given_to_it` | Tamper case (a): same identity, same size, one byte changed, so only the manifest SHA-256 tells.    |
| `a_key_that_does_not_belong_to_the_certificate_is_refused`                          | Tamper case (b): another host's key under this certificate, with the manifest made to agree.        |
| `an_identity_file_lost_from_its_copy_is_refused_the_same_way`                       | Tamper case (c): the manifest names the file, but the file is gone.                                 |

### The positive test

The test checks, in order:

1. The copy carries the identity.
2. `restore_now` with `Auto` returns `Restored`.
3. `report.revision == copy revision + 1`. The copy revision is read from the copy's own `host_revision`.
4. The new host has the same fingerprint and `hostId` as the old one, and a different address.
5. Nothing answers at the old address (`Unreachable`).
6. `change_address` succeeds. `device_id`, `host_id` and `fingerprint` are unchanged, and `device.json` differs only in `host_address`.
7. `GET /v1/device` returns the same id.
8. The feed revision equals copy+1.
9. Facts are held: `POST /v1/device/facts` returns 503 `restore_pending`.
10. Known blocks return exactly `[known, registered]`, with no `block_mismatch` and no `block_overlap`.
11. The revision after the blocks is above the revision the station saw on the old host.
12. The office PC changes its address and signs in again (a restore ends all sessions).
13. The office resumes the facts.
14. A box closed with the lost block 2's first serial is accepted record by record. Without the registration it would be `sscc_not_issued`.
15. The next block comes above block 2.

### The negative tests

- **Older copy (no identity).**
  - The `.identity` file is removed and `identity` is dropped from the manifest.
  - The result is `other_host`, `Kept { copy_had_one: false }`, the installer's fingerprint stays, and the host id differs from the old one.
  - The station gets `AddressOtherHost` and its `device.json` is unchanged.
  - `--take-identity` refuses: "carries no host identity".
- **Copy from another host.**
  - The target is a working host with a wizard and a paired station of its own.
  - `Auto` refuses with a message naming both flags, and the host restarts unchanged.
  - `Take` makes the computer host A. A's station keeps its pairing, and the replaced host's station gets `AddressOtherHost`.
- **Tampered identity.**
  - `Auto` and `Take` both refuse with "damaged" and name `--keep-identity`.
  - The refusal message does not contain the first 24 characters of the key.
  - The restart shows the host unchanged.
  - `Keep` then restores the data. The outcome is `Kept { copy_had_one: true }` and the station gets `AddressOtherHost`.

## Evidence

No RED run: the file is a new test file and the host code already existed. RED is shown by the mutants below. All logs are in `/tmp/claude/impl-i1-t6/`.

- First run (`run1.txt`): 6 passed, 1 failed.
  - The failure was my own test. It restored while the "new" host was still running. The host lock refused with "Nothing was changed". I stopped the host before the `--take-identity` attempt.
- Greens: `green1.txt`, `green2.txt`, and 5 repeat runs `rep1..5.txt`. All pass, 7/7.
- A mutant run exposed a race in my `copy_now` helper.
  - The worker's own automatic copy made `POST /v1/office/backups` answer 409 `backup_running`.
  - The helper now asks again until 202. After that, the 5 repeat runs and the whole mutant set were run on the final file.

### Mutants

Run by `/tmp/claude/impl-i1-t6/mutate.py` on pristine copies. Each mutant has a log in `mut/Mxx.txt`.

| Id  | One-line mutant of host code                                                                                    | Killed by                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| M01 | `restore.rs` `identity_plan`: `_ if choice == Keep => Ok(own)` becomes `_ => Ok(own)` (never install)           | the positive test (the brief's mutant: `AddressOtherHost`) and the working-host test |
| M02 | the same line becomes `_ if false => Ok(own)` (`--keep-identity` ignored)                                       | the keep-identity test                                                               |
| M03 | `other_host()` becomes always false                                                                             | the older-copy test and the keep-identity test                                       |
| M04 | `Some(_) if !established \|\| Take` becomes `Some(_)` (installs over a working host)                            | the working-host test                                                                |
| M05 | drop `\|\| choice == Take` (`--take-identity` refused over a working host)                                      | the working-host test                                                                |
| M06 | the `Damaged` arm becomes `if false`                                                                            | all 3 tamper tests                                                                   |
| M07 | `read_beside_coded`: drop the SHA-256 comparison and keep the size                                              | tamper (a)                                                                           |
| M08 | `tls.rs` `from_der`: `identity.server_config()?` becomes `let _ = …` (key not checked against the certificate)  | tamper (b)                                                                           |
| M09 | restore revision: `next_revision` becomes `current_revision` (not copy+1)                                       | the positive test                                                                    |
| M10 | `resume_facts` no longer clears the hold                                                                        | the positive test                                                                    |
| M11 | the restore does not set `facts_held_since`                                                                     | the positive test (the 503 `restore_pending` check)                                  |
| M12 | `known_blocks`: `device == device_id` becomes `!=` (`block_mismatch` for the pre-existing pairing)              | the positive test                                                                    |
| M13 | `known_blocks` registers nothing (`Some((from, to))` becomes `None`)                                            | the positive test                                                                    |
| M14 | `copy_had_one: true` fixed in the report                                                                        | the older-copy test                                                                  |
| M15 | `known_blocks` INSERT stores `to_serial` as `from_serial`. The revision still moves, so only the facts show it. | the positive test (receipt `sscc_not_issued`)                                        |

All 15 are KILLED.

**Restore proofs.** After the runs, `shasum -a 256` of the five touched host files equals the pristine copies, and `cmp` agrees. The files are `restore.rs` (`c41ea3aa…`, the same as the Task 4 report), `identity.rs`, `tls.rs`, `routes/backups.rs` and `routes/known_blocks.rs`. Each was `touch`ed after the restore so cargo rebuilds.

## Totals

- Focused `--test restore_identity`: 7 passed. The plan said +2. The extra five are the negative cases the dispatch asked for.
- ONE final `cargo test --workspace --offline --locked --no-fail-fast`, unsandboxed (`workspace.txt`): 72 result lines, **1189 passed, 0 failed, 0 ignored**, exit 0, 0 warnings. Task 4 left 1182, so this is +7.
- `cargo fmt --check` is clean.
- `cargo check -p markiro-host -p markiro-proto --all-targets` and `cargo check -p markiro-standalone --tests` give 0 warnings.
- `git diff --check` is clean.
- `grep -cF '\u0'` on the new file gives 0.
- `grep -rnF '\u04' src test` finds only `pairing-code.ts:66`.
- No TS, JSON or MD file changed, so the prettier gate has nothing to check. No Vitest was needed.

## Anchor adaptations and differences from the brief

1. **Brief test 1 is extended.** It now includes the facts hold, known-blocks and resume steps, the revision and the device-id checks. The brief's own assertions are all kept. The test needs an open shift and blocks before the copy, so `old_host_died` sets those up.
2. **Role.** `claim` with `InstallRole::Station` worked, so no fall-back to `Office` was needed.
3. **Office session.** A restore deletes all `office_sessions` (existing `restore.rs` behaviour). The office PC therefore changes its address and signs in again with the wizard fixture's credentials (read from the project's own `bootstrap-request.json`). Then it resumes the facts.
4. **`SqliteConnection`.** The copy revision is read from the copy with sqlx. `sqlx` is already a dependency of the shell, so no manifest change.
5. **`cargo fmt` expanded the file** to 888 lines (the `json!` blocks).

## Self-review and concerns

1. **The "revision monotonic" claim.**
   - It means: restored revision = copy+1 (host and feed) and, after the blocks are re-registered, above the revision the station last saw on the old host.
   - It does not mean the restored revision is above the old host's last revision. The restore deliberately sets copy+1.
   - Here, the old host's last revision (after block 2) equals copy+1, so a station cursor at that value sees "nothing new" until the registration moves it. This is the existing behaviour of plan РК, not new.
2. **Not covered:** the station's own connection task and `host_claim` reaction to the new `restoreEpoch`. They are not in this crate's host tests. The test drives the same calls the webview makes (`change_address`, known blocks, facts).
3. **Loopback only.** The "new address" is a different loopback port. DHCP, DNS, a real second PC, Windows ACLs on `.identity` and the firewall port from `host.json` are not exercised (runbook, section 10).
4. **Tamper (b)** uses another host's real key, so it checks the certificate-key match. It does not check a malformed DER.
5. The rules file `i1-implementer-rules.md` describes a floor plan. I followed the dispatch standard and the brief.
