# plan СКЛ, Task 6 report: delivery of the warehouse records and retention

Status: DONE_WITH_CONCERNS. Commit: `f290f84f4 feat(standalone): deliver warehouse reprint records after the facts, hourly retention (plan СКЛ task 6)` on `claude/wh` (base 5936f6f7f). Tree clean after commit.

## What was done

- `src/local/warehouse-sender.ts` (brief code verbatim): `sendWarehouseBatch`, `WAREHOUSE_UNSENT_SQL`, `WAREHOUSE_ATTEMPT_SQL`, `WAREHOUSE_RECEIPT_SQL`, `MAX_WAREHOUSE_BATCH = 100`.
- Plan pins: the three texts added to `test/floor-schema.test.ts` (Node 3.53). The shell side (3.46) already held the same texts from Task 4 (`the_warehouse_reads_search_an_index`); the TS-vs-Rust text agreement test passes, so both pins are byte-equal.
- `src/app/host-link.ts`: `sendWarehouseRecords?` option, delivery after the facts when none wait (`!more`). Beyond the brief (constraint "never retried hot, back-off"): a non-shell failure of the warehouse route does NOT touch the facts line (`facts_sent`, never `facts_failed`) but arms a retry of its own: `nextSyncRetryMs(warehouseFailures)` (2 s, 4 s ... 60 s) with its own counter (reset on a delivery that went through), the host's `RESTORE_HOLD_RETRY_MS` for `restore_pending` (same `factsHeld` hold as the facts), none while the link is down, none for `not_paired`. A refused key / changed certificate still ends the link. The brief's variant swallowed the error with no retry at all (records would wait for the next unrelated trigger).
- `src/app/App.tsx`: `sendWarehouseRecords: hostApi.sendWarehouseRecords`; the hourly pass runs `purgeWarehouseSessions` after `purgeAcknowledged`, each in its own try/catch (neither holds the other back), dispatch `outbox_changed` when either removed something, the pass still fails if one failed.
- Addendum "forget guard": shell `UnsentGuard` now counts `outbox` AND `wh_outbox` records with `acked_at IS NULL` (`UNSENT_TABLES`; `count_unsent(connection, guard, skip_missing)`). An open database must have both tables (a missing/unreadable one is an error, never 0); a database that did not open skips a table that is not there (an older build). The webview count shown to the person (`countUnsentRecords` in `src/local/outbox.ts`) adds the `wh_outbox` unsent records, pairing-scoped or all-pairings. Error code stays `unsent_facts`.
- Retention keeps unresolved records: `DUE_SESSIONS_SQL`/`PURGE_SESSION_SQL` (Task 4) already exclude any session with a record whose outcome is not `accepted` (unsent or rejected); the new app tests prove it through the real hourly pass.

## Anchor adaptations

- None semantic. All anchors matched once. `FactReceipt` was already imported in `host-link.ts`. The `scheduleRetention` block in App.tsx matched exactly; extended as described above (try/catch pair instead of the brief's sequential awaits; lint `only-throw-error` forced `throw failure instanceof Error ? ...`).
- Brief step 5 asked for tests "by the pattern of host-link-facts.test.ts"; I wrote them in `test/warehouse-sender.test.ts` (names below) and four app-level tests in `test/app.test.tsx` (App wiring and retention, which the brief did not name but the addenda require).
- Brief step 6's mutation was reworked into the table below.

## Tests added (names)

`test/warehouse-sender.test.ts`: the brief's 2 tests, "the warehouse sender's guards" (8: 100 cap/oldest first/`more`; only this pairing's waiting records; attempt counted before send and kept on failure; send/receipt instants; receipt without id by place; more receipts / swapped / conflict keep nothing; no overwrite of a receipt got meanwhile; receipts whole or not at all), "the warehouse records on the link" (13: go once online + outbox_changed; after the last fact batch only; batch of 100 asks for the next; no route = wait with 0 attempts; 404 = not a facts failure, 2 s / 4 s back-off; waits restart after success; refused key ends the link; restore_pending holds for the host's time; not_paired not retried; link drop in flight; route changed on rerender; no timer while the link is down; nothing told after unmount).
`test/outbox.test.ts`: count includes `wh_outbox`. `test/app.test.tsx` (describe "the warehouse reprint's sessions in the hourly pass"): delivery wired in App; purge keeps refused/unsent/recent, removes the accepted; `outbox_changed` for a session-only purge; neither purge holds the other back (both orders, app told in both). `src-tauri/tests/local_db.rs`: `a_forget_refuses_while_unsent_warehouse_records_remain`, `a_warehouse_outbox_that_cannot_be_counted_stops_a_forget`, `a_missing_warehouse_outbox_in_an_open_database_stops_a_forget`, `an_unopened_database_counts_its_warehouse_records_too`; `src-tauri/tests/ipc.rs`: `forgetting_the_device_waits_for_this_pairings_unsent_warehouse_records`.

## RED / GREEN

- RED: `vitest run test/warehouse-sender.test.ts` -> "Failed to resolve import ../src/local/warehouse-sender.js" (`/tmp/claude/impl-skl-t6/red.log`). GREEN after the sender: 37 passed with floor-schema. The Rust/guard and link/App tests were written together with their code; their RED is shown by the mutants below (each guard's mutant fails them).
- Final: new/changed Vitest files `--reporter=verbose`: stderr 0 bytes, 0 `stderr |` lines (sender+outbox+schema 62; app+host-link suites 220). Delayed-`setImmediate` stand (3 ms), temp files deleted: sender+host-link-{facts,shifts,restore}+outbox 92 passed; `app.test.tsx` 155 passed.
- Full Vitest `exec vitest run --testTimeout=60000 --hookTimeout=60000`: 154 files, 4784 passed (Task 5 baseline 4756, +28: sender 23, outbox 1, app 4).
- Cargo: `--test local_db` 35 passed (was 31, +4), `--test ipc forgetting` 5, then ONE full `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed: exit 0, 1171 passed, 0 failed, 0 warnings (Task 4 baseline 1166, +5). `cargo fmt --check` 0; `cargo check -p markiro-host -p markiro-proto -p markiro-standalone --all-targets` 0 warnings; typecheck 0; lint 0; webview build 0; prettier gate live-proven (mis-formatted scratch file exit 1, deleted) and clean on all changed TS/TSX; `git diff --check` clean; `grep -rnF '\u04'` only `pairing-code.ts:66`.

## Mutants (harness `/tmp/claude/impl-skl-t6/mut.py`, `rmut.py`; every restore asserted by sha256 against `orig/`/`rorig/`, Rust files touched after restore; final trees equal)

All killed unless noted. Tests: sender+outbox+floor-schema for S/O; sender for H; `app.test.tsx -t "warehouse reprint"` for A.

| Mutant (one line)                                                                | Killed by                                                                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 drop `ORDER BY seq`                                                           | text agreement pin only (behaviourally invisible: the partial index already yields seq order)                                                   |
| S2/S2b `MAX_WAREHOUSE_BATCH` 101 / 99                                            | "sends at most 100 ...", "ask for the next batch at once"                                                                                       |
| S3 / S4a / S4b drop `acked_at IS NULL` / device / host filter of the unsent read | plan pin + "sends only this pairing's records that wait"                                                                                        |
| S5 `attempts` not counted; S6 `sent_at` NULL                                     | brief test 1; "counts the send before it leaves"                                                                                                |
| S8 receipt without `acked_at IS NULL`                                            | "does not overwrite a receipt a record got meanwhile"                                                                                           |
| S9 code column dropped; S10 receipt stamped with epoch                           | brief test 1; "stamps the send and the receipt with their own instants"                                                                         |
| S11 `!==` -> `<` receipt count                                                   | "refuses more receipts than records ..."                                                                                                        |
| S12 id check off; S13 null id refused; S14 conflict allowed                      | brief test 2 / "refuses ... swapped"; "answers a receipt without an id by its place"; brief test 2 + "refuses ..."                              |
| S15/S16 `more` always / never                                                    | brief test 1; "sends at most 100 ..."; "ask for the next batch at once"                                                                         |
| S18 attempts list emptied; S19 payload sent as string; S21 `sent: 0`             | brief test 1, "keeps nothing ...", "sends at most 100"                                                                                          |
| S22 drop `+` on host_id of attempt                                               | text pin                                                                                                                                        |
| H1 drop `!more &&`                                                               | "go after the last batch of facts, not between batches of them"                                                                                 |
| H2 rethrow every error; H15 failure not remembered                               | "are no failure of the facts ... 2 s, 4 s" (`facts_failed` / no retry)                                                                          |
| H3 shell action swallowed                                                        | "ends the link on a refused key"                                                                                                                |
| H4 failure count not reset; H5 not incremented                                   | "start their waits again after a delivery that went through" (needed a strict call count, not `waitFor`, whose timeout is faked); back-off test |
| H6 retry armed while the link is down                                            | "set no wait of their own while the link is down" (timer count; the run's own online check made it otherwise invisible)                         |
| H7 / H16 / H18 restore_pending wait ignored / not applied / not held             | "wait for the host's own time when it holds ..."                                                                                                |
| H8 `not_paired` retried                                                          | "are not retried for a host that does not know the device"                                                                                      |
| H9 no `active` check after the warehouse send                                    | "tell the app nothing once the link is gone"                                                                                                    |
| H10 `outbox_changed` only for facts; H11 `more` of the warehouse ignored         | "go once the link is online ..."; "ask for the next batch at once when a batch of 100 went"                                                     |
| H12 send called with no route                                                    | "wait when the link has no route" (attempts stay 0)                                                                                             |
| H17 dependency list without the route                                            | "go by the route the link is given now" (all other hook inputs made stable in the helper, otherwise a rerender restarts the link anyway)        |
| A1 warehouse purge not run; A2 dispatch threshold; A6 dispatch always            | app "removes a session ...", "tells the app the outbox changed when only a session went", existing "does not tell the app ... deleted nothing"  |
| A3 / A4 one purge failing holds the other / the dispatch back                    | "lets neither purge hold the other back" (both orders; A4 needed the app-told assertion)                                                        |
| A5 route not wired in App                                                        | "sends the records of a reprint to the host once it is on the link"                                                                             |
| O1 / O3 / O2 `outbox.ts` wh part dropped / `IS NOT NULL` / device filter         | "count the warehouse reprint's records ... with the facts"                                                                                      |
| R1 `UNSENT_TABLES` without `wh_outbox`                                           | local_db x3 + ipc test                                                                                                                          |
| R2 / R5 / R6 skip-missing logic dropped / inverted / always off                  | `an_unopened_database_counts_its_warehouse_records_too`, `a_database_that_did_not_open_is_counted_without_being_changed`                        |
| R3 `+=` -> `=` (not a sum) ; R4 `IS NOT NULL`                                    | `a_forget_refuses_while_unsent_warehouse_records_remain`, `a_forget_refuses_while_unsent_records_remain`                                        |
| R7 open database skips a missing table                                           | `a_missing_warehouse_outbox_in_an_open_database_stops_a_forget` (added after R7 first survived)                                                 |

Unkillable (reported): the `if (failure !== null) throw ...` of the retention pass changes nothing observable (`scheduleRetention` discards the result of `run`); kept so the pass honestly fails for a future caller.

## Concerns

- Visibility of a refused (rejected) record: it stays in `wh_outbox` with its code, keeps its session through retention, and is never resent, but nothing on screen shows or clears it yet (status bar / "Очередь отправки" belongs to later tasks / plan ОЧ). The forget guard counts only records with no receipt, as for facts.
- The `unsent_facts` texts (`shell.unsent.*`, `device...unsent_facts`) still say "записей смен"/"данные смен"; app tests assert them, so unchanged. A forget refused for reprint records only reads slightly off.
- The retry of the warehouse route shares the `factRetry` timer slot and the `factsHeld` flag with the facts (one pending wait at a time); a `restore_pending` from the reprint route holds the facts too (the host holds both routes at once).
- A pre-existing environment issue: `packages/domain/dist` in the worktree was stale after the merge (3 `forms-parity` failures "ПАЛЕТА" vs "ПАЛЛЕТА"); rebuilt with `pnpm --filter @markiro/domain build` (ignored output), then all green. Not part of the commit.
- Windows/hardware/real host: not exercised; the host's `warehouse/reprints` route is Task 3's and is faked here.
- `graphify update .` not run (worktree outside the sandbox write scope).

## Files

Created: `apps/standalone/src/local/warehouse-sender.ts`, `apps/standalone/test/warehouse-sender.test.ts`. Modified: `src/app/host-link.ts`, `src/app/App.tsx`, `src/local/outbox.ts`, `test/floor-schema.test.ts`, `test/outbox.test.ts`, `test/app.test.tsx`, `src-tauri/src/local_db.rs`, `src-tauri/tests/local_db.rs`, `src-tauri/tests/ipc.rs`.
