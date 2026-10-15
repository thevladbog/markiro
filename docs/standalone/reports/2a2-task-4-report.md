# Plan 2a2, Task 4: `box_closed`

BASE `61501873f5c363188f921d2fe1c8136e3fa0d44c`, commit `060e1aea9` ("feat(standalone): a box closes with an SSCC of its device's block") on `claude/2a2-facts` (worktree `/tmp/claude/wt/2a2-facts`). Status: DONE_WITH_CONCERNS.

## What was done

The plan's Step 1 (tests, fixture, support helpers, proto tests), Step 3 (code) and Step 5 (AGENTS) applied with an anchor-matching script; every code anchor matched exactly once. Then 7 tests of mine beyond the plan, one extra support helper, and the mutant run below.

## Anchor adaptations

- `host/src/facts/box_closed.rs` did not exist ("FILE MISSING" expected): created by this task.
- `apps/standalone/AGENTS.md` («Facts»): the brief's anchor («…writes nothing.\n\n## Marking rules») no longer matches (0 matches): Tasks 2 and 3 added the codes paragraph and the timestamp-formats paragraph after it. I applied the INTENT on the current text: the `box_closed` paragraph (the brief's text, word for word) sits right after the scan/registry paragraph and before «Any device asks whether a code is taken…». That keeps the facts' kinds together; the codes and timestamp paragraphs of Tasks 2/3 are untouched.
- The brief's counts are shifted by the extras of Tasks 1–3: the RED run had 17 passing + 2 failing `facts` tests (brief: 10 + 2), and GREEN shows 19 (brief: 12). Proto 5 + 43 as the brief says.
- I applied the whole plan implementation in one pass, so the RED run was produced afterwards by reverting `mod.rs`, `proto/src/lib.rs` and removing `box_closed.rs` (copies in `/tmp/claude/t4/impl/`), then restoring them byte-identically (`cmp` equal).

## Evidence

RED (`/tmp/claude/t4/red-host.txt`, `red-proto.txt`):

- `--test facts`: 17 passed, 2 failed (`a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared`, `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`): every `box_closed` record got `invalid_record` without a field.
- `-p markiro-proto`: `error[E0432]: unresolved import markiro_proto::BoxClosedFact`, `E0599 no variant BoxClosed`.

GREEN of the plan's code: `--test facts` 19 passed; `-p markiro-proto` 5 + 43 passed.

After my tests: `--test facts` 26 passed (19 + 7 mine).

Full run, outside the sandbox: `cargo test --offline --locked -p markiro-host -p markiro-proto`, exit 0, 37 suites, **459 passed, 0 failed, 0 ignored** (proto 48, host 411). Log `/tmp/claude/t4/full.txt`. The brief's count of host suites cannot be compared one to one (shifted by Tasks 1–3 extras).

Static: `cargo fmt --all -- --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` exit 0 (the only warning is the environmental `xcrun` build-script note); clippy exit 0, nothing in `box_closed.rs` (the warnings it lists are older code and plan-supplied test lines in other places); `prettier --check` on `AGENTS.md` and `facts-request.json` clean; `git diff --check` clean; `\u0` grep: only the pre-existing `\u001d` in the fixture's canonical code; `git status --short` empty after the commit. No manifest, lockfile or migration touched. No TS/webview test lines in this task.

## Guards decided against the lead's list

- The SSCC check digit (GS1 mod-10): the plan (Global Constraint 3, decision 13) and the brief say the host never counts it (the domain's `buildSscc` writes it). I followed that, and added a test that PINS it (`the_host_never_counts_the_check_digit_of_an_sscc`), so any change is deliberate. See concern 1.
- Form positions: extension digit (X26), the 9-digit prefix (X27, M5), the 7-digit serial (X30, wrong-serial case), length (X6: 17 and 19 digits), non-digits (X7), block boundaries first/last/first-1/last+1 (M3, M4, plus cases 22 and 23), revoked block (M2), block of another device (M1), unknown block id, block of another prefix (X3), another live block of the same station named instead (X1), a pallet block of the same station (X2), `consumed_through` last-write (M7), first-write (X24), the update hitting every block (X4), box of another device or shift (X29 + the new test), both arrival orders of `sscc_taken` and the replay, items vs digest (M8, X17–X20), empty box (M11), capacity (X28, equivalent), receipts with exact codes and details, in-transaction (the new rollback test).

## Tests added beyond the plan (all in `host/tests/facts.rs`; helper `sscc_under(prefix, serial)` in `tests/support/app.rs`, `sscc` now calls it)

1. `a_serial_must_lie_in_the_block_the_record_names_and_in_a_box_block_of_the_shifts_prefix`: two live blocks of one station (1500–3499, 3500–5499) plus a pallet block (extension 1, 5500–5999, inserted by SQL because the host does not issue pallets yet). A serial of the other live block, of the named block's outside, and of the pallet block are `sscc_not_issued`; closes in each block move only that block's `consumed_through` (the pallet block and the other stay as they were); a shift snapshot whose prefix differs from the block's prefix refuses.
2. `every_field_of_a_close_is_checked_before_anything_is_written`: invalid `boxId`, a 19-digit SSCC, `openedAt` with an offset, `closedAt` without milliseconds, an upper-case digest, a serial of 2^63 (`data.serial`, the `i64` conversion), an unknown extra field, an item count overflowing `u32` or negative, a float serial, a missing serial, a null block id: each with its exact `invalid_record` field; the box stays open and the block untouched.
3. `the_host_never_counts_the_check_digit_of_an_sscc` (pin of decision 13).
4. `one_sscc_closes_one_box_whichever_arrives_first_and_the_same_close_again_changes_nothing`: one SSCC for two boxes in one batch, in both orders (the first in the batch wins, the other is `sscc_taken` and stays open); a lower serial closing later keeps `consumed_through`; the same record again returns its receipt without a write; the same close under a new id with other times, count and digest is accepted and leaves the whole box row and `consumed_through` as they were; the receipts keep kind `box_closed`, a refused record's too.
5. `a_close_of_a_box_of_another_device_or_another_shift_is_a_box_unknown`: the colleague's box, and a box of the floor's own device in the colleague's shift: `box_unknown`, nothing closed, nothing consumed.
6. `a_close_compares_the_boxs_live_items_and_keeps_what_the_station_reported`: items taken out by an exception (`removed_at`, set by SQL: the exception kinds come with Task 5) do not count; members in any order give the same digest; the count is kept as the station reported it (9 for 2 items) while the digest decides `digest_matches`; a stale digest and an emptied box compare false.
7. `a_close_is_written_with_its_batch_or_not_at_all`: a trigger refuses the block's `consumed_through` update after the box row was written; the batch is a 500 `internal`, no table row, no host revision, the box still open; after the trigger is dropped the same batch is accepted.

## Mutants (harness `/tmp/claude/t4/mut.py`, `mut3.py`; results `/tmp/claude/t4/mut-out.jsonl`, `mut3-out.jsonl`; each run `--test facts`; the source was restored from an in-memory copy after each and its sha256 compared to the start value: `restored: true` in every row; the final tree equals the committed one)

Plan mutants M1–M11 (all fail the tests the plan names, plus more):

| Mutant (one change)                  | Failed tests                               |
| ------------------------------------ | ------------------------------------------ |
| M1 any device's block                | `…only_with_an_sscc_issued_to_its_device…` |
| M2 revoked block counts              | same                                       |
| M3 `from_serial < ?`                 | 7 tests, incl. both plan tests             |
| M4 `to_serial > ?`                   | `…only_with_an_sscc_issued…`, test 1       |
| M5 prefix and extension not compared | `…only_with_an_sscc_issued…`               |
| M6 `sscc_taken` off                  | `…only_with_an_sscc_issued…`, test 4       |
| M7 `consumed_through = ?1`           | plan test 1, test 4                        |
| M8 displaced items counted           | plan test 1                                |
| M9 replay refused                    | plan test 1, test 4                        |
| M10 `openedAt` not kept              | plan test 1, test 6                        |
| M11 empty box allowed                | `…only_with_an_sscc_issued…`               |

Mine (every row restored, sha256 equal):

| Mutant                                                        | Failed tests                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| X1 named block id not required in the lookup                  | plan test 2, test 1                                                                                 |
| X2 `extension = 0` dropped                                    | test 1 (only)                                                                                       |
| X3 block `issuer_prefix` not compared                         | test 1 (only)                                                                                       |
| X4 consumed update without `WHERE id`                         | test 1 (only)                                                                                       |
| X5 `serial as i64` instead of `try_from`                      | test 2 (only)                                                                                       |
| X6 SSCC length `< 18`                                         | test 2 (only)                                                                                       |
| X7 SSCC digits not checked                                    | plan test 2                                                                                         |
| X8 `boxId` shape not checked                                  | test 2 (only)                                                                                       |
| X9 `blockId` shape not checked                                | plan test 2                                                                                         |
| X10 / X11 `closedAt` / `openedAt` not checked                 | plan test 2, test 2                                                                                 |
| X12 digest shape not checked                                  | plan test 2, test 2                                                                                 |
| X13 `sscc_taken` code swapped                                 | plan test 2, test 4                                                                                 |
| X14 `box_already_closed` code swapped                         | both plan tests                                                                                     |
| X15 operator not kept                                         | plan test 1                                                                                         |
| X16 count taken from host items                               | plan test 1, test 6                                                                                 |
| X17 / X18 digest always matches / compare inverted            | plan test 1, test 6                                                                                 |
| X19 items of every box                                        | plan test 1, test 6                                                                                 |
| X20 removed items counted (`removed_at` filter dropped)       | test 6 (only; the plan's M8 drops the displaced filter)                                             |
| X21 serial column off by one                                  | plan test 1, test 6                                                                                 |
| X22 `closed_at` kept as `opened_at`                           | plan test 1, test 6                                                                                 |
| X23 `block_id` kept as the SSCC                               | 7 tests                                                                                             |
| X24 `consumed_through` first write wins                       | 4 tests                                                                                             |
| X25 `names_serial` skipped                                    | plan test 2                                                                                         |
| X26 extension digit not compared                              | plan test 2                                                                                         |
| X27 prefix not compared                                       | plan test 2                                                                                         |
| X29 `box_unknown` code swapped                                | plan test 2                                                                                         |
| X30 serial form compared on `serial % 1000`                   | 7 tests                                                                                             |
| X31 proto: `deny_unknown_fields` dropped from `BoxClosedFact` | test 2 (only)                                                                                       |
| X32 proto: `as_str` of the kind `"boxclosed"`                 | `tests::stored_names_parse_back_into_their_variants` (proto) and test 4 (the receipt's stored kind) |

Survivor: **X28 (drop `serial < validate::serial_capacity(...)` in `names_serial`) survives and is equivalent**: a serial of 10^7 or more is written with more digits than the 7 the form allows, so the string comparison fails anyway. The guard is redundant; left as the plan wrote it. Also equivalent in practice: `16 - issuer_prefix.len()` as a constant 7, since the host's prefix is always 9 digits (not mutated).

## Self-review

- Everything of a close happens in the batch's single write transaction on the shared `conn`; the new rollback test proves the box row and the block update go with a later failure. A close takes no revision and writes no audit row (asserted: revision and audit rows unchanged).
- Order of checks: the replay answer comes before the SSCC/block checks, so a re-sent close of a closed box with the same SSCC is accepted even if its block was revoked since. That is the plan's design (idempotency of the same close); it writes nothing.
- The digest is a station-sent string checked by `is_code_hash`; the host's side digests its own stored items (hashes validated and distinct at insert), so Minor 5 (digest of unchecked input) does not arise here.
- `shift.status` (a closed shift) is not looked at by this handler: late data is Task 6's generic marking in `mod.rs`.

## Concerns

1. **Check digit not counted (decision 13).** A close with a wrong GS1 check digit on an otherwise right SSCC is accepted and stored, and the label would carry it. It can only come from a station bug (the station builds the SSCC with the domain's `buildSscc`), and the form, prefix, serial, block and uniqueness are all enforced. If the owner wants a host-side mod-10, it is a one-line addition in `names_serial` plus changing the pin test, but it contradicts decision 13 and Global Constraint 3, so I did not do it.
2. `closedAt` earlier than `openedAt` is accepted (the plan states no such rule). Both are kept as sent; the stage-4 card would show them. Not changed.
3. `itemCount` is only stored, never compared with the host's live item count; only the digest decides `digest_matches` (the plan). The digest covers the membership, so a count mismatch with a matching digest is the station's own inconsistency. Test 6 pins this.
4. The plan's own tests do not catch X2, X3, X4, X5, X6, X8, X20 and X31; the tests above close them. The host `facts` suite is now 26 tests (plan: 12) and `codes` stays 8.
5. Deviation notes for the 2a2 final record: AGENTS paragraph placement (above), the extra support helper `sscc_under`, and the 7 added tests.

## Files

Created: `apps/standalone/host/src/facts/box_closed.rs`. Modified: `host/src/facts/mod.rs`, `host/tests/facts.rs`, `host/tests/support/app.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `proto/fixtures/facts-request.json`, `apps/standalone/AGENTS.md`.

## Fix section (review Important 1: one serial, two boxes)

BASE `060e1aea92ab764c8e325ce251453b7a635b438b`. Commit: see the reply (subject `fix(standalone): two boxes never close on one serial of a block, whatever their check digits`).

Change: `box_closed.rs` `sscc_taken` query is now `SELECT 1 FROM boxes WHERE sscc = ? OR (block_id = ? AND serial = ?)` (same `sscc_taken` receipt, no details, as before); migration `0010` (unreleased, edited) gets `CREATE UNIQUE INDEX boxes_block_serial ON boxes (block_id, serial) WHERE block_id IS NOT NULL AND serial IS NOT NULL` next to `boxes_sscc` (kept); AGENTS.md `box_closed` paragraph states the rule. The check digit is still not counted (decision 13 kept; owner question recorded in `2a2-minors.md` items 10-13 with Minors 2-4).

Tests added (`host/tests/facts.rs`, helper `sscc_off_by_a_digit`):

1. `one_serial_of_a_block_closes_one_box_whatever_the_check_digits_say`: right-then-wrong digit and wrong-then-right on two serials in one batch; the second of each is `sscc_taken`, stays open (sscc/block/serial NULL), `consumed_through` 1501; a later close of the holder box with the other digit is `box_already_closed` and the box keeps its SSCC (pins the review's survivor R11).
2. `a_serial_of_a_block_is_unique_among_closed_boxes_in_the_database_itself`: two direct UPDATEs closing two boxes on serial 1500 of one block with different SSCCs; the second fails with a UNIQUE violation, the box stays open.

RED (code unchanged, tests added; `/tmp/claude/fix4/red.txt`): `--test facts` 26 passed, 2 failed: test 1 got `accepted` for records 11 and 13 (expected `sscc_taken`); test 2 `unwrap_err()` on an `Ok` update. GREEN after the code check: 27 passed, 1 failed (test 2 only, the index missing); after the index: `--test facts` 28 passed, 0 failed (`/tmp/claude/fix4/green.txt`); `--test codes` 8 passed. The full host suite was not run (focused targets only, as instructed); the earlier Task 4 full run was 459 passed.

Mutants (files restored from `/tmp/claude/fix4/orig`, `shasum -a 256` equal before and after, `cmp` silent):

| Mutant                                                                                | Result                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: `(block_id = ? AND serial = ? AND 0)` in the code check (index kept)               | test 1 FAILS with a 500 `{"error":{"code":"internal"...}}` instead of the `sscc_taken` receipt (the index layer fires; proves both that the code layer is needed for the receipt and that the index backs it) |
| B: `CREATE UNIQUE INDEX` -> `CREATE INDEX` for `boxes_block_serial` (code check kept) | test 2 FAILS; test 1 and all others pass (the handler still refuses `sscc_taken`)                                                                                                                             |
| C: replay compares `sscc[..17]` only (review's R11)                                   | test 1 FAILS (`box_already_closed` became accepted)                                                                                                                                                           |

Not mutated: the `sscc = ?` half of the OR is now redundant in the same block (equal SSCC implies equal serial), kept for the explicit intent and a block mismatch between records.

Static: `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 (only the environmental `xcrun` build-script warning), prettier on AGENTS.md clean, `git diff --check` clean, `git status --short` empty. No manifest/lockfile/other migration touched.
