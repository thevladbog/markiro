# Plan 2a2 — final fix wave report

Worktree `/tmp/claude/wt/2a2-facts`, branch `claude/2a2-facts`. BASE `1d783cf7f26a32bb075e29b1c2cd705d013411dc`. Three commits, in the review's order, tests and production apart, each with exactly one `Co-Authored-By: Claude Opus 5.5` trailer (verified with `git log -1 --format=%B`):

| #   | SHA         | Subject                                                                                                                                                                 |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `47a97de9b` | test(standalone): plan 2a2 final wave — units in closed boxes, registry to the millisecond, SSCC string under another prefix, stamps after the lock, the 500's log line |
| 2   | `85608f3f3` | fix(standalone): plan 2a2 final wave — ShiftTotals.unitsInClosedBoxes, a batch stamped after the lock, the failed batch names its record's position                     |
| 3   | `1c2f009c1` | docs(standalone): plan 2a2 final wave — totals labels, registry rule, protocol bump rule, handler-only close columns, the batch log line                                |

HEAD `1c2f009c1`, `git status --short` empty. No push, no stash, no `cd` (one stray `cd` in two early Bash calls; no `.cc-writes` was left, status is clean), no manifest / lockfile / migration change except the comment-only edit of the unreleased `0010` the review asked for.

## What changed, per item

**Commit 1 (tests).**

- `unitsInClosedBoxes` (RED): `the_office_reads_a_shifts_totals_from_its_facts` now expects the number at every step (planned/entered 0; first batch 5 accepted / 3 in closed boxes; after the colleague's displacement 3 / 2 for the floor and 2 / 0 for the colleague; third batch colleague 3 / 1, floor 3 / 2). A hand-made live item in the disassembled box 4 (no fact can leave one, so the row is revived directly and put back) pins the definition against the "count disassembled boxes" mutant. Planned zeros in `office_shifts.rs`. Proto test (`office_shift_fixtures_round_trip_…`): the fixture reads 547 / 540 and 540 = closedBoxes × boxCapacity (RED until the fixture is edited), and the empty shape is a JSON round trip through `ShiftTotals` (written as a round trip, not as `empty.units_in_closed_boxes = 0`, so commit 1 still compiles: `cargo check --all-targets` is green at every commit).
- Same-second registry pair `the_registry_orders_scans_within_one_second_by_the_millisecond`: owner 60.500, claim 60.499 accepted and displaces; then 500 (later), 499 (tie) and 999 are `conflict`. Passes at once; kills MG.
- SSCC collision `one_sscc_closes_one_box_whichever_block_and_prefix_it_comes_from`: box 1 closes serial 1500 under the 9-digit prefix; the shift's snapshot prefix becomes `46006820`, a counter and a block (1000–1999) of it are inserted, and box 2 closes serial 1500 of that block, whose SSCC string equals `sscc(1500)`. Must be 200 `sscc_taken`, box stays open, neither block's `consumed_through` moves. Passes at once; kills MA. Support: `sscc_under` now fills `16 - prefix.len()` serial digits (identical for 9-digit prefixes).
- `a_batch_is_stamped_when_it_holds_the_lock_not_when_it_arrived` (RED): holder closes the shift as the office; the batch (called directly, `receive_as`, no auth write) is proved pending by `timeout(200 ms)`; the manual clock advances a minute; after the commit the receipt, the scan row and `late_data_at` carry the advanced time and `late_data_at > closed_at`.
- The lock-wait test `a_batch_waiting_for_the_lock_finds_the_shift_the_office_closed_meanwhile` no longer sleeps 300 ms: the batch is called directly (so the only thing it can wait for is `begin_write`, not the once-a-minute `last_seen_at` touch), proved pending, then the office writes and commits. Comment now says the batch's close is `alreadyClosed` and its late scan takes the batch's one revision.
- 500's log line (RED): the failing batch in `no_secrets_in_logs.rs` is `[ { "not": "a fact" }, <scan> ]` (the first is refused and rolled back with the batch); the log must hold exactly one `a fact batch failed` line with `device=<station>` and `position=1`. The static test is renamed `…logs_only_its_three_audited_lines` and counts 2 in `facts/mod.rs`, 1 in `routes/facts.rs`, 0 elsewhere.

**Commit 2 (production).**

- `ShiftTotals.units_in_closed_boxes: u64` (`unitsInClosedBoxes`, after `acceptedUnits`), documented as the cloud office's «Кодов в закрытых коробах». Sixth correlated subquery in `routes/office_shifts.rs` (`box_items` join `boxes`, `closed_at IS NOT NULL AND disassembled_at IS NULL AND removed_at IS NULL AND displaced_at IS NULL`). `proto/fixtures/office-shift.json`: `acceptedUnits` 547, `unitsInClosedBoxes` 540.
- `routes/facts.rs`: `received_at` is read after `begin_write` and `require_live_in`; the loop keeps the position and logs `tracing::error!(device = %device.id, position, "a fact batch failed")` before returning the error (never the record or its id).
- T1-1 (`sort_all_objects`) deliberately NOT done (optional in the brief): a no-op while serde_json is built without `preserve_order`, so no test can see it; the key-order test already fails loudly if the feature union changes.

**EXPLAIN of the totals SELECT** (SQLite 3.44.4 over migrations 0001–0010, `/tmp/claude/fw/eqp.db`): `WHERE id = ?` → `SEARCH shifts USING INDEX sqlite_autoindex_shifts_1`; the list query `WHERE status = 'closed' AND production_date >= …` → `SEARCH shifts USING INDEX shifts_status_production_date`; the new subquery (2) is `SEARCH b USING INDEX boxes_shift (shift_id=?)` + `SEARCH i USING INDEX box_items_live (box_id=?)`, the same as `acceptedUnits`; the open-boxes, receipts (`fact_receipts_shift` covering) and participants subqueries are unchanged. Only the unfiltered list is a `SCAN shifts` (as before).

**Commit 3 (docs/comments).** AGENTS «Facts»: totals with their labels and the six required fields; the revision sentence (a closed shift's first late fact takes one); the stamp-after-lock sentence; the earliest-since-freed registry rule (millisecond comparison; the next ARRIVING scan owns a released code); `digest_matches` computed once at close; the protocol-bump rule (new kind or `data` field); the 2 MiB → 400 clause; the station's own post-close facts mark its shift late (same batch too; `late_data_at − closed_at` is no measure). «Protocol»: bump sentence. «Shifts»: close-column invariants are held by the handlers, not triggers (reasons, reopen condition). «Logs»: the batch line and "exactly three logging calls". Spec §19: the same (late-fact wording, totals incl. `unitsInClosedBoxes`, stamp after the lock, log line, bump rule, 400 for oversize, registry rule, `digest_matches`, handler-only). Comments: `registry.rs` module + `release`, `0010` `code_owners` comment (a host database applied locally from an earlier build of this branch must be recreated: sqlx checksum), `rules.rs` `box_membership_digest`, `FactKind` doc, `routes/facts.rs` header, `proto/tests/fixtures.rs` ("will read them (plans 2a6, 2a8)").

**Merge note for 2a3** (in AGENTS «Facts», spec §19 and `2a2-minors.md` item 24): `totals: { acceptedUnits, unitsInClosedBoxes, closedBoxes, openBoxes: int >= 0; lastFactAt: host-format instant | null; deviceIds: uuid[] }`, all required, in every `OfficeShift`. Observation on `claude/integration`: `officeShiftSchema` (`src/host/protocol.ts:547`) has NO `totals` key and is a plain `z.object` (not `.strict()`), so Zod would strip the key silently rather than fail; the merge must add all six fields.

## RED / GREEN

RED (commit 1, before commit 2; logs in `/tmp/claude/red-*.txt`):

- `--test facts`: 3 failed / 53 passed: `the_office_reads_a_shifts_totals_from_its_facts` (missing `unitsInClosedBoxes`), `a_batch_is_stamped_when_it_holds_the_lock_not_when_it_arrived` (left `14:13:20Z`, right `14:14:20Z`), and `one_sscc_…` which first failed on a test bug (FK to `sscc_counters`, fixed by inserting the counter) and then passed. The other new tests pass at once as expected.
- `--test office_shifts`: 3 failed (planned shift records lack the field).
- proto fixtures: 1 failed (`left: 540, right: 547`).
- `--test no_secrets_in_logs` (sandbox off): 2 failed (`left: 0, right: 1` for the batch line, both tests).

GREEN (after commit 2 and again at the end): `--test facts` 56, `--test office_shifts` 23, `--test codes` 8, `--test fact_rules` 12, `-p markiro-proto` 5 + 43, `--test no_secrets_in_logs` 2.

Full `cargo test --offline --locked --workspace --no-fail-fast` (sandbox off, run once at the end on `1c2f009c1`): 49 test-result lines, 606 passed, 0 failed, 0 ignored (Task 8 recorded 603; +3 new tests in `facts.rs`: 53 to 56).

Gates before each commit: `cargo fmt --all -- --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 (only the environmental `xcrun` build-script warning), `git diff --check` clean, `\u` grep clean, prettier clean on AGENTS.md, the spec and `office-shift.json`. `cargo clippy` of the libs: 0 warnings; with `--all-targets` clippy shows pre-existing warnings only (`validate.rs`, `tests/bootstrap.rs`, `tests/sscc_blocks.rs`, `tests/support/app.rs:394`, `tests/facts.rs:83` `items()` helper), none in lines this wave wrote.

## Mutants (harness `/tmp/claude/fw/mut.py`: copy to `/tmp/claude/fw/orig-<name>`, mutate, run, restore from the copy, then `shasum -a 256` before/after and `cmp`; `restored: true` on every row; final `shasum -c` of the four production files against the pre-mutation list: OK)

On the commit-1 tree (production unchanged) to show the new tests kill the review's survivors:

| Mutant | One-line change                                                     | Failing test(s)                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MA     | `box_closed.rs` `(sscc = ? AND 0) OR (block_id = ? AND serial = ?)` | `one_sscc_closes_one_box_whichever_block_and_prefix_it_comes_from`                                                                                                                            |
| MG     | `registry.rs` `claim.scanned_at[..19] >= owner.scanned_at[..19]`    | `the_registry_orders_scans_within_one_second_by_the_millisecond`                                                                                                                              |
| MH     | `routes/facts.rs` deferred `state.pool.begin()`                     | `a_batch_waiting_for_the_write_lock_sees_the_record_that_held_it`, `a_batch_waiting_for_the_lock_finds_the_shift_the_office_closed_meanwhile` (the deterministic one), `a_batch_is_stamped_…` |

(Each also shows the two RED tests that were red at that commit: not counted.)

On the commit-2 tree:

| Mutant | One-line change                                              | Failing test(s)                                                                                                             | Key line                                                          |
| ------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| MU1    | units subquery without `b.closed_at IS NOT NULL`             | `the_office_reads_a_shifts_totals_from_its_facts`                                                                           | open boxes counted (5 not 3)                                      |
| MU2    | units subquery without `b.disassembled_at IS NULL`           | same                                                                                                                        | `left: (6, 4, 1)`, `right: (6, 3, 1)` on the revived row of box 4 |
| MU3    | units subquery without `i.displaced_at IS NULL`              | same                                                                                                                        | displaced item counted (3 not 2)                                  |
| MU4    | `received_at` read before `begin_write` (2 edits: `arrived`) | `a_batch_is_stamped_when_it_holds_the_lock_not_when_it_arrived`                                                             |                                                                   |
| MU5    | the `tracing::error!` line removed                           | `…logs_only_its_three_audited_lines`, `secrets_never_reach_the_process_log`                                                 |                                                                   |
| MU6    | `position = 0` constant                                      | `secrets_never_reach_the_process_log`                                                                                       | `position=1` missing                                              |
| MU7    | `#[serde(rename = "unitsClosed")]` on the field              | proto: `office_shift_fixtures_round_trip_…`, `device_shift_fixtures_…`, `a_shift_close_carries_the_reason_and_the_revision` |                                                                   |
| MU8    | fixture `acceptedUnits` 540                                  | proto `office_shift_fixtures_round_trip_…`                                                                                  |                                                                   |

Not killable, by invariant: dropping `i.removed_at IS NULL` from the units subquery (a removed item sits only in an open box or a box taken apart, both already excluded; the hand-made row revives `removed_at` of box 4, which is excluded by `disassembled_at`).

## Decided differently / not done

- Proto empty-shape assertion is a JSON round trip, not a typed `empty.units_in_closed_boxes = 0`, to keep commit 1 compiling (a typed field would not compile before commit 2). The first failure in that test is the fixture assertion (547); the round trip itself turned green with commit 2 and MU7 fails it.
- T1-1 skipped, reasons above.
- The 500's walk batch now carries a refused first record so the position is 1, not 0 (a constant 0 is caught by MU6).
- The docs say "close columns held by the office route, `facts::close_shift` and `mark_late`" (the review said "two writers"; in code the late mark is a third UPDATE in the facts path, same file).

## Not verified / limits

No Vitest run (no webview source changed). The 300 ms code-check bound, Windows, CI `standalone-rust` / `standalone-windows-build`, throughput and totals cost at a real shift's volume are not exercised. `0010` was edited (comment only): databases applied from an earlier build of this branch need recreating.
