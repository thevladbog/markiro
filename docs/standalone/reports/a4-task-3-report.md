# А4 Task 3 report — host: A4 sheets (list, stock sheets, rename, state, delete, default)

Status: DONE_WITH_CONCERNS. Branch `claude/prt`, base 32090b9d8. Commit 36a9d6994 `feat(standalone): A4 pallet sheets on the host — the list, stock sheets, rename, state, delete and the default (plan А4, task 3)`.

## What was done

- Routes (`host/src/routes/pallet_sheets.rs`, mounted in `server.rs`): `GET/POST /v1/office/pallet-sheets`, `PUT/DELETE /v1/office/pallet-sheets/{id}`, `PUT /v1/office/pallet-sheet-default`. Helpers `default_sheet(conn)` and `check_sheet(conn, field, id)` public for task 4. SQL consts `BY_PRESET_SQL`, `PLANNED_SHIFTS_SQL`, `DEFAULT_SHEET_SQL` are `pub` so the plans are pinned by a test.
- `validate::sheet_spec` / `preset_key` (+ `MAX_SHEET_SPEC_BYTES`); proto types `PalletSheet*`, 5 fixtures, parity test; Zod schemas, 5 `HostApi` methods, `officeKeys.palletSheets`, fake `HostApi` members.
- Brief rules kept: no revision/feed entry for sheets (stations never receive them; `host_revision` pinned unchanged by every operation); create with a known `presetKey` answers the existing sheet with no write and no audit; update bumps the sheet's own `revision` once, only on a real change (no-op is quiet, no audit); `stale_revision` both older and ahead; disabling the default and deleting the default -> `conflict template_is_default`; delete of a sheet a PLANNED shift names -> `conflict template_in_use`; default only an enabled sheet (`validation_failed` on `templateId`, 400); every write route does `require_catalog()` early and `require_catalog_in(tx)` inside the write transaction; audit rows carry ids/names only (`pallet_sheet.create|update|delete|default`).

## Differences from the brief (additions, all strengthening)

1. `PalletSheetDefaultUpdate.templateId` is REQUIRED (nullable, not optional): plain serde reads a missing `Option` as `None`, so `{}` would have silently cleared the organization's default. Fixed with `deserialize_with = "present"` in proto; Zod already required it. Pinned in proto parity test, host test and Zod test.
2. `template_in_use` details carry `shiftIds` (sorted) next to `constraint`, like the template route.
3. Default audit uses `audit::update_details` (`changed` + `{from,to}`), as the brief's note asked.
4. Tests assert 400 `validation_failed` (this tree), not 422.

## Anchor adaptations

- Brief's 422 -> 400 (validation errors here are `400 validation_failed`, `details.field`).
- Brief's test for `template_in_use` was deferred to task 4; it is done here with raw SQL (`UPDATE shifts SET pallet_sheet_template_id`, planned shift planned through the office API) because the dispatch asked for every referencing table: planned (blocks, 5 shifts, sorted ids), active and closed (do not block, row left unrewritten), `org_profile.default_*` (blocks).
- Stray rustfmt reflows only.

## RED / GREEN

- RED: routes unmounted (server.rs lines removed), `cargo test -p markiro-host --test pallet_sheets`: 13 failed, 2 passed (`/tmp/claude/impl-a4-t3/red.txt`). One of the two passes was `a_sheet_that_does_not_exist_is_not_found_to_delete` passing on the router's own 404; strengthened to assert the message `no such sheet`.
- GREEN: `pallet_sheets` 15/15; `validate` unit 42; proto 5+6 (fixtures incl. new parity test); `vitest protocol+api` 461 passed, stderr 0 bytes.
- Full: `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed: 1191 passed, 0 failed, 0 ignored, 0 warnings (baseline task 2: 1173 + 18 new). `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings, typecheck/lint/build 0, prettier gate live (scratch file made it exit 1, deleted) clean on all changed TS/JSON, `git diff --check` clean, `\u04` grep only `pairing-code.ts:66`, tree clean after commit.
- Full vitest: 154 files / 4791 tests (task 2: 4771, +20). Under load 170 (cargo running concurrently, then still ~170) 11 old office/shift/template suites timed out (5 s timeouts, "overlapping act()" noise, none touched by this task); re-run alone with `--testTimeout=60000 --hookTimeout=60000`: 11 files / 514 tests passed, stderr empty. The same suites are the known heavy ones from the dispatch rule.
- No React test added, so the delayed-`setImmediate` stand is not applicable.
- `no_secrets_in_logs` source-walk: the new route file is outside the facts path and has no `tracing::`/print calls; count 17 unchanged (green in the full run).

## Mutants (scripted: `/tmp/claude/impl-a4-t3/mutate.py`, originals in `/tmp/claude/impl-a4-t3/orig/`; each restored from the copy, `os.utime` touched; sha256 of all 6 mutated files identical before/after, `cmp` same) — 60 mutants, 60 killed (2 re-run after test strengthening)

| #           | Mutant (one line)                                                                                                                                                               | Killed by                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| M01-M04     | in-tx `require_catalog_in` dropped in create / update / delete / default                                                                                                        | `a_user_turned_off_after_the_extractor_passed_writes_nothing`                           |
| M05         | preset replay lookup skipped                                                                                                                                                    | `a_stock_sheet_added_twice_is_one_sheet`                                                |
| M06/M07/M08 | name / preset key / spec validation dropped on create                                                                                                                           | `a_sheet_is_checked_before_it_is_kept`                                                  |
| M09         | `enabled` ignored on create                                                                                                                                                     | `a_disabled_sheet_is_not_the_default...`                                                |
| M10/M11/M12 | stale check `<`, `>`, dropped                                                                                                                                                   | `a_rename_and_a_switch_raise_the_revision...` (older and ahead)                         |
| M13         | update may switch the default off                                                                                                                                               | `the_default_sheet_is_neither_switched_off_nor_deleted`                                 |
| M14         | update refuses any change of the default                                                                                                                                        | `a_technologist_keeps_the_sheets_too` (rename of the default)                           |
| M15         | no-op update still writes/audits                                                                                                                                                | `an_update_that_changes_nothing_is_quiet`                                               |
| M16         | revision + 2                                                                                                                                                                    | `a_stock_sheet_added_twice...` (renamed sheet revision 2)                               |
| M17         | update name not trimmed/validated                                                                                                                                               | `a_bad_update_is_refused_and_changes_nothing`                                           |
| M18         | `enabled` ignored on update                                                                                                                                                     | `a_disabled_sheet_is_not_the_default...`                                                |
| M19         | delete of the default allowed                                                                                                                                                   | `the_default_sheet_is_neither_switched_off_nor_deleted`                                 |
| M20         | planned-shift check dropped                                                                                                                                                     | `a_sheet_a_planned_shift_names_is_not_deleted_but_an_opened_one_is`                     |
| M21         | delete audited as update                                                                                                                                                        | same (exact audit row)                                                                  |
| M23/M24     | default: `check_sheet` dropped / accepts disabled                                                                                                                               | `a_disabled_sheet_is_not_the_default_and_an_unknown_one_either`                         |
| M25         | unchanged default still written/audited                                                                                                                                         | `the_default_sheet_is_neither_switched_off...` (quiet re-set; re-run after anchor fix)  |
| M26         | `default_sheet` ignores `enabled`                                                                                                                                               | `the_default_and_the_check_see_only_an_enabled_sheet`                                   |
| M27         | list ordered by id                                                                                                                                                              | `the_list_is_by_name_with_the_default` (8 sheets, random ids)                           |
| M28         | list default not read                                                                                                                                                           | default test                                                                            |
| M29         | planned query without `status = 'planned'`                                                                                                                                      | planned/opened test                                                                     |
| M30         | planned ids unordered                                                                                                                                                           | SURVIVED with 2 shifts (50% luck); test strengthened to 5 planned shifts, re-run KILLED |
| M31         | create audit loses `presetKey`                                                                                                                                                  | stock test (exact row)                                                                  |
| M32/M33     | DELETE / default routes not mounted                                                                                                                                             | not-found test (message), disabled-default test                                         |
| M34-M37     | validate: version 2->1, kind unchecked, size `>=`, depth dropped                                                                                                                | `a_sheet_spec_is_a_v2_pallet_sheet_within_bounds` (exact 64 KiB, depth 64/65)           |
| M38-M41     | preset key: 65 chars, empty, upper case, underscore                                                                                                                             | `a_preset_key_is_one_to_sixty_four...`                                                  |
| M42         | proto: `templateId` may be absent                                                                                                                                               | `pallet_sheet_fixtures_round_trip`                                                      |
| M43/M45/M46 | proto: create / update / default not `deny_unknown_fields`                                                                                                                      | same                                                                                    |
| M44         | proto: create `enabled` default false                                                                                                                                           | same                                                                                    |
| M47-M54     | Zod: update not strict, create spec any value, default optional, list default not nullable, revision not positive, presetKey not nullable, name may be empty, create not strict | protocol.test (request fixtures + "the A4 pallet sheets"), api.test                     |
| M55-M60     | client: PUT->POST, delete path, default path, no office token, no body, lenient list parse                                                                                      | `api.test` CASES and answer-rejection test                                              |

Not mutated (reasoned): early `require_catalog()` alone (both roles in this tree are catalog roles, so it is equivalent to the in-tx check in outcome; the in-tx check is mutated); `officeKeys.palletSheets` (no consumer until task 5); the 2 MiB axum ceiling (not our code, pinned by a 3 MiB create body).

## Query plans

`EXPLAIN QUERY PLAN` pinned for `BY_PRESET_SQL` (unique autoindex), `PLANNED_SHIFTS_SQL` (`shifts_planned_pallet_sheet`) and `DEFAULT_SHEET_SQL` (primary-key lookups, no SCAN) in `the_sheet_statements_search_by_an_index`. Other statements are by primary key or list the (small) sheet table.

## Files

Created: `host/src/routes/pallet_sheets.rs`, `host/tests/pallet_sheets.rs`, 5 fixtures `proto/fixtures/pallet-sheet{s,-create,-update,-default-update}.json`. Modified: `host/src/{validate.rs,routes/mod.rs,server.rs}`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `src/host/{protocol.ts,api.ts}`, `src/office/office-query.ts`, `test/{protocol,api}.test.ts`, `test/support/office.tsx`.

## Concerns

1. **Name uniqueness**: the brief/migration have none (two sheets may share a name, as templates); the dispatch mentioned "rename uniqueness". Not added (would be a migration change; renaming cannot collide on a key). Decide if the office needs it.
2. **Disabling a sheet a planned shift names** is allowed (brief); task 4 (opening a shift) must handle a disabled/missing sheet at open time.
3. **Delete of a sheet used by an active/closed shift** is allowed by the brief (the snapshot owns it); `shifts.pallet_sheet_template_id` keeps the dangling id by design (no FK). Pinned by a test that the delete never rewrites a shift.
4. **Stock sheets are deletable and editable by name** per the brief (only default/in-use block); re-adding a deleted stock sheet creates it again with the same key.
5. Delete of an unknown id is `404 no such sheet` (no tombstones for sheets, unlike templates), so a repeated delete after a lost answer is a 404.
6. Host migrations 0013-0015 still absent here (task 2 note). Windows/browser/printer behaviour not exercised. `graphify update .` not run.
