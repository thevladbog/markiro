# Plan ПЛ-Х, Task 4 report: a box on a pallet, `pallet_closed`

Status: DONE_WITH_CONCERNS (concerns at the end; none blocks).
Worktree `/tmp/claude/wt/plh`, branch `claude/plh-pallets`, base `b5710db9d` (Task 3).

## Commits

- `9633d19f9` feat(standalone): a box closes onto its station's pallet, and a pallet closes with an SSCC of its device's pallet block
- `ef3dc1da9` test(standalone): the logging walk counts the three pallet modules of the facts path (see Concern 1)

Both end with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line. `git status --short` is empty after the commits.

## What was done

Applied the brief's steps 1 to 5 as written: `facts/blocks.rs` (`issued`, `consume`, shared by boxes and pallets), `facts/pallets.rs` (`OwnPallet`, `require`, `find`, `open`), `facts/pallet_closed.rs`, the `box_closed` changes (`palletId`, pallet joins, replay compares the pallet), `FactShift.pallets_enabled`, `OwnBox.pallet_id`, proto (`FactKind::PalletClosed`, `PalletClosedFact`, `BoxClosedFact.pallet_id`), `facts-request-pallets.json`, the proto fixture test, the support helpers and the AGENTS.md "Pallets" paragraph.

Minors addendum item 1: the brief's `pallet_closed::check` already runs the 18-digit shape check before `names_serial`, and `box_closed::check` does too (boxes were safe). What was missing was a test that pins it for 17, 19 and non-digit-18th-character texts, and the mutants. Added (see tests 12 and the S1 to S4 rows).

## Anchor adaptations (all mechanical, by meaning)

1. `support/app.rs` fragment 3 (`sscc_under`): the file's `sscc_under` already computes the serial width as `16 - prefix.len()` (2a2 fix), not the brief's `{serial:07}`. `sscc_of(extension, prefix, serial)` keeps the width formula; `sscc_under` is `sscc_of(0, ..)`; `pallet_sscc` uses `sscc_of(1, "460068200", ..)`. Same output for the 9-digit prefix.
2. `proto/src/lib.rs` `FactKind` doc comment (fragment at brief line 1236): the comment already said "either raises `PROTOCOL_VERSION`" (2a2 review). Only added "(the pallet kinds came with protocol 3, plan ПЛ-Х)".
3. `AGENTS.md`: the anchor "nothing.\n\nAny device asks..." does not exist verbatim; the pallets paragraph is inserted before the unchanged line "Any device asks whether a code is taken (`GET /v1/device/codes/{codeHash}`,", which occurs once. The paragraph is the brief's text plus one clause: the SSCC form is checked before the serial is read, because the serial read looks only at the first 17 characters.
4. The brief's `check_fragments.py` reported NO MATCH for the three above and for the mutation fragments of files that did not exist yet; every other fragment matched once.

No semantic mismatch; no NEEDS_CONTEXT.

## RED and GREEN

RED (before implementation):

- `cargo test -p markiro-host --test pallet_facts`: `0 passed; 11 failed` (`/tmp/claude/impl-plh-t4/red-pallet.txt`).
- `cargo test -p markiro-proto`: compile error, 5 errors: unresolved `markiro_proto::PalletClosedFact`, no variant `PalletClosed` (x2), no field `pallet_id` on `BoxClosedFact` (x2) (`red-proto.txt`).

GREEN, brief's tests: `pallet_facts` 11 passed. Final with my additions: 18 passed.

Focused run (`--test pallet_facts --test facts --test fact_rules --test codes --test office_shifts --test device_shifts`), plan count vs measured:

| suite         | plan     | measured | note                                                                  |
| ------------- | -------- | -------- | --------------------------------------------------------------------- |
| codes         | 8        | 8        |                                                                       |
| device_shifts | 20       | 23       | Task 3 added 3 after the plan's count                                 |
| fact_rules    | 13       | 13       |                                                                       |
| facts         | 36       | 57       | the plan was measured on an older 2a2 head; this base holds 2a2 whole |
| office_shifts | 30       | 34       | Task 2/3 additions                                                    |
| pallet_facts  | 11       | 18       | 11 from the brief + 7 mine                                            |
| markiro-proto | 5 and 45 | 5 and 45 | equal                                                                 |

Vitest `test/protocol.test.ts`: 213 passed (the new fixture file breaks nothing).

Final gate, unsandboxed: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast --offline --locked` after both commits: EXIT 0, 50 suites, 793 passed, 0 failed (`/tmp/claude/impl-plh-t4/workspace2.txt`). The first workspace run (before `ef3dc1da9`) had exactly one failure, `no_secrets_in_logs::the_host_prints_nothing_and_the_facts_path_logs_only_its_three_audited_lines` (left 15, right 12); fixed by Concern 1.

Other checks: `cargo fmt --all -- --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings; `cargo clippy` on the same: no warning in any file this task adds or touches in `src/` (the 43 lines are in `validate.rs`, `tests/support/app.rs:394`, `sscc_blocks.rs` and other earlier files; I fixed the one clippy warning my own test file raised); `prettier --check` on AGENTS.md and the new JSON clean; `git diff --check` clean; `grep -rnF '\u04' src test` shows only `pairing-code.ts:66`; `grep -rnF '\u0'` on the Rust and JSON I wrote finds nothing.

## Tests I added beyond the brief (7, all in `host/tests/pallet_facts.rs`)

12. `a_pallet_sscc_that_is_not_eighteen_digits_is_refused_whatever_its_first_seventeen_say`: seven malformed forms (17 correct digits, 17 + letter, 19 digits, 18 + letter, 17 + multibyte, 17 + newline, empty) all `invalid_record` on `data.sscc`; the pallet stays open, `consumed_through` stays null, a right close afterwards is accepted.
13. `a_pallet_close_comes_again_with_the_receipt_it_had_and_a_refusal_is_kept_for_good`: same bytes get the same accepted and rejected receipts (also after the pallet block is revoked); same id, other bytes is `payload_mismatch` and writes nothing (receipts and `consumed_through` unchanged); a refusal is kept (`sscc_not_issued` stays), the corrected close under a new id is accepted; the kept receipt row has `kind = pallet_closed`; the same SSCC re-sent under a new id with different count and instants is accepted and the row is unchanged.
14. `one_sscc_is_one_pallet_even_under_another_block_that_covers_its_serial`: two overlapping pallet blocks inserted by SQL; the second pallet on the same SSCC is `sscc_taken`, not a unique-index 500.
15. `a_pallet_close_after_the_shift_was_closed_is_taken_and_marks_it_late`.
16. `a_box_the_host_refuses_opens_no_pallet`: `box_unknown`, `sscc_not_issued`, `sscc_taken` and a pallet-block serial for a box, each naming a new pallet: no pallet row, `consumed_through` unmoved.
17. `the_stations_count_and_instants_of_a_pallet_are_kept_as_sent`: pins that `boxCount` above capacity, `boxCount` other than the boxes held, and `openedAt` after `closedAt` are evidence kept as sent (the brief's design), not refusals.
18. `a_pallet_serial_in_a_block_of_another_issuer_prefix_is_not_issued`: a pallet-extension block of another prefix (counter row inserted by SQL), with an SSCC under the shift's prefix and under the block's.

## Mutants

All run with `/tmp/claude/impl-plh-t4/mut.py` (copy to `/tmp/claude/impl-plh-t4/before-<id>-<file>`, apply, run, copy back, `touch`, `cmp` and `sha256` compared; every row below reports `restored=True`). Test names are shortened; "pf" is `--test pallet_facts`, "+facts" means `--test facts` too. Logs: `/tmp/claude/impl-plh-t4/mut-<id>.txt`, summary `mutants-out.txt`.

Brief's M1 to M17:

| id  | mutant (one line)                                    | tests that fail                                                                                            |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| M1  | pallet_closed `names_serial(.., 1,` to `0,`          | 12 (all pallet-close tests)                                                                                |
| M2  | pallet_closed `blocks::issued(.., 1, serial)` to `0` | 12                                                                                                         |
| M3  | `OR (block_id = ? AND serial = ? AND 0)`             | `a_pallet_sscc_lies_in_a_live_pallet_block...`                                                             |
| M4  | pallets::find drop the device comparison             | `a_pallet_of_another_device_or_shift_is_unknown`                                                           |
| M5  | pallets::find drop the shift comparison              | same                                                                                                       |
| M6  | box replay ignores the pallet                        | `a_box_closed_again_on_another_pallet_is_refused`                                                          |
| M7  | drop `pallets::require` in box_closed                | `a_shift_without_pallets_takes_no_pallet`                                                                  |
| M8  | pallet replay accepts any SSCC (`if true`)           | `a_pallet_closed_again_changes_nothing...`                                                                 |
| M9  | `consume` uses `min`                                 | 4 (`..._never_goes_down`, `..._one_label`, `boxes_closed_on_a_pallet...`, `a_pallet_close_comes_again...`) |
| M10 | ON CONFLICT no longer stores `opened_at`             | `boxes_closed_on_a_pallet...`, `the_stations_count_and_instants...`                                        |
| M11 | box `.bind(None::<String>)` for pallet_id            | 4 (as the brief)                                                                                           |
| M12 | block query drops `revoked_at IS NULL`               | `a_pallet_sscc_lies_in_a_live_pallet_block...`                                                             |
| M13 | `.bind(1)` for box_count                             | `boxes_closed_on_a_pallet...`, `the_stations_count_and_instants...`                                        |
| M14 | `from_serial <` (+facts)                             | 33 tests of both suites                                                                                    |
| M15 | `to_serial >` (+facts)                               | 3 (`..._one_label`, `a_box_closes_only_with_an_sscc_issued...`, `a_serial_must_lie_in_the_block...`)       |
| M16 | `pallets::require` always Ok                         | `a_shift_without_pallets_takes_no_pallet`                                                                  |
| M17 | first box does not open the pallet                   | 14 (the FK error is a 500)                                                                                 |

Mine (the integrity core and the addendum):

| id        | mutant (one line)                                             | tests that fail                                                                                                                                      |
| --------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1        | pallet_closed shape check to `if false`                       | `a_pallet_close_and_a_boxs_pallet_have_their_form`, test 12                                                                                          |
| S2        | drop only the `len != 18` half                                | same two                                                                                                                                             |
| S3        | drop only the all-digits half                                 | same two                                                                                                                                             |
| S4        | box_closed shape check to `if false` (+facts)                 | `every_field_of_a_close_is_checked_before_anything_is_written`, `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`                  |
| D1        | drop the `sscc = ?` disjunct of the taken query               | test 14 only (`one_sscc_is_one_pallet_even_under_another_block...`)                                                                                  |
| R1        | `as_str` of `PalletClosed` misspelled                         | test 13                                                                                                                                              |
| L1        | late-mark skips `PalletClosed`                                | test 15                                                                                                                                              |
| O1        | box_closed opens the named pallet before any check            | 6 (incl. test 16)                                                                                                                                    |
| B1        | blocks::issued `device_id = ? OR 1` (+facts)                  | `..._one_label`, `a_box_closes_only_with_an_sscc_issued_to_its_device...`                                                                            |
| B2        | `issuer_prefix = ? OR 1` (+facts)                             | the box prefix test in `facts` (before test 18); after adding test 18: `a_pallet_serial_in_a_block_of_another_issuer_prefix_is_not_issued` (pf only) |
| B3        | `extension = ? OR 1` (+facts)                                 | `..._one_label`, `a_box_the_host_refuses_opens_no_pallet`, `a_serial_must_lie_in_the_block...`                                                       |
| B4        | box_closed `blocks::issued(.., 0,` to `1` (+facts)            | 32 tests                                                                                                                                             |
| P1        | pallet_closed drops `pallets::require`                        | `a_shift_without_pallets_takes_no_pallet`                                                                                                            |
| P2        | pallet_closed operator bind to None                           | `boxes_closed_on_a_pallet...`, `a_pallet_closed_before_its_boxes...`                                                                                 |
| P4        | pallet_closed drops `blocks::consume`                         | 6                                                                                                                                                    |
| P5        | box_closed drops `blocks::consume` (+facts)                   | 10                                                                                                                                                   |
| V1        | `Reject::field("data.serial")` renamed                        | `a_pallet_close_and_a_boxs_pallet_have_their_form`                                                                                                   |
| V2        | `box_count == 0` check to `false`                             | same                                                                                                                                                 |
| V3        | blockId UUID check reads `pallet_id`                          | same                                                                                                                                                 |
| V4        | openedAt check reads `closed_at`                              | same                                                                                                                                                 |
| V5        | box `data.palletId` UUID check to `false`                     | same                                                                                                                                                 |
| V6        | proto `PalletClosedFact` loses `deny_unknown_fields`          | same                                                                                                                                                 |
| V7 to V10 | ON CONFLICT drops `serial`, `block_id`, `sscc` or `closed_at` | 11 each (closed-pallet CHECK, so a 500)                                                                                                              |

Mutants that passed on first run: none. B2 was initially killed only by the pre-existing box-side test in `facts.rs`; I added test 18 so the pallet side kills it too. `a_pallet_close_waiting_for_the_write_lock...` and `a_pallet_close_is_written_with_its_batch_or_not_at_all` (the brief's whole-batch tests) are killed by M1, M2, V7 to V10, P4.

## Guard coverage checklist (the controller's list)

- SSCC vs block, serial, extension, prefix: M1, M2, M12, M14, M15, B1 to B3, test 18.
- Duplicate SSCC and duplicate block serial: M3, D1, test 14 and the unique indexes (schema test).
- `palletId` of another shift or device: M4, M5 (box and close paths).
- Pallet capacity vs `boxCount`, `boxCount` vs live boxes, `closedAt`/`openedAt` ordering: the brief makes them evidence, not guards (`box_count_reported`, reports compare). Pinned as such by test 17. If the owner wants any of them refused, that is a new decision (see Concern 3).
- Idempotent replay (same bytes, same receipt), conflicting replay (`payload_mismatch`): test 13 (generic `receive`, exercised for the new kind; R1 pins the stored kind).
- Same close of a closed pallet under a new id: M8, tests 3 and 13.
- Box onto a pallet already closed: the brief's test 4 (M11); box replay on another pallet: M6.
- Earliest-scan-wins registry: this task touches no scan or registry code; the existing `facts` suite (57 tests, includes the registry tests) passes unchanged. No new guard there.
- Receipts: per-record, rejected stored forever: test 13.
- Whole batch 500 on a DB error: the brief's `a_pallet_close_is_written_with_its_batch_or_not_at_all` (its trigger fails after the pallet row was written; the whole batch, boxes included, is gone). The record-position log line belongs to `routes/facts.rs` (unchanged) and is asserted in `no_secrets_in_logs.rs` (Task 7 adds the pallet pass).
- `closedPallets`/`openPallets` totals: Task 6, not here.

## Concerns

1. Unplanned failing test, mechanical fix in a second commit. `no_secrets_in_logs.rs` ends with `assert_eq!(facts_files, 12)`, a tripwire counting the source files of the facts path (`facts/*` plus three route files). Task 4 adds three files under `facts/`, so it became 15 and the test failed (found by the unsandboxed workspace run). The plan's Task 7 does not mention this assertion. Fixed in `ef3dc1da9` (12 to 15, with a comment). Task 5 adds `pallet_label.rs` and `pallet_exception.rs`: that assertion must become 17 there (and the plan's Task 5/7 text should mention it); it will fail again otherwise. Neither new module logs.
2. Counts differ from the plan's "Expected" (table above); the plan was measured on an older base. The workspace total is 793 passed in 50 suites.
3. Design observations for the controller, not changed: (a) the host does not check `openedAt <= closedAt` or `boxCount <= capacity` (pinned by test 17); (b) a pallet first named by a box is opened with `opened_at` = that box's `closedAt` and later replaced by the station's `openedAt` at `pallet_closed`, per the brief; (c) a closed pallet's replay is accepted even after its block is revoked (consistent with the box path).
4. Process slip: my very first command used `cd /tmp/claude/wt/plh` (against the rules); everything afterwards uses `--manifest-path`/absolute paths. No `.claude/.cc-writes` directory was left (checked) and `git status` is empty.
5. Not verified here (outside this environment): any Windows, device or station behaviour; this task is host-only.

## Files changed

`apps/standalone/host/src/facts/{blocks,pallets,pallet_closed}.rs` (new), `host/src/facts/{mod,box_closed,boxes}.rs`, `host/tests/pallet_facts.rs` (new), `host/tests/support/app.rs`, `host/tests/no_secrets_in_logs.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `proto/fixtures/facts-request-pallets.json` (new), `apps/standalone/AGENTS.md`.
