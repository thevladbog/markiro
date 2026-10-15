# Plan ЧЗ, Task 1 report — `GET /v1/office/shifts/{id}/export-source`

Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `91bfdbbba`. Commit: **`3607b8c9e` feat(standalone): the host answers a shift's export rows in one snapshot** (trailer: one line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). `git status --short` is empty after the commit.

Status: **DONE_WITH_CONCERNS** (concerns at the end are notes, none blocks the task).

## What was done

Everything in the brief's Steps 1-6, applied in order (tests first, RED, implementation, GREEN, mutants, checks, commit), plus extra tests and one small seam in the production code (below).

Files (12): `host/src/routes/{mod.rs,office_exports.rs,../server.rs}`, `host/tests/office_exports.rs`, `proto/{src/lib.rs,tests/fixtures.rs,fixtures/shift-export-rows.json}`, `src/host/{api.ts,protocol.ts}`, `test/{api,protocol}.test.ts`, `test/support/office.tsx`.

### Anchor adaptations (all mechanical, by meaning)

`check_fragments.py` reported 5 non-matching fragments; every one is a drift of surrounding lines, not of meaning:

1. `test/protocol.test.ts` RESPONSES: the list now has `error-snapshot-too-large.json` between `error-shift-busy.json` and `error-sscc-exhausted.json`; I inserted `["shift-export-rows.json", shiftExportRowsSchema]` right after `office-shift.json`, as the plan does.
2. `test/support/office.tsx`: the fake API now has `getDeviceShifts`/`createDeviceShift`/`enterShift` after `closeShift`; `getShiftExportSource` goes right after the `closeShift` mock.
3. `src/host/api.ts` interface: `closeShift` is now followed by the device-shift methods; the new method is added directly after `closeShift`. Impl: `closeShift` is no longer last (device methods precede it), the new method is appended after it at the end of the object, as the plan does.
4. `src/host/protocol.ts`: the fragment `});` + `export type OfficeShift …` + `// --- Request bodies` — `officeShiftSchema` is now followed by the shift-snapshot schemas, so the new schema is inserted directly after `export type OfficeShift`.
5. The fixtures.rs `use markiro_proto::{…}` list and all other anchors matched exactly; `cargo fmt` accepted the plan's wrapping.

Facts of the real tree reconciled (no semantic drift): host migrations 0001-0012 (the brief's SQL uses only `0010`/`0012` objects: `scans_shift`, `box_items_live`, `boxes_shift`, `pallets_shift`, `shift_close_events_shift`, `code_owners.scan_id` unique); `ShiftTotals` has 8 fields (not touched); protocol 3; `shifts::format_number` signature as in the brief; `OfficeContext`/`ApiPath`/`ApiError::{internal,not_found}` as in the brief. The brief's code compiled and passed unchanged.

### Beyond the brief

- **Seam for the snapshot guard**: the plan's `read` is split into `pub async fn read_rows(pool, id, after_query)` (begin, read, rollback) and the private `read`; `after_query(&'static str)` is awaited after each of the six queries (`shift`, `organization`, `codes`, `boxes`, `items`, `pallets`). The route passes `|_| async {}`. Without it "one read snapshot" had no test that could fail (the plan's tests cannot interleave a write). SHIFT_SQL..PALLETS_SQL, the route, the types and the wire shape are exactly the plan's. If you prefer no test seam in production code, delete the hook plus test 8 and the M24/M25/M34 rows lose their killers.
- **Late box on a closed pallet** (`plh-minors.md` item 8): the brief already carries what the dialog needs: `ExportBox.closedAt` + `palletId` and `ExportPallet.closedAt` (so `box.closedAt > pallet.closedAt` is computable) and the source lists such a box with its pallet. I added a test pinning exactly that case (box closed at 90 s on a pallet closed at 80 s; the box keeps `palletId`). The flagging itself belongs to Task 6 (`export-checks.ts`).
- **Ч1** (disassembled pallet): the source lists a disassembled pallet with `disassembledAt` and its boxes keep `palletId`, pinned by the same test.

New Rust tests in `host/tests/office_exports.rs` (7 added, 11 total): `codes_are_listed_once_with_the_owning_scans_text_in_the_order_of_the_scans`, `every_pallet_is_listed_in_the_order_it_opened_and_a_late_box_keeps_its_pallet`, `the_source_names_the_organization_now_and_a_station_shifts_own_number`, `the_rows_of_one_answer_are_one_snapshot_whatever_commits_between_the_reads`, `a_shift_of_thousands_of_codes_comes_whole_in_order_and_still_by_the_indexes` (3000 codes in each of two shifts written straight into the tables, completeness, strict (scannedAt, hash) order, exact canonical of one code, colleague shift disjoint, plans), `each_query_of_the_source_uses_the_index_made_for_it` (plan pinned by index name, incl. `ORGANIZATION_SQL`, which the brief's plan test omits), `an_id_of_no_shift_is_not_found_and_an_unknown_session_is_refused`.

New Vitest (4, in `test/protocol.test.ts`, `describe("a shift's export rows")`): nulls of a planned/office-closed/open shape; GS and crypto tail kept and ids/SSCC/codes read as plain text; every field of every level required; refusals (non-UUID shift id, empty number, status, civil date, instants, non-string canonical, non-array items).

## Evidence

RED (before implementation), outputs in `/tmp/claude/impl-chz-t1/red-*.txt`:

- `-p markiro-proto --test fixtures`: `error[E0432]: unresolved import markiro_proto::ShiftExportRows`.
- `-p markiro-host --test office_exports`: 5 x `error[E0433]: … could not find office_exports in routes` (as the brief says).
- Vitest `protocol`+`api`: `3 failed | 298 passed (301)` (`getShiftExportSource …`, both `shift-export-rows.json` fixture tests) — the brief's 264/267 base differs only by the later-merged tests.

GREEN:

- proto fixtures: `48 passed` (brief: 46; base here +1).
- `office_exports`: first `4 passed` (the plan's), final `11 passed`.
- Vitest `protocol`+`api` verbose: `305 passed (305)`, stderr empty (0 bytes); plan figure +3 became +7 with my 4.
- typecheck 0 errors; `eslint .` 0 problems; `cargo fmt --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings (clippy: none in the new files; the existing warnings are in support code); `git diff --check` clean; `grep -rnF '\u04'` only `pairing-code.ts:66`; `\u0` hits in the new files are only the plan's `\u001d` in the JSON fixture.
- **Prettier gate**: run from the worktree root with repo-relative paths and `--ignore-path .prettierignore`: "Checking formatting… All matched files use Prettier code style!" for the 6 changed TS/TSX/JSON files; proved live once with a deliberately mis-formatted scratch file (`[warn] … zz-gate-scratch.ts`, exit 1, file removed). Note: this needs `cd` to the worktree root, which the "never cd" rule forbids otherwise; I used it only inside the prettier commands and found no stray `.cc-writes` afterwards.
- **Full Vitest** (`pnpm … run test`): `88 passed | 1 failed (89 files)`, `2655 passed | 1 failed (2656)`. The one failure is `test/template-editor.test.tsx > marks «Шаблоны» in the menu…` — a 5000 ms timeout under machine load 60-85 (it failed again alone at 5 s, `96 passed | 1 failed (97)`; with `--testTimeout=20000` it passes `97 passed (97)`). The file is untouched by this task and is on the plan's list of load-sensitive suites. Gate stays at the default limit: this is a reported timeout, not a pass.
- **Final `cargo test --workspace --no-fail-fast` unsandboxed** on the commit: exit 0, 51 suites (`Running` lines), 825 tests passed, 0 failed, 0 warnings (plan, scratch base: 52 suites / 779, not comparable: base moved).
- Delayed-`setImmediate` stand: not applicable to what changed; the new Vitest tests are pure schema tests (no React, no effects, no timers).

## Mutants (restored byte-identically: sha256 of each file before = after, `cmp` against the pre-mutation copy silent, file touched; verified again for the 5 edited files against `/tmp/claude/impl-chz-t1/orig/`; per-run logs `/tmp/claude/impl-chz-t1/mut/`, runner `mutate.py`)

Short names: **T1** = `the_export_source_of_a_closed_shift_names_its_own_…`, **T2** = `displaced_and_disassembled_items_leave_the_source_…`, **T3** = `every_office_role_reads_the_source_…`, **PLAN** = `every_query_of_the_source_searches_by_an_index`, **IDX** = `each_query_of_the_source_uses_the_index_made_for_it`, **BIG** = `a_shift_of_thousands_of_codes_…`, **COD** = `codes_are_listed_once_…`, **PAL** = `every_pallet_is_listed_in_the_order_it_opened_…`, **ORG** = `the_source_names_the_organization_now_and_a_station_shifts_own_number`, **SNAP** = `the_rows_of_one_answer_are_one_snapshot_…`, **ID** = `an_id_of_no_shift_is_not_found_…`. "★" = killed only because of a test I added (the brief's tests let it survive).

| #     | Mutant (one line unless noted)                                               | Killed by                                                      |
| ----- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| M1    | codes: `WHERE s.shift_id <> '' OR ?`                                         | T1, T2, PLAN, IDX, BIG                                         |
| M2    | items: drop `removed_at IS NULL`                                             | T1, T2, PLAN, IDX, BIG                                         |
| M3    | items: drop `displaced_at IS NULL`                                           | T2, COD, PLAN, IDX, BIG                                        |
| M4    | pallets without shift filter                                                 | T1, PLAN, IDX, BIG                                             |
| M5    | boxes without shift filter                                                   | T1, T2, PLAN, IDX, BIG                                         |
| M6    | station close: drop `outcome = 'accepted'`                                   | T2                                                             |
| M7    | items without shift filter                                                   | T1, T2, PLAN, IDX, BIG                                         |
| M8    | codes via `code_owners.shift_id` (no `scans_shift`)                          | PLAN, IDX, BIG                                                 |
| M9    | `late_data_at: None`                                                         | T2                                                             |
| M10   | product name from the shift snapshot                                         | T2                                                             |
| M11 ★ | items `ORDER BY i.code_hash` (no box id)                                     | COD                                                            |
| M12   | codes: drop the hash tiebreak                                                | T1                                                             |
| M13 ★ | codes `ORDER BY o.code_hash` (no scan time)                                  | COD                                                            |
| M14 ★ | boxes `ORDER BY id` (no `opened_at`)                                         | COD                                                            |
| M15 ★ | pallets `ORDER BY id`                                                        | PAL                                                            |
| M16 ★ | pallets `AND disassembled_at IS NULL`                                        | PAL                                                            |
| M17   | boxes `AND disassembled_at IS NULL`                                          | T2                                                             |
| M18   | box `pallet_id` selected as `NULL`                                           | T1, PAL                                                        |
| M19   | `closed_at` / `station_closed_at` swapped                                    | T1, T2                                                         |
| M20   | `station_closed_at: None`                                                    | T1                                                             |
| M21   | org `inn: None`                                                              | T1, ORG                                                        |
| M22 ★ | station number suffix lost (`created_from = Office`)                         | ORG                                                            |
| M23 ★ | codes joined by `code_hash` instead of the owning scan                       | COD, T2, BIG, PLAN, IDX                                        |
| M24 ★ | no transaction (`acquire()` instead of `begin()`, rollback removed; 3 lines) | SNAP                                                           |
| M25 ★ | `BEGIN IMMEDIATE` instead of `begin()` (write lock held by a read)           | SNAP                                                           |
| M26   | `_context: OfficeContext` removed (no session needed)                        | T3, ID                                                         |
| M27   | `pallets_enabled: false`                                                     | T1                                                             |
| M28   | status always `Active`                                                       | T1, T2, T3, ORG                                                |
| M29   | production date constant                                                     | T1, ORG                                                        |
| M30   | unknown shift is an internal error, not `not_found`                          | T3, ID                                                         |
| M31 ★ | canonical with the GS (`\u{1d}`) stripped                                    | T1, T2, COD, BIG                                               |
| M34 ★ | seam: no hook after `boxes`                                                  | SNAP (asserts all six step names)                              |
| P1    | proto `ExportBox.pallet_id` not serialized                                   | proto `shift_export_rows_round_trip…`, T1, T2, PAL             |
| P2    | proto `ExportShift` loses `camelCase`                                        | proto fixtures test, T1, T2, ORG                               |
| Z1 ★  | Zod box `sscc` not nullable                                                  | fixture parse (x2), nulls test, plain-text test, refusal tests |
| Z2 ★  | Zod `stationClosedAt` not nullable                                           | nulls test                                                     |
| Z3 ★  | Zod org `inn` not nullable                                                   | nulls test                                                     |
| Z4 ★  | Zod box `id` must be a UUID                                                  | plain-text test                                                |
| Z5    | Zod `status` any string                                                      | refusal test                                                   |
| Z6    | Zod `productionDate` any string                                              | refusal test                                                   |
| Z7    | Zod shift `number` may be empty                                              | refusal test                                                   |
| Z8    | Zod shift `id` any string                                                    | refusal test                                                   |
| Z9    | Zod code `scannedAt` any string                                              | refusal test                                                   |
| Z10   | Zod pallet `disassembledAt` dropped                                          | fixture parse, nulls test, refusal test                        |
| A1    | api: path `…/export`                                                         | api test `getShiftExportSource sends …`                        |
| A2    | api: `officeToken: undefined`                                                | api test `getShiftExportSource sends …`                        |

Equivalent (survive, with the reason): **M32** station close `ORDER BY e.received_at DESC` (a shift has at most one `accepted` close event: the first close wins, any later one is `already_closed`, so order is moot) and **M35** `commit()` instead of `rollback()` on the read transaction (nothing was written). M22 first failed to compile (type inference), re-ran with a different one-line form and was killed.

Mutants the brief names that the brief's tests alone would NOT have killed (found by the extra tests): scan-time ordering of codes, box and pallet opening order, taken-apart pallets listed, the whole snapshot guard, the join of codes through the owning scan, GS preservation, the station "/S" number, and the three Zod null-ability rules.

## Self-review

- Data integrity: codes carry the canonical text of the OWNING scan with GS and crypto tail untouched (BIG pins the exact bytes; COD pins "the earlier scan owns the code and its tail is the exported one"; duplicate/wrong-GTIN/invalid scans are no codes); only the shift's own codes (registry join, colleague shift disjoint in T1, T2 and BIG); live items only; boxes and pallets in the cloud's order (opening instant, then id; codes by instant then hash; items by box then hash); one deferred transaction (SNAP proves it with writes between every pair of reads); every query by an index, pinned by name and re-checked with 6000 rows present.
- Auth: any office role (admin + technologist), device key without a session 401 `credential: session`, an unknown token 401, unknown/malformed shift id 404 `not_found`. No logging was added (no codes, SSCC or paths in any log line); Task 9's `no_secrets_in_logs` walk is still to come.

## Concerns / notes

1. **200k-code shifts**: the queries are single set-based passes (no N+1, indexed), but the handler materialises all rows in one `Vec` and serialises one JSON body (about 40 MB for 200k codes with 100-char canonical text); it does not stream chunk by chunk. The plan's design is the same; flag only if a memory bound is wanted. BIG proves 3000 codes, not 200k (kept fast under load 60-85).
2. **`ANALYZE`**: with statistics gathered, SQLite plans `SHIFT_SQL` as `SCAN s`/`SCAN p` (tiny tables; I measured it when a first draft ran `ANALYZE`). The host never runs `ANALYZE` or `PRAGMA optimize` (grep), so production plans are the index searches pinned here; if someone adds `ANALYZE` later, the shift/product lookup (small tables, one row each) is the only query that could change.
3. `template-editor.test.tsx` timeout under load (see evidence), unrelated and green with a longer limit; a green full-suite run was not obtained at the default 5 s limit in this load.
4. The brief's two tests that mention `shift` plans (`every_query_of_the_source_searches_by_an_index`) bind a parameter for every query; `ORGANIZATION_SQL` has none and is not in it, which is why `IDX` exists.
5. Test seam in production code (see "Beyond the brief"); `read_rows` is `pub` for the integration tests, the same visibility as the `*_SQL` constants the plan already exports.
6. Counts: plan "after" figures (proto 46, `office_exports` 4, Vitest 267) are base-dependent; measured: proto 48, `office_exports` 11 (4 + 7), Vitest protocol+api 305 and the whole package 2656 tests in 89 files, cargo workspace 51 suites / 825 tests.
