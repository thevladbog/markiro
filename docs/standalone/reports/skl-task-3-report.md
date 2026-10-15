# plan СКЛ, Task 3 report: host reprint records (migration 0015)

Status: DONE_WITH_CONCERNS. Commit: `b3f2a371e feat(standalone): host keeps warehouse reprint records, migration 0015 (plan СКЛ task 3)` on `claude/wh` (base c7ca5bfb9). Tree clean after commit. Host migration number 0015 is taken by plan СКЛ.

## What was done

- `host/migrations/0015_warehouse_reprints.sql` (verbatim from the brief): table `warehouse_reprints`, PK `(device_id, record_id)`, FK to `devices`, CHECKs, index `warehouse_reprints_identity`.
- `host/src/routes/warehouse.rs`: `receive_records` (`POST /v1/device/warehouse/reprints`), `IncomingRecords`, `readable`, `subject_exists`, `receive`; pub SQL consts `STORED_SQL`, `UNIT_EXISTS_SQL`, `BOX_EXISTS_SQL`, `PALLET_EXISTS_SQL` (for the plan pins); module doc extended.
- `host/src/server.rs`: route wired. The restore hold already covered `/v1/device/warehouse/` (Task 2): the existing `a_restore_holds_the_warehouse_routes` already posts to `/reprints` and now reaches the layer on a real route.
- `host/tests/warehouse.rs`: the brief's 2 tests + 16 more (34 total, was 16).
- `host/tests/no_secrets_in_logs.rs`: runtime walk now sends real reprint requests (kept x3, repeat, `subject_unknown`, `invalid_record`, `payload_mismatch`) carrying the code hash and both SSCCs; source walk: `routes/warehouse.rs` now expects exactly 1 `tracing::` (the batch `error!`, as `routes/facts.rs`); test renamed `..._logs_only_its_four_audited_lines`.

## Duties from the Task 1/2 reports

- `repair` presence: enforced on the host by an explicit presence check on the JSON value (`has_nullable_keys`, before the typed read) because serde reads a missing key as `None` and the proto type is shared (Task 1 files). Zod's schema also requires `errorCode` and `operatorId` keys (`.nullable()`, "missing" cases in `test/warehouse-protocol.test.ts`), so the host requires all three keys (`repair`, `errorCode`, `operatorId`); explicit `null` is accepted. Parity test `the_host_refuses_what_the_zod_schema_refuses_of_the_shared_fixture`: takes the shared fixture `proto/fixtures/warehouse-records-request.json` (read from the real file; it is accepted as is), applies the 18 cases of Zod's `it.each("refuses a record with %s")` to every fixture record and expects `invalid_record` for each; the case NAMES are looked up in the Vitest file text, so the two tables cannot drift apart silently.
- Station-only: `device.require_station_in(&mut tx, STATION_ONLY)` INSIDE the write transaction (re-reads kind and revocation after the lock wait) -> `403 forbidden` for office/handheld, `401` for no key/bad key/revoked station; consistent with `lookup`.
- Explicit `null` in the lookup body: unchanged from Task 2 (read as absent, pinned and documented there). For records, `null` is meaningful (nullable keys) and a missing key is refused.

## Anchor adaptations (no semantic differences)

1. Station gate: the brief had `require_live_in` (any kind); changed to `require_station_in` per the dispatch (station-only family).
2. Presence check for the three nullable keys added in `receive` (not in the brief's code).
3. SQL strings of the stored-digest read and the three existence checks hoisted into pub consts (same text) so their plans are pinned.
4. `the_lookup_reads_inside_one_transaction_that_it_rolls_back` (Task 2) counted `state.pool` / `&mut tx` / `commit` over the whole file; it now slices the source before `/// The body as the host reads it` (the lookup half), and a new twin test pins the records half.
5. The brief's step-4 mutants are included in the table below; formatting re-wrapped by rustfmt.
6. `office_shifts.rs`/`facts.rs` did not enumerate all tables, no change needed there.

## RED / GREEN

- RED: `cargo test -p markiro-host --test warehouse -- records_are each_field` -> both FAILED (`404`), `/tmp/claude/impl-skl-t3/red.log`.
- GREEN: brief's tests passed on first implementation (`green1.log`); final `--test warehouse` 34 passed (`green6.log`); `--test warehouse --test foundation --test backup_schema --test no_secrets_in_logs` all ok (5 + 12 + 2 + 30 at that time).
- Full `cargo test --workspace --offline --locked` (unsandboxed, ONE run): 73 binaries ok, 1164 passed, 0 failed, 0 warnings (Task 2 baseline 1146, +18 = warehouse 16 -> 34). Vitest `test/warehouse-protocol.test.ts` 41 passed. `markiro-proto` warehouse/fixtures parity tests are inside the workspace run.
- `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings, `git diff --check` clean, `\u04` grep only `pairing-code.ts:66`, no `\u0` in the written Rust/SQL. Prettier gate / Vitest stands: no TS/MD touched, not applicable.

## Mutants (harness `/tmp/claude/impl-skl-t3/mut.py`, `muts.py`; logs `mut-*.log`; each restore asserted by sha256 against `/tmp/claude/impl-skl-t3/orig/` and the file touched)

Final sha256: warehouse.rs `1e22b110...`, server.rs `e6d5a8ac...`, tests/warehouse.rs `807ae74f...`, no_secrets `905efa1f...`, 0015 sql `4f9899de...` (before == after).

| Guard                       | One-line mutant                                                                                                                                                                    | Killed by                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| subject check               | `if false && !subject_exists`                                                                                                                                                      | `a_record_names_its_subject_by_id_and_identity_together`, plan test, Zod parity                        |
| unit/box/pallet identity    | each `AND code_hash/sscc = ?` -> `AND ? IS NOT NULL` (3)                                                                                                                           | identity test + plan-pin test                                                                          |
| kind -> SQL map             | box/pallet SQL swapped                                                                                                                                                             | identity test (+10 others)                                                                             |
| error_code iff unsettled    | `None => true`                                                                                                                                                                     | `records_are_kept_once...`                                                                             |
| error code word             | alphabetic / len 0 / drop `is_code_word` (3)                                                                                                                                       | `the_bounds_of_a_records_text_codes_and_counts`                                                        |
| nullable keys present       | drop `has_nullable_keys`; drop each of repair / errorCode / operatorId (4)                                                                                                         | Zod parity test                                                                                        |
| station gate                | `require_live_in`                                                                                                                                                                  | `only_a_live_station_records...`, transaction-shape pin                                                |
| batch size                  | `1..MAX` (100 refused); `0..=MAX` (empty ok)                                                                                                                                       | `a_batch_is_one_to_a_hundred...`; `each_field...`                                                      |
| idempotence                 | `stored == digest` -> `true` / `!=`                                                                                                                                                | batch-order, per-device, plan tests                                                                    |
| per-device key              | stored SQL ignores device; PK `(record_id)`                                                                                                                                        | `one_stations_record_ids_are_not_anothers`, plan pin                                                   |
| field rules                 | operator uuid; attempt bound (<=10000, MAX 10001); plain-text trim / control / length (3); text max 63; template_rev>=0; reason list; outcome list; instant; legacy repair on unit | bounds test, each-field test, Zod parity                                                               |
| receipt id only when a uuid | drop the `is_uuid` filter                                                                                                                                                          | `a_refusal_names_the_record_only_when_its_id_is_a_uuid`                                                |
| deny unknown fields         | removed                                                                                                                                                                            | `a_batch_is_one_to_a_hundred...` (valid record + extra key)                                            |
| commit                      | `commit` -> `rollback`                                                                                                                                                             | 9 tests incl. shape pin                                                                                |
| immediate tx                | `begin_write` -> `pool.begin()`                                                                                                                                                    | `the_records_are_written_in_one_immediate_transaction_after_the_station_is_checked`                    |
| stored columns              | received_at = occurred_at; digest constant; session/job swapped                                                                                                                    | `a_record_of_each_kind_is_kept_exactly_as_sent...` (exact row incl. device id, digest, host timestamp) |
| plans                       | `device_id                                                                                                                                                                         |                                                                                                        | ''` | `every_query_of_a_record_searches_by_an_index` |
| route path                  | misspelt                                                                                                                                                                           | 13 tests                                                                                               |
| logging                     | `tracing::info!` in the route; `debug!`; and an aliased `use tracing as log; log::info!(identity..)` that the source count cannot see                                              | source walk (first two); RUNTIME walk `secrets_never_reach_the_process_log` (third)                    |
| table                       | 14 migration mutants: unit+repair CHECK, error/outcome CHECK (2 shapes), FK, PK, digest/attempt/kind/reason/rev/outcome CHECKs, index column, NOT NULL on operator_id/identity     | `the_table_refuses_the_rows_no_record_may_leave`, `the_history_of_one_label...`, others                |

Survivors: none among the above. Not mutation-testable: a database error mid-batch rolling back the whole batch (needs fault injection) — pinned only by the source-shape test (one `begin_write`, check inside, one commit, no rollback, ordering).

## Other checks added

- `a_database_without_0013_and_0014_takes_0015_and_the_others_late`: the migrator minus versions 13/14 applies 0015; the full migrator then applies the rest; count equals `MIGRATOR` (vacuous for 13/14 today as they do not exist yet in this branch, becomes real when I1/ОЧ merge).
- `a_record_of_each_kind_is_kept_exactly_as_sent_and_changes_nothing`: every column of the three rows (unit, box with legacy repair and attempt 0, pallet failed), plus facts/boxes/pallets/codes counts, `audit_log` count and host revision unchanged.
- Other tests: per-device ids, in-batch repeat/mismatch, batch edges (100 ok, 101/0/shape 400), who may record, all reasons/outcomes, history-by-identity index, trail kept for a box taken apart.

## Concerns

- Audit: the brief and migration comment say reprint records, like facts, write no audit row and no revision (production trail, the row itself holds device id, subject, reason, outcome, instants). The dispatch asked for an "audit row shape exact"; I followed the brief and pinned "no audit row, no revision" plus the exact stored row. If the owner wants an `audit_log` row per record, that is a separate decision (cost: write amplification on every attempt).
- Host is stricter than Zod in places by the brief: `attempt <= 10000`, text 1-64 chars trimmed without controls, `errorCode` lower-case words, instant in `Date.toISOString` form. The station (Task 4+) must send exactly these shapes; the station's real error codes should be checked against `[a-z_]{1,64}`.
- The host also requires the `errorCode` and `operatorId` keys (not only `repair`), matching Zod.
- The no-network/Windows/hardware checks do not apply to this task.
