# Plan О-Ф, Task 2 report: `GET /v1/office/shifts/{id}/pallet-report-data`

Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `d8a58a47c`. Commit: **`4cb02ad42` feat(standalone): the host reads a shift's pallets with every box that stood on them for the pallet forms** (one trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). `git status --short` is empty after the commit. Artefacts (RED/GREEN outputs, mutant logs `mut-host.txt`, `mut-other.txt`, per-mutant outputs in `orig/`, runner scripts) are in `/tmp/claude/impl-pof-t2/`.

Status: **DONE_WITH_CONCERNS** (concerns are notes; none blocks).

## What was done

Brief Steps 1-6 in order (tests, RED, implementation, GREEN, mutants, gates, commit). The brief's production code is applied as written, with one addition: the read-snapshot seam of Task 1 (`read_pallet_rows(pool, id, after_query)`, hook names `shift`, `organization`, `pallets`, `boxes`; the route passes `|_| async {}`). Beyond the brief: 4 host tests (7 incl. the unknown-shift/session test), 4 Vitest tests, one extra column in a null test.

### Anchor adaptations (all mechanical, by meaning)

1. `proto/tests/fixtures.rs`: the import list is longer than the brief's; `PalletReportRows` inserted after `PalletLabelFact`, `cargo fmt` rewrapped. The new test is inserted before the ПЛ-Х totals test (the brief's end anchor `"{item:?}"` sits in the box-report test, not at the file end).
2. `test/protocol.test.ts`: import and RESPONSES row placed beside `boxReportRowsSchema` / `box-report-rows.json` (the lists have extra entries between).
3. `test/support/office.tsx`: new mock directly after `getBoxReportRows` (later mocks precede `...overrides`).
4. `src/host/api.ts`: interface member placed directly after `getBoxReportRows` (the interface continues with `getDeviceShifts`...), factory member directly after `getBoxReportRows`'s; imports as in the brief.
5. `office_reports.rs` / `server.rs`: the brief's fragments for the module doc, imports and route matched mechanically; the new code is appended at the end of the file.
   No semantic difference; no NEEDS_CONTEXT.

### Data semantics checked against the cloud (`palletReportData` `code-search.service.ts:1274`, `palletPlacardData` `:1423`, `shiftPlacardsData` `:1370`)

- Membership: the cloud takes boxes by `boxes.pallet_id = palletId`, ordered `closed_at, id`, disassembled boxes included. The host query takes `boxes WHERE shift_id = ? AND pallet_id IS NOT NULL ORDER BY pallet_id, closed_at, id` and groups by pallet. A box and its pallet are always in the same shift on the host (`facts/pallets.rs::find` refuses another shift's pallet), so shift-scoping equals pallet-id scoping. Disassembled boxes and boxes on a disassembled pallet stay in the lists; the pallet row carries `disassembledAt`, so the office shows that and not the box counts (`chz-minors.md` item 1). Late box on a closed pallet (`plh-minors.md` item 8): the box stays in the list, last, with its own `closedAt` later than the pallet's (test pins it); the office flags it (Tasks 6-7).
- Units: the live items (`removed_at IS NULL AND displaced_at IS NULL`, the `box_items_live` partial index). The cloud counts the items present at disassembly for a disassembled box, but `pallet-report.ts` prints "—" for it and `pallet-placard.ts:70` skips it, neither sums it, so the bytes agree (a disassembled box has 0 here; pinned).
- Product: current (Ф5): name, GTIN, shelf life from `products` joined via the shift. Dates: the shift's `production_date`. The host has no warehouse pallets (no `products` coalesce needed).
- Pallets by `opened_at, id`; the order of the shift placards (`closed_at, id`, closed and not taken apart, with SSCC) is the office's (Task 4).
- One deferred read transaction, rolled back (as Task 1); four indexed queries.

## Evidence

RED (`/tmp/claude/impl-pof-t2/red-*.txt`): proto `error[E0432]: unresolved import markiro_proto::PalletReportRows`; host `error[E0425]` for `PALLET_SHIFT_SQL`, `PALLETS_SQL`, `PALLET_BOXES_SQL`; Vitest `protocol`+`api`: `Tests  3 failed | 380 passed (383)` (brief: 3 failed).

GREEN:

- proto fixtures: **52 passed** (brief 50; base is +1 vs the brief, as in Task 1 +2).
- host `office_reports`: brief's 3 new tests (11 total with Task 1's 8), final **15 passed** (+4 mine: ties/late box, four-read snapshot, 300 pallets x 5 boxes, unknown shift/session).
- Vitest `protocol`+`api` verbose: **387 passed (387)** (brief 288; base differs), stderr empty (0 bytes). The delayed-`setImmediate` stand does not apply: schema and API-client tests only, no component or effect.
- `typecheck` 0 errors; `lint` 0 problems (first run caught `no-loss-of-precision` on my wrong-kind SSCC literal, replaced by small numbers); `cargo fmt --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings; `git diff --check` clean; `grep -rnF '\u04'` only `pairing-code.ts:66`; no `\u0` escapes in new Rust/JSON besides the existing `\u{1d}`.
- PRETTIER GATE proven live (scratch `test/zz_gate_probe.ts` printed `[warn]`, rc 1, file removed); the 6 changed TS/TSX/JSON files: `Checking formatting... All matched files use Prettier code style!`.
- **Final `cargo test --workspace --no-fail-fast`** (unsandboxed, `--offline --locked`), tree identical to the commit: rc 0, **53 suites (`Running`), 886 tests passed, 0 failed**, 0 warnings (Task 1: 878; +8 = host +7, proto +1).
- **Full Vitest package**: `Test Files 3 failed | 95 passed (98)`, `Tests 13 failed | 3061 passed (3074)` at load average 84-105. All 13 are `Test timed out in 5000ms` in load-sensitive suites (`template-editor` 10, `shifts-page` 2, `export-dialog` 1). Alone: `export-dialog` 32/32; `template-editor` 97/97 with `--testTimeout=60000`; `shifts-page` failed 4 at the default 5 s alone and passed 34/34 with `--testTimeout=60000`. None of these files is touched by this task. Gate left at the default; a green full run at the default limit was not obtained (same as Task 1).

Measured: 300 pallets x 5 boxes (1500 boxes, 1500 live items) answered in the test under a 10 s bound (asserted loosely; real elapsed is tens of ms; the guard is the pinned plan).

## Mutants (all restored byte-identically)

Method: `/tmp/claude/impl-pof-t2/mut.py` copies the file, applies the one change, runs the target, copies back, `cmp` + sha256, `touch`. After the host campaign the sha256 of `office_reports.rs` and its test file equal `hashes-before.txt` (cmp: SAME). Test short names: **MAIN** `the_pallet_forms_read_every_pallet_with_every_box_that_stood_on_it` (brief), **TIES** `ties_come_by_id_and_a_box_closed_after_its_pallet_stays_in_its_list` ★, **SNAP** `the_four_reads_of_the_pallet_forms_are_one_snapshot_…` ★, **BIG** `a_shift_of_hundreds_of_pallets_comes_whole_in_order_and_still_by_the_indexes` ★, **IDX** `every_query_of_the_pallet_forms_searches_by_an_index`, **ROLE** `every_office_role_reads_the_pallet_forms_…`, **NOSHIFT** `an_id_of_no_shift_is_not_found_…` ★. ★ = added beyond the brief.

| #               | Mutant (one change in `host/src/routes/office_reports.rs` unless noted)                                | Killed by                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| P1              | boxes `ORDER BY b.pallet_id, b.id` (brief P1)                                                          | MAIN, BIG                                                                                       |
| P1b             | `ORDER BY b.pallet_id, b.closed_at` (no id tie-break)                                                  | TIES only                                                                                       |
| P1c             | `closed_at DESC, id`                                                                                   | MAIN, BIG, TIES                                                                                 |
| P2              | units without `displaced_at IS NULL` (brief P2)                                                        | MAIN, IDX, BIG                                                                                  |
| P2b             | units without `removed_at IS NULL`                                                                     | MAIN, IDX, SNAP, BIG                                                                            |
| P3              | pallets `opened_at DESC, id` (brief P3)                                                                | MAIN, BIG                                                                                       |
| P3b             | pallets `ORDER BY opened_at` (no id)                                                                   | TIES only                                                                                       |
| P3c             | pallets `ORDER BY id`                                                                                  | BIG only (opened order reverses id order there)                                                 |
| M2              | `WHERE (b.shift_id = ? OR b.shift_id IS NOT NULL) AND …` (reads every box of the host)                 | BIG (plan pin: not `boxes_shift`)                                                               |
| M3              | pallets `WHERE ? IS NOT NULL` (colleague's pallets)                                                    | MAIN, IDX, BIG                                                                                  |
| M4              | product name from `s.id`                                                                               | MAIN                                                                                            |
| H1              | drop `_context: OfficeContext` (no office auth)                                                        | ROLE, NOSHIFT                                                                                   |
| H2              | unknown shift 403 instead of 404                                                                       | ROLE, NOSHIFT                                                                                   |
| H3              | `pool.acquire()` instead of `begin()`+rollback                                                         | SNAP                                                                                            |
| H4, H5, H6, H6b | drop the hook after `shift` / `organization` / `pallets` / `boxes`                                     | SNAP (steps list asserted)                                                                      |
| H7              | organization `inn: None`                                                                               | MAIN                                                                                            |
| H8              | box `disassembled_at: None`                                                                            | MAIN                                                                                            |
| H9              | pallet `disassembled_at: None`                                                                         | MAIN, SNAP                                                                                      |
| H10             | `boxes: Vec::new()`                                                                                    | MAIN, BIG, SNAP, TIES                                                                           |
| H11             | shift number `number_seq + 1`                                                                          | MAIN, ROLE, BIG                                                                                 |
| H12             | `production_date` from product name                                                                    | MAIN                                                                                            |
| H13             | `shelf_life_days: None`                                                                                | MAIN                                                                                            |
| H14             | `gtin14: String::new()`                                                                                | MAIN                                                                                            |
| H15             | box `sscc: None`                                                                                       | MAIN                                                                                            |
| H16             | pallet `sscc: None`                                                                                    | MAIN                                                                                            |
| PR1/PR2/PR3     | proto `ReportShift` / `ReportPallet` / `ReportPalletBox` lose `camelCase`                              | proto `pallet_report_rows_round_trip_and_agree_with_the_lists`                                  |
| F1-F4           | fixture: box `units` 2->3 / pallet SSCC / product name differs from the export source / box `closedAt` | same proto test                                                                                 |
| Z1              | Zod `shift.id` any string                                                                              | wrong-kind test                                                                                 |
| Z2              | `shift.number` without `min(1)`                                                                        | wrong-kind test                                                                                 |
| Z3              | `productionDate` any string                                                                            | wrong-kind test                                                                                 |
| Z4 / Z4b        | `shelfLifeDays` not nullable / not positive                                                            | nulls test / wrong-kind test                                                                    |
| Z5, Z6, Z7      | pallet `sscc` / `closedAt` not nullable, `disassembledAt` not nullable                                 | nulls test (Z7 also fixture x2, api, wrong-kind)                                                |
| Z8              | box `closedAt` nullable                                                                                | wrong-kind test                                                                                 |
| Z9              | box `disassembledAt` not nullable                                                                      | 7 tests                                                                                         |
| Z10, Z11        | `units` without `nonnegative()` / without `int()`                                                      | wrong-kind test                                                                                 |
| Z12             | pallet `openedAt` any string                                                                           | wrong-kind test                                                                                 |
| Z13             | `organization.inn` not nullable                                                                        | nulls test                                                                                      |
| Z14             | `pallets` optional                                                                                     | missing-field test                                                                              |
| Z15             | box `sscc` not nullable                                                                                | nulls test (needed my added `{ ...box, sscc: null }` row: killed only after adding it)          |
| A1              | api path `…/pallets`                                                                                   | `getPalletReportRows sends …`                                                                   |
| A2              | api `officeToken: undefined`                                                                           | same                                                                                            |
| A3              | api `schema: z.unknown()`                                                                              | survives Vitest; **killed by `typecheck`** (`TS2322 Promise<unknown>`), shown in `orig/A3t.out` |

Survivors / equivalents:

- **M1** (drop `AND b.pallet_id IS NOT NULL`): output-equivalent. The boxes without a pallet decode with an empty pallet key and are never attached to a pallet, so the answer is identical. The guard is a cost bound (the partial index `boxes_pallet` and fewer rows read); no black-box test can see it without pinning SQL text, which I did not do. (Note for review: a NULL `pallet_id` decodes as `""` into `String` instead of failing.)
- **PR4** (`PalletReportRows` loses `camelCase`): equivalent, its three fields are single lowercase words.
- `ORDER BY` without leading `b.pallet_id`: not tried; equivalent in output (rows are grouped into a map).

## Self-review (data attention)

- Membership and order follow the cloud's rule: every box that stood on the pallet (disassembled ones too), `closed_at` then `id`; pallets `opened_at` then `id`; live units; current product; disassembly only on the pallet (`disassembledAt`), not in box counts. Ties are pinned by two tests with reverse insertion order (TIES, BIG).
- One snapshot: pinned with writes between each of the four reads (SNAP) and an unknown shift stopping after its own query.
- Indexed: three plans pinned by index name with 1500 boxes / 3000 items present (`sqlite_autoindex_shifts_1` + `sqlite_autoindex_products_1`; `pallets_shift`; `boxes_shift` + `box_items_live`), no `SCAN`. A colleague shift of the same size is disjoint.
- Office auth: any role (admin, technologist), device key alone 401 `credential: session`, unknown token 401, unknown or malformed shift id 404 `not_found`.
- No logging added; the route never logs codes, SSCC or layout (the `no_secrets_in_logs` walk is Task 9).
- Not in this task (as per the plan): the office mapping, the disassembled-pallet / late-box flags in the cards, `no_secrets_in_logs`, docs.

## Concerns / notes

1. Test seam `read_pallet_rows` (`pub`, hook) in production code, as in Task 1; deleting it loses the killers of H3-H6b.
2. Full-package Vitest timeouts under load (above), unrelated and green with a longer limit; no green full run at the default limit.
3. Counts vs the brief: proto 52 (brief 50), `office_reports` 15 (brief 6 for plan counts; Task 1 had 8 and the brief's 3 new gives 11, +4 mine), `protocol`+`api` 387 (brief 288), workspace 53 suites / 886 tests (Task 1: 53 / 878). The plan's "Expected" numbers are base-dependent.
4. M1 and PR4 survive as explained (equivalent in output).
