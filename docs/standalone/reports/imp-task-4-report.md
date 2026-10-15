# Report: plan ИМП Task 4 - `proto`: the import request and answer built from the golden transfer file

Status: DONE_WITH_CONCERNS. Commit 48e2948b0 `feat(standalone): import request and summary types against the export tool's golden file` on claude/imp-cloud (worktree /tmp/claude/wt/imp, base a7f32d9de). Trailer: exactly one `Co-Authored-By: Claude Opus 5.5` line.

## What was done

- `apps/standalone/proto/src/cloud_import.rs` (new): the brief's types verbatim (request + nested structs `deny_unknown_fields`; summary + its two counter value structs tolerant). `pin_phc`, `badge_phc`, `badge_salt` are `Secret` (existing `markiro_proto::Secret`, whose `Debug` prints `Secret(***)`), so the derived `Debug` of every type that holds a verifier is redacted; no manual Debug impl was needed, and it is proved per part (test below).
- `proto/src/lib.rs`: `pub mod cloud_import;` added.
- `proto/fixtures/cloud-import-summary.json` (new, verbatim); `proto/tests/cloud_import.rs` (new, 11 tests, the brief's 4 strengthened/extended).
- The golden file `cloud-export-file.json` is untouched: sha256 68c3d36ad199b7492959cbfe983780fe5a0ae5f011d03fac37c1db5046463c02 before and after; the Rust tests read it directly (no second copy), so the fixtures are byte-identical by construction.

## Beyond the brief (tests and doc)

- Debug tests cover all three verifier kinds (7 `Secret(***)` in the request: 3 PIN + 3 badge + 1 salt; 6 with the salt `None`), both `{:?}` and `{:#?}`, and each part alone (payload, operators, one operator, badges, one badge, salt). The secret values are read from the golden file, never spelled in the test; no test name contains a secret. A parse-error test checks that serde's refusal text (unknown field at operator/badge/payload; wrong type for `dryRun` via `from_str`) holds no verifier.
- Required-field test over 55 (pointer, key) pairs; nullable test (`badgeSalt` null round trip); wire-type boundary test (extension 256/-1, nextSerial -1, lastSeq/box/pallet/shelf/group overflow and negatives, bad purpose, wrong scalar types, and u8/u64/u32 maxima accepted); summary required-fields and tolerance for a new field inside `shiftNumberCounters` rows too; `CLOUD_IMPORT_FORMAT_VERSION == 1`.
- Module doc: the brief's text mentions a `cloud-import-request.json` fixture that the brief itself says does not exist; the doc now says the request is built from the golden file (mechanical, see adaptations).

## RED / GREEN

- RED: `cargo test -p markiro-proto --offline --locked --test cloud_import` -> `error[E0432]: unresolved import markiro_proto::cloud_import` (/tmp/claude/impl-imp-t4/red.txt).
- GREEN: 11 passed (brief says 4). `cargo test -p markiro-proto` whole: 5 suites ok (5 + 6 + 11 + 52 + 0 doc tests).

## Mutant table (58 mutants, 57 killed by a failing test, 1 by compile error; no restore mismatch)

Each mutant: copy to /tmp/claude/impl-imp-t4/before.bak, sha256 recorded, edit, run `--test cloud_import`, restore, `cmp` + sha256 compare, `touch`. Script: /tmp/claude/impl-imp-t4/mutants.py, results mutants.out/mutants.json. Final `shasum -a 256 -c` of cloud_import.rs and lib.rs matches the pre-mutation hashes.

| Guard                                                                | One-line mutant                                                                                                                                                                                                                                    | Killed by                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| strictness, 13 request structs + `CategoryTemplateDefaultInput` (14) | drop `deny_unknown_fields` from that struct                                                                                                                                                                                                        | the_request_refuses_a_field_it_does_not_know_at_every_level (also a_parse_error_holds_no_verifier for payload/operator/badge) |
| summary tolerance (3)                                                | add `deny_unknown_fields` to Summary / SsccCounterValue / ShiftNumberCounterValue                                                                                                                                                                  | the_summary_fixture_round_trips_and_tolerates_new_fields                                                                      |
| redaction (3)                                                        | `pin_phc` / `badge_phc` / `badge_salt` -> `String` / `Option<String>`                                                                                                                                                                              | both Debug tests (request, part)                                                                                              |
| `badge_salt` must stay optional                                      | `Option<Secret>` -> `Secret`                                                                                                                                                                                                                       | COMPILE ERROR in the test (`badge_salt = None`), plus the nullable test would fail                                            |
| format version                                                       | constant 1 -> 2                                                                                                                                                                                                                                    | the_format_version_this_build_reads_is_one, golden round trip                                                                 |
| wire types (9)                                                       | extension u16, request nextSerial u32, lastSeq u64, boxCapacity/palletBoxCapacity/shelfLifeDays i64, group code u64, `Vec<i64>` codes, purpose String                                                                                              | the_request_refuses_a_value_the_wire_type_cannot_hold                                                                         |
| requiredness (14 request, 5 summary)                                 | `#[serde(default)]` on enabled, archived, importId, dryRun, rehearsal, lines, operators, ssccCounters, shiftNumberCounters, login, operatorId, gln, tenantId, categories; summary repeated, operators, sscc_counters, extension, badgeSaltReplaced | the_request_needs_every_field_that_is_not_nullable / the_summary_needs_every_field_it_names                                   |
| nullability (5)                                                      | inn, printName, role, label, defaultBoxTemplateId `Option<String>` -> `String`                                                                                                                                                                     | the_nullable_fields_may_be_null (+ golden round trip)                                                                         |
| naming (2)                                                           | drop `rename_all` on Summary / Request                                                                                                                                                                                                             | summary round trip / golden round trip                                                                                        |
| null salt serialises as null                                         | `skip_serializing_if` on `badge_salt`                                                                                                                                                                                                              | the_nullable_fields_may_be_null                                                                                               |

The brief's own two mutants (CloudBadge deny_unknown_fields; pin_phc -> String) are in the table (rows 10 and 17 of the script).

## Gates

- `cargo fmt --check` 0; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings.
- Prettier gate proved live (scratch json failed `Checking formatting...`, deleted), fixture file clean; `git diff --check` clean; `\u0` grep: only `src/host/pairing-code.ts:66`.
- Parity tests: `node --test tools/standalone-export/test/transform.test.mjs sscc.test.mjs` -> 92 pass, 0 fail (raw fixture -> golden file; sscc-serials fixture); the Rust side reads the same golden file.
- Final full `cargo test --workspace --offline --locked --no-fail-fast` (unsandboxed): EXIT 0, 72 `test result` lines, 1135 passed, 0 failed, 0 ignored, 0 warnings. The first full run (without `--no-fail-fast`) failed once in `host/tests/restore.rs::a_restore_cut_off_after_the_database_left_is_rolled_back_by_the_next` (`the database closed: Elapsed` - its own 10 s wal-checkpoint timeout under load 50-200); that suite alone passed 33/33 and the second full run passed. Not touched by this task.
- `git status --short` empty after the commit; no scratch files.

## Anchor adaptations

- `lib.rs`: the brief's anchor `pub mod pairing;` matched once, but `pub mod backup;` now precedes it (merged from main); `pub mod cloud_import;` inserted between them (alphabetical).
- Module doc of `cloud_import.rs`: replaced the sentence about the non-existent `cloud-import-request.json` fixture (see above).
- Test counts: plan says +4 proto tests; measured +11 (strengthened as above). Workspace totals: plan-time counts predate main's merge; measured 72 result lines / 1135 tests.

## Concerns

1. The request type is strict at every level, so a future export format that adds a field to the file needs a `formatVersion` bump and a type change together (intended, as the brief says); the summary is tolerant.
2. `badge_salt` is an `Option`, so a request without the key deserialises as `None` (serde default for Option) - same as `null`; the host (Task 5/6) must decide what `None` means (keep the site's salt) and must not treat "absent" as an error. Tests pin `null`, not absence.
3. Redaction of `Debug` depends on `Secret`; `Serialize` of the request prints the verifiers (needed for tests), so the host must never serialize the request into a log or the audit row (Task 6's `no_secrets_in_logs` territory).
4. One load-induced flake in an old suite (`restore.rs`) in the first full run, described above; not caused by this change.
