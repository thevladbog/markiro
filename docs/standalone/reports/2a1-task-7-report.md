# Plan 2a1, Task 7 — SSCC blocks for stations: report

Status: DONE_WITH_CONCERNS (concerns below are small design notes, nothing blocks).

BASE 9596a2a7af2e5cf0a2193bd48a5fe4b5ae6d16d2. Commit: `773d30508 feat(standalone): SSCC blocks for stations and the sscc_exhausted code` (one trailer, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). `git status --short` is empty after it.

## What was done

- `POST /v1/device/sscc/blocks` (`routes/sscc_blocks.rs::issue_block`), `audit::actions::SSCC_BLOCK_ISSUE`, route in `server.rs`, `routes/mod.rs`, the module comment of `routes/sscc.rs` replaced as the brief says.
- `proto`: `codes::SSCC_EXHAUSTED` (+ `ALL`), `SsccBlockRequest` (`deny_unknown_fields`), `SsccBlock`; fixtures `sscc-block-request.json`, `sscc-block.json`, `error-sscc-exhausted.json`, `error-codes.json`; the fixtures test.
- Webview: `API_ERROR_CODES` and `errors.api.sscc_exhausted` in `ru.json` (brief text, Cyrillic as letters).
- `AGENTS.md` "Shifts": the SSCC-blocks paragraph was inserted after the (reworded) shift-close paragraph, which was kept as it stands; the paragraph additionally says the device is re-read in the transaction.
- Deviation from the brief's code (hardening the brief did not ask for in text but the dispatch did): `require_station_in` re-reads the device inside the write transaction (`devices WHERE id = ? AND revoked_at IS NULL`, kind must still be `station`): a revoked key gets 401 `credential: device`, a non-station 403, before the repeat lookup. Existing `device_shifts` handlers do not do this; I did not touch them (see concerns).

## RED evidence (before any implementation)

- `cargo test -p markiro-host --test sscc_blocks`: 4 failed / 4 (panics at the first `200`/`400` assertions; route 404).
- `cargo test -p markiro-proto`: `error[E0432]: unresolved imports markiro_proto::SsccBlock, SsccBlockRequest` and `error[E0425]: cannot find value SSCC_EXHAUSTED in module codes`.
- `vitest run test/errors.test.ts`: 1 failed / 4 ("list exactly the host's error codes": fixture has `sscc_exhausted`, `API_ERROR_CODES` does not).

## GREEN evidence

- `sscc_blocks` + `office_admin`: 11 + 11 passed (brief: 4 + 11; the 7 extra are mine, below).
- `markiro-proto`: 5 unit + 40 fixtures + 0 doc = 45 (brief: 5 + 40).
- `vitest run test/errors.test.ts --reporter=verbose`: 4 passed, stderr empty (no TS test file changed, so no delayed-`setImmediate` run was needed).
- `sscc_blocks` run 12 more times in a row: 12/12 green (the two concurrency tests are not timing-dependent for their verdict).
- Full `cargo test -p markiro-host -p markiro-proto --offline --locked`, sandbox disabled: exit 0, 34 suites, **402 passed, 0 failed**. Proto 45; host 357 (a pure sum of per-suite lines; host = 402 - 45). The brief says host 334 / proto 45; host differs by earlier tasks' extra tests (before this task the host was 346 = 357 - 11 new here). Not edited in the plan.
- `cargo fmt --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline`: 0 warnings; prettier --check on the 7 listed files clean; eslint on `src/host/errors.ts` clean; `git diff --check` clean; Cyrillic grep: only the pre-existing `pairing-code.ts:66` in src/test, and no `\u0` introduced by me in Rust/SQL/JSON/MD (the single `\u001d` in AGENTS.md line 429 is old).

## Tests added beyond the plan (host/tests/sscc_blocks.rs, 7 more tests)

The plan's four tests let these survive (shown by running each mutant against the plan's tests alone first): `issued_at`, the stream wake, the in-transaction guards, deferred vs immediate transaction, a counter update that ignores `extension`.

1. `a_repeated_request_answers_its_own_block_after_others_were_issued` — three requests of one station plus one of a colleague with the same id; every id repeated oldest-first and newest-first returns its own block; repeat with another (unknown) prefix in the body still answers the old block; no revision, row, counter move or new block row.
2. `an_issue_stores_the_block_whole_wakes_the_streams_and_touches_no_other_counter` — the `sscc_blocks` row field by field (device, request, from/to, `consumed_through` NULL, `issued_at` = clock after advancing 5 minutes, `revoked_at` NULL); the watch channel gets the new revision; the pallet counter of the same prefix is untouched (40, rev 1); a repeat and a 400 do not wake.
3. `a_block_that_just_fits_is_whole_and_the_next_request_is_exhausted` — size 1000 against 9 999 000: exact fit, then `sscc_exhausted` leaves the counter and block rows as they were.
4. `only_a_station_asks_whatever_the_body_says` — office PC and handheld get 403 even with a bad body (kind before body); the handler called with a forged `AuthDevice{kind: Station}` for the office PC's id is refused 403 in the transaction; nothing written.
5. `a_station_revoked_meanwhile_gets_no_block` — the handler is called directly for a station revoked in the DB after it had a block: a new request and a repeat of the old one are both 401 `credential: device`, nothing written (deterministic stand-in for "revoked between the extractor and the transaction").
6. `an_issue_waiting_for_the_write_lock_starts_after_the_block_that_held_it` — deterministic concurrency: a colleague's issue is held open in a `begin_write` transaction (counter moved to 3500, block 1500-3499 inserted, not committed); this station's request, called directly, provably blocks (200 ms timeout), then after the holder commits it gets 3500-5499, rows are disjoint, counter 5500 rev 3. Same pattern as `an_entry_waiting_for_the_write_lock_...` of Task 5.
7. `requests_arriving_together_get_disjoint_blocks_and_a_repeat_gets_the_same` — `tokio::join!` of four requests (two stations, same request id twice from one): all 200, the duplicate answers the same block, exactly three rows, serial ranges `{1500-3499, 3500-5499, 5500-7499}` in some order, counter 7500, three audit rows. The verdict does not depend on the arrival order.

## Mutant table

Restore proof for every row: `shasum -a 256` of `host/src/routes/sscc_blocks.rs` (or the proto/webview file) before and after identical, `cmp` against a pre-mutation copy silent (the runner prints `restore_ok: true`; sha of sscc_blocks.rs before and after: 32386294c44f...). "Plan tests" = the plan's four tests; "final" = the 11 tests.

| Mutant (one line)                                                        | Test that failed                                                                                                          | Note                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| M1 `to = next + size - 1` (no cut at the end)                            | `a_block_is_cut_short_...exhausted`                                                                                       | plan M1                                |
| M1b `.min(capacity)` instead of `capacity - 1`                           | same                                                                                                                      |                                        |
| M2 repeat lookup `.filter(\|_\| false)`                                  | `a_station_gets_a_block_and_the_counter_moves_past_it`                                                                    | plan M2                                |
| M3 `rev = rev + 0 * ?` (counter revision kept)                           | same                                                                                                                      | plan M3                                |
| M4 read `... AND (request_id = ? OR 1)`                                  | `a_block_is_cut_short...`, `a_station_gets_a_block...`                                                                    |                                        |
| M5 read `(device_id = ? OR 1) AND ...`                                   | `only_a_station_gets_blocks_and_only_of_a_known_box_counter` (other station's block)                                      |                                        |
| M6 `SELECT pallet_block_size`                                            | four tests                                                                                                                |                                        |
| M7 `next > capacity` (exhausted too late)                                | `a_block_is_cut_short...` (500 from the CHECK)                                                                            |                                        |
| M8 exhausted with `details: {}`                                          | `a_block_is_cut_short...`                                                                                                 |                                        |
| M9 counter stops at `to` instead of `to + 1`                             | four tests                                                                                                                |                                        |
| M10 row `from_serial` bound to `to`                                      | `a_station_gets_a_block...` (repeat differs)                                                                              |                                        |
| M11 `issued_at` bound to `""`                                            | **survived the plan tests** → `an_issue_stores_the_block_whole_...` (new)                                                 |                                        |
| M12 audit `target_type` `sscc_blocks`                                    | `a_station_gets_a_block...`                                                                                               |                                        |
| M13 audit `toSerial: next`                                               | same                                                                                                                      |                                        |
| M14 `tx.commit()` instead of `commit_with_revision` (no wake)            | **survived** → `an_issue_stores_the_block_whole_...` (new)                                                                |                                        |
| M15 `client_uuid` call removed                                           | `only_a_station_gets_blocks_...`                                                                                          |                                        |
| M16 extension guard `if false`                                           | same (pallet counter exists, 200 instead of 400)                                                                          |                                        |
| M17 early kind guard removed                                             | **survived** (the in-transaction check catches it) → `only_a_station_asks_whatever_the_body_says` (new: kind before body) |                                        |
| M17b in-transaction kind check `if true`                                 | **survived** → `only_a_station_asks_...` (forged `AuthDevice`)                                                            |                                        |
| M17c both kind guards removed                                            | `only_a_station_asks_...` and `only_a_station_gets_blocks_...`                                                            |                                        |
| M18 `revoked_at IS NULL` removed from the in-transaction read            | **survived** → `a_station_revoked_meanwhile_gets_no_block` (new)                                                          |                                        |
| M19 `state.pool.begin()` instead of `begin_write`                        | **survived** → `requests_arriving_together_...` and `an_issue_waiting_for_the_write_lock_...` (new)                       |                                        |
| M20 repeat answered only if the body prefix matches                      | **new** `a_repeated_request_answers_its_own_block_...`                                                                    |                                        |
| M21 unknown prefix → `unwrap_or(0)`                                      | `only_a_station_gets_blocks_...`                                                                                          |                                        |
| M24 counter UPDATE `(extension = ? OR 1)` (moves the pallet counter too) | **survived** → `an_issue_stores_the_block_whole_...` (pallet counter unchanged)                                           |                                        |
| M25 repeat answered only while it is the newest block                    | **new** `a_repeated_request_answers_its_own_block_...` ("even after others were issued")                                  |                                        |
| P1 `SsccBlockRequest` without `deny_unknown_fields`                      | proto `sscc_block_fixtures_round_trip_and_a_station_never_names_the_size`                                                 | (host `size` assertion also covers it) |
| P2 `SSCC_EXHAUSTED` missing from `codes::ALL`                            | proto `the_error_code_fixture_lists_every_code`                                                                           |                                        |
| P3 constant value `sscc_exhaustd`                                        | the same test and the block-fixtures test                                                                                 |                                        |
| P4 `"sscc_exhausted"` removed from `API_ERROR_CODES`                     | vitest `list exactly the host's error codes`                                                                              |                                        |
| P5 `errors.api.sscc_exhausted` text removed                              | vitest `have a text for every code the shell and the host send`                                                           |                                        |

Mutants M1-M25 were run twice where noted (plan tests alone, then the final file); the ones not marked "survived" were killed by the plan tests and remain killed by the superset.

## Files changed (commit 773d30508, 15 files, +973 -6)

host: `src/routes/sscc_blocks.rs` (new), `src/routes/mod.rs`, `src/routes/sscc.rs` (module comment), `src/audit.rs`, `src/server.rs`, `tests/sscc_blocks.rs` (new, 11 tests); proto: `src/lib.rs`, `tests/fixtures.rs`, `fixtures/{sscc-block-request,sscc-block,error-sscc-exhausted,error-codes}.json`; webview: `src/host/errors.ts`, `src/i18n/ru.json`; docs: `AGENTS.md`. No manifests, lockfile, migrations, `src-tauri` or `apps/station` touched.

## Self-review

- Every guard of the dispatch list has a failing mutant: stations only (early + in-transaction), `extension` 0 only, unknown prefix, block size from the site, short block at the end and `sscc_exhausted` with prefix + extension, counter past the block with a new revision in the same transaction (revision of the counter equals the host revision), `sscc_below_floor` and `stale_revision`, repeat semantics (own block after others, other station's id is its own), audit row exact (actor, action, target type/id, result, details), stream wake, deterministic no-overlap, in-transaction device re-check.
- The wake is asserted on the `revisions` watch channel (as Task 5's test does), not through a real SSE connection.
- Not run: browser/Windows/hardware checks (none relate), the shell crate (`src-tauri`) tests (untouched), `pnpm test`/`typecheck`/`lint` of the whole package (only `errors.test.ts` and eslint on `errors.ts`, because no other TS file changed; `ru.json` is checked by `errors.test.ts`).

## Concerns

1. The in-transaction device/session re-check exists only in the new route. `device_shifts.rs` (`create_device_shift`, `enter_shift`) and the other device writes read nothing after `begin_write`, so a station revoked while its request waits for the lock can still open/create a shift. Not changed here (outside Task 7); worth a follow-up or a decision of the controller.
2. A repeated `requestId` answers the old block even if the body now names another (valid-format) prefix, by the plan's rule "whatever the body says"; I pinned it with a test. A malformed body is still rejected before the lookup.
3. The host does not check that the station has an active shift on that prefix (the brief does not ask for it); any station may draw blocks of any known box counter. The station-side rule (plan 2a6) is the only throttle for now.
4. Counts: host 357 (brief 334), proto 45 (45); the difference is earlier tasks' extras plus my 7.
