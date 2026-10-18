# Plan I1, Task 3 report: verifying a copy reads the identity; `identity_plan`; `verify-copy`

Status: DONE_WITH_CONCERNS. Commit `9a480e6a5` on `claude/m2` (BASE `1591c8eed`).

## What was done

- `restore.rs`: `VerifiedCopy.identity: CopyIdentity` (`Absent` / `Present(Arc<HostIdentity>)` / `Damaged(IdentityDamage)`), `IdentityChoice` (`Auto`, `Keep`, `Take`), private `IdentityPlan` (+ `audit_word`) and `identity_plan`, exactly as in the brief. `verify_copy` reads the identity the manifest names and never fails the copy for a damaged one. `--without-manifest` and a manifest without `identity` give `Absent`.
- `main.rs`: `verify-copy` prints `host identity: host <id> (certificate <fingerprint>)`, `host identity: none (...)`, or fails with `host identity: DAMAGED (<code>: <reason>); ...`.
- Stable error codes (asked for by the dispatch, beyond the brief): `identity.rs` gets `read_beside_coded() -> Result<HostIdentity, IdentityError>`; `read_beside` is now a thin `String` wrapper over it (same texts, same interface as Task 1). `read_bounded` returns `IdentityError` (`Unreadable` for open/read errors, `Invalid` for "too large"). `restore.rs` maps it to `IdentityDamage { code: "identity_unreadable" | "identity_invalid", reason }`. Neither holds a byte of the key.
- C1 semantics untouched: `foreign` / `history_known = Read && initialized && !foreign` (restore.rs ~line 1350) are not edited. `identity_plan` takes `established` as an input; Task 4 must compute it as "current database is a working host's: read with `site.initialized_at` set, or unreadable", and `foreign` must still be computed from the folder's `host.json` BEFORE the restore (Д7). Task 3 changes neither.

## Anchor adaptations / deviations from the brief

1. `CopyIdentity::Damaged(String)` became `Damaged(IdentityDamage)` (a struct with `code` and `reason`, `Display` = the reason). Reason: the dispatch asks for stable codes, which a bare `String` cannot carry. Only Task 3's own text uses `Damaged`; the plan's later tasks do not mention it. Tests that the brief wrote as `Damaged("changed".to_owned())` use a `damaged("changed")` helper.
2. `identity.rs` was edited (the brief's file list does not name it): `read_beside_coded`, `read_bounded` error type. `replicate` logs the same text as before (`IdentityError` implements `Display`).
3. `IdentityPlan`, `audit_word` and `identity_plan` are unused outside tests until Task 4, so they carry `#[cfg_attr(not(test), allow(dead_code))]` (`cargo check` must stay at 0 warnings). Task 4 should remove these three attributes.
4. The existing test helper `verified()` in `restore.rs` needed `identity: CopyIdentity::Absent` (new field).
5. All fragment anchors matched exactly once.

## Tests

- RED: compile level only. Honest note: I wrote production code and tests in one pass and ran no failing build before the code; the guards are therefore proven by the mutants below, not by a RED log.
- GREEN, focused: `--lib restore::identity_tests` 4 passed (plan +1); `--test restore` 33 -> 37 (plan +1; mine +3: damaged identity matrix, huge file, CLI test through the real binary); `--bin markiro-host` unchanged and green (inside the workspace run).
- Full `cargo test --workspace --offline --locked`, unsandboxed: **71 result lines, 1166 passed, 0 failed, 0 ignored**, exit 0 (Task 2 baseline 1158, +8), 0 warnings. Log `/tmp/claude/impl-i1-t3/workspace.txt`.
- `cargo fmt --check` clean, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings, `git diff --check` clean, `git status --short` empty after the commit. No TS/MD/JSON/proto shape touched, so prettier, Vitest and both parity tests were not re-run beyond the workspace run (the proto test is part of it and green).

Tests added beyond the brief:

- `every_combination_of_copy_folder_state_and_choice_has_its_one_outcome`: table-driven over copy {Present, Absent, Damaged} x folder {none, same, same hostId with another certificate/key, other host, unreadable} x established {false,true} x choice {Auto, Keep, Take} = 90 cases, against an oracle written from Д6 (not from the code); every refusal must name the way out.
- `a_refusal_over_a_working_host_names_both_hosts_and_never_the_key`, `the_audit_word_of_every_plan_is_its_own`.
- `a_damaged_identity_beside_a_copy_is_named_and_never_trusted` (through `verify_copy`): file missing -> `identity_unreadable`; one byte changed with the same size; a port change that leaves host, certificate and key intact (only the manifest SHA-256 sees it); cut short; key cut short with the manifest made to agree; junk file with agreeing manifest; a valid identity of ANOTHER host with an agreeing manifest; right file but a manifest naming another certificate; all put back -> `Present`. Each damaged case asserts the code and that neither 24 chars of the key nor of the certificate appear in the text.
- `a_huge_file_beside_a_copy_is_a_damaged_identity` (1 MiB, text "too large").
- `verify_copy_command_prints_the_identity_and_fails_on_a_damaged_one`: the real `markiro-host verify-copy` binary: exit codes, stdout lines, `--without-manifest`, copy without identity, damaged -> non-zero exit with `DAMAGED`, `identity_invalid`, `--keep-identity` in stderr, and no key fragment on stdout/stderr.

## Mutants

Harness `/tmp/claude/impl-i1-t3/mutate.py`: each mutant applied to a pristine copy under `/tmp/claude/impl-i1-t3/orig/`, run with `cargo test -p markiro-host --lib --test restore --no-fail-fast -- identity_tests verify_copy damaged_identity huge_file`, then restored. After the run `shasum -a 256` and `cmp` matched the originals for all four files (restore.rs `1cb4b408...`, main.rs `e4f4c479...`, identity.rs `42f9c854...`, tests/restore.rs `92cfb4b6...`), and the files were touched. Logs in `/tmp/claude/impl-i1-t3/log-*.txt`.

| Id  | One-line mutant                                                              | Result                                                                                                 | Killed by                                             |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| R01 | damaged identity read as `Absent`                                            | KILLED                                                                                                 | damaged-identity test, huge-file, CLI (4)             |
| R02 | damaged identity fails the whole copy                                        | KILLED                                                                                                 | same                                                  |
| R03 | code always `identity_invalid`                                               | KILLED                                                                                                 | damaged-identity test (missing file)                  |
| R04 | good identity read as `Absent`                                               | KILLED                                                                                                 | verify_copy reads..., CLI, damaged-identity           |
| R05 | `--without-manifest` forced `Absent`                                         | SURVIVED, equivalent (no manifest means no reference; brief says to record it)                         |                                                       |
| R06 | `Display` prints the code instead of the reason                              | KILLED                                                                                                 | damaged-identity, huge-file                           |
| P01 | drop `                                                                       |                                                                                                        | choice == Take`                                       | KILLED | matrix, brief rule test |
| P02 | `Some(_) => Install` always                                                  | KILLED                                                                                                 | 3 tests                                               |
| P03 | `!established` -> `established`                                              | KILLED                                                                                                 | 3 tests                                               |
| P04 | `Same` never chosen                                                          | KILLED                                                                                                 | matrix, brief rule test                               |
| P05 | `Same` by host id only                                                       | KILLED                                                                                                 | matrix (same hostId, other certificate)               |
| P06 | `--keep-identity` arm tests `Take`                                           | KILLED                                                                                                 | matrix, brief rule test                               |
| P07 | no identity in folder -> `Create`                                            | KILLED                                                                                                 | matrix, brief rule test                               |
| P08 | damaged refused only with `Take`                                             | KILLED                                                                                                 | 3 tests                                               |
| P09 | damaged refused only with `Auto`                                             | KILLED                                                                                                 | matrix, brief rule test                               |
| P10 | absent+`Take` refusal tests `Keep`                                           | KILLED                                                                                                 | matrix, brief rule test                               |
| P11 | `own` always `KeepFolder`                                                    | KILLED                                                                                                 | matrix, brief rule test                               |
| P12 | `own` always `Create`                                                        | KILLED                                                                                                 | matrix, brief rule test                               |
| P13 | audit word `kept` -> `restored`                                              | KILLED                                                                                                 | audit-word test                                       |
| P14 | unreadable-folder refusal prints the reason where the copy's host id belongs | KILLED                                                                                                 | refusal-text test                                     |
| I01 | `read_beside_coded` drops the host id check                                  | KILLED                                                                                                 | damaged-identity (another host)                       |
| I02 | drops the SHA-256 compare (keeps size)                                       | KILLED                                                                                                 | damaged-identity (port change)                        |
| I03 | drops the size compare (keeps SHA-256)                                       | SURVIVED, equivalent (SHA-256 of the same bytes covers the size; the cut-short case also fails on SHA) |                                                       |
| I04 | drops the fingerprint compare                                                | KILLED                                                                                                 | damaged-identity (manifest names another certificate) |
| I05 | drops the "too large" refusal                                                | KILLED                                                                                                 | huge-file                                             |
| I06 | open/read errors coded `Invalid`                                             | KILLED                                                                                                 | damaged-identity (missing file)                       |
| I07 | parse errors coded `Unreadable`                                              | KILLED                                                                                                 | damaged-identity                                      |
| C01 | `verify-copy` prints and exits 0 on a damaged identity                       | KILLED                                                                                                 | CLI test                                              |
| C02 | `verify-copy` prints the identity file (key)                                 | KILLED                                                                                                 | CLI test                                              |
| C03 | wrong text for an absent identity                                            | KILLED                                                                                                 | CLI test                                              |
| C04 | wrong fingerprint text                                                       | KILLED                                                                                                 | CLI test                                              |

Compile-error mutants (first harness run, rewritten as P14, C02) are not counted. The first run also found two real test gaps, fixed before the table above: P05 (`same_as` by host id only) survived until the same-hostId/other-certificate folder case was added, and the SHA-256 compare survived until the port-change case was added (the fingerprint check was catching the byte flip first).

## Self-review and concerns

- Semantic reading of `established`: the unit tests treat it as given. Whether `Read && initialized` (and `Unreadable` as established) is computed correctly is Task 4's job; Task 3 cannot prove the C1 margins stay intact. Task 4 must keep `foreign` computed from the folder identity before the restore.
- The `verify-copy` command prints the `ok (...)` line before failing on a damaged identity, so a script that only reads stdout sees "ok"; the exit code is non-zero and stderr says DAMAGED (as the brief writes it).
- A folder identity with the copy's `hostId` but another certificate is treated like another host (refused over a working host with `Auto`). The refusal text then names the same host id twice; correct but slightly odd for an engineer. Not changed.
- Key memory is not zeroized and `HostIdentity::read` is not constant-time (unchanged from Task 1).
- Windows `icacls`/NTFS behaviour is still unverified (Tasks 1-2 concern); nothing in this task exercises it.
- `i1-implementer-rules.md` still describes a floor plan; I followed the dispatch standard and the brief.
