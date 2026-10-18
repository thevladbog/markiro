# Plan 2a1, Task 3 report — office edit/delete of a shift, `template_in_use`

BASE: 736390e3475dad8659427950022cbe22e05e0121. Status: DONE_WITH_CONCERNS (concerns below are minor).

## What was done

Steps 1–5 of the brief applied in order (every anchor matched exactly once): tests, `shift-update.json` fixture + proto fixture test, `audit::actions::{SHIFT_UPDATE, SHIFT_DELETE}`, `update_shift`/`delete_shift`, `shifts::status_conflict`, `template_in_use` in `routes/templates.rs`, route registration, `ShiftUpdate` in proto, AGENTS.md («Catalog and label templates», «Shifts»).

Additions beyond the brief (all in `host/tests/office_shifts.rs`, plan tests kept verbatim otherwise; Task 2's fix tests kept):

- New test `editing_and_deleting_stop_a_user_turned_off_after_the_extractor_passed`: the in-transaction `require_shift_planning_in` of PUT and DELETE (one user per request, one trigger per user — the shared `turn_the_user_off` trigger name made a second `CREATE TRIGGER`/`DROP TRIGGER` flaky), no write/revision/audit row, and a device key opens neither route.
- `an_active_shift_takes_only_its_plan_and_a_closed_one_nothing`: added a `counterpartyId` change case and made `expectedRev` follow the returned `rev` (a counterparty is created first). Needed because mutant M11 survived the plan's test.

## RED

- `cargo test -p markiro-proto --offline --locked`: `error[E0432]: unresolved import markiro_proto::ShiftUpdate`.
- `cargo test -p markiro-host --test office_shifts`: 8 passed, 5 failed (13 tests; brief says 5 of 11 +2 from Task 2): PUT/DELETE of a shift got `405 method_not_allowed`; template delete got `204` instead of `409 template_in_use`.

## GREEN

- `--test office_shifts --test templates`: 14 (13 plan-shaped + my 1) and 27. Brief: 11 and 27 (office_shifts 11+2 from Task 2 = 13).
- `-p markiro-proto`: 5 unit + 36 fixtures (brief: 5 + 36).
- Full `-p markiro-host -p markiro-proto` outside sandbox: rc=0, 366 passed, 0 failed = proto 41 + host 325. Brief: host 321, proto 41; measured host = 321 + 1 (Task 1 `only_digits_and_dashes_make_a_date`) + 2 (Task 2 fix) + 1 (my new test) = 325.
- `cargo fmt --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline`: 0 warnings; prettier on `shift-update.json` and AGENTS.md clean; `git diff --check` clean; `\u` grep on touched files finds only the pre-existing AGENTS.md:429 `\u001d`.

## Mutants (scratch script `/tmp/claude/mutate.py`; each restored, `cmp` silent and sha256 identical every time)

Run: `office_shifts` + `templates` (host) or `-p markiro-proto`.

| Mutant                                                               | Test that failed                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 `Active if !fixed_changed` -> `Active`                            | an_active_shift_takes_only_its_plan_and_a_closed_one_nothing                                                                                                              |
| M2 delete: `!= Planned` -> `== Closed`                               | only_a_planned_shift_is_deleted                                                                                                                                           |
| M3 `template_in_use` condition always false                          | a_template_that_a_planned_shift_names_is_not_deleted                                                                                                                      |
| M4 in-use query drops `status = 'planned'`                           | same                                                                                                                                                                      |
| M5 in-use query `ORDER BY id DESC`                                   | same                                                                                                                                                                      |
| M6 stale check `!=` -> `<`                                           | a_planned_shift_changes_what_is_sent_and_keeps_its_number                                                                                                                 |
| M7 changed line not checked                                          | an_edit_checks_a_changed_line_…                                                                                                                                           |
| M8 changed template not checked                                      | same                                                                                                                                                                      |
| M9 changed counterparty not checked                                  | same                                                                                                                                                                      |
| M10 unchanged line rechecked                                         | same                                                                                                                                                                      |
| M11 counterparty out of `fixed_changed`                              | SURVIVED the plan's test -> strengthened (counterparty case added); now an_active_shift_takes_only_its_plan_and_a_closed_one_nothing fails                                |
| M12 date out of `fixed_changed`                                      | an_active_shift_takes_only_its_plan_and_a_closed_one_nothing                                                                                                              |
| M13 plannedQty unvalidated                                           | an_edit_checks_a_changed_line_…                                                                                                                                           |
| M14 boxCapacity unvalidated                                          | same                                                                                                                                                                      |
| M15 `check_mode` dropped                                             | same                                                                                                                                                                      |
| M16 productionDate unvalidated                                       | a_planned_shift_changes_… and an_edit_checks_…                                                                                                                            |
| M17 / M20 early `require_shift_planning()` dropped (update / delete) | survive — equivalent: only Admin and Technologist exist and both plan, and the in-transaction recheck (M18/M19) is the observable guard                                   |
| M18 update tx recheck dropped                                        | editing_and_deleting_stop_a_user_turned_off_…                                                                                                                             |
| M19 delete tx recheck dropped                                        | SURVIVED the first version of my new test (the second request was refused by the extractor, not the route) -> one user per request; now editing_and_deleting_stop_… fails |
| M21 no-op still writes/audits (`update_details` forced `Some`)       | a_planned_shift_changes_what_is_sent_and_keeps_its_number                                                                                                                 |
| M22 delete audit `number` wrong                                      | only_a_planned_shift_is_deleted                                                                                                                                           |
| M23 `status_conflict` status string wrong                            | an_active_shift_… and only_a_planned_shift_is_deleted                                                                                                                     |
| M24 update audit action wrong                                        | a_planned_shift_changes_… and an_active_shift_…                                                                                                                           |
| M25 delete takes no revision (reads current)                         | only_a_planned_shift_is_deleted                                                                                                                                           |
| P1 `ShiftUpdate` loses `deny_unknown_fields`                         | a_shift_update_carries_only_what_changes_and_never_the_product                                                                                                            |
| P2 `planned_qty` not `nullable`                                      | same                                                                                                                                                                      |
| P3 `counterparty_id` not `nullable`                                  | survives in proto (fixture has no `counterpartyId: null`); host run P3h fails a_planned_shift_changes_what_is_sent_and_keeps_its_number — covered by the host test        |
| R1 / R2 PUT / DELETE route unregistered                              | 4 / 3 tests incl. the new one                                                                                                                                             |

## Files

Modified: `apps/standalone/host/src/{audit,shifts,server}.rs`, `host/src/routes/{office_shifts,templates}.rs`, `host/tests/office_shifts.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `apps/standalone/AGENTS.md`. Created: `proto/fixtures/shift-update.json`. No manifests, lockfile, migrations or other crates touched.

## Concerns

- Brief numbers (11 / 321) are shifted; real are 14 / 325 as explained above.
- Proto fixture test alone does not cover `counterpartyId: null` (P3); host test does. The plan's proto test was kept verbatim.
- The brief's `PUT` accepts `mode`/`palletsEnabled` only to run `check_mode` (always rejects non-default); as specified.
- Test-only: the shared `turn_the_user_off` trigger helper cannot be reused twice per DB (flaky CREATE after DROP), so the new test creates its own per-user triggers.

## Fix round (review Important 1, Minor 1) — tests only, `host/tests/office_shifts.rs`

Base 559ddf529. Production code untouched.

- New `a_planned_shifts_template_change_is_stored_read_back_and_audited`: template scoped `[8]` (the product's group), PUT `{boxTemplateId, expectedRev}` -> 200 with the new id, GET returns the same record, audit row `{"changed":["boxTemplateId"],"boxTemplateId":{from,to}}`.
- `an_edit_checks_…` gains: archive the product after planning; changing to a `[8]` template answers 409 `conflict` `{constraint: product_inactive}` with no audit row; an edit that keeps the template (plus `plannedQty`) still passes.
- GREEN: `--test office_shifts` 15 passed (was 14). fmt, `cargo check --all-targets` (0 warnings), `git diff --check` clean.

| Mutant (one line, `host/src/routes/office_shifts.rs`)                           | Test that failed                                                                | Key line                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| A `.bind(&box_template_id)` -> `.bind(&current.box_template_id)`                | a_planned_shifts_template_change_is_stored_read_back_and_audited                | updated record keeps the old boxTemplateId (left != right)  |
| B `check_box_template(.., product.group)` -> `product.group + 1`                | same                                                                            | status 400 vs 200                                           |
| C `shift_product(..)` replaced by `ShiftProduct { group: 8, box_capacity: 12 }` | an_edit_checks_a_changed_line_template_or_counterparty_and_keeps_unchanged_ones | `(200, (Null, Null))` vs `(409, conflict/product_inactive)` |

Each run: 14 passed, 1 failed. Restore proof: file copied to `/tmp/claude/r4/orig.rs`; after every mutant sha256 `d3271b28…df5e82` (equal to the pre-mutation hash) and `cmp` silent.
