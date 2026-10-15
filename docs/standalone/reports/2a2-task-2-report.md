# Plan 2a2, Task 2 — report

Status: DONE_WITH_CONCERNS (concerns below are decisions for the controller, not blockers).
Worktree `/tmp/claude/wt/2a2-facts`, branch `claude/2a2-facts`. BASE `6fcee4307` (Task 1). Commit `1d72a9ef6 feat(standalone): facts in batches with a receipt per record, scans and the registry of codes`. `git status` clean. One `Co-Authored-By: Claude Opus 5.5` trailer (the repository pin).

## What was done

- Every anchor of the brief matched exactly once; plan code applied verbatim (extracted by script from the brief, no retyping), except as listed under "Deviations". Nothing in manifests, lockfile, `src-tauri`, `src/` or applied migrations changed.
- Files: `host/migrations/0010_facts.sql`, `host/src/facts/{mod,boxes,registry,scan}.rs`, `host/src/routes/{facts,mod}.rs`, `host/src/{server,auth}.rs` (`AuthDevice::require_live_in`, `require_station_in` now built on it), `host/src/clock.rs` (doc comment only), `proto/src/lib.rs`, `proto/fixtures/facts-{request,response}.json`, `proto/tests/fixtures.rs`, `host/tests/facts.rs`, `host/tests/support/app.rs`, `AGENTS.md`.

## Deviations from the plan's text

1. `registry.rs`: the plan's `owner()` SQL had runs of spaces where line continuations belong (`created_from,          o.device_id`); rewritten with `\` continuations. Same SQL.
2. Migration `0010` strengthened beyond the plan (it is this plan's own until released). Added, all checked against the plan's later tasks (5, 6, 7) so no planned writer breaks:
   - `scans`: `box_id REFERENCES boxes (id)`; `CHECK ((verdict='duplicate') = (duplicate_source IS NOT NULL))`; `CHECK ((verdict='invalid') = (raw_kind <> 'km'))`; code columns (`code_hash`, `gtin14`, `serial`, `canonical`) all null or all set; `length(code_hash) = 64`; `UNIQUE (device_id, record_id)` (`scans_record`).
   - `UNIQUE (device_id, record_id)` on `box_exceptions` and `shift_close_events` (one row per record; a bug that applied a record twice now fails loudly instead of duplicating a production fact).
   - NOT added, deliberately: any check on `boxes.membership_digest` / `item_count_reported` (the plan's own test `close_box_directly` closes a box without them), and `removed_at`/`displaced_at` exclusivity on `box_items` (Task 5's undo may set `removed_at` on a displaced item).
3. `clock.rs` doc comment of `format_timestamp` said "the only timestamp format stored in the database"; false from this task on (Task 1 review carry-forward). Reworded; `AGENTS.md` now says the two formats (device instant, 24 chars; host timestamp, 20 chars) are never compared with each other.
4. `AGENTS.md`: the plan's two paragraphs plus one of mine (formats, schema invariants, and "a refusal of a record is permanent" — see concern 1).

## Tests added beyond the plan (host `facts` suite: plan 10, measured 17)

All in `host/tests/facts.rs`, after the plan's ten. Each was written against a one-line mutant that the plan's tests let through (found by reading, then confirmed by the mutant table).

1. `records_of_one_batch_see_what_the_records_before_them_wrote`: same record twice in one batch (replay), same id changed in the batch (`payload_mismatch`), two records of one code in one batch in both scan-time orders (conflict; take-back), so batch application order matters.
2. `the_whole_record_not_only_its_data_keys_its_receipt`: same id with another operator, shift, kind, extra key or box is `payload_mismatch`, no row written.
3. `the_envelope_is_read_strictly_and_an_absent_operator_is_none`: absent `operatorId` accepted as null; extra key, missing `kind`/`data`, `kind: 1` -> `invalid_record` with a readable id; `data: null` / `[]` -> field `data`; kept receipts exact.
4. `a_journal_row_and_a_receipt_keep_what_was_sent_and_when`: host clock moved first; `duplicate`/`host`, `sscc`, `unknown`, `rawLength` 18 and 0; `fact_receipts.digest` equals `record_digest`, `received_at` of receipts, scans and boxes is the batch's instant; a second scan into an open box leaves it untouched.
5. `an_earlier_scan_of_a_code_in_the_same_box_replaces_the_later_item`: the unique index of live items never refuses a displacement inside one box.
6. `a_scan_that_loses_its_code_still_opens_its_new_box`.
7. `the_schema_refuses_the_rows_no_fact_may_leave`: direct SQL, 70-odd statements; every CHECK, FK and unique index of `0010` has a refused row paired with an accepted control that differs in one thing; refusals pinned by the constraint text (e.g. `UNIQUE constraint failed: box_items.box_id, box_items.code_hash`).

## RED / GREEN

- RED host (`--test facts`): `E0432 unresolved import markiro_host::routes::facts`, `E0425 cannot find function receive in module markiro_host::facts`, plus type-annotation errors that follow. RED proto: `cannot find type FactKind` / `FactOutcome` / `ScanVerdict` / `ScanRawKind` / `DuplicateSource` (27 errors).
- GREEN (plan's code only): `--test facts` 10 passed on the first run; `-p markiro-proto` 5 + 42 passed. After my additions: `--test facts` 17 passed.

## Counts (plan vs measured)

|                                                        | plan (with Task 1's +7)                  | measured                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `facts` suite                                          | 10                                       | 17 (+7 mine)                                                                                                                            |
| `-p markiro-host -p markiro-proto` outside the sandbox | host 32 suites / 387 tests, proto 2 / 47 | host 32 suites / 394 tests, proto 2 / 47: 34 suites, 441 tests, 0 failed, 0 code warnings (one environmental `xcrun` build-script note) |

Not run: Vitest (no webview file changed by this task), the delayed-`setImmediate` stand (no React), `-p markiro-shell`/`--workspace` (shell not touched), Windows, any live host/station pair. `cargo fmt --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings; `prettier --check` on `AGENTS.md` and both JSON fixtures clean; `git diff --check` clean; `grep '\u04'` finds only `pairing-code.ts:66`; the only `\u00` in new JSON is the GS1 separator the plan shows.

## Mutants

Harness `/tmp/claude/t2/mut.py` (outside the tree): copies the file, applies one exact-once replacement, runs `cargo test … --test facts`, restores. After the run all eight touched files hash identically to before (`cmp` on the before/after sha256 lists silent; `restored: true` in every record, `/tmp/claude/t2/mut-results-run1.jsonl`, 84 mutants). Originals under `/tmp/claude/t2/orig/`.

Plan mutants M1–M24: every one fails exactly the tests the brief names, or those plus more of mine (M2 also my tests 1 and 2; M3 also mine; M7 also test 3; M8, M14, M18, M20 more; none fails fewer).

| Mutant                                                             | Failing tests (key)                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| M1 receipt lookup without device                                   | `a_record_sent_again_with_other_content…`                                                   |
| M2 digest not compared                                             | same + `records_of_one_batch…`, `the_whole_record…`                                         |
| M3 receipt not stored                                              | 11 tests                                                                                    |
| M4 unreadable id stored                                            | `a_record_the_host_cannot_read…`                                                            |
| M5 no entry check                                                  | `a_record_names_a_shift_the_device_entered…`                                                |
| M6 operatorId unchecked                                            | `every_field_of_a_scan…`                                                                    |
| M7 kind not stored                                                 | `a_record_sent_again…`, `a_record_the_host_cannot_read…`, `the_envelope_is_read_strictly…`  |
| M8 details lost on replay                                          | `a_record_the_host_cannot_read…`, `the_earliest_scan…`                                      |
| M9–M13 scan field rules (rawKind, GTIN, closed box, 64/1024 bytes) | the brief's tests                                                                           |
| M14 box opened with host time                                      | `a_batch_is_answered…`, `a_journal_row…`, `a_scan_that_loses…`                              |
| M15 operator lost                                                  | `a_batch_is_answered…`                                                                      |
| M16 other device's box in same shift                               | `an_accepted_scan_goes_into_an_open_box…`                                                   |
| M17 tie displaces the owner                                        | `the_earliest_scan…`                                                                        |
| M18 displaced_at NULL                                              | `the_earliest_scan…`, `an_earlier_scan_of_a_code_in_the_same_box…`, `records_of_one_batch…` |
| M19 winner/loser swapped, M20 sameDevice inverted                  | `the_earliest_scan…` (+ `records_of_one_batch…` for M20)                                    |
| M21 deferred transaction                                           | `a_batch_waiting_for_the_write_lock…`                                                       |
| M22 device not re-read, M23 revoked not seen                       | `a_device_revoked_meanwhile_keeps_nothing`                                                  |
| M24 batch of 100 refused                                           | `a_record_names_a_shift_the_device_entered…`                                                |

My code mutants (all killed):

| Mutant                                                | Killed by                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| N1 digest of `data` only                              | `the_whole_record…`, `a_journal_row…` (survived the plan's tests)                                            |
| N2 receipt `received_at` wrong                        | `a_journal_row…` (survived the plan's tests)                                                                 |
| N3 `scans.received_at` = scanned_at                   | `a_batch_is_answered…`, `a_journal_row…`                                                                     |
| N4 `boxes.received_at` = scanned_at                   | `a_journal_row…` (survived the plan's tests)                                                                 |
| N5 `duplicate_source` always `local`                  | `a_journal_row…` (survived the plan's tests)                                                                 |
| N6 receipts reversed                                  | 8+ tests                                                                                                     |
| N7 batch takes a revision and wakes                   | `a_batch_is_answered…` (revision, wake, audit assertions)                                                    |
| N8 records applied in reverse, receipts reversed back | `a_batch_is_answered…`, `records_of_one_batch…`                                                              |
| N9 conflict `detected_at` = scanned_at                | `the_earliest_scan…`                                                                                         |
| N10 gtin14 stored as serial                           | `a_batch_is_answered…`                                                                                       |
| N11 tie-break against host time                       | `the_earliest_scan…`, `a_scan_that_loses…`, `records_of_one_batch…`                                          |
| N12 shift number replaced in the winner wire          | `the_earliest_scan…`, `records_of_one_batch…` (first attempt did not compile; rerun after fixing the mutant) |

Schema mutants (each drops one CHECK / FK / unique): S1–S37 and A1–A9 (arms of the exception-kind check). All killed by `the_schema_refuses_the_rows_no_fact_may_leave`, after three survivors the first run exposed and I fixed in the test: S13b (canonical arm of the all-or-nothing code columns: no case), S27 (`kind IN` fragment matched the text of the big kind check, a false match: fragment made exact), A6 (clear with a target: no case). Re-run after the fix: killed.

## Self-review against the lessons

- Field-by-field row copies: journal, receipts, boxes, items, owners, conflicts all asserted column by column, with distinct values per column (N1–N5, N10 prove it).
- Guards and codes: every `invalid_record` field, `unknown_shift`, `not_entered`, `gtin_mismatch`, `box_unknown`, `box_closed`, `payload_mismatch` pinned; batch bounds 0, 1, 100, 101 (1 via the single-record batches).
- Receipt order and isolation: bad records between good ones; N6 and N8 prove order tests bite.
- Idempotency scope: another device's same id is a separate record; the whole record (not only `data`) keys the digest; a rejected record stays rejected on resend and is not applied.
- Revision/wake: asserted unchanged and not woken (N7). Audit rows asserted unchanged.
- In-transaction re-checks: deterministic (handler called directly with a forged `AuthDevice`; a second writer holds the lock) — no timing hopes (the 200 ms timeout only asserts that the waiter is still pending, as in 2a1).
- Earliest-scan-wins in both orders, across batches and inside a batch, same-box displacement, tie, one-millisecond boundary.
- Timestamps compared as TEXT only inside the device format (`scanned_at` vs `scanned_at`, validated 24 chars); `AGENTS.md` and `clock.rs` document the two formats.
- Logs: only device id, record id and receipt code are logged (`mod.rs`); no payload, code, hash or serial. The process-log walk with a crypto tail belongs to Task 8 (`no_secrets_in_logs`).

## Concerns for the controller

1. **A rejected record is rejected for good** (plan-mandated: the receipt, `rejected` included, is kept forever and replayed). A fact refused for a reason that later changes (`not_entered` before the device entered the shift, `box_unknown`/`box_closed` after an ordering slip) never succeeds under the same id. The station (plans 2a5/2a6) must either never resend such a record, or send it under a new id; documented in `AGENTS.md`. If that is not wanted, the receipt of a `not_entered`/`unknown_shift` rejection would have to stay unkept — a product decision, not made here.
2. **Poison pill by design:** a database error fails the whole batch (500) and the station resends the same batch forever. By construction no valid record can cause one (I checked the unique indexes against every write path of the plan), but the new unique indexes make a future writer bug loud instead of silent. A SAVEPOINT per record would let a handler bug reject one record instead of wedging the outbox; not in the plan, not done.
3. **Schema additions (deviation 2)** bind later tasks: Task 5 must write one `box_exceptions` row per record and Task 6 one `shift_close_events` row per record (the plan's code does), and tests of later tasks that insert such rows directly need distinct `(device_id, record_id)`. The sibling tasks' implementers should be told.
4. `received_at` is read before the write lock (`routes/facts.rs`), as the plan has it, so a batch that waited for the lock stamps its arrival, not its write. `displaced_at`/`detected_at` of two concurrent batches may thus be ordered by arrival. Harmless today (nothing orders by it); noted.
5. A scan into a closed shift is accepted (no status check) until Task 6 adds the late-data mark.
6. Environment only: the full run's `Running` count is 34 (32 host + 2 proto); the machine ran the 20-minute run in under ten.
