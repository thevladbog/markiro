# Plan 2a2, Task 7 report — `totals` in every `OfficeShift`

Status: DONE_WITH_CONCERNS (concerns are notes, not blockers).
BASE: 1a2105a11be53dfe87c2df872ca25877e90cd0ae. Commit: `ceea2c126 feat(standalone): the office reads a shift's totals from its facts` (branch claude/2a2-facts, tree clean after).

## What was done

- `proto/src/lib.rs`: `ShiftTotals { accepted_units: u64, closed_boxes: u32, open_boxes: u32, last_fact_at: Option<String>, device_ids: Vec<String> }` (camelCase), `OfficeShift::totals` (required).
- `host/src/routes/office_shifts.rs`: the single `SELECT` const gets five correlated subqueries (units, closed boxes, open boxes, last receipt, participants as `json_group_array(... ORDER BY first_entered_at, device_id)`); `ShiftRow`/`record` map them. Every reader (list, GET, POST, PUT, close, via `read`) therefore answers with totals; nothing is stored.
- `proto/fixtures/office-shift.json` + `proto/tests/fixtures.rs`: fixture carries `totals`; the owner is among `deviceIds`; `round_trip` proves serialisation equals the fixture byte-for-byte as JSON (field contract for plan 2a3); an added assertion pins the empty shape (`lastFactAt: null`, `deviceIds: []`).
- `host/tests/office_shifts.rs`: `planned(...)` carries zero totals (the three tests the plan names).
- `host/tests/facts.rs`: `the_office_reads_a_shifts_totals_from_its_facts` (plan's test, extended, see below).
- `apps/standalone/AGENTS.md` («Facts»): totals paragraph.
- No migration, manifest, lockfile, webview or other file touched. No index added (see performance).

## Decisions on what counts (stated in AGENTS.md and the proto doc)

- accepted unit = `box_items` row, `removed_at IS NULL AND displaced_at IS NULL`, in open AND closed boxes of THAT shift (box.shift_id). Undone/cleared items, items of a disassembled box (Task 5's disassembly removes every live item), and items displaced by an earlier scan elsewhere are excluded. A `conflict` loser has no `box_items` row, so it is never counted.
- `closedBoxes` = `closed_at NOT NULL AND disassembled_at NULL`; `openBoxes` = `closed_at NULL` AND has a live item (a box emptied by undo OR by displacement is not open).
- `lastFactAt` = `MAX(fact_receipts.received_at)` for the shift: host format, whole seconds, fixed length, so text MAX is time MAX. Only receipts whose `shift_id` is set (record passed the entry check; non-participants and unknown shifts never touch it); refused records included. NULL when no receipt.
- `deviceIds` = participants by `first_entered_at`, `device_id` as tie-break; `json_group_array` over no rows is `[]`, never absent.

## Tests: extra coverage added to the plan's test (hunting the lessons)

The plan's test did not kill several mutants, so the test was extended:

- box 5 with only a DISPLACED item (colleague's earlier scan of code 9): must not be an open box (kills "displaced item keeps box open", which the undo-only box 3 missed);
- the colleague closes a box of his own block in his own shift: kills closed-boxes/open-boxes/units/lastFactAt/devices "of every shift" mutants (the plan's colleague had nothing closed and shared the receipt instant with the floor, so the filters were unproven);
- after that, the floor's totals are asserted unchanged (isolation), then the office closes the shift and the close answer's `totals` is compared with the list/GET totals (totals present in write answers; POST/PUT are the zero-totals planned tests).
  List and detail agree in every assertion (helper `totals()` compares both).

## RED / GREEN

- RED (`--test facts --test office_shifts --no-fail-fast`): facts 52 passed, 1 failed (`the_office_reads_a_shifts_totals_from_its_facts`); office_shifts 20 passed, 3 failed (`an_administrator_plans_a_shift_and_reads_it_back`, `a_planned_shift_changes_what_is_sent_and_keeps_its_number`, `a_planned_shifts_template_change_is_stored_read_back_and_audited`). (proto: compile error `no field totals` before step 3 was not separately run; the fixture test needs the type.)
- GREEN: facts 53, office_shifts 23, proto 5 + 43.
- Full `-p markiro-host -p markiro-proto` (outside the sandbox): 35 test binaries, 487 tests passed, 0 failed, 0 ignored (+2 empty doc-test runs). Brief's counts (facts 19→20) are shifted by earlier tasks: facts is 53 here (52 + this one), office_shifts 23 as planned, proto 5/43 as planned.
- `cargo fmt --check` clean, prettier on AGENTS.md + fixture clean, `git diff --check` clean, no `\u0` in the diff. `cargo check -p markiro-host -p markiro-proto --all-targets --locked`: 0 Rust warnings (one `markiro-host (build script)` warning is the sandbox's `xcrun: couldn't create cache file` noise, environmental). `cargo check --workspace --all-targets` also compiled (shell crate unaffected).

## Mutants (target: `--test facts --test office_shifts`; the file restored with `cmp` silent and equal sha256 after each)

All fail only `the_office_reads_a_shifts_totals_from_its_facts` (key line = first differing assert).

| Mutant                                            | Key line (actual vs expected)                       |
| ------------------------------------------------- | --------------------------------------------------- |
| M1 removed items counted                          | facts.rs:6740 acceptedUnits 8 vs 5                  |
| M2 displaced items counted                        | facts.rs:6786 acceptedUnits 5 vs 3                  |
| M3 disassembled box counted closed                | 6740 closedBoxes 2 vs 1                             |
| M4 empty open box counted (`AND 1 OR EXISTS`)     | 6740 openBoxes 4 vs 2                               |
| M5 lastFactAt without rejected                    | 6786 lastFactAt 14:18:20 vs 14:23:20                |
| M6 devices unordered                              | 6821 device order swapped                           |
| M6b devices ordered by id only                    | 6821 device order swapped                           |
| M7 units of every shift (`WHERE 1`)               | fails (colleague's units leak)                      |
| M8 closed boxes of every shift                    | fails (colleague's closed box leaks)                |
| M9 open boxes of every shift                      | fails                                               |
| M10 displaced item keeps box open                 | fails (box 5) — NOT killed by the plan's test alone |
| M10b removed item keeps box open                  | fails                                               |
| M11 lastFactAt of every shift                     | fails                                               |
| M12 devices of every shift                        | fails                                               |
| M13 MIN instead of MAX                            | fails                                               |
| M14 closed/open mapping swapped in `record`       | fails                                               |
| P1 proto: `skip_serializing_if` on `last_fact_at` | proto fixtures.rs:701 empty-shape assertion         |

Restore proof: office_shifts.rs sha256 prefix equal before/after each run (script `/tmp/claude/t7/mut.py`, `cmp` vs `/tmp/claude/t7/before.rs`); proto lib.rs `826eeb6b…` before and after P1.

## Performance (measured, not guessed)

Synthetic DB (migrations 0001–0010 applied in SQLite 3.53 via Python; the host bundles 3.46, the plan checks match): 366 shifts x 300 boxes x 12 items = 1.3M `box_items`, 110k boxes, 1.46M receipts. `EXPLAIN QUERY PLAN`: units/closed/open use `boxes_shift (shift_id=?)` + `box_items_live (box_id=?)` (open boxes via `EXISTS ... USING INDEX box_items_live`), last fact `COVERING INDEX fact_receipts_shift`, devices the PK autoindex of `shift_participants`; no full scan of a facts table. One query for the whole list (no N+1). 366-shift list: 0.14 s with `ANALYZE`, 0.2–0.6 s without (loaded machine, noisy); one shift: 0.5 ms. A covering index on `boxes` was tried: no measurable gain beyond noise, so 0010 is untouched. Cost is linear in the facts of the listed shifts (inherent to computed totals); plan 2a3's 366-day period at pilot volume is far below this synthetic load. If volume ever demands it, store counters instead — a deliberate future change.

## Anchor adaptations (NO MATCH lines and drift)

1. `host/tests/facts.rs` Step 1.1: the anchor (end of the file) does not match any more — later tasks' tests end the file. The new `totals` helper + test were appended at the end of the file instead (file lacked trailing newline after the append, fixed).
2. `host/src/routes/office_shifts.rs` Step 3 module doc: the plan's «anchor» started a line earlier than the real doc; the intent (extra two doc lines) applied on the current text. The SELECT/Row/record/proto fragments matched as given.
3. `apps/standalone/AGENTS.md` Step 5: the plan's anchor («`commit_with_revision` … a batch that changes no shift takes none» then «## Marking rules») no longer abuts; the paragraph is placed immediately before «## Marking rules», after the timestamp-format paragraph, with the plan's text extended (open+closed boxes, displacement, whole seconds host format, tie-break, index/change rule).
4. Step 6 mutant fragments (M1–M6) were applied by hand on the current SELECT text (they matched the text Step 3 created); plus the extra mutants M6b, M7–M14, P1 above.
5. Plan counts: facts 52 baseline passing (not 19), becoming 53; reported both.

## Concerns / notes for later

- `lastFactAt` is the host's receipt time of a record that passed the entry check, including refused records — a station that only sends refused records still shows activity (by design, in the plan and AGENTS).
- `acceptedUnits` is "live items", so a displaced/undone scan lowers it later; reports reading it at different times see different numbers (the numbers are never stored). Historical per-day figures would need a stored snapshot (stage-4 reports).
- `openBoxes` excludes empty open boxes; a station may still show them locally.
- Not run: webview Vitest (no webview file touched; plan 2a3 adds `totals` to `officeShiftSchema`, which is `.strict()` there, so 2a3's merge MUST add the field or its fixture test fails); no browser/Windows checks.
- Sandbox: loopback test suites were run outside the sandbox as the rules require.
