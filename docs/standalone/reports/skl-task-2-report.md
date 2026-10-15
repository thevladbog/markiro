# plan СКЛ, Task 2 report: host warehouse lookup

Status: DONE_WITH_CONCERNS. Commit: `c7ca5bfb9 feat(standalone): host warehouse lookup by code hash or SSCC (plan СКЛ task 2)` on `claude/wh` (base 056b157ac). Tree clean after commit.

## What was done

- `host/src/routes/warehouse.rs`: `lookup` plus `UNIT_SQL`, `UNIT_SEEN_SQL`, `BOX_SQL`, `PALLET_SQL` (and `SHIFT_SQL`, made `pub` to pin its plan). Route wired in `server.rs` (`POST /v1/device/warehouse/lookup`), `pub mod warehouse` in `routes/mod.rs`, `held_by_a_restore` holds `/v1/device/warehouse/` (comment extended).
- `host/tests/warehouse.rs`: the brief's 6 tests plus 10 more (16 total).
- `host/tests/no_secrets_in_logs.rs`: `routes/warehouse.rs` joins the source walk (zero `tracing::` calls, file count 17 -> 18) and the runtime walk performs lookups of a unit (full code in the body), a box, a pallet, a malformed hash and a malformed SSCC; all the existing needles (hash, canonical, SSCCs) must stay out of the process log.

## Decisions for the duties from the Task 1 report

- Shapes: the route checks `rules::is_code_hash` (64 lower-case hex) and `is_sscc` (18 ASCII digits) and answers `400 validation_failed` with `details.field` (`codeHash` / `sscc`); "none or both" -> field `codeHash`.
- Option fields. `Option` in serde reads a missing key and an explicit `null` as `None`, and the proto type is shared. For the lookup the host therefore treats `{"codeHash": null, "sscc": X}` as an SSCC lookup (pinned by a test, documented in the doc comment); the station's Zod union is the stricter side and never sends it. Stricter on the host would need a custom deserializer in `proto` (not in this task's files). For Task 3 and `WarehouseRecord.repair` my recommendation: require the key to be present (Zod already does; a station always sends it) via `deserialize_with`/an explicit presence check in the route, and pin it with a parity test; Task 2 has no such field.
- Device authorization: `AuthDevice` (bearer key, revoked -> 401, touches `last_seen_at` at most once a minute like the other device routes), then `device.kind != Station` -> `403 forbidden`. This is STRICTER than the brief ("any device of the site"): the answer carries a unit's full code, other routes of the area (shifts, known blocks) are station-only, and a handheld/office device has no reprint function. Tell me if you want any device kind instead (one line, one test).
- Limits: no new body limit; the request is two short strings under axum's default body limit and `ApiJson`'s strict `deny_unknown_fields`; no rate limit exists for device routes.
- One snapshot: `state.pool.begin()` (deferred transaction = read snapshot from the first SELECT), every query on `&mut tx`, `tx.rollback()` (nothing written). Behaviourally a snapshot cannot be interleaved from a test, so the shape is pinned by a source-text test (exactly one `begin`, one `rollback`, no `commit`, no other `state.pool` use, two `&mut tx`).
- Indexes: all five statements pinned in `every_query_of_a_lookup_searches_by_an_index` (host SQLite): no `SCAN` step and the exact indexes (`sqlite_autoindex_code_owners_1`, `sqlite_autoindex_scans_1`, `sqlite_autoindex_operators_1`, `scans_code_hash`, `boxes_sscc`, `box_items_live`, `pallets_sscc`, `boxes_pallet`, `sqlite_autoindex_shifts_1`).
- Logging: none in the route; `ApiError::internal` messages carry fixed strings only.

## RED / GREEN

- RED: `cargo test -p markiro-host --test warehouse` -> 6 failed (`404 no route for POST /v1/device/warehouse/lookup`), `/tmp/claude/impl-skl-t2/red.log`.
- GREEN: brief's 6 pass first time with the route; final 16 pass (`green4.log`).
- `restore_hold`, `codes`, `no_secrets_in_logs`: part of the full workspace run below.

## Mutants (harness `/tmp/claude/impl-skl-t2/mut.py`, logs `mut-N.log`; each restore verified by sha256 against `/tmp/claude/impl-skl-t2/orig/` and `cmp`; restored files touched)

Final sha256: warehouse.rs `0b60c210...6666518`, server.rs `a1e6d0b0...24048e` (before == after).

| #     | One-line mutant                                    | Killed by                                                                                                                         |
| ----- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0     | box `disassembled_at` guard disabled               | `a_freed_code_and_a_box_taken_apart_...`                                                                                          |
| 1     | pallet `disassembled_at` guard disabled            | `a_pallet_taken_apart_is_unavailable`                                                                                             |
| 2     | hash shape check -> `len() > 0`                    | `a_lookup_of_another_shape_is_refused_by_field`, `a_lookup_asks_exactly_one_...`                                                  |
| 3     | SSCC length `== 18` -> `<= 18`                     | same two                                                                                                                          |
| 4     | SSCC digit check dropped                           | same two                                                                                                                          |
| 5     | both given still answered by code                  | `a_lookup_asks_exactly_one_well_formed_thing_...`                                                                                 |
| 6     | station-only gate disabled                         | `only_a_station_looks_up_...`                                                                                                     |
| 7     | unit: `LEFT JOIN operators` -> `JOIN`              | `a_label_is_made_from_the_frozen_shift_...` (unit with no operator)                                                               |
| 8     | "seen" test without `verdict='ok'`                 | `a_code_that_was_never_accepted_is_not_found_not_released` (+ plan test)                                                          |
| 9     | released/not_found swapped                         | `a_freed_code_...`, `a_code_that_was_never_...`                                                                                   |
| 10    | unit `item_count: 2`                               | `a_unit_of_another_station_...`                                                                                                   |
| 11    | unit `at` not the scan instant                     | same                                                                                                                              |
| 12    | unit `identity` not the hash                       | same                                                                                                                              |
| 13    | box count includes displaced items                 | `a_box_is_printed_with_the_count_...` (+ plan test)                                                                               |
| 14    | box count includes removed items                   | same                                                                                                                              |
| 15    | reported count ignored (`COALESCE(NULL, live)`)    | `a_box_is_printed_with_the_count_...` (reported 7)                                                                                |
| 16    | box `at` not the close instant                     | `a_box_is_found_by_its_sscc_...`                                                                                                  |
| 17    | box carries a `canonical`                          | `a_box_is_found_by_its_sscc_...`                                                                                                  |
| 18    | pallet units include boxes taken apart             | `a_pallet_counts_the_units_of_the_boxes_not_taken_apart`                                                                          |
| 21    | pallet `device_id`/`shift_id` swapped              | pallet tests (subjectId/shiftId/deviceId asserted)                                                                                |
| 22    | pallet `boxCount` missing                          | pallet tests                                                                                                                      |
| 23    | pallet operator join broken                        | `a_pallet_counts_...` (operator name asserted)                                                                                    |
| 24    | station-created shift numbered as office (no `/S`) | `a_label_is_made_from_the_frozen_shift_...`                                                                                       |
| 25    | product read not from the snapshot                 | same + unit test                                                                                                                  |
| 26    | counterparty dropped                               | same                                                                                                                              |
| 27    | shift number wrong format                          | same + pallet/box tests                                                                                                           |
| 28    | transaction not ended by `rollback` (`drop(tx)`)   | `the_lookup_reads_inside_one_transaction_that_it_rolls_back`                                                                      |
| 29    | `rollback` -> `commit`                             | same                                                                                                                              |
| 30    | a `tracing::info!(?what, ..)` in the route         | `no_secrets_in_logs`: source walk ("has a logging call this test does not know") AND runtime walk (hash found in the process log) |
| 31-35 | each of the five queries made un-indexable (`col   |                                                                                                                                   | '' = ?`) | `every_query_of_a_lookup_searches_by_an_index` (plan SCAN / missing index) |
| 36    | restore hold for `/v1/device/warehouse/` dropped   | `a_restore_holds_the_warehouse_routes`                                                                                            |
| 37    | route path misspelt                                | all lookup tests                                                                                                                  |

Survivors, both justified:

- #19 pallet SQL without `b.closed_at IS NOT NULL`: equivalent. `boxes` has `CHECK (pallet_id IS NULL OR closed_at IS NOT NULL)` (migration 0012), so no open box can belong to a pallet; the clause is belt and braces. (My first attempt at a test reopened a box and cleared `pallet_id`, which proved nothing; replaced by "every box taken apart" below.)
- #20 pallet `COALESCE(SUM(..), 0)` removed: equivalent through sqlx. A `NULL` decoded into a non-`Option` `i64` yields 0 (SQLite `sqlite3_value_int64`), so the zero-box pallet still answers `itemCount 0` (that case IS tested: both boxes taken apart). The COALESCE is kept in the SQL as written in the brief.
- Not mutation-testable: "one consistent snapshot" semantics (needs interleaved writer); only the handler's shape is pinned.

## Tests

Plan: 6 tests in `host/tests/warehouse.rs`. Measured: 16 (adds: shapes by field, station-only/no key, writes nothing, box count + operator + reported/live/removed/displaced, pallet counts + disassembled box + all boxes apart, pallet taken apart, frozen snapshot + counterparty + station `/S` number, never-accepted code, plans, transaction-shape pin).

- Focused: `--test warehouse` 16 passed.
- ONE full `cargo test --workspace --offline --locked` (unsandboxed): 73 test binaries ok, 1146 passed, 0 failed, 0 warnings (Task 1 baseline 72 binaries / 1130).
- Parity: `markiro-proto --test warehouse --test fixtures` 6 + 52 passed; Vitest `test/warehouse-protocol.test.ts` 41 passed.
- `cargo fmt --check` 0; `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings; `git diff --check` clean; `\u04` grep only `pairing-code.ts:66`; no `\u0` in the written Rust.
- Prettier gate / Vitest stands: no TS/MD files changed, not applicable.

## Files

`apps/standalone/host/src/routes/warehouse.rs` (new), `host/src/routes/mod.rs`, `host/src/server.rs`, `host/tests/warehouse.rs` (new), `host/tests/no_secrets_in_logs.rs`.

## Anchor adaptations

No semantic differences. Mechanical/additive: (1) `lookup` takes `device: AuthDevice` (named, not `_device`) and refuses non-stations (the station-kind gate, see above); (2) `SHIFT_SQL` made `pub` for the plan pin; (3) `no_secrets_in_logs.rs` gets a small `looked_up` helper beside `send_facts`; (4) rustfmt re-wrapped the brief's code and tests; (5) the `a_restore_holds...` test passes with the layer alone, as the brief says.

## Concerns

- Station-only gate is stricter than the brief's "any device"; the pairing flow can currently produce `office` and `handheld` devices, so a future handheld reprint would need the gate widened deliberately.
- Explicit `null` in a lookup body is tolerated on the host (see Option decision); Task 3 should decide `repair` presence (recommendation above).
- A full-workspace run took one pass only, as required; the delayed-`setImmediate` stand is not applicable (no React code).
- No Windows/hardware/browser checks apply to this task.
