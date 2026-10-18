# plan ПЛ-Х, Task 2 report — migration 0012 and the shift with pallets in the office

Status: DONE_WITH_CONCERNS (concerns are numbers/environment only, see the end).
Worktree `/tmp/claude/wt/plh`, branch `claude/plh-pallets`, base `e93cc55c6` (Task 1). One commit: `cb559e828`
`feat(standalone): a shift with pallets names its pallet template and capacity, planned and edited in the office`
(one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer; `git status --short` empty after it).

## What was done

All 54 fragments of the brief (Steps 1, 3, 5) were applied by a script in the brief's order (tests first, RED run, then implementation).
53 matched exactly once on the first try. Migration `0012_pallets.sql` and `shift-create-pallets.json` were created as the brief shows.

### Anchor adaptations (1)

- Step 3 item 32 (`apps/standalone/src/host/protocol.ts`, the doc comment of `officeShiftSchema`): the file wraps the comment differently
  (the tree has `* (plan 2a2), read as text so a code a newer host adds does not fail the list;` / `* \`closeReasonText\` is the office's words.`).
Applied by meaning: the same sentence appended — ` The pallet capacity and template are set exactly when \`palletsEnabled\` (plan ПЛ-Х).` Comment only, no code difference.
- Migration number: `0012` kept (host has 0001–0010; 0011 is the backups plan, not merged). `sqlx` applies it after 0010.
- 2a2/2a3 drift: none semantic. `ShiftProduct`, `check_mode`, the `OfficeShift` row, `shift_product`, `update_shift` and `delete_template` were exactly as the brief expects.

## RED / GREEN

RED (before the implementation, tests and fixtures only):

- `cargo test -p markiro-host --test office_shifts`: `18 passed; 12 failed` (the plan's number; the 12 are the 7 new tests plus 5 old ones that compare whole records or expect `palletTemplateId` errors).
- `cargo test -p markiro-proto`: 6 compile errors `no field pallet_box_capacity / pallet_template_id on type OfficeShift / ShiftCreate`.
- `vitest run test/protocol.test.ts`: `Tests 4 failed | 209 passed (213)` — the 4 tests the plan names.

GREEN (final tree):

| Run                                                      | Result                                 | Plan says                                       | Note                                                                                              |
| -------------------------------------------------------- | -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `--test office_shifts`                                   | 34 passed                              | 30                                              | +4 tests of mine (below)                                                                          |
| `--test device_shifts`                                   | 17                                     | 17                                              | +1 assertion block in an existing test                                                            |
| `--test templates`                                       | 27                                     | 27                                              |                                                                                                   |
| `--test sscc_blocks`                                     | 13                                     | 13                                              |                                                                                                   |
| `--test facts`                                           | 57                                     | 36                                              | the tree carries 2a2's later facts tests (56 before my one) ; +1 mine                             |
| `-p markiro-proto`                                       | 5 and 43                               | 5 and 43                                        |                                                                                                   |
| `vitest test/protocol.test.ts`                           | 213 passed                             | 211                                             | the +2 is Task 1's tests, already on the base                                                     |
| `cargo test --workspace` (unsandboxed, once, at the end) | 49 suites, 761 tests, all ok, 0 failed | 47 suites / 616 (plan measured on another base) |                                                                                                   |
| `vitest run` (whole package)                             | 2274 passed, 5 failed (2279)           | 2123 (other base)                               | the 5 are 5 s timeouts in `shifts-page` (2) and `template-editor` (3) under load ~130 — see below |

Heavy UI suites (not touched by this task): `shifts-page.test.tsx` alone: 34/34 pass. `template-editor.test.tsx` alone at the default 5 s: 5 different tests time out
(different set each run, 5.0–6.5 s); with `--testTimeout=60000` on the command line: 97/97 pass. Nothing in the repo's timeouts or assertions was touched.

Other gates: `cargo fmt --check` 0; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings; `pnpm typecheck` 0; `pnpm lint` 0;
`prettier --check` on the changed TS/JSON/MD clean; `git diff --check` clean; `grep -rnF '\u04' src test` only `src/host/pairing-code.ts:66`; no `\u0` in the Rust/SQL/JSON I wrote.
`vitest --reporter=verbose` on `test/protocol.test.ts`: stderr 0 bytes. The delayed-`setImmediate` stand is not applicable: `protocol.test.ts` is pure Zod parsing, no React and no passive effects.

## Tests beyond the brief (added because mutants survived or no test existed)

In `host/tests/office_shifts.rs` (30 -> 34):

1. `a_shift_without_pallets_records_no_pallet_field_anywhere` — the requirement "nothing records a pallet field for a shift with pallets disabled": columns `(0, NULL, NULL)` in the table for plain and explicit `palletsEnabled:false` shifts,
   exact create audit rows of all three shifts (plain, explicit-false, with pallets: the same four details), exact update audit row of a `plannedQty`-only edit, `palletsEnabled:false` repeated on a plain shift writes no revision and no audit row,
   pallets turned off clear both columns.
2. `pallets_turned_on_take_the_capacity_the_edit_names_and_a_closed_shift_keeps_them` — turning on with a named capacity keeps it (25, not the product's 40) with the exact three-field audit row; capacity without template is `validation_failed` on `palletTemplateId`
   and writes nothing; 10 000 is taken on edit; a closed shift refuses capacity/enabled/template edits with `shift_status closed`.
3. `a_pallet_template_scoped_to_the_products_group_fits_it` — mirror of the box test: templates scoped `[8]` and `[8,15]` are accepted at plan and on switching pallets on (this killed the one real survivor, X1).
4. `the_pallet_tables_refuse_the_rows_no_fact_may_leave` — every CHECK, UNIQUE index, FK and NOT NULL of `pallets`, `pallet_exceptions` and `boxes.pallet_id`, each refusal breaking exactly one rule and paired with a control; includes "three open pallets of one station and shift are taken" (the station's rule is not a constraint), the per-device uniqueness of `(device_id, record_id)` (second paired device may reuse a record id), UPDATE paths (reopen a pallet, disassemble an open one, link an open box), and the seven indexes by name plus the partial predicate of `shifts_planned_pallet_template`.

In `host/tests/facts.rs` (+1): `migration_0012_applies_to_a_host_that_already_holds_shifts_and_boxes` — back-compat. Builds a host with a planned shift, an open shift, scans, one closed and one open box; `VACUUM INTO` a snapshot; builds an empty database from the migration files `< 0012` through a runtime `Migrator` (proves the start point has no 0012 objects); copies every table row by row (`INSERT OR REPLACE`, the migrations' own seed rows are identical);
runs the real `db::MIGRATOR` over it; asserts all row counts, a digest of every shift (pallet columns included) and box, `_sqlx_migrations` complete, `boxes.pallet_id`/`pallets`/`pallet_exceptions` empty, `PRAGMA foreign_key_check` empty, `integrity_check` ok,
and that the new rules govern the old rows (a closed legacy box joins a pallet, the open one is refused by the CHECK, a planned legacy shift cannot switch `pallets_enabled` on bare — trigger).
In `host/tests/device_shifts.rs` (+0 tests): the existing `a_station_create_takes_every_field_it_names` also asserts the station-made shift has no pallet field in the record and the row.

Migrations 0001–0010 verified byte-identical to `e93cc55c6` (sha256 of each file from `git show` equals the working file; `git diff --name-only e93cc55c6 -- apps/standalone/host/migrations` lists nothing, `0012` is the only new file).

## Mutant table

Harness: `/tmp/claude/impl-plh-t2/mutants.py` (applies one exact-once replacement, runs the covering test, restores from a copy under `/tmp/claude/impl-plh-t2/orig/`, compares sha256 before/after; refuses to start if the working file differs from the saved copy). Logs: `/tmp/claude/impl-plh-t2/mut/<id>.log`, results `/tmp/claude/impl-plh-t2/mutation-results.txt`.
Every row restored byte-identically (`restored=True`, the sha256 equals the pre-mutation one); the six mutated source files were also `cmp`-ed to the copies at the end. Total 96 distinct mutants, 95 killed, 1 expected survivor (X19, a harness control); X1 survived once and was killed after the test it exposed (final verdicts counted).

Brief mutants M1–M13: all killed with the tests the brief names (M1: the three named plus my test 2; M7 additionally by my test 1).

| Mutant                                        | Killed by                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| M1 drop `.or(current.pallet_template_id)`     | `a_planned_shift_turns_pallets_on…`, `an_active_shift_keeps_its_pallets`, `an_edit_keeps_unsent_pallet_fields…` |
| M2 template re-checked always (`if true`)     | `an_edit_keeps_unsent_pallet_fields_and_checks_what_it_changes`                                                 |
| M3 drop `get_or_insert(product capacity)`     | `a_planned_shift_turns_pallets_on_changes_them_and_turns_them_off`                                              |
| M4 drop template clause of `fixed_changed`    | `an_active_shift_keeps_its_pallets`                                                                             |
| M5 capacity without pallets accepted          | `a_plan_with_pallets_needs…`, `an_edit_keeps_unsent_pallet_fields…`                                             |
| M6 named capacity not stored                  | `a_shift_with_pallets_takes_its_template_and_the_products_capacity`                                             |
| M7 pallet template checked as `Box`           | 6 tests incl. `a_pallet_template_a_planned_shift_names_is_not_deleted`                                          |
| M8 delete guard blind to pallet template      | `a_pallet_template_a_planned_shift_names_is_not_deleted`                                                        |
| M9 `pallets_enabled` not written              | 6 tests                                                                                                         |
| M10 update trigger drops template clause      | `the_schema_keeps_a_shifts_pallet_fields_together`                                                              |
| M11 template missing from update audit        | `a_planned_shift_turns_pallets_on…`, my test 2                                                                  |
| M12 capacity validated after the shift lookup | `an_edit_keeps_unsent_pallet_fields…`                                                                           |
| M13 (Zod) office capacity `z.number()`        | `shift shapes > refuse an unknown status, …`                                                                    |

Mutants beyond the brief (all killed unless marked):

| Mutant                                                                                                                                                                   | Killed by                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1 `check_pallet_template` passes `None` instead of the group                                                                                                            | SURVIVED at first (a `[15]` template is also refused for the organisation slot, so the brief's cases cannot tell); killed after my test 3 `a_pallet_template_scoped_to_the_products_group_fits_it`                   |
| X2 `(false, None, Some)` accepted (template without pallets)                                                                                                             | `a_plan_with_pallets_needs…`, `an_edit_keeps_unsent_pallet_fields…`                                                                                                                                                  |
| X3 `(true, _, None)` accepted (pallets without template)                                                                                                                 | 5 tests                                                                                                                                                                                                              |
| X4 drop the capacity `count` check in `pallet_request`                                                                                                                   | `a_plan_with_pallets_needs…`                                                                                                                                                                                         |
| X5 `unwrap_or(false)` for the unsent `palletsEnabled`                                                                                                                    | 4 tests                                                                                                                                                                                                              |
| X6 drop `.or(current.pallet_box_capacity)`                                                                                                                               | `a_planned_shift_turns_pallets_on…`                                                                                                                                                                                  |
| X7 `get_or_insert` -> overwrite with the product's                                                                                                                       | `a_planned_shift_turns_pallets_on…`, my test 2                                                                                                                                                                       |
| X8 drop capacity clause of `fixed_changed`                                                                                                                               | `an_active_shift_keeps_its_pallets`                                                                                                                                                                                  |
| X9 / X10 palletsEnabled / palletBoxCapacity missing from update audit                                                                                                    | `a_planned_shift_turns_pallets_on…`, my test 2 (X10 also `an_edit_keeps…`)                                                                                                                                           |
| X11 `pallets_enabled` bound `false` in the UPDATE                                                                                                                        | 4 tests                                                                                                                                                                                                              |
| X12 delete guard without parentheses around the OR                                                                                                                       | `a_template_that_a_planned_shift_names_is_not_deleted` (the box test)                                                                                                                                                |
| X13 insert stores the box capacity as the pallet capacity                                                                                                                | 3 tests                                                                                                                                                                                                              |
| X14 `pallets()` skips the template check                                                                                                                                 | `a_plan_with_pallets_needs…`                                                                                                                                                                                         |
| X15 office plan ignores its pallet request                                                                                                                               | 5+ tests                                                                                                                                                                                                             |
| X16 / X17 read-back maps template / capacity to `None`                                                                                                                   | 4+ tests each                                                                                                                                                                                                        |
| X18 turned-off edit ignores the fields it sends                                                                                                                          | `an_edit_keeps_unsent_pallet_fields…`                                                                                                                                                                                |
| X19 harness control (an equivalent no-op)                                                                                                                                | SURVIVED as it must — shows the harness reports survivors honestly                                                                                                                                                   |
| X20 default capacity = the product's box capacity                                                                                                                        | 3 tests                                                                                                                                                                                                              |
| X21 edit checks the template against the wrong group                                                                                                                     | `a_pallet_template_scoped_to_the_products_group_fits_it`                                                                                                                                                             |
| X22 `shift_product` swaps the two capacity columns                                                                                                                       | 6+ tests                                                                                                                                                                                                             |
| Z1–Z3 insert trigger without capacity clause / without template clause; update trigger without the capacity clause                                                       | `the_schema_keeps_a_shifts_pallet_fields_together`                                                                                                                                                                   |
| Z4–Z6 update trigger `OF` list without the template / capacity / enabled column                                                                                          | same                                                                                                                                                                                                                 |
| Z7–Z10 drop each of the four `closed_at IS NULL = …` CHECKs                                                                                                              | `the_pallet_tables_refuse_the_rows_no_fact_may_leave`                                                                                                                                                                |
| Z11–Z14 drop `box_count > 0`, `disassembled needs closed`, `length = 18`; GLOB `1*` -> `[0-9]*`                                                                          | same                                                                                                                                                                                                                 |
| Z15 / Z16 drop `pallets_sscc` / `pallets_block_serial` unique indexes                                                                                                    | same                                                                                                                                                                                                                 |
| Z17–Z20 drop the shift / device / block REFERENCES, `opened_at NOT NULL`                                                                                                 | same                                                                                                                                                                                                                 |
| Z21–Z27 exceptions: kind list widened, `kind NOT NULL`, reason CHECK, `reason_code NOT NULL`, pallet FK, unique index on record only, unique index dropped               | same                                                                                                                                                                                                                 |
| Z28 / Z29 `boxes.pallet_id` CHECK dropped / REFERENCES dropped                                                                                                           | same                                                                                                                                                                                                                 |
| Z30–Z34 drop `pallets_shift`, `boxes_pallet`, `pallet_exceptions_pallet`, `shifts_planned_pallet_template`, its `WHERE`                                                  | same                                                                                                                                                                                                                 |
| Z35 add a "one open pallet per station and shift" unique index                                                                                                           | same (the three open-pallet controls)                                                                                                                                                                                |
| Z36 migration backfills `boxes.pallet_id`                                                                                                                                | `migration_0012_applies_to_a_host_that_already_holds_shifts_and_boxes`                                                                                                                                               |
| Z37 migration deletes `scans`                                                                                                                                            | same                                                                                                                                                                                                                 |
| Z38 migration switches a planned shift's pallets on bare                                                                                                                 | same                                                                                                                                                                                                                 |
| P1 / P2 `ShiftUpdate` capacity / template lose `skip_serializing_if`                                                                                                     | `a_shift_update_carries_only_what_changes_and_never_the_product`                                                                                                                                                     |
| P3 / P4 `ShiftCreate` capacity / template lose `skip_serializing_if`                                                                                                     | `office_shift_fixtures_round_trip_and_a_plan_carries_no_number_or_status`                                                                                                                                            |
| P5 `OfficeShift.pallet_template_id` skips when `None`                                                                                                                    | same                                                                                                                                                                                                                 |
| V1 office template `z.string()`                                                                                                                                          | `shift shapes > refuse an unknown status…`                                                                                                                                                                           |
| V2 / V4 office capacity / template not nullable                                                                                                                          | fixture `office-shift.json` parse tests                                                                                                                                                                              |
| V3 office capacity without `.positive()`                                                                                                                                 | `shift shapes > refuse an unknown status…`                                                                                                                                                                           |
| VC1–VC7, VU1–VU7 create / update schema: no `.positive()`, no `.int()`, `z.string()` template, field required, `nullable` accepted, template required, template nullable | `shift shapes > refuse a shift to plan, to move or to close with a field of another form…` (VC4, VC6, VU4, VU6 — the "required" ones — also the `shift-create.json` / `shift-update.json` fixture and builder tests) |

Equivalent mutants noted, not run: dropping `|| pallets_enabled != current.pallets_enabled` from `fixed_changed` (turning pallets on/off always also changes the capacity or the template, so the clause is redundant);
`#[serde(default)]` on an `Option` field of a derived struct (serde already defaults a missing `Option`).

## Decisions and judgement calls

- Migration 0012 is the brief's text verbatim. `pallets.sscc` carries the shape CHECK (18 chars, `GLOB '1*'`) that `boxes` does not; the schema test pins it.
- The planner does not choose `shifts_planned_pallet_template` for the deletion query on a tiny table (an `EXPLAIN QUERY PLAN` assertion picked `shifts_status_production_date`), so the schema test pins the index by name and its partial predicate instead of the plan.
- `OfficeShift` Zod does not enforce "capacity and template exactly when `palletsEnabled`" (the brief only types the fields; the host and the triggers guarantee the pairing). A refinement would be a one-liner; left to the owner.
- Devices cannot send pallet fields yet (`DeviceShiftCreate` is a separate strict type); Task 3 owns that, so no test pins "device create with `palletsEnabled` is refused" (it would have to be rewritten in Task 3).

## Files

Changed (all in `apps/standalone`): `host/migrations/0012_pallets.sql` (new), `host/src/shifts.rs`, `host/src/routes/{office_shifts,device_shifts,templates}.rs`, `host/tests/{office_shifts,facts,device_shifts}.rs`, `host/tests/support/app.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `proto/fixtures/{office-shift,shift-create-pallets}.json` (second new), `src/host/protocol.ts`, `test/protocol.test.ts`, `test/support/shifts.ts`, `AGENTS.md`.

## Not exercised

Browser, Windows, hardware, printer, 1C, mail, object storage: none of this task touches them. Production deploy not touched. The station (`src-tauri`) is unaffected (workspace tests green).

## Concerns

1. Counts differ from the plan only because the base differs: facts 57 (plan 36: 2a2's later tests on the tree), protocol.test.ts 213 (plan 211: Task 1), whole-package Vitest 2279 and whole workspace 49 suites / 761 tests. Increments are as the plan says plus my +4/+1 tests in `office_shifts`/`facts`.
2. Whole-package `vitest run` under load ~130 shows 5 timeouts at 5 s in `shifts-page` and `template-editor` (both untouched; pass alone / with a longer CLI timeout). Reported, not hidden.
3. Task 1 minor m1 (18-digit check before `names_serial` for pallet SSCC) belongs to Task 4, not this task.
