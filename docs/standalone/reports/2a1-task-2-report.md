# Plan 2a1, Task 2 report — shifts in the host's model and the office's plan

Status: DONE. BASE a3284f712e0fac835fdc454b2c6763943679e1b4. Commit: c83b51181 "feat(standalone): shifts in the host's model and the office's plan" (trailer verified, one Co-Authored-By line; `git status --short` empty after it).

## What was done

Steps 1-7 of the brief in order: tests first (host `office_shifts.rs`, `ShiftSetup`/`shift_setup`/`shift_body`/`plan_shift` in `tests/support/app.rs`, two proto fixtures, proto unit and fixture tests), then migration `0009`, `audit::actions::SHIFT_CREATE`, `auth::plans_shifts` + `require_shift_planning(_in)`, `require_active_line` made `pub`, `validate::{MAX_PLANNED_QTY, civil_date, client_uuid}`, `shifts.rs` (ShiftProduct, product_inactive, shift_product, check_counterparty, check_box_template, NewShift, insert, civil_text), `routes/office_shifts.rs` + routing, proto `ShiftStatus/ShiftMode/OfficeShift/ShiftCreate`, AGENTS.md («Writes», «Shifts»).

Anchor deviation (not a mismatch of substance): the plan's anchors for `tests/support/app.rs` (`.collect()\n}\n\n`) and `shifts.rs` (`format!(...)\n}\n\n`) end with a blank line, but both files end right after the closing brace (the blank line is a code-fence artifact). I appended / replaced without the trailing blank line; the files end with a single `}\n`. All other anchors matched exactly once. The first scripted batch stopped at that shifts.rs anchor after applying the earlier edits; the rest was applied by a second script, so no edit was applied twice (checked by diff).

## RED evidence

- `cargo test -p markiro-host --test office_shifts --offline --locked`: exit 101, 6 of 6 FAILED. `plan_shift` got `404` where `200` was expected (5 tests); `a_plan_needs_…` got `(404, not_found)` where `(400, validation_failed, field productId)` was expected. Matches the brief.
- `cargo test -p markiro-proto --offline --locked`: did not compile, `error[E0432]: unresolved imports super::ShiftMode, super::ShiftStatus` (+2 E0282). Matches.

## GREEN evidence

- `--test office_shifts`: 6 passed, 0 failed.
- `-p markiro-proto`: 5 unit + 35 fixture tests passed (40).
- Outside the sandbox, `cargo test -p markiro-host -p markiro-proto --offline --locked`: exit 0, 32 suites, 357 passed, 0 failed = host 317 + proto 40.

## Test totals (plan vs measured)

- Plan: host 316, proto 40. Measured: host 317, proto 40. The +1 host test is Task 1's extra `only_digits_and_dashes_make_a_date` (as announced in the dispatch).
- `cargo fmt --all -- --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline`: 0 warnings; `prettier --check` on the two fixtures and AGENTS.md clean; `git diff --check` clean; no literal `\u0` in any file I wrote.

## Mutants (each run: `--test office_shifts`, or `-p markiro-proto` for M17; every file restored, `cmp` against a pre-mutation copy in /tmp/claude/ silent, sha256 unchanged — the script printed `cmp=True sha_same=True` for all 17; shifts.rs d127e9c8cd51, office_shifts.rs 7d984bde3ed3, validate.rs 2c973a6c2533, proto lib.rs 236d190694db)

| #   | Mutant (one line)                                                                                   | Test that failed                                                              | Key line                           |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------- |
| M1  | drop `check_box_template` call (brief M1)                                                           | a_plan_needs_an_active_product_an_active_line_and_a_fitting_template          | office_shifts.rs:353               |
| M2  | list: `WHERE status <> 'closed' OR production_date >= ?` -> `WHERE production_date >= ?` (brief M2) | the_list_holds_open_shifts_and_recent_closed_ones_or_a_period                 | office_shifts.rs:410               |
| M3  | counter `last_seq = last_seq + 1` -> `last_seq` (brief M3)                                          | numbers_count_per_month_of_the_production_date and the_list_holds_open_…      | support/app.rs:502 (500 on UNIQUE) |
| M4  | `if pallets_enabled {` -> `if false {`                                                              | a_plan_needs_…                                                                | office_shifts.rs:353               |
| M5  | drop `check_counterparty`                                                                           | a_plan_needs_…                                                                | office_shifts.rs:353               |
| M6  | archived product passes (`false` -> `_` in the match)                                               | a_plan_needs_…                                                                | office_shifts.rs:353               |
| M7  | skip the `from > to` check                                                                          | the_list_holds_…                                                              | office_shifts.rs:434               |
| M8  | drop the `plannedQty` cap check                                                                     | a_plan_needs_…                                                                | office_shifts.rs:353               |
| M9  | drop `require_active_line`                                                                          | a_plan_needs_…                                                                | office_shifts.rs:353               |
| M10 | default capacity `product.box_capacity` -> `1`                                                      | an_administrator_plans_a_shift_and_reads_it_back                              | office_shifts.rs:69                |
| M11 | `RECENT_DAYS` 31 -> 30                                                                              | the_list_holds_…                                                              | office_shifts.rs:410               |
| M12 | drop `deny_unknown_fields` on `ShiftListQuery`                                                      | the_list_holds_… (`status=closed` case)                                       | office_shifts.rs:434               |
| M13 | audit details without `productionDate`                                                              | an_administrator_plans_… and a_technologist_plans_…                           | office_shifts.rs:71                |
| M14 | `mode` check disabled (`if false && …`)                                                             | a_plan_needs_…                                                                | office_shifts.rs:353               |
| M15 | drop the `boxCapacity` cap check                                                                    | a_plan_needs_…                                                                | office_shifts.rs:353               |
| M16 | `civil_date` trims its input (padded date accepted)                                                 | a_plan_needs_…                                                                | office_shifts.rs:353               |
| M17 | drop `deny_unknown_fields` on `ShiftCreate`                                                         | proto office_shift_fixtures_round_trip_and_a_plan_carries_no_number_or_status | fixtures.rs:712                    |

M4, M5, M6, M8, M9, M14, M15, M16 are caught inside the one many-case table of `a_plan_needs_…`, where the panic message names the failing `change`; none passed on its mutant. Not mutated: `plans_shifts` (both roles are true, no wildcard; nothing to flip without a third role), the migration CHECKs/indexes (no route exercises them in this task; `close_directly` in the test does write a closed row through the status/closed CHECKs and so exercises the status CHECK pair, and `UNIQUE (number_month_key, number_seq)` is what turned M3 into a 500).

## Files changed (16)

apps/standalone/AGENTS.md; host/migrations/0009_shifts_sscc_blocks.sql (new); host/src/{audit,auth,shifts,validate,server}.rs; host/src/routes/{devices,mod}.rs; host/src/routes/office_shifts.rs (new); host/tests/office_shifts.rs (new); host/tests/support/app.rs; proto/src/lib.rs; proto/tests/fixtures.rs; proto/fixtures/{office-shift,shift-create}.json (new). Cargo.toml, Cargo.lock, package.json, lockfile, applied migrations 0001-0008 untouched.

## Self-review / concerns

- No concerns blocking. Code was applied verbatim from the brief apart from the trailing-blank-line anchor issue above.
- The checker's earlier 'FILE MISSING' and 'NO MATCH' (`shifts.rs` mutation fragment `DO UPDATE SET last_seq = last_seq + 1`) are resolved: both now exist/match, and M3 used that fragment exactly once.
- The full host+proto run took ~20 minutes wall time on this machine (suites bind 127.0.0.1, run with the sandbox disabled).
- Vitest / delayed-setImmediate hygiene rules do not apply: no TS tests were touched.

## Fix round (review Important 1, Important 2, Minor 1) — tests only, production code untouched

BASE c83b51181d577cc727add8451d8e9d352f51f672. Commit: `test(standalone): the shift plan's session re-check, group-scoped templates and list order are covered` (only `host/tests/office_shifts.rs` changed).

Added to `host/tests/office_shifts.rs` (6 -> 8 tests; imports `turn_the_user_off_at_the_next_activity`):

- `planning_stops_a_user_turned_off_after_the_extractor_passed` (Important 1; model: `products.rs:742`): trigger turns the technologist off at the next activity, clock +2 min, `POST /v1/office/shifts` -> 401 `unauthorized`, `credential: session`; asserts user inactive (trigger fired after the extractor), session row still present (refusal is the route's), no `shifts`/`shift_number_counters` rows, host revision and audit row count unchanged.
- `a_box_template_scoped_to_the_products_group_fits_it` (Important 2): enabled box templates scoped to `[8]` and `[8, 15]` are each planned for the group-8 product and the shift keeps the template id.
- Minor 1, inside `numbers_count_per_month_of_the_production_date`: `GET /v1/office/shifts` lists `NOV26-001, OCT26-003, OCT26-002, OCT26-001`. Note: the two shifts sharing 2026-10-08 are `OCT26-001` and `OCT26-002` (the review's `OCT26-003` is dated 10-31), so the whole list is asserted. Finding while writing it: with a fixed clock and random v4 ids the first version of this assertion passed on mutant B half of the time (the tie fell to `id`), so the test now pins the two ids (`UPDATE shifts SET id`, older shift gets the smaller id) and the mutant fails deterministically.

RED/GREEN: the new tests assert existing behaviour, so RED is shown on mutants (run `--test office_shifts`, in the sandbox, no bind needed). Pristine run: 8 passed (5 repeated runs, all 8 ok). Mutants (script `/tmp/claude/fix2mut.py`; each restored from a pre-mutation copy, `cmp` equal and sha256 equal; shifts.rs d127e9c8cd51, office_shifts.rs 7d984bde3ed3 before and after, checked also with `shasum -c` at the end):

| #   | One-line mutant                                                  | Test that failed                                            | Key line                                    | Restore proof          |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- | ---------------------- |
| A   | `shifts.rs:140` `Some(group)` -> `None`                          | a_box_template_scoped_to_the_products_group_fits_it         | support/app.rs:502 (plan_shift got non-200) | cmp=True sha_same=True |
| A2  | `office_shifts.rs:209` `product.group` -> `product.box_capacity` | a_box_template_scoped_to_the_products_group_fits_it         | support/app.rs:502                          | cmp=True sha_same=True |
| B   | `office_shifts.rs:112` drop `number_seq DESC`                    | numbers_count_per_month_of_the_production_date              | office_shifts.rs:143 (list order)           | cmp=True sha_same=True |
| E   | delete `context.require_shift_planning_in(&mut tx).await?;`      | planning_stops_a_user_turned_off_after_the_extractor_passed | office_shifts.rs:194 (status not 401)       | cmp=True sha_same=True |

Gates: `cargo fmt --all -- --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets --offline` 0 warnings, `git diff --check` clean, no literal `\u0`. Counts: host `office_shifts` 8 (was 6); the full host/proto run was not repeated (the change is tests-only in one target); previous full-run total 357 becomes 359.
