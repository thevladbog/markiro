# Plan ПЛ-Х, Task 6 report: `closedPallets` and `openPallets` in every `OfficeShift`

Status: DONE (concerns at the end; none blocks).
Worktree `/tmp/claude/wt/plh`, branch `claude/plh-pallets`, base `d92ea7d85` (Task 5).

## Commit

- `2d320ca02` feat(standalone): a shift's totals count its closed and open pallets

One `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (checked with `git log -1 --format=%B`). `git status --short` is empty after the commit.

## Semantics (checked against the host code)

- `closedPallets` = pallets of the shift with `closed_at IS NOT NULL AND disassembled_at IS NULL`. A closed pallet counts whatever its boxes are: alive, all taken apart, or none received yet (a pallet "opened closed" by its own `pallet_closed`). The box count the station reported is evidence for О-Х, not a guard. Pinned by the extra test (pallets 2 and 3).
- `openPallets` = pallets of the shift with `closed_at IS NULL` that hold at least one box with `disassembled_at IS NULL`. This is the same rule as `openBoxes` (an open box counts only while it holds a live item): a pallet whose boxes were all taken apart is not counted. A pallet is opened only by a box that names it, so an open pallet row with no boxes cannot appear; the EXISTS only filters out the taken-apart ones. A pallet with several live boxes counts once.
- A pallet taken apart is closed by the schema CHECK, so it is excluded from `closedPallets` and can never be in `openPallets`. Boxes keep `pallet_id` after either disassembly (Task 5), so the live-box test reads `boxes.disassembled_at`, as 2a2's box totals do.
- Same single read snapshot: the two counts are two more correlated scalar subqueries in the one `SELECT` const used by get, list, and every office write answer. The list is one query, not N+1.
- Index use (EXPLAIN QUERY PLAN, measured): `SEARCH p USING INDEX pallets_shift (shift_id=?)` twice, `SEARCH b USING INDEX boxes_pallet (pallet_id=?)` once, no scan other than the outer `shifts` read (both for `WHERE id = ?` and for the list filter).

## Required vs optional (webview and Rust)

Both fields are REQUIRED on both sides, as the brief states: Rust `closed_pallets: u32`, `open_pallets: u32` (no `serde(default)`), Zod `z.number().int().nonnegative()` with no `.optional()`/`.default()`. Reasons: the wire fixture `office-shift.json` now carries them, the host always sends them, the office and host are installed together, and the sibling four counts are required the same way. The Zod `.nonnegative()` is my addition to the brief's `.int()`: it mirrors `u32` and the four sibling counts (Rust refuses `-1`, so Zod should too). A protocol-2 host talking to this office would fail the parse (missing field); that is the accepted install-together rule (minors item 4). Direction check: Rust refuses a missing/negative/fractional/string/null count (new proto test), Zod refuses the same (extended and new protocol tests), so parity holds both ways.

Hand-built `OfficeShift`/totals fixtures updated (all in `apps/standalone/test`): `support/shifts.ts` `NO_TOTALS`, `ACTIVE` and `CLOSED` (PLANNED reuses `NO_TOTALS`; the brief named only ACTIVE), and `protocol.test.ts` (the `toEqual` of the fixture's totals and the planned-totals literal). Other suites spread `ACTIVE.totals` (`shift-totals`, `shifts-page`) or use `toMatchObject` (`api.test.ts`), so they needed no edit. Rust literals updated: `host/tests/facts.rs` (6 totals literals), `host/tests/office_shifts.rs` (1), `proto/tests/fixtures.rs` (1 round-trip literal).

## Anchor adaptations (mechanical, by meaning)

On this tree `ShiftTotals` already has `unitsInClosedBoxes` (2a2 final contract), so:

- The doc comment of `ShiftTotals` differs from the brief's anchor: the pallets sentence was appended to the existing text (the brief's anchor text for the struct doc did not match; the replacement kept the tree's wording).
- All Rust totals literals in tests are the six-field form; I appended `"closedPallets": 0, "openPallets": 0` to each, not the brief's five-field form. The new pallet test expects `"unitsInClosedBoxes": 5` as well (brief omitted it); measured and reasoned: 5 live items in 5 closed, not-taken-apart boxes.
- `pallet_facts.rs` import list on this tree contains `close_from_office`; I added `box_exception` to that list, re-sorted by `rustfmt`.
- `protocol.ts`: the Zod fields sit after `deviceIds` in `shiftTotalsSchema` as the brief says; added `.nonnegative()` (above).
- `support/shifts.ts`: three literals, not one (above).
- AGENTS.md: the paragraph on `totals` had been rewritten by 2a2; I adapted the brief's text: "six fields" became "eight fields", `closedPallets`/`openPallets` added to the list and to the non-negative integers, and the index sentence now names `0012` (`pallets_shift`, the partial `boxes_pallet`).
- Proto round trip in `proto/tests/fixtures.rs` (the "empty" totals) gets the two fields, since the fields are required.

None of these changes meaning; no STOP condition.

## RED and GREEN

RED (`/tmp/claude/impl-plh-t6/red-*.txt`), tests and fixtures only:

- `cargo test -p markiro-host --test pallet_facts --test facts --test office_shifts`: `facts` 56 passed / 1 failed (`the_office_reads_a_shifts_totals_from_its_facts`), `office_shifts` 30 / 4 failed (`an_administrator_plans_a_shift_and_reads_it_back`, `a_planned_shift_changes_what_is_sent_and_keeps_its_number`, `a_planned_shifts_template_change_is_stored_read_back_and_audited`, `a_shift_with_pallets_takes_its_template_and_the_products_capacity`), `pallet_facts` 27 / 1 failed (`the_office_reads_a_shifts_pallets_from_its_facts`). The same failing set as the brief names.
- `cargo test -p markiro-proto`: `5 passed` and `45 passed; 1 failed` (`office_shift_fixtures_round_trip_and_a_plan_carries_no_number_or_status`).
- Vitest `test/protocol.test.ts`: `Tests 3 failed | 211 passed (214)` (the brief's two plus the existing "figures" test that I extended with the pallet fields).

GREEN after the implementation:

- Brief tests: `facts` 57, `office_shifts` 34, `pallet_facts` 28 (`/tmp/claude/impl-plh-t6/green1-host.txt`; Task 5 left 57/34/27).
- With my additional tests (below): `pallet_facts` 29, host lib 59 (one new unit test), `markiro-proto` 5 and 47.
- Vitest: `test/protocol.test.ts` plus `api`, `shift-form`, `shift-list`, `shift-totals`, `shifts-refetch`: 6 files, 295 passed, `--reporter=verbose`, no stderr, no `act` warnings (`vitest-a.txt`).
- `typecheck` 0, `lint` 0.
- Full Vitest `run test`: 81 files, 2278 passed, 2 failed, both in `test/template-editor.test.tsx` with "Test timed out in 5000ms" (machine under load; the file touches nothing of this task). Re-run alone with the default timeout: the same 2 fail (5 s); with `--testTimeout=60000`: 97 of 97 pass. Both numbers reported.
- Final gate, unsandboxed, after the last source edit and the commit content: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast --offline --locked`: EXIT 0, 50 suites, 807 passed, 0 failed (`workspace.txt`). Task 5 left 803; 803 + 1 (brief test) + 1 (mine, `pallet_facts`) + 1 (mine, host lib plan) + 1 (mine, proto) = 807.

Counts, plan vs measured: the plan's host/proto numbers were measured on an older 2a2 head; this tree has `facts` 57 (plan 36), `office_shifts` 34 (plan 30), `pallet_facts` 28 with the brief's test (plan 16), proto 5 and 45 as the plan with the brief's test; the Vitest `protocol.test.ts` count is 213 with the brief test (plan 212).

Other checks: `cargo fmt --all -- --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings; `cargo clippy` same targets: only pre-existing warnings (`host/tests/support/app.rs:394`, `bootstrap.rs:671`, `no_secrets_in_logs.rs:1611`, `facts.rs` lines 83/894/1296/3009/3025, none in this task's code); prettier clean on AGENTS.md, `office-shift.json`, `protocol.ts`, `protocol.test.ts`, `support/shifts.ts`; `git diff --check` clean; `grep -rnF '\u04' src test` finds only `pairing-code.ts:66`; `\u0` in the Rust/JSON diffs finds nothing.

## Tests beyond the brief (3 + 1)

- `pallet_facts.rs` `each_shift_counts_its_own_pallets_and_a_pallet_counts_once`: three shifts at once (station A with pallets: 1 closed with a live box, 2 closed whose only box was taken apart, 3 closed with no box received, 4 open with three boxes, one of them taken apart; station B with two closed and one open pallet; a third station on a shift without pallets with a box). Expects (3, 1), (2, 1), (0, 0) from `GET /v1/office/shifts/{id}` and from the list row by row, and the office's close answer carrying (3, 1) which also stays after the close. Kills scope, join-duplication, "closed needs a live box" and per-row correlation mutants the brief test lets live.
- host lib `the_pallet_totals_run_on_the_indexes_of_0012` (in `routes/office_shifts.rs`, tempfile db opened with the real migrator): EXPLAIN QUERY PLAN of the shift query for `WHERE id = ?` and for the list filter pins two `pallets_shift` searches, one `boxes_pallet` search and no scan other than the outer `shifts`.
- `proto/tests/fixtures.rs` `a_shifts_totals_carry_both_pallet_counts_as_required_whole_numbers`: both fields round trip, each required, and `-1`, `1.5`, `"1"`, `null` are refused (Rust parity with Zod).
- `protocol.test.ts`: the brief's pallets test with `-1` added to the refused values, and the existing "figures" test extended with `closedPallets`/`openPallets` refused values (`[-1, 1.5, "1", null]`) and the fixture `toEqual`.

## Guard and mutant table

Method: `/tmp/claude/impl-plh-t6/mutate.py` copies the file to `/tmp/claude/impl-plh-t6/mut/<id>.orig`, checks the anchor occurs exactly once, applies the mutant, runs `pallet_facts` plus host lib (host), the proto suite (proto) or `protocol.test.ts` (Zod, fixture), restores the original bytes, `touch`es the file and checks `cmp` and `shasum -a 256` against the pre-mutation hash. All 28 restored byte-identically (`restored: true`), logs and results in `mut/` (`results.json`). `git status` showed only the intended modifications afterwards. No mutant survived.

| id  | one-line mutant                                                        | killed by                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | closed counts a pallet taken apart (brief M1)                          | the_office_reads_a_shifts_pallets_from_its_facts                                                                                                                                                                                                             |
| H2  | closed counts an open pallet (drop `closed_at IS NOT NULL`)            | each_shift_counts_its_own_pallets_and_a_pallet_counts_once; the_office_reads_a_shifts_pallets_from_its_facts                                                                                                                                                 |
| H3  | closed not scoped to the shift (`1 = 1`)                               | each_shift_counts_its_own_pallets_and_a_pallet_counts_once; the_pallet_totals_run_on_the_indexes_of_0012                                                                                                                                                     |
| H4  | closed also needs a live box                                           | each_shift_counts_its_own_pallets_and_a_pallet_counts_once; the_pallet_totals_run_on_the_indexes_of_0012                                                                                                                                                     |
| H5  | open not scoped to the shift                                           | each_shift_counts_its_own_pallets_and_a_pallet_counts_once; the_pallet_totals_run_on_the_indexes_of_0012                                                                                                                                                     |
| H6  | open counts a closed pallet with a live box (drop `closed_at IS NULL`) | each_shift_counts_its_own_pallets_and_a_pallet_counts_once; the_office_reads_a_shifts_pallets_from_its_facts                                                                                                                                                 |
| H7  | open without the EXISTS (brief M2)                                     | the_pallet_totals_run_on_the_indexes_of_0012; the_office_reads_a_shifts_pallets_from_its_facts                                                                                                                                                               |
| H8  | a box taken apart keeps the pallet open (brief M3)                     | the_pallet_totals_run_on_the_indexes_of_0012; the_office_reads_a_shifts_pallets_from_its_facts                                                                                                                                                               |
| H9  | EXISTS reads any box of the shift, not the pallet's                    | the_pallet_totals_run_on_the_indexes_of_0012; the_office_reads_a_shifts_pallets_from_its_facts                                                                                                                                                               |
| H10 | open counted through a join (a pallet counted per live box)            | each_shift_counts_its_own_pallets_and_a_pallet_counts_once only (the brief test does not kill it)                                                                                                                                                            |
| H11 | the two counts swapped (brief M4)                                      | each_shift_counts_its_own_pallets_and_a_pallet_counts_once; the_office_reads_a_shifts_pallets_from_its_facts                                                                                                                                                 |
| H12 | closed count always 0                                                  | the same two                                                                                                                                                                                                                                                 |
| H13 | open count always 0                                                    | the same two                                                                                                                                                                                                                                                 |
| H14 | index defeated: `p.shift_id \|\| ''` in the closed count               | the_pallet_totals_run_on_the_indexes_of_0012                                                                                                                                                                                                                 |
| H15 | index defeated: `b.pallet_id \|\| ''` in the EXISTS                    | the_pallet_totals_run_on_the_indexes_of_0012                                                                                                                                                                                                                 |
| H16 | index defeated: `p.shift_id \|\| ''` in the open count                 | the_pallet_totals_run_on_the_indexes_of_0012                                                                                                                                                                                                                 |
| P1  | proto: `#[serde(default)]` on `closed_pallets`                         | a_shifts_totals_carry_both_pallet_counts_as_required_whole_numbers                                                                                                                                                                                           |
| P2  | proto: `#[serde(default)]` on `open_pallets`                           | the same                                                                                                                                                                                                                                                     |
| P3  | proto: `closed_pallets` signed (`i32`)                                 | the same                                                                                                                                                                                                                                                     |
| P4  | proto: `open_pallets` renamed on the wire                              | a_shifts_totals_carry_both_pallet_counts_as_required_whole_numbers; office_shift_fixtures_round_trip_and_a_plan_carries_no_number_or_status; device_shift_fixtures_round_trip_and_a_station_names_no_line; a_shift_close_carries_the_reason_and_the_revision |
| Z1  | zod: `closedPallets` may be negative (drop `.nonnegative()`)           | "read a shift's pallets in its totals and refuse a count …"; "read a shift's figures, a planned shift's zeros among them, …"                                                                                                                                 |
| Z2  | zod: `openPallets` may be fractional (drop `.int()`)                   | the same two                                                                                                                                                                                                                                                 |
| Z3  | zod: `closedPallets` optional                                          | the same two                                                                                                                                                                                                                                                 |
| Z4  | zod: `openPallets` nullable                                            | the same two                                                                                                                                                                                                                                                 |
| Z5  | zod: `openPallets` defaults to 0                                       | the same two                                                                                                                                                                                                                                                 |
| F1  | fixture `office-shift.json`: `closedPallets` left out                  | 15 tests (proto and Vitest)                                                                                                                                                                                                                                  |
| F2  | fixture `office-shift.json`: `openPallets` 3                           | "read a shift's figures, …" (the fixture value is pinned)                                                                                                                                                                                                    |

Coverage by guard: each counted state (closed, open, closed-with-live-box not open, open-with-only-taken-apart-boxes not counted, pallet taken apart not closed, closed pallet with no boxes still closed): H1, H2, H4, H6 to H9; other shift's pallets excluded and zero for a shift without pallets: H3, H5, H12, H13 plus the third station in the extra test; per row in the list (not a single scalar for the whole list): the list row check plus H3/H5; no duplication: H10; field names, order, serde/Zod requiredness and non-negativity: H11, P1 to P4, Z1 to Z5, F1, F2; index use: H14 to H16 (H3, H5, H7 to H9 also change the plan).

## Files changed

`apps/standalone/proto/src/lib.rs`, `proto/tests/fixtures.rs`, `proto/fixtures/office-shift.json`, `host/src/routes/office_shifts.rs`, `host/tests/{pallet_facts,facts,office_shifts}.rs`, `src/host/protocol.ts`, `test/protocol.test.ts`, `test/support/shifts.ts`, `apps/standalone/AGENTS.md`. No manifest, lockfile, migration or applied file touched.

## Self-review and concerns

1. `.nonnegative()` is added to the Zod fields beyond the brief's `.int()`; it is the tighter, sibling-consistent choice and is pinned by `-1` tests. If the controller wants the brief's literal text it is a one-line removal (Z1 shows the tests then fail).
2. A late box (its `closedAt` after its pallet's) joins a closed pallet silently (minors item 8); totals do not signal it, and neither should they. The count mismatch and flag are for О-Х/О-Ф/ЧЗ.
3. `openPallets` ignores pallets whose live boxes are open boxes only if the box is closed: a box with `pallet_id` is always closed (schema CHECK), so a pallet holds closed boxes only. A pallet whose boxes are all taken apart but later gets a new box (a re-sent box under a new id) is counted again, correctly.
4. Process slips: I started a few Bash commands with `cd /tmp/claude/wt/plh` (against the rules) before switching to absolute paths. I checked afterwards: no stray `.claude/.cc-writes` directory exists in the worktree (`.claude/launch.json` is the tracked file) and `git status` is empty.
5. The delayed-`setImmediate` stand was not run: this task adds no UI test, only schema, fixture and data edits (the touched Vitest files are `protocol.test.ts` and the shared `support/shifts.ts`, run verbosely with empty stderr).
6. Not verified here: any browser rendering, a station, Windows or live office; the office forms and the card showing pallets are plan О-Ф. The `dist` of the webview that the shell embeds was not rebuilt (the shell tests pass on the existing build).
