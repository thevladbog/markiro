# Plan I1, Task 1 report: host identity (`.identity` file and key protection)

Status: DONE_WITH_CONCERNS. Commit `a14d9ad32` on `claude/m2` (BASE 2c726efba).

## What was done

- `host/src/tls.rs`: `TlsIdentity::from_der` (validated through `server_config()`) and `private_der()`, as in the brief.
- `host/src/backup/mod.rs`: `pub mod identity;` and the doc line, as in the brief.
- `host/src/backup/identity.rs` (new): `HostIdentity`, `IdentityRef`, `IdentityError`, `KeyFileGuard`, `OwnerOnly`, `IcaclsGuard`, `key_file_acl_args`, `platform_guard`, `attach`, `replicate`, `read_beside`, `identity_path`, `sha256_hex`. The brief's code is kept; the hardening below is added.

## Hardening beyond the brief (security-critical file)

1. **Key never in a file with inherited access.** `put_file` creates `<file>.partial` exclusively (0600), calls `guard.protect` while the file is still EMPTY, and only then reopens and writes the key. The brief writes first and protects afterwards, which on Windows leaves the key under the folder's inherited ACL for a moment.
2. **Planted link / stale partial.** The stale `.partial` is removed first and the new one is created with `create_new`, so nothing is written through a symlink planted under the partial's name.
3. **Length bound.** `MAX_IDENTITY_BYTES` = 64 KiB. `read_bounded` (used by `read_beside` and `replicate`) reads at most bound+1 bytes, so a huge file in a writable copies folder is never read whole. `from_file_bytes` has the same bound. The real file is about 2 KiB.
4. **Stable code.** `IdentityError::code()` returns `identity_unreadable` or `identity_invalid`.
5. Extra tests: known-answer SHA-256 (`abc`), the format, unknown-member and base64 refusals, no key fragment in any refusal text, size and hash mismatch checked separately, missing file, a refused attach leaves an existing identity byte-identical, `OwnerOnly` and `platform_guard` take 0644 or 0666 down to 0600, same key with another certificate.

## Tests

- RED: the module did not exist before the edit (compile-level RED). The first GREEN run was 17 passed. After the added tests (SHA known-answer, same-key/other-certificate) the final run is `backup::identity`: **18 passed** (the plan says 7). `markiro-host --lib` goes from 90 to 108.
- Full `cargo test --workspace --offline --locked`, unsandboxed: **71 result lines, 1142 passed, 0 failed, 0 ignored**, exit 0, 0 warnings. The log is in `/tmp/claude/impl-i1-t1/workspace.txt`.
- `cargo fmt --check`: clean. `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked`: 0 warnings. `git diff --check`: clean. `git status --short`: empty after the commit.
- Prettier, Vitest and the `\u04` grep were not run: no TS, MD or JSON file was touched.

## Mutants

Every mutant was applied to a copy of the file, run with `cargo test -p markiro-host --lib backup::identity`, and restored from `/tmp/claude/impl-i1-t1/*.orig`. After the run `shasum -a 256 -c` printed OK for both files, `cmp` matched, and the files were touched so cargo rebuilds. The harness is `/tmp/claude/impl-i1-t1/mutate.py`.

| Mutant                                                            | Result                                                                                 | Killed by                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| M01 OWNER RIGHTS grant -> Everyone (`S-1-1-0`)                    | KILLED                                                                                 | windows_closes_the_key_file_...                                                  |
| M02 drop `guard.protect`                                          | KILLED                                                                                 | 4 tests, including an_identity_goes_beside_its_copy_only_when_it_could_be_closed |
| M03 `read_beside` drops the host_id check                         | KILLED                                                                                 | an_identity_goes_beside_its_copy_...                                             |
| M04 `same_as` drops the key compare                               | SURVIVED, equivalent (the key must match the certificate; the brief says to record it) |                                                                                  |
| M05 `same_as` drops the host_id compare                           | KILLED                                                                                 | two_hosts_are_the_same_only_by_...                                               |
| M06 `same_as` drops the certificate compare                       | KILLED (after adding the same-key/other-certificate case)                              | two_hosts_are_the_same_only_by_...                                               |
| M07 protect after the write                                       | KILLED                                                                                 | the_key_is_never_in_the_file_before_the_file_is_closed                           |
| M08 no removal of the stale partial                               | KILLED                                                                                 | a_stale_or_planted_partial_is_never_written_through                              |
| M09 no removal and non-exclusive create (write through a symlink) | KILLED                                                                                 | a_stale_or_planted_partial_...                                                   |
| M10 non-exclusive create only                                     | SURVIVED, equivalent (the removal alone already covers links; defence in depth)        |                                                                                  |
| M11 OwnerOnly 0600 -> 0644                                        | KILLED                                                                                 | 3 tests                                                                          |
| M12 OwnerOnly does nothing                                        | KILLED                                                                                 | owner_only_takes_every_right_...                                                 |
| M13 `from_file_bytes` bound `>` -> `>=`                           | KILLED                                                                                 | a_file_beyond_the_bound_...                                                      |
| M14 `take(MAX+1)` -> `take(MAX)`                                  | KILLED                                                                                 | a_file_beyond_the_bound_...                                                      |
| M15 `read_bounded` drops the refusal                              | KILLED                                                                                 | a_file_beyond_the_bound_...                                                      |
| M16 `from_file_bytes` drops the size bound                        | KILLED                                                                                 | a_file_beyond_the_bound_...                                                      |
| M17 format check dropped                                          | KILLED                                                                                 | 2 tests                                                                          |
| M18 `deny_unknown_fields` dropped                                 | KILLED                                                                                 | 2 tests                                                                          |
| M19 / M20 `read_beside` drops the size / sha check                | KILLED                                                                                 | a_size_or_a_hash_that_differs_...                                                |
| M21 / M22 `replicate` drops the size / sha check                  | KILLED                                                                                 | a_size_or_a_hash_that_differs_...                                                |
| M23 `read_beside` drops the fingerprint check                     | KILLED                                                                                 | a_size_or_a_hash_that_differs_...                                                |
| M24 Debug prints the key                                          | KILLED                                                                                 | nothing_prints_the_private_key                                                   |
| M25 / M26 hostId UUID / port-0 check dropped                      | KILLED                                                                                 | a_key_of_another_certificate_or_a_bad_host_id_...                                |
| M27 `from_der` skips `server_config()` (tls.rs)                   | KILLED                                                                                 | 2 tests                                                                          |
| M28 write to the target directly                                  | KILLED                                                                                 | a_refused_identity_leaves_the_one_beside_the_copy_as_it_was                      |
| M29 a failed write leaves its partial                             | KILLED                                                                                 | 2 tests                                                                          |
| M30 `code()` Unreadable -> invalid                                | KILLED                                                                                 | a_refusal_names_no_part_of_the_key_and_has_a_stable_code                         |
| M31 `sha256_hex` without zero padding                             | KILLED                                                                                 | the_hash_a_manifest_names_is_lower_case_hex_sha256                               |
| M32 icacls exit code ignored                                      | KILLED                                                                                 | windows_closes_the_key_file_...                                                  |
| M33 icacls keeps inheritance                                      | KILLED                                                                                 | windows_closes_the_key_file_...                                                  |
| M34 icacls grants Users instead of the administrators             | KILLED                                                                                 | windows_closes_the_key_file_...                                                  |
| M35 `config()` wrong port                                         | KILLED                                                                                 | an_identity_file_reads_back_as_the_same_host                                     |
| M36 `attach` reference size 0                                     | KILLED                                                                                 | 6 tests                                                                          |
| M37 `sync_all` dropped                                            | SURVIVED: durability cannot be observed by a host test                                 |                                                                                  |

## Anchor adaptations

None. All three anchors (`load_or_create`, the `mod.rs` header, the new file) matched once. The deviations from the brief's code are the hardening above; the interface in the brief is unchanged.

## Self-review and concerns

- **Windows is not verified.** Only `key_file_acl_args` and `IcaclsGuard` are tested through a fake `Commands`. `icacls` on NTFS, OWNER RIGHTS for the service account, a FAT32/exFAT drive and a network share (where `icacls` must fail so the copy goes without the identity) need a Windows probe or CI. Protecting the empty file and then reopening it for writing relies on the owner keeping write access through OWNER RIGHTS, and Windows has not run that.
- **Unix reopen race.** The reopen after `protect` follows no link check (no `O_NOFOLLOW`). An attacker who can write to the copies folder could swap the partial between `protect` and the reopen. That folder is already trusted, so I left it and noted it.
- **No constant-time compare.** The brief asks for none. The SHA-256 compares in `read_beside` and `replicate` are plain `!=`; the hash is not a secret and the manifest is local.
- **Refusal codes.** `read_beside` returns `String` per the interface, and `attach` and `replicate` return `None` with a log-only reason. Only `IdentityError` has stable codes. Task 3 (`restore.rs`) should map the `read_beside` strings to codes.
- **Key memory.** The key bytes are not zeroized in memory, as in the existing `TlsIdentity`.
- **Rules file.** `i1-implementer-rules.md` still describes a floor plan (`0006`, `outbox`) and does not match plan I1. I followed the dispatch message and the brief.
