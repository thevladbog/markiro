# Plan О-Ф, Task 1 report: `GET /v1/office/boxes/{id}/report-data`

Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `66d9d6e4b` (ЧЗ complete). Commit: **`d8a58a47c` feat(standalone): the host reads a box's contents as the cloud's «Состав короба» prints them** (one trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). `git status --short` is empty after the commit. Artefacts (RED/GREEN outputs, mutant logs, runner scripts) are in `/tmp/claude/impl-pof-t1/`.

Status: **DONE_WITH_CONCERNS** (concerns are notes; none blocks).

## What was done

Brief Steps 1-6 in order: tests first, RED, implementation, GREEN, mutants, gates, commit. The brief's production code is applied as written, with one addition: a test seam for the read snapshot (below). Beyond the brief: 5 more host tests and 4 more Vitest tests that kill mutants the brief's tests let live.

Files (12): `host/src/routes/{mod.rs,office_reports.rs}`, `host/src/server.rs`, `host/tests/office_reports.rs`, `proto/{src/lib.rs,tests/fixtures.rs,fixtures/box-report-rows.json}`, `src/host/{api.ts,protocol.ts}`, `test/{api,protocol}.test.ts`, `test/support/office.tsx`.

### Anchor adaptations (all mechanical, by meaning)

1. `proto/tests/fixtures.rs` `use markiro_proto::{…}` list: it has more names than the brief's (Pallet*, Shift*...). I put `BoxReportRows` right after `BoxLabelFact` and let `cargo fmt` rewrap the list (the diff shows 5 deleted lines, all the rewrap).
2. `proto/tests/fixtures.rs` new test: the anchor (`value["folder"] = ...C:\\Users`) matched once; the test is inserted there as in the brief. The tail of the file differs (the later `ПЛ-Х` totals test follows), which is irrelevant.
3. `test/protocol.test.ts` RESPONSES list: it has `error-snapshot-too-large.json` between `error-shift-busy.json` and `error-sscc-exhausted.json`; the new row goes right after `shift-export-rows.json`, as in the brief.
4. `test/support/office.tsx`: more mocks precede `...overrides` than in the brief (device-shift mocks, etc.); the new mock goes directly before `...overrides`.
5. `src/host/api.ts` / `protocol.ts`: imports, interface and the end of the factory were located by their own lines (`shiftExportRowsSchema`, `type ShiftExportRows`, `recordShiftExport`, `officePalletSchema` type), not by the brief's surroundings, because ПЛ-Х / ЧЗ / 2a streams added lines around them. The schema was inserted directly after `export type OfficePallet`, the API method last in the object.
6. `host/src/server.rs`: the anchor (`record_export` route, then `…/users`) matched exactly.
   No semantic difference found; no NEEDS_CONTEXT.

### Data semantics checked against the cloud (`CodeSearchService.boxReportData`, `code-search.service.ts:1174`)

- Cloud selects `box_items` of the box with `displacedAt IS NULL AND (removedAt IS NULL OR removedAt = boxes.disassemblyReceivedAt)`, joined to the code row of the item's own scan (`codeHash` + `scannedAt = addedAt`), ordered `gtin14, serial`. Host: the item's own scan is `box_items.scan_id` (primary key), so the join is exact; the disassembly instant on the host is `disassembled_at`, which `facts/exception.rs` writes with the same `occurred_at` it writes to `removed_at` of the items it takes out (lines 110-124). Earlier removals (undo, clear) carry their own exception's instant, and undo/clear need an open box, so they cannot coincide with the disassembly of a closed box. The cloud's own comment notes it uses the server instant for the same reason; the host's equivalent is `disassembled_at`.
- Ф6: ordering is SQLite BINARY; pinned by a test with mixed digits / capitals / small letters.
- The box's own `sscc` is returned as stored (18 digits, the cloud form does `formatSsccWithAi` in the loader; that is the office mapping in later tasks).

### Beyond the brief

- **Snapshot seam (as ЧЗ Task 1's `read_rows`).** `pub async fn read_box_rows(pool, id, after_query)` (begin, read, rollback) with the private `read_box`; `after_query(&'static str)` is awaited after each of the three queries (`box`, `organization`, `items`). The route passes `|_| async {}`. Without it "one read snapshot" had no test that could fail. If you prefer no hook in production code: delete the hook and test `the_three_reads_of_a_box_form_are_one_snapshot_…` (mutants H3-H5 then lose their killer).
- **Host tests added** (8 in total with the brief's 3):
  1. `a_box_taken_apart_prints_what_its_disassembly_took_out_and_not_what_left_before`: a code undone before the close, the codes a clear took out before the box was filled again, a code scanned back into the box after the clear (printed once).
  2. `the_three_reads_of_a_box_form_are_one_snapshot_whatever_commits_between_them` (also an unknown box stops after its own query).
  3. `the_codes_come_by_gtin_then_serial_byte_for_byte`: two GTINs, serials `10 B3 S000001 Z9 a1 b2`, GS and crypto tail kept.
  4. `a_box_of_thousands_of_codes_comes_whole_in_order_and_still_by_the_indexes`: 3000 items in a second box of the shift, 3000 in a colleague's shift, rows written straight into the tables; completeness, strict order, exact bytes of one item, colleague disjoint, plans pinned by index name (`sqlite_autoindex_boxes_1`, `shifts_1`, `products_1`, `scans_shift`, `sqlite_autoindex_box_items_1`; no `SCAN`).
  5. `an_id_of_no_box_is_not_found_and_an_unknown_session_is_refused`.
- **Vitest added** (`describe("a box's form data (plan О-Ф)")`, 4 tests in `test/protocol.test.ts`): nulls of open / taken-apart / empty box, GS and tail kept and ids / SSCC read as plain text, missing field at every level, wrong kind of every field.

## Evidence

RED (before wiring the module / the schema), files `red-*.txt`:

- `-p markiro-proto --test fixtures`: `error[E0432]: unresolved import markiro_proto::BoxReportRows`.
- `-p markiro-host --test office_reports`: `error[E0433]: failed to resolve: could not find office_reports in routes`.
- Vitest `protocol`+`api`: `Tests  3 failed | 373 passed (376)` (the brief says 3 failed: the two `box-report-rows.json` fixture tests and `getBoxReportRows`).

GREEN:

- proto fixtures: `51 passed` (brief: 49; base is +2).
- `office_reports`: brief's tests `3 passed`; final `8 passed`.
- Vitest `protocol`+`api` verbose: `380 passed (380)` (brief 285; base 376-3=373 before +4 mine +3 new), stderr empty (0 bytes), no `act(` text. The delayed-`setImmediate` stand does not apply: the changed tests are schema/API-client tests with no component and no effect.
- `typecheck` 0 errors; `lint` 0 problems (after replacing three unused-`_dropped` destructurings); `cargo fmt --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings; `git diff --check` clean; `grep -rnF '\u04'` only `pairing-code.ts:66`; `\u0` in the new files is only the `\u001d` of the JSON fixture.
- PRETTIER GATE proven live: from the worktree root with `--ignore-path .prettierignore`, a scratch mis-formatted `apps/standalone/test/zz_gate_probe.ts` printed `[warn] …` rc 1 (file removed); the six changed TS/TSX/JSON files: `Checking formatting… All matched files use Prettier code style!`. (A `$F` variable is not word-split in zsh and gave a vacuous "No files matching" the first time; explicit paths fixed it.)
- **Final `cargo test --workspace --no-fail-fast`** (unsandboxed, `--offline --locked`) on the tree identical to the commit: rc 0, **53 suites, 878 tests passed, 0 failed**, 0 warnings (ЧЗ Task 2 measured 52 / 834; this base also has later ЧЗ tasks; the new suite `office_reports` adds 1 suite).
- **Full Vitest package**: `Test Files 3 failed | 95 passed (98)`, `Tests 8 failed | 3059 passed (3067)` at load average 75-80. All 8 are the 5000 ms timeouts of the load-sensitive suites the plan names (`shifts-page` 2, `template-editor` 4, `templates-page` 2). Re-run alone: `shifts-page` 34/34, `templates-page` 55/55; `template-editor` failed 4 of 97 alone at the default 5 s (`Test timed out`, same tests) and passed 97/97 with `--testTimeout=60000`. None of these files is touched by this task; the gate stays at the default limit, so this is reported as a load timeout, not a green run.

## Mutants (all restored byte-identically)

Method: `/tmp/claude/impl-pof-t1/mut.py` copies the file to `…/orig/`, applies the one-line change, runs the target, copies back, `cmp` + sha256 compare, `touch`. After each campaign the sha256 of `office_reports.rs` and the test file equal `hashes-before.txt` (`SAME`). Logs: `mut-host.txt`, `mut-host2.txt`, `mut-ts2.txt`; each run's full output `orig/<id>.out`. Short names: **MAIN** = `the_box_form_prints_the_live_codes_and_a_disassembled_box_its_last_contents`, **APART** = `a_box_taken_apart_prints_what_its_disassembly_took_out_and_not_what_left_before`, **ORDER** = `the_codes_come_by_gtin_then_serial_byte_for_byte`, **BIG** = `a_box_of_thousands_of_codes_…`, **SNAP** = `the_three_reads_of_a_box_form_are_one_snapshot_…`, **ROLE** = `every_office_role_reads_a_box_form_…`, **IDX** = `every_query_of_a_box_form_searches_by_an_index`, **ID** = `an_id_of_no_box_is_not_found_…`. "★" = killed only by a test I added beyond the brief.

| #     | Mutant (one line in `host/src/routes/office_reports.rs` unless noted)                                       | Killed by                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| B1    | items: drop `AND i.displaced_at IS NULL`                                                                    | MAIN                                                                                  |
| B2    | items: `removed_at` only `IS NULL` (brief's M B2)                                                           | MAIN, APART                                                                           |
| B2b ★ | `(removed_at IS NULL OR b.disassembled_at IS NOT NULL)` (a disassembled box prints everything ever removed) | APART                                                                                 |
| B2c   | `(removed_at = disassembled_at)` only (live items lost)                                                     | BIG, ROLE, MAIN, ORDER, SNAP                                                          |
| B2d   | filter replaced by `AND 1`                                                                                  | APART, MAIN, SNAP                                                                     |
| B3    | drop `ORDER BY s.gtin14, s.serial`                                                                          | BIG, MAIN, ORDER                                                                      |
| B3b ★ | `ORDER BY s.serial` only                                                                                    | ORDER                                                                                 |
| B3c   | `ORDER BY s.gtin14` only                                                                                    | BIG, MAIN, ORDER                                                                      |
| B3d ★ | `ORDER BY s.gtin14, s.serial COLLATE NOCASE`                                                                | ORDER                                                                                 |
| B3e   | serial `DESC`                                                                                               | BIG, APART, MAIN, ORDER, SNAP                                                         |
| B4    | `JOIN scans s ON 1`                                                                                         | IDX, BIG                                                                              |
| B5    | drop `AND i.box_id = b.id` (another box's items)                                                            | BIG, MAIN                                                                             |
| B6    | strip the GS from `canonical`                                                                               | BIG, APART, ROLE, MAIN, ORDER, SNAP                                                   |
| H1    | drop `_context: OfficeContext`                                                                              | ID, ROLE                                                                              |
| H2    | unknown box answers 403 instead of 404                                                                      | ID, ROLE                                                                              |
| H3 ★  | `pool.acquire()` instead of `begin()`+rollback                                                              | SNAP                                                                                  |
| H4 ★  | drop the hook after `organization`                                                                          | SNAP                                                                                  |
| H5 ★  | drop the hook after `box`                                                                                   | SNAP                                                                                  |
| H6    | organization `inn: None`                                                                                    | MAIN                                                                                  |
| H7    | `gtin14`/`serial` swapped in the mapping                                                                    | BIG, APART, ROLE, MAIN, ORDER, SNAP                                                   |
| H8    | `disassembled_at: None`                                                                                     | APART, MAIN                                                                           |
| H9    | `sscc: None`                                                                                                | MAIN                                                                                  |
| H10   | `shift_id` from the box id                                                                                  | BIG, MAIN                                                                             |
| H11   | product name from `s.id` instead of the product                                                             | MAIN                                                                                  |
| P1    | proto `BoxReportRows` loses `camelCase`                                                                     | proto `box_report_rows_round_trip_and_agree_with_the_export_source`                   |
| F1    | fixture serial changed so the item order breaks                                                             | same proto test                                                                       |
| F2    | fixture `productName` differs from the export source                                                        | same proto test                                                                       |
| F3    | fixture `sscc` differs from the export source's                                                             | same proto test                                                                       |
| Z1    | Zod `shiftId` any string                                                                                    | wrong-kind test                                                                       |
| Z2    | Zod `sscc` not nullable                                                                                     | nulls test                                                                            |
| Z3    | Zod `openedAt` any string                                                                                   | wrong-kind test                                                                       |
| Z4    | Zod `closedAt` not nullable                                                                                 | nulls test                                                                            |
| Z5    | Zod `disassembledAt` not nullable                                                                           | 7 tests (fixture x2, nulls, plain text, missing, wrong kind, api)                     |
| Z6    | Zod `closedAt` any string                                                                                   | wrong-kind test                                                                       |
| Z7    | Zod `organization.inn` not nullable                                                                         | nulls test                                                                            |
| Z8    | Zod item drops `canonical`                                                                                  | 3 tests                                                                               |
| Z9    | Zod `items` optional                                                                                        | missing-field test                                                                    |
| Z10   | Zod `productName` nullable                                                                                  | wrong-kind test                                                                       |
| Z11   | Zod `organization.name` nullable                                                                            | wrong-kind test                                                                       |
| Z12   | Zod item `serial` a number                                                                                  | 7 tests                                                                               |
| A1    | api path `…/report`                                                                                         | api `getBoxReportRows sends …`                                                        |
| A2    | api `officeToken: undefined`                                                                                | same                                                                                  |
| A3    | api `schema: z.unknown()`                                                                                   | survives Vitest; **killed by `typecheck`** (`TS2322 Promise<unknown>` not assignable) |

Survivors / equivalents: A3 under Vitest only (typecheck kills it, shown). `BoxReportItem` losing `camelCase` is not killable: all three field names are single lowercase words (equivalent). One extra mutant of mine (a `skip_serializing` field `extra` in proto, P3) changes nothing on the wire and survived: it was not a guard, I do not count it.

## Self-review

- Data attention: the codes that appear are exactly the cloud's rule (live items plus items taken out by the box's own disassembly; displaced never; earlier undo/clear removals never), joined to the item's own scan (so the canonical text is the one the owning scan carries, GS and crypto tail untouched), ordered by GTIN then serial. One read transaction, three indexed queries (plans pinned by index name, re-checked with 3000-item boxes present). No logging added (no codes, SSCC or layout in any log line; `no_secrets_in_logs` is Task 9). Office auth: any role (admin and technologist tested), device key alone 401 `credential: session`, unknown token 401; unknown or malformed box id 404 `not_found`.
- The wire carries only what the form needs; `shiftId` lets the office resolve the shift for the form; instants are the device's.

## Concerns / notes

1. **Cost of the items query for a box in a huge shift.** The brief's design reaches a box's non-live items through the shift's scans (`scans_shift`) because no index of `box_items` names non-live items; so a request for a tiny box reads every scan of its shift (PK lookup into `box_items` for each). Measured on this loaded machine (load ~75): a one-item box in a shift of 100,000 scans answered in 139 ms; a box with 100,000 items (not realistic) in 3.0 s. The plan is still index-only (no `SCAN`). If a shift can hold millions of scans, an index on `scans(box_id)` or `box_items(box_id, …)` would be a host migration, outside this plan (constraints forbid migrations).
2. **Product name of a form is the product's name now** (Ф5), joined through the shift; if a product is renamed after the shift, an old box's form prints the new name (as the cloud's loader does).
3. **Disassembled-pallet and late-box flags** (`chz-minors.md` item 1, `plh-minors.md` item 8) are card concerns for Tasks 6-7: the lists `…/boxes` and `…/pallets` (ЧЗ Task 2) already carry what they need (`closedAt` vs the pallet's, `disassembledAt`, `boxCountReported`); this task adds no field for them, as its route is per box.
4. Test seam in production code (`read_box_rows`, `pub`, the hook), as in ЧЗ Task 1.
5. Full-package Vitest timeouts under load (above), unrelated and green with a longer limit; a green full run at the default limit was not obtained.
6. Counts: brief's expected "Vitest 285 / proto 49 / `office_reports` 3" are base-dependent; measured proto 51, `office_reports` 8 (3 + 5), Vitest `protocol`+`api` 380; workspace 53 suites / 878 tests.
