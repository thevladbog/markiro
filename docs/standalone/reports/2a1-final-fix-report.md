# Plan 2a1 — final fix wave report

BASE (HEAD at start): `366e87f06cd766ecc6bd70269cbb47adca7bbf03`. Other agents added plan-only commits (`16b41f435`, `51925bae2`, `bf4235cc8`) between my commits; ignore them.

Status: DONE_WITH_CONCERNS (see Concerns).

## Commits (the seven of the proposed wave, in order)

| #   | SHA         | Subject                                                                                                                         |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `b92acbe9b` | test(standalone): every shift write wakes the streams with its revision                                                         |
| 2   | `c50ff69c9` | test(standalone): the last serial of a prefix, a hex digit in a date, a cleared counterparty                                    |
| 3   | `3cd773508` | fix(standalone): 0009's status CHECKs hold the whole lifecycle                                                                  |
| 4   | `c27fec336` | test(standalone): a shift row that breaks its lifecycle is refused by the schema                                                |
| 5   | `dce191af9` | fix(standalone): a revoked station neither creates nor enters a shift; a block request id keeps its prefix                      |
| 6   | `eab496ea7` | test(standalone): a station revoked in the race neither enters nor creates; a block request id keeps its prefix                 |
| 7   | `1d6fd17e0` | docs(standalone): the six shift and block audit actions, the lifecycle CHECKs, the device re-check, a block request id's prefix |

Each message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git status --short` is empty apart from a plan file another agent wrote (`docs/superpowers/plans/2026-10-09-standalone-2a2-host-facts.md`, not mine).

## What each commit does

1. `office_shifts.rs`: `office_create_edit_and_delete_each_wake_the_streams_with_their_revision` (subscribe, then create, a no-op edit that must NOT wake, an edit, a delete; each wake carries the write's rev). `device_shifts.rs`: `a_station_creating_a_shift_wakes_the_streams_with_its_revision_and_a_repeat_does_not`.
2. Item 18 (`the_last_serial_of_a_prefix_is_a_block_of_one_and_then_none_is_left`), item 1 (`"202a-10-08"` in `only_digits_and_dashes_make_a_date`), item 6 (`counterpartyId: null` -> `Some(None)` and back to `null`, in `proto/tests/fixtures.rs`), item 7 done (the shared helper `turn_the_user_off_at_the_next_activity` names its trigger `turn_off_<user_id>` and `editing_and_deleting_stop_a_user_turned_off...` uses it instead of an inline SQL copy), item 9 (`proto/fixtures/error-with-details.json` is `1..=2` / `maxProtocol: 2`, with `test/protocol.test.ts`).
3. `0009`: the two status CHECKs are now `CASE WHEN status = 'planned' THEN snapshot/opened_at/owner IS NULL ELSE ... IS NOT NULL END` and `CASE WHEN status = 'closed' THEN closed_at/closed_by_kind/closed_by IS NOT NULL ELSE ... IS NULL END`, as Minor 3 proposed. `close_reason_*` and `late_data_at` stay free.
4. `office_shifts.rs`: `a_shift_row_that_breaks_its_lifecycle_is_refused_by_the_schema` (22 direct statements over a planned, an active and a closed row, each must meet "CHECK constraint failed"; then the legal open and close pass).
5. `AuthDevice::require_station_in` (in `auth.rs`, moved from `sscc_blocks.rs`, with the forbidden text as a parameter) is called first after `begin_write` by `create_device_shift`, `enter_shift` and `issue_block`. A repeated block `requestId` whose stored block has another `issuer_prefix` is `validation_failed` on `requestId` and writes nothing. The pinned assertion of `a_repeated_request_answers_its_own_block_after_others_were_issued` (old answer for another prefix) is removed here so that this commit stays green; the new rule is tested in commit 6.
6. `device_shifts.rs`: `a_station_revoked_while_its_write_waited_neither_enters_nor_creates_a_shift` (holds the write lock like the existing deterministic entry race; the holder revokes the station and commits; the waiting handler, called directly, answers 401 `credential: device`; nothing written). `sscc_blocks.rs`: `a_repeated_request_id_with_another_prefix_is_refused_and_the_same_body_answers_its_block` (a real second counter is seeded; both directions; revision, audit, both counters and blocks unchanged; same bodies still answer their blocks; a colleague's same id is its own).
7. Docs: `update_shift` doc comment (item 8), `ShiftSnapshot` doc + AGENTS sentence (item 10), AGENTS operators paragraph (item 24), AGENTS «Audit» (device actor, repeats write no row) and «Shifts» (all six audit actions with actors and details, lifecycle CHECKs, device re-check, requestId/prefix rule, snapshot rule), `sscc_blocks.rs` module doc. New AGENTS lines are at most 80 columns (checked) and prettier-clean.

## RED evidence (new tests against pre-fix code)

- Commit 1: the tests are the first to assert the wake; RED is the four mutants below (they passed `office_shifts` 21/21 and `device_shifts` 15/15 before).
- Commit 4: against the previous `0009` (restored from `366e87f06`) the test fails at `the schema took "snapshot = NULL"` (active without a snapshot was accepted).
- Commit 6, device test, against the production files of the commit before 5: `assertion failed: enter <id>: {... "status":"active","ownerDeviceId":"<revoked station>" ...}` with `left: (200, Null)`, `right: (401, "device")`: the revoked station entered and owned the shift. The sscc test is RED through the prefix mutant (below), which is the pre-fix behaviour for it (the pre-fix run stopped after the device failure because cargo does not continue to the next test target without `--no-fail-fast`).
- Commit 2 (vitest): with the old fixture the changed `protocol.test.ts` fails: `expected maxProtocol 2 ... received 1`.

## Mutants (all restored; `cmp` silent and sha256 equal to the pre-mutation copies in `/tmp/claude/ff/`)

| Mutant                                                            | Test that failed                                                 | Key line                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| W1 office create `commit_with_revision(tx, .., rev)` -> `0`       | `office_create_edit_and_delete_each_wake...`                     | `office_shifts.rs:1086` (the create wake)           |
| W2 office update `rev` -> `0`                                     | same                                                             | `office_shifts.rs:1109` (the edit wake)             |
| W3 office delete `rev` -> `0`                                     | same                                                             | `office_shifts.rs:1115` (the delete wake)           |
| W4 station create `rev` -> `0`                                    | `a_station_creating_a_shift_wakes_the_streams...`                | `device_shifts.rs:414`                              |
| `is_ascii_digit` -> `is_ascii_hexdigit` (`shifts.rs`)             | `only_digits_and_dashes_make_a_date`                             | `shift_numbers.rs:78`                               |
| `next >= capacity` -> `next + 1 >= capacity` (`sscc_blocks.rs`)   | `the_last_serial_of_a_prefix_is_a_block_of_one...`               | `sscc_blocks.rs:204`                                |
| drop `with = "nullable"` on `ShiftUpdate.counterparty_id` (proto) | `a_shift_update_carries_only_what_changes_and_never_the_product` | `fixtures.rs:733` `left: None`, `right: Some(None)` |
| `0009` planned arm without `owner_device_id IS NULL`              | `a_shift_row_that_breaks_its_lifecycle...`                       | `the schema took "owner_device_id = '<uuid>'"`      |
| `0009` non-planned arm without `owner_device_id IS NOT NULL`      | same                                                             | `the schema took "owner_device_id = NULL"`          |
| `0009` closed arm without `closed_by IS NOT NULL`                 | same                                                             | `the schema took "closed_by = NULL"`                |
| `0009` not-closed arm without `closed_by IS NULL`                 | same                                                             | `the schema took "closed_by = 'x'"`                 |
| previous `0009` CHECKs (whole revert)                             | same                                                             | `the schema took "snapshot = NULL"`                 |
| drop `require_station_in` in `enter_shift`                        | `a_station_revoked_while_its_write_waited...`                    | `device_shifts.rs:1349` (`enter <id>`, 200 not 401) |
| drop `require_station_in` in `create_device_shift`                | same                                                             | `device_shifts.rs:1349` (`create <id>`)             |
| prefix comparison -> `if false` (`sscc_blocks.rs`)                | `a_repeated_request_id_with_another_prefix_is_refused...`        | `sscc_blocks.rs:470`                                |

Not mutated: the `require_station_in` helper itself (kind and revoked branches), already covered by the existing sscc tests `only_a_station_asks_whatever_the_body_says` and `a_station_revoked_meanwhile_gets_no_block`. The `extension` side of the repeat rule is not compared (it is 0 on both sides until plan 2b, so a guard there would be untestable); the code comment and AGENTS say so. The items 7, 8, 10, 24 and the fixture change need no mutant (helper refactor, doc, fixture), but item 7's test still passes through the helper.

## Gate (final HEAD `1d6fd17e0`, my last commit)

- Focused (sandbox, `--offline --no-fail-fast`): `device_shifts` 17/17, `office_shifts` 23/23, `shift_numbers` 4/4, `sscc_blocks` 13/13, `templates` 27/27. Measured before the wave (review): office_shifts 21, device_shifts 15, sscc_blocks 11, shift_numbers 4; now 23, 17, 13, 4: +6 host tests (wake x2, lifecycle, revoked race, last serial, prefix repeat); `markiro-proto` stays at 45 (assertions added to an existing test). The full host total (359 before) was not re-run.
- `no_secrets_in_logs` (outside the sandbox): 1/1.
- `-p markiro-proto`: 5 + 40 passed (45, unchanged; item 6 added assertions to an existing test).
- `vitest run test/protocol.test.ts test/shift-numbers.test.ts --reporter=verbose`: 2 files, 214 tests passed, stderr empty (`protocol.test.ts` alone 186/186).
- `cargo fmt --all -- --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline` 0 warnings, 0 errors; `prettier --check` on `protocol.test.ts`, `error-with-details.json` and `AGENTS.md` clean; `git diff --check` clean (also over `366e87f06..HEAD`).
- Not run: the full host suite (about 20 minutes, controller's `cargo test --workspace`), the delayed-`setImmediate` stand (no webview test file was added or changed beyond one assertion value in an existing one).

## Concerns / notes for the controller

1. A local host database created with the previous `0009` fails the sqlx checksum and must be recreated. Only scratch databases are known; stated in the commit-3 message.
2. Plans 2a2/2a3/2a4 are being written now: the CHECK text of `0009` changed (status arms above), the new shared helper is `AuthDevice::require_station_in(&self, conn, forbidden)` in `host/src/auth.rs` (its old home, a private fn in `sscc_blocks.rs`, is gone), and a block repeat with another prefix is now `validation_failed` on `requestId`. The plan 2a6 `floor_block_requests` must repeat its stored request whole.
3. In commit 5 I removed the old-answer assertion from `a_repeated_request_answers_its_own_block_after_others_were_issued` in the same commit as the production change (instead of in commit 6) so that no commit is red; the brief put "update the pinned repeat test" in commit 6. The replacement positive test is in commit 6.
4. Compile times in this environment were 2 to 7 minutes per host rebuild (other agents compile concurrently), so mutants ran one at a time.
5. Not exercised: the real race through the router (the revoke test, like the existing entry race, calls the handler directly while a writer holds the lock); no live pair, no CI (push not authorized).
6. For «Отклонения/Перенесено» (controller writes it): the wave's own extras are the shared `require_station_in`, the `turn_off_<user_id>` trigger name and the "a no-op edit and a repeated station create wake nobody" assertions.
