# Plan 2a2, Task 5: `box_label` and `box_exception`

BASE `407a3cae4616a70b7a6d6e50c5660c4844507ef0`, commit `f66882792` ("feat(standalone): label checks and box exceptions as facts") on `claude/2a2-facts` (worktree `/tmp/claude/wt/2a2-facts`). Status: DONE_WITH_CONCERNS (concerns are design notes, not defects of this task).

## What was done

The brief's Step 1 (tests, fixture, support helper, proto tests), Step 3 (code) and Step 5 (AGENTS) applied with an anchor-matching script (`/tmp/claude/t5/apply.py`, anchor must match exactly once). Two files are new (`facts/box_label.rs`, `facts/exception.rs`; the checker's "FILE MISSING"). Then 7 tests of mine beyond the plan, 1 unit test, the plan's 13 mutants, 18 mutants of my own, and the full host run.

## Anchor adaptations

- `host/tests/facts.rs` import block (the brief's step 1.1, "NO MATCH"): Task 4 had added `sscc_under` to the list. INTENT applied on the CURRENT text: `box_exception` added to the `support::app` list, `cargo fmt` reflowed it (the list now also has `sscc_under`).
- `apps/standalone/AGENTS.md` ("Facts", NO MATCH): the anchor (`…refuses nothing.\n\n## Marking rules`) no longer matches because Tasks 2-3 added the codes and timestamp-format paragraphs after the `box_closed` one. INTENT applied: the brief's `box_label`/`box_exception` paragraph sits right after the `box_closed` paragraph, before "Any device asks whether a code is taken…". I extended it (see Documents) with the lines that state what my extra tests pin.
- Counts shifted by earlier extras: RED had 28 passing + 3 failing `facts` tests (brief: 12 + 3), GREEN 31 (brief 15). Proto 5 + 43 as the brief says.
- I applied the whole plan implementation in one pass, then produced RED by reverting `mod.rs` and `proto/src/lib.rs` to HEAD and moving the two new files out (copies in `/tmp/claude/t5/impl/`), then restored them (`cp`).

## Evidence

RED (`/tmp/claude/t5/red-host.txt`, `red-proto.txt`):

- `--test facts`: 28 passed, 3 failed (`a_label_check_marks_a_closed_box_of_its_own`, `an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them`, `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`): the new kinds were unknown, so every record got `invalid_record` without a field.
- `-p markiro-proto`: `E0432 unresolved imports BoxExceptionFact, BoxLabelFact, ExceptionKind, LabelOutcome`; `E0599 no variant BoxLabel / BoxException`.

GREEN of the plan's code (`green-host.txt`, `green-proto.txt`): `--test facts` 31 passed; proto 5 + 43 passed.

After my tests: `--test facts` **38 passed** (28 earlier + 3 plan + 7 mine); `validate` unit test 1 passed (host lib 58 tests).

Full run, outside the sandbox: `cargo test --offline --locked -p markiro-host -p markiro-proto`, exit 0, 35 suites with tests, **472 passed, 0 failed, 0 ignored** (log `/tmp/claude/t5/full.txt`; the Task 4 fix run was 461, +3 plan +7 mine +1 unit = 472).

Static: `cargo fmt --all -- --check` 0; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 (only the environmental `xcrun` build-script warning); `cargo clippy` same targets exit 0, nothing in `box_label.rs`, `exception.rs`, `registry.rs`; `prettier --check` on `AGENTS.md` and `facts-request.json` clean; `git diff --check` clean; `\u0` grep: only the pre-existing `\u001d` in the fixture's canonical code; `git status --short` empty after the commit. `git diff --patience --numstat` on `facts.rs`: +1722 / -4 (the plain diff of the commit shows a large rewrite only because the plan's tests land in the middle of the file). No manifest, lockfile or migration touched (migration 0010 NOT edited). No TS/webview test lines in this task.

## Plan mutants M1-M13 (all caught as the brief expects; restore proof: every mutation went through `/tmp/claude/t5/mut.py`, which copies the file, mutates, runs `--test facts`, restores and compares `shasum -a 256`: "restored True" for all)

| Mutant                               | Failed tests                                           |
| ------------------------------------ | ------------------------------------------------------ |
| M1 undo takes all codes (`OR 1`)     | `an_undo_or_a_clear_…`                                 |
| M2 no `registry::release`            | `a_reprint_or_a_disassembly_…`, `an_undo_or_a_clear_…` |
| M3 `disassembled_at` never set       | `a_reprint_or_a_disassembly_…`                         |
| M4 reprint takes items               | `a_reprint_or_a_disassembly_…`                         |
| M5 disassembled box reprinted        | `a_reprint_or_a_disassembly_…`                         |
| M6 undo/clear on a closed box        | `an_undo_or_a_clear_…`                                 |
| M7 disassemble uses reprint reasons  | `a_reprint_or_a_disassembly_…`                         |
| M8 words with any reason             | `a_reprint_or_a_disassembly_…`                         |
| M9 words not trimmed                 | `a_reprint_or_a_disassembly_…`                         |
| M10 limit 199 (`MAX_TEXT_CHARS - 1`) | `a_reprint_or_a_disassembly_…` (and the new unit test) |
| M11 `removed_at` = host clock        | `an_undo_or_a_clear_…`, `a_reprint_or_a_disassembly_…` |
| M12 verified/skipped columns swapped | `a_label_check_marks_a_closed_box_of_its_own`          |
| M13 label check on an open box       | `a_label_check_marks_a_closed_box_of_its_own`          |

## My mutants (hunt) and the tests added for the survivors

Run on the code with all 7 new tests unless noted. "Survivor" = the plan's tests alone let it through (found by first running the mutant before the test existed, or by reading which test could fail).

| Mutant                                                                       | Result                                                                                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1 drop the `data.boxId` UUID check of an exception                          | FAILS `an_exceptions_fields_are_checked_whole_…` (the plan has no bad-boxId case: SURVIVOR of the plan)                                                   |
| X3 `targetScannedAt` not checked for shape                                   | FAILS the same test (SURVIVOR: plan tests only missing/present)                                                                                           |
| X4 code hash checked by length only                                          | FAILS the same test (upper-case and 63-char cases; SURVIVOR)                                                                                              |
| X5 any non-empty reason code accepted                                        | FAILS `a_reprint_or_a_disassembly_…` and the new field test                                                                                               |
| X7 `other` without words refused                                             | FAILS the new field test (SURVIVOR: plan always sends words with `other`)                                                                                 |
| X8 take-out query ignores the box                                            | FAILS 3 tests: `a_reprint_or_a_disassembly_…`, `an_exception_takes_out_only_live_items_of_its_own_box`, `an_undo_or_a_clear_…`                            |
| X9 take-out re-takes already removed items                                   | FAILS `an_exception_is_one_row_per_record_…`, `an_exception_takes_out_only_live_…` (SURVIVOR)                                                             |
| X10 take-out also takes displaced items                                      | FAILS `an_exception_takes_out_only_live_items_of_its_own_box` (SURVIVOR)                                                                                  |
| X11 `release` deletes every owner (`OR 1`)                                   | FAILS 3 tests incl. the plan's two                                                                                                                        |
| X13 operator id not stored                                                   | FAILS `an_undo_or_a_clear_…`                                                                                                                              |
| X14 `received_at` bound as the device instant                                | FAILS `an_exception_is_one_row_per_record_of_its_shift_and_device_…` (SURVIVOR; the test checks length 20, shift, device)                                 |
| X15 label update without its `WHERE id`                                      | first PASSED all 38 tests (SURVIVOR); after the assertion that box 2's checks stay empty, FAILS `a_reprint_changes_nothing_and_a_box_taken_apart_keeps_…` |
| X17 disassemble/reprint allowed on a taken-apart box                         | FAILS `a_reprint_or_a_disassembly_…`                                                                                                                      |
| X22 `disassembled_at` = host clock                                           | FAILS `a_reprint_changes_nothing_…`, `a_reprint_or_a_disassembly_…`                                                                                       |
| X26 reprint stored as `disassemble`                                          | FAILS 2 tests                                                                                                                                             |
| X27 disassembly does not release codes (only clear/undo do)                  | FAILS `a_code_freed_by_an_exception_is_claimed_again_…`, `a_reprint_or_a_disassembly_…`                                                                   |
| X28 the exception INSERT error turned into a receipt (not a transport error) | FAILS `an_exception_is_written_with_the_batch_or_not_at_all` (batch answered 200 with items already taken out and no exception row)                       |
| unit: `MAX_TEXT_CHARS + 1` in `exception_reason_text`                        | FAILS the new unit test (restored, `cmp` silent, same sha)                                                                                                |

All files restored byte-identically (`shasum -a 256` equal, "restored True" printed by the harness; the validate.rs run done by hand with `cmp`).

## Tests added beyond the plan (all in `host/tests/facts.rs`, plus one unit test; helper `closed_and_open_box`)

1. `an_exceptions_fields_are_checked_whole_before_the_box_and_every_listed_reason_is_taken`: 19 refusals with exact codes and `details.field` (bad/upper-case box id, instants without milliseconds or with an offset, upper-case and 63-char code hash, mis-spelled/empty/other-kind reason codes, non-string and multi-line/empty words, an unknown field, and field errors winning over `box_state`/`box_unknown`); then every literal reason of both lists accepted (5 reprints on box 1, 5 disassemblies on boxes 3-7, `other` without words and with trimmed words), exact stored reason code/words.
2. `an_exception_is_one_row_per_record_of_its_shift_and_device_whoever_sends_it_again`: the same record twice in a batch and again later (one row), same id with other content (`payload_mismatch`, no row), a new `clear` of the emptied box and an `undo` of a code already out (accepted, kept, one row each, removed instants unchanged), shift/device/`received_at` format stored.
3. `a_box_of_another_device_or_shift_is_unknown_to_a_label_check_and_to_every_exception`: all four kinds and the label check against a colleague's box (other shift), a colleague's box in this very shift, and this station's own boxes named from another shift of the same station; 13 `box_unknown`, nothing changed.
4. `a_code_freed_by_an_exception_is_claimed_again_by_the_earliest_scan_in_either_order`: after a clear and a disassembly the registry is empty; code 1 claimed late by the colleague and then by the station at an earlier instant (earliest wins, colleague's item displaced), code 2 claimed by the station and then lost by the colleague's later scan (exact `conflict` winner), code 3 (disassembly) claimed by the colleague.
5. `an_exception_takes_out_only_live_items_of_its_own_box`: an undo naming a code of another open box is kept and takes nothing; an undone item keeps its instant under a later clear; a clear does not touch an item an earlier scan displaced, and the displacer keeps the code.
6. `a_reprint_changes_nothing_and_a_box_taken_apart_keeps_its_label_and_serial`: two reprints leave box row, items, owners and `disassembled_at` untouched; a disassembly leaves the close as it was; a label check of a taken-apart box is accepted and marks that box only; the same serial under another check digit closes no other box (`sscc_taken`, `consumed_through` unchanged).
7. `an_exception_is_written_with_the_batch_or_not_at_all`: a trigger breaks the second clear's row after its items were taken out and its codes freed: 500, receipts/items/owners/revision exactly as before (the first clear went with it); resent after the trigger is dropped both are accepted.
8. (unit, `validate.rs`) `the_words_of_an_exception_reason_are_trimmed_and_at_most_200_characters`: trimming, 200 characters of Cyrillic (characters, not bytes), 201/blank/tab/newline/NUL refused with `data.reasonText`.

## Documents

`apps/standalone/AGENTS.md`: the brief's paragraph plus: an undo takes the live item of its code in THIS box (none when that scan lost the code or the code sits in another box; `targetScannedAt` is kept, not compared); a reprint changes no state; an item an exception took out never comes back; an item an earlier scan displaced is not taken out by an exception of its box; one exception row per record with its shift, device and operator.

## Self-review against the lessons

Exact reason lists (test 1, literal strings, not the constants), every refusal code and details field, one row per record (test 2 and the `UNIQUE (device_id, record_id)` index), release on clear/undo/disassemble and re-claim in both arrival orders (test 4), `disassembled_at` only on a closed box (the CHECK plus `fits`, plan test) and SSCC/serial of a taken-apart box not reusable (test 6), reprint changes nothing (test 6), replays idempotent (test 2), repeated exception on a taken-apart box = `box_state` (plan records 40/41), boxes of another device/shift (test 3), digest validation: the exception's `codeHash` goes through `is_code_hash` before it is bound (no digesting happens in this task), in-transaction (handler reads and writes inside the batch's `BEGIN IMMEDIATE`; test 7), no codes/SSCC in logs (the only log line of a refusal carries the receipt code and ids; no new log), timestamps: no new comparison of instants; stored instants validated by `device_instant` (24-char canonical).

## Concerns

1. **`targetScannedAt` is stored but not matched.** An undo takes the live item of `codeHash` in the box. If a delayed or resent undo (a refused record resent under a new id, plan note 2 in the minors) arrives after the same code was scanned again into the same box, it removes the newer item. Matching `i.added_at = targetScannedAt` would make a stale undo harmless (kept, takes nothing), at the price of one more condition; the plan and brief say "the live item of its code", so I did not add it. Decision for the final review; it belongs with the 2a6 resend ordering rule.
2. **A displaced item is not restored when its displacer is removed.** Station A scans X at t=5 (owner), B scans X earlier at t=3 and A's item is displaced; if B then undoes X, the code is free and A's item stays displaced although A's box physically holds it. The registry rule in the plan is "release", not "re-elect"; the cloud has the same shape. Record for 2b (conflict review) as the case where the office must resolve it.
3. Minors 12 stays true: `digest_matches` is computed once at close, so a later undo/clear/disassembly of that box makes it stale (disassembly leaves the box closed with all its items removed and `digest_matches` as it was). Stage-4 card must read live items.
4. Not mutated: the `box_label` handler's `UPDATE … WHERE id = ?` is covered only through label_checks of boxes 1 and 2 (X15), not through a third box; the route-level whole-batch transaction is Task 2's (test 7 above exercises it with the exception's multi-statement write).
5. Deviation notes for the 2a2 final record: the two anchor adaptations, the 8 tests and the helper `closed_and_open_box` beyond the plan, the extended AGENTS paragraph, host `facts` 38 (plan counts 15) and the host lib +1.

## Files

Created: `apps/standalone/host/src/facts/box_label.rs`, `apps/standalone/host/src/facts/exception.rs`. Modified: `host/src/facts/mod.rs`, `host/src/facts/registry.rs`, `host/src/validate.rs`, `host/tests/facts.rs`, `host/tests/support/app.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `proto/fixtures/facts-request.json`, `apps/standalone/AGENTS.md`.

---

# Fix section (review Important 1 + Minors 1-4), commit `ca5bfb298`, BASE `f66882792`

Status: DONE. One commit `ca5bfb298` "fix(standalone): a late undo or clear never takes out a code scanned after it" (AGENTS.md, `host/src/facts/exception.rs`, `host/tests/facts.rs`; no manifest, migration or proto change).

## Decisions

- **Important 1 (fixed as the reviewer recommends).** `exception.rs` builds the take-out query per kind: undo = live item of the box with `code_hash = ? AND added_at = targetScannedAt`; clear = live items with `added_at <= occurredAt` (canonical TEXT comparison, Task 1's rule); disassemble = every live item (a closed box takes no scans); reprint = none.
- **Receipt when nothing matches: `accepted`**, nothing taken, row kept. Why: it is the brief's and Task 2's existing rule for an undo whose scan lost the code (no item to take); `rejected` receipts are stored forever and cannot be repaired by any new id, so a rejected stale undo would only feed another no-op "send again".
- Trade-off recorded in `2a2-minors.md` item 14 (station clock stepping back between a scan and a clear leaves the item live; the cloud's `emptyBox` accepts the same): confirm with the owner at the final review.
- **Minor 1:** `owned`-assertion added to `an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them` (codes 1, 2 keep their scans, 4 the colleague's after the undo of 3). **Minors 2-4:** documentation only (items 16-18 of `2a2-minors.md`); no code change.
- AGENTS.md `box_exception` paragraph rewritten (lines <= 80 columns as the surrounding text; prettier clean) for the new rules and the fact-shape requirement.
- **Fact-shape consequence for 2a6/2a8/ОЧ** (`2a2-minors.md` items 15): the station's `undo` must carry the exact `codeHash` and `targetScannedAt` of the `floor_codes` row (`floor_codes.scanned_at` is the very string of the scan record's `data.scannedAt`, plan 2a6 `processScan`), a `clear`'s `occurredAt` is the station-clock moment of the clear; a record sent again keeps `data` byte-identical. Plan 2a6's `boxExceptionRecord(head, data)` is a plain wrapper, so the requirement falls on 2a8's builders.

## RED / GREEN

- Tests first (`/tmp/claude/fix5-red.txt`): `cargo test ... --test facts -- a_late an_undo_or_a_clear` -> 1 passed, 2 FAILED: `a_late_undo_never_takes_out_a_code_scanned_again_after_it` (item of the re-scan `removed_at` = the late undo's instant 7 instead of null) and `a_late_clear_never_takes_out_a_code_scanned_after_it` (item scanned at 6 got `removed_at` = 4, earlier than its `added_at`). The Minor-1 assertion passed on the old code (as expected: it guards the release query).
- GREEN (`/tmp/claude/fix5-final.txt`): `--test facts` **40 passed** (38 + 2 new), `--test codes` 8 passed, outside the sandbox (loopback). `cargo fmt --check` 0; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings except the environmental `xcrun` build-script one; `git diff --check` clean; `git status --short` empty after the commit. The full host suite was NOT re-run (only the focused targets, as instructed).

New tests: `a_late_undo_never_takes_out_a_code_scanned_again_after_it` (scan X@1, clear@3, scan X@5; late undo with a new id targeting @1 -> accepted, X@5 stays live, owner = the re-scan, `codes/{hash}` = taken; an undo naming an instant no live item has -> nothing; the undo of @5 takes it; other order in one batch [clear, stale undo, re-scan]; two codes at one instant: an undo names its own code) and `a_late_clear_never_takes_out_a_code_scanned_after_it` (late clear @4 after a scan @6 leaves it live and owned; both orders in one batch; a clear exactly at an item's instant takes it, inclusive cutoff).

## Mutants (harness `/tmp/claude/fix5/mut.py`: copy to `/tmp/claude/fix5/*.orig`, mutate one line, run `--test facts`, restore, `shasum -a 256` and `cmp` against the copy; "restored True / cmp True" for all rows; `exception.rs` sha `adeb507aa8fb...` before and after, `registry.rs` `766cd5065a66...`)

| Mutant (one line)                                                                                                | Killed by                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| M1 undo drops `added_at = ?`                                                                                     | `a_late_undo_...`                                                                                     |
| M2 clear drops the `occurredAt` cutoff                                                                           | `a_late_clear_...`                                                                                    |
| M3 cutoff direction flipped (`>=`)                                                                               | 7 tests incl. both new ones and the plan's clear test                                                 |
| M4 cutoff exclusive (`<`)                                                                                        | `a_late_clear_...` (the clear exactly at an item's instant)                                           |
| M5 undo matches `added_at >= target`                                                                             | `a_late_undo_...`                                                                                     |
| M6 undo drops `code_hash = ?` (kept the instant)                                                                 | survived first; strengthened with the two-codes-at-one-instant case, then killed by `a_late_undo_...` |
| M7 an undo frees the code by hash even when it took nothing (the released code must stay claimed by the re-scan) | `a_late_undo_...`, `an_undo_or_a_clear_...`, `an_exception_takes_out_only_live_items_of_its_own_box`  |
| R2 (review) `release` frees every owner of the item's box                                                        | `an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them` (the new owners assertion)         |

## Concerns

- Confirm with the owner: a clear whose `occurredAt` precedes an item's `added_at` (station clock stepped back) leaves that item live on the host (same as the cloud).
- Deviation from the brief's SQL (undo "the live item of its code") belongs in the 2a2 deviations note: tests 38 -> 40 for `facts`.
