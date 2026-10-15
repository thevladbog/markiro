# Plan ЧЗ, Task 2 report: `GET /v1/office/shifts/{id}/boxes` and `…/pallets`

Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `3607b8c9e` (ЧЗ Task 1). Commit: **`e7d6a9198` feat(standalone): the office lists a shift's boxes and pallets with what is live on them** (one trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified with `git log -1 --format=%B`). `git status --short` is empty after the commit.

Status: **DONE_WITH_CONCERNS** (concerns at the end are notes; none blocks).

## What was done

Brief Steps 1-6 in order (tests first, RED, implementation, GREEN, mutants, gates, commit), plus the extra tests below. The production code is exactly the brief's: `BOXES_SQL`/`PALLETS_SQL`, `list_boxes`/`list_pallets`, `OfficeBox`/`OfficePallet`, the two routes, the Zod schemas and the two `HostApi` methods; no seam was needed (each list is one SELECT inside a deferred transaction that is rolled back, so there is no multi-read snapshot to pin).

Files (13): `host/src/routes/{mod.rs,office_boxes.rs}`, `host/src/server.rs`, `host/tests/office_boxes.rs`, `proto/{src/lib.rs,tests/fixtures.rs,fixtures/office-boxes.json,fixtures/office-pallets.json}`, `src/host/{api.ts,protocol.ts}`, `test/{api,protocol}.test.ts`, `test/support/office.tsx`.

### Anchor adaptations (all mechanical, by meaning)

`check_fragments.py` reported 4 non-matching existing-file fragments (the rest were `office_boxes.rs`, a new file); each is drift of surrounding lines after Task 1 and earlier streams, not of meaning:

1. `test/support/office.tsx`: the fake API now has `getDeviceShifts`/`createDeviceShift`/`enterShift` after `getShiftExportSource`, so the fragment's `...overrides` tail does not follow. The two new mocks go right after the `getShiftExportSource` mock.
2. `src/host/api.ts` imports: `shiftExportRowsSchema` etc. sit among them and `labelTemplateSummarySchema` is followed by `officeLineSchema`; I inserted `officeBoxSchema` before `officeLineSchema` and `officePalletSchema` after `officeOperatorSchema`, as the brief's replacement shows (the surrounding list differs: no `deviceRecordSchema, labelTemplateSchema` adjacency).
3. `src/host/api.ts` interface: the doc comment is now the three-line form with `getShiftExportSource` followed by device-shift methods; the two new methods go directly after `getShiftExportSource`. Implementation: `getShiftExportSource` is the last entry, the new two follow it.
4. `src/host/protocol.ts`: the brief's `});` + `export type ShiftExportRows` + `// --- Request bodies` no longer adjoin (shift-snapshot schemas follow); the two schemas go directly after `export type ShiftExportRows`.
5. `proto/tests/fixtures.rs` use list and the `assert!(rows.codes…)` tail and `lib.rs` `Taken { owner }` anchors matched; `cargo fmt` accepted the brief's wrapping.

## RED and GREEN

RED (before any implementation, `/tmp/claude/impl-chz-t2/` holds the files):

- `cargo test … -p markiro-proto --test fixtures`: compile error `unresolved imports markiro_proto::OfficeBox, OfficePallet` ("no `OfficePallet` in the root").
- `cargo test … -p markiro-host --test office_boxes`: `could not find office_boxes in routes` (2 errors), `could not compile markiro-host (test "office_boxes")`.
- `vitest run test/protocol.test.ts test/api.test.ts`: `Tests  6 failed | 305 passed (311)`: 2 `listShift*` api tests (`… is not a function`) and 4 `list fixture … (plan ЧЗ)` tests (`Cannot read properties of undefined (reading 'array')`). Matches the brief (6 failed, plan base 267 vs measured 305).

GREEN with the brief's tests only:

- `fixtures`: `49 passed` (plan 47; base measured after Task 1 is 48).
- `office_boxes`: `3 passed` (the brief's tests).
- `vitest protocol+api`: `311 passed (311)`; `typecheck` clean.

GREEN final (with my extra tests):

- `cargo test -p markiro-proto --test fixtures`: 49 passed.
- `cargo test -p markiro-host --test office_boxes`: **8 passed** (3 brief + 5 mine; runs in the sandbox).
- `vitest run test/protocol.test.ts test/api.test.ts --reporter=verbose`: **340 passed (340)**, stderr empty (0 bytes), no `act(...)` text. The delayed-`setImmediate` stand does not apply: these two files render no component and have no effect to race; I did not run it.
- One final `cargo test --workspace` (unsandboxed, `--offline --locked`): **rc 0, 52 suites, 834 passed, 0 failed** (Task 1 measured 51 suites / 825; +1 suite `office_boxes` with 8, +1 proto test = 834). Plan says "+1 suite with 3, proto +1"; measured numbers differ only by my 5 extra host tests.
- Whole package `pnpm … run test`: `Test Files 5 failed | 84 passed (89), Tests 16 failed | 2675 passed (2691)` at load average 134: every failure is a 5000 ms timeout in the heavy UI files the plan names (`shift-delete-close`, `shift-dialog`, `shifts-page`, `template-editor`, `templates-page`). Re-run alone: `shift-delete-close` 45, `shift-dialog` 48, `shifts-page` 34, `templates-page` 55 all green; `template-editor` failed 2 of 97 twice (same two timeouts, load 130) and passed 97 of 97 with `--testTimeout=30000` (the plan's documented check). None of these files touch this task (Task 1 saw the same on this machine). Total package: 89 files, 2691 tests (Task 1: 2656; +35 = 6 brief + 29 mine).

Gates: `cargo fmt --all -- --check` clean (it also left the files I wrote unchanged after one formatting pass); `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked`: 0 warnings; `typecheck` clean; `lint` clean; `git diff --check` clean; `grep -rnF '\u04'` on `src` and `test` finds only `src/host/pairing-code.ts:66`; `grep -F '\u0'` on the Rust, JSON files I wrote finds nothing.

PRETTIER GATE proven live: `pnpm --dir /tmp/claude/wt/chz exec prettier --ignore-path /tmp/claude/wt/chz/.prettierignore --check <7 repo-relative TS/TSX/JSON paths>` printed `Checking formatting…` and `All matched files use Prettier code style!`; a scratch misformatted `apps/standalone/test/zz_gate_probe.ts` (`export const x   =  1`) made the same command print `[warn] … Code style issues found` (removed afterwards; `git status` clean). Note for zsh: a `$FILES` variable is not word-split, which made the first attempt vacuous ("No files matching the pattern"); explicit paths are required.

## Tests beyond the brief (5 Rust, 29 Vitest rows)

Rust, in `host/tests/office_boxes.rs`:

1. `a_late_box_and_a_count_that_disagrees_can_be_told_from_the_lists` (plh-minors item 8): a box closed at 90 s on a pallet closed at 80 s, the pallet's station count (1) against the live boxes (2); the test derives from the two lists alone "boxes closed after their pallet" = box 2 and "pallets with `boxes != boxCountReported`" = pallet 1. Also a skipped pallet label (`printSkippedAt` with no `printVerifiedAt`) and a disassembled pallet that stays listed with `disassembledAt` (its box keeps the link: boxes 1, units 1, as in the cloud and Ч1).
2. `ties_in_the_opening_instant_are_listed_by_id`: boxes and pallets with equal opening instants arriving in descending id order, ids not in opening order: expected `[3, 1, 2]`.
3. `an_undone_code_is_no_unit_and_a_close_that_did_not_compare_says_so`: a code undone before the close (box and pallet units exclude it); a box closed claiming codes it did not hold: `digestMatches: false`, `itemCountReported` 2 against `units` 1; `printVerifiedAt` on a box; `printSkippedAt` stays null.
4. `each_list_uses_the_indexes_made_for_it`: the EXPLAIN plans pinned by index name and `SEARCH`: boxes `boxes_shift` + `box_items_live`; pallets `pallets_shift` + `boxes_pallet` + `box_items_live`; no `SCAN`.
5. `a_shift_of_thousands_of_boxes_comes_whole_in_order_and_still_by_the_indexes`: 1500 closed boxes (2 items each) on 300 pallets of a shift, and 700 boxes / 140 pallets of a colleague's, written straight into the tables: both lists complete and ordered (every box id and pallet id in order), every box `units` 2, every pallet `boxes` 5 / `units` 10 / `boxCountReported` 5, one box compared whole (exact JSON), the colleague's lists disjoint, plans re-pinned with that many rows. No N+1: each list is one SQL statement with indexed correlated sub-selects (the pinned plans prove it).

Vitest, in `test/protocol.test.ts` (`describe("the office's box and pallet lists (plan ЧЗ)")`): shapes the host writes that the fixtures do not show (open pallet: null `sscc`, `closedAt`, `boxCountReported`, `printVerifiedAt`; pallet taken apart; box taken apart with `digestMatches: false`) and refusal tables (11 box rows, 13 pallet rows: wrong types, missing or negative or fractional counts, `boxCountReported: 0`, bad instants, non-UUID device, missing keys), plus "no 32-bit cap on a pallet's units".

## Mutants (all restored byte-identically)

Method: `/tmp/claude/impl-chz-t2/mut.py` copies the file to `/tmp/claude/impl-chz-t2/orig/`, applies one one-line change, runs the target, restores from the copy, `cmp`, compares `sha256` to the pre-mutation hash and `touch`es the file; afterwards `verify.py` compares all 13 changed files with the pre-mutation baseline hashes: 0 changed (`verified, changed: 0` after every batch). Outputs: `host.out`, `host2.out` via the printed JSON, `ts.out`, `ts2.json.res`. "Brief-only" marks mutants the brief's three host tests alone would not have killed.

Host SQL and handlers (`host/src/routes/office_boxes.rs`, `server.rs`), target `--test office_boxes`; "main" = `the_lists_name_the_shifts_boxes_and_pallets_with_what_is_live_on_them`, "big" = the 1500-box test, "order" = `ties_in_the_opening_instant_are_listed_by_id`, "late" = the late-box test, "undo" = the undone-code test, "role" = `every_office_role_reads_the_lists_and_an_unknown_shift_is_not_found`, "idx" = `each_list_uses_the_indexes_made_for_it`/`both_lists_search_by_an_index`:

| Mutant                                                                                                                                | Killed by                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| B1 box units count displaced items (drop `displaced_at IS NULL`)                                                                      | idx, main, big                                                                                                      |
| B2 box units count removed items                                                                                                      | idx, main, undo, big                                                                                                |
| B3 boxes not filtered by shift (`shift_id <> '' OR ?`)                                                                                | idx, main, big                                                                                                      |
| B4 pallet boxes include disassembled boxes                                                                                            | main                                                                                                                |
| B5 pallet units count displaced items                                                                                                 | idx, main, big                                                                                                      |
| B6 pallets not filtered by shift                                                                                                      | idx, main, big                                                                                                      |
| B7 pallet units without `closed_at`/`disassembled_at` guard                                                                           | SURVIVES: equivalent (a disassembled box's items are all removed, and `boxes.pallet_id` is CHECKed to closed boxes) |
| B8 unknown shift answers `[]` (both handlers)                                                                                         | role                                                                                                                |
| B9 boxes `ORDER BY opened_at` only (brief-only)                                                                                       | order                                                                                                               |
| B10 boxes `ORDER BY id` (brief-only)                                                                                                  | order                                                                                                               |
| B11 boxes `opened_at DESC, id`                                                                                                        | order, undo, main, big                                                                                              |
| B12 boxes `opened_at, id DESC` (brief-only)                                                                                           | order                                                                                                               |
| B13 pallets `ORDER BY opened_at` only (brief-only)                                                                                    | order                                                                                                               |
| B14 pallets `ORDER BY id` (brief-only)                                                                                                | order                                                                                                               |
| B15 pallets `opened_at DESC, id`                                                                                                      | order, late, main, big                                                                                              |
| B16 pallets `opened_at, id DESC` (brief-only)                                                                                         | order                                                                                                               |
| B17 `digest_matches` constant 1 (brief-only)                                                                                          | undo, main                                                                                                          |
| B18 box `print_verified_at`/`print_skipped_at` swapped (aliases; a plain column reorder is equivalent because `FromRow` maps by name) | undo, main                                                                                                          |
| B19 pallet `box_count_reported` NULL                                                                                                  | late, order, undo, main, big                                                                                        |
| B20 pallet label marks swapped (aliases)                                                                                              | late, main                                                                                                          |
| B21 hide disassembled pallets (brief-only)                                                                                            | late                                                                                                                |
| B22 hide disassembled boxes                                                                                                           | main                                                                                                                |
| B23 pallet boxes without the `closed_at` guard                                                                                        | SURVIVES: equivalent (`boxes.pallet_id` CHECK requires `closed_at`)                                                 |
| B24 pallet `boxes` = station's reported count instead of live (brief-only; the "never `box_count_reported`" rule)                     | late, main                                                                                                          |
| B25 pallet units count removed items                                                                                                  | idx, undo, big (main cannot: a disassembled box's items are removed)                                                |
| B26 pallet `disassembled_at` NULL                                                                                                     | order, late, undo, main, big                                                                                        |
| B27 box `disassembled_at` NULL                                                                                                        | undo, order, late, main, big                                                                                        |
| B28 box `sscc` NULL                                                                                                                   | order, undo, late, main, big                                                                                        |
| B29 pallet `sscc` NULL                                                                                                                | late, order, undo, main, big                                                                                        |
| B30 box `pallet_id` NULL (in SQL)                                                                                                     | late, undo, order, main, big                                                                                        |
| B31 box `device_id` ← `shift_id`                                                                                                      | undo, order, late, main, big                                                                                        |
| B32 pallet `device_id` ← `shift_id`                                                                                                   | late, order, undo, main, big                                                                                        |
| H1 `list_boxes` without `OfficeContext` (no session needed)                                                                           | role                                                                                                                |
| H2 `list_pallets` without `OfficeContext`                                                                                             | role                                                                                                                |
| H3 `list_pallets` without `require_shift`                                                                                             | role                                                                                                                |
| H4 `list_boxes` without `require_shift`                                                                                               | role                                                                                                                |
| H5 pallet `boxes` mapped from `units`                                                                                                 | big (main and others have boxes == units)                                                                           |
| H6 pallet `units` mapped from `boxes`                                                                                                 | big                                                                                                                 |
| H7 box `units` and `itemCountReported` exchanged                                                                                      | undo, main                                                                                                          |
| H8 box `palletId` mapped to None                                                                                                      | late, main, big                                                                                                     |
| H9 box `digestMatches` mapped to `Some(true)`                                                                                         | undo, main                                                                                                          |
| R1 `/boxes` routed to `list_pallets`                                                                                                  | 5 tests incl. main, big                                                                                             |
| R2 `/pallets` routed to `list_boxes`                                                                                                  | 5 tests incl. main, big                                                                                             |
| E1 `commit()` instead of `rollback()` on the boxes read                                                                               | SURVIVES: equivalent (nothing was written)                                                                          |

Wire and fixtures (target `--test fixtures`, all killed by `office_box_and_pallet_lists_round_trip_and_agree_with_the_export_source`): P1 `OfficeBox` loses `rename_all`; P2 `OfficePallet` loses it; P3 one pallet field renamed on the wire; F1 box fixture `units` 2→3; F2 pallet fixture `units` 2→3; F3 pallet fixture `boxes` 1→2; F4 box fixture id changed.

Zod and client (target Vitest `protocol`+`api`): for each field of `officeBoxSchema` and `officePalletSchema`: `.nullable()` removed, `.int()` removed, `.nonnegative()` removed, `.positive()` removed, `z.uuid()`→`z.string()`, `z.iso.datetime()`→`z.string()`, and field dropped: 74 mutants. The brief's tests alone left these alive and I added tests for each: box `itemCountReported` `.int()` and `.nonnegative()`, box `printSkippedAt` datetime, pallet `units` `.int()`, pallet `boxCountReported` `.int()`, pallet `printVerifiedAt` datetime, and the nullability of the pallet's `sscc`, `closedAt`, `boxCountReported`, `printVerifiedAt` (the fixture pallet has them all non-null). After the new tests every Zod mutant fails at least one test. (Two "field dropped" mutants for the last field of each schema first built as no-ops by my script; re-run correctly as `…dropped(fixed)`: both killed.) Client: A1/A2 wrong path, A3/A4 wrong schema, A5/A6 `z.array` dropped, A7/A8 `officeToken: undefined`: all killed by the `listShiftBoxes`/`listShiftPallets sends the office token to the right route` api tests.

Three survivors, all equivalent, named above: B7, B23 (the `closed_at IS NOT NULL` part of the pallet boxes/units subqueries; guaranteed by the schema CHECK `pallet_id IS NULL OR closed_at IS NOT NULL`, so no row can show the difference) and E1 (commit vs rollback of a read-only transaction). One sub-guard of the fixtures test is not killable by the shared fixtures: `b.disassembled_at.is_none()` in the pallet agreement (the fixtures contain no disassembled box and must keep Task 1's ids); the host tests cover the same rule (B4).

## Self-review

Data integrity: counts come from live rows only; `boxes`/`units` of a pallet are its closed non-disassembled boxes and their live items (as the cloud's pallet card), and the station's reported count rides next to them (`boxCountReported`, `itemCountReported`, `digestMatches`) without ever feeding a count (B24 pins it). Disassembled boxes and pallets are listed with `disassembledAt`. A box closed after its pallet is visible from `closedAt` vs the pallet's `closedAt`, and `boxes` vs `boxCountReported` shows the mismatch (plh-minors 8). Tenant isolation: single-site product, so the cross-shift denial is what is tested (colleague shift's boxes/pallets never appear; B3/B6). Auth: any office role; the device key alone is 401, unknown token 401 (Task 1 already covers the token side for the source route; here the device-key case for both lists), unknown shift `not_found`. Order: `opened_at, id`, deterministic, pinned with ties.

## Concerns / notes

1. **No paging**: both lists return the whole shift, as the brief and the O-Ф contract say (`OfficeBox[]`, `OfficePallet[]`). Measured here with 1500 boxes / 300 pallets; one SQL statement each, indexed. A shift of tens of thousands of boxes becomes a large single body (about 330 bytes a box); if O-Ф wants paging it needs a contract change.
2. **Disassembled pallet counts**: a disassembled pallet is listed with its boxes and units still counted (the link and the boxes stay on the host, Ч1 and the migration comment "link stays when the pallet is taken apart"). O-Ф should show `disassembledAt` rather than the counts for such a pallet; the test pins the current behaviour.
3. **Opening-instant text order**: `ORDER BY opened_at` compares text; it is chronological only because the host stores device instants in one fixed millisecond form (Task 1 relies on the same). Not re-proved here.
4. **`ANALYZE`**: as in Task 1, the pinned plans are what the host has without statistics; the host never runs `ANALYZE`/`PRAGMA optimize`.
5. **Load**: the 134 average made the full Vitest package fail 16 tests by the 5 s limit (`template-editor` still 2 of 97 on its own); they pass with a longer limit. The brief's own expected counts are base dependent (proto 47, `office_boxes` 3, Vitest 273); measured are 49, 8 (3 + 5) and 340 for the two touched Vitest files.
6. `git add -N` was used on new files before the mutant campaign only to keep them in `git ls-files -m` for hashing; the commit added explicit paths.
