# plan СКЛ — final fix wave report (branch claude/wh, 74362fe17..2d511fb38)

Status: DONE_WITH_CONCERNS (one concern: commit 1 edits this plan's own, unreleased shell migration 0012 — see Concerns).

Worktree `/tmp/claude/wt/wh`, base 74362fe17, tree clean after the last commit. «Отклонения при исполнении» of the plan NOT written (controller's).

## Commits

| SHA       | Subject                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| f96697d4f | fix(standalone): a host restored from a copy gets the warehouse reprint records back |
| c8aead803 | fix(standalone): the warehouse delivery waits on a retry of its own                  |
| d0fb48432 | test(standalone): warehouse reprint gaps                                             |
| 2d511fb38 | docs(standalone): warehouse reprint limits                                           |

Each message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (checked with `git log -1 --format=%B | grep -c`).

## 1. I1 — restore reopens `wh_outbox` (f96697d4f)

- `src/local/restore-reconcile.ts`: new `WAREHOUSE_REOPEN_SQL` = `UPDATE wh_outbox SET outcome = NULL, outcome_code = NULL, acked_at = NULL WHERE host_id = ? AND device_id = ? AND outcome = 'accepted' AND acked_at >= ?`, put in the SAME reconcile transaction (between `REOPEN_SQL` and `SETTLE_SQL`, same `since`). Predicate: this pairing only, window's first instant inclusive, accepted only (rejected never resurrected; no `dismissed` state exists in this branch — ОЧ adds it; `= 'accepted'` excludes any later state too). Once per epoch: it rides on the settling (`SETTLE_SQL expectedChanges: 1` + `DUE_SQL`), so a second run of the same epoch is `none`, and a later epoch noted meanwhile rolls it back (`changes_mismatch`). `attempts`/`sent_at` kept.
- Index: new partial `wh_outbox_accepted ON wh_outbox (host_id, device_id, acked_at) WHERE outcome = 'accepted'` added to `src-tauri/migrations/0012_warehouse_reprint.sql` (commented). Partial on purpose: no other statement names `outcome = 'accepted'`, so it attracts nothing (a non-partial version DID attract the unsent reads — mutant IX1 below broke the warehouse «search an index» pins). `wh_outbox_session (session_id, host_id, device_id)` and `wh_outbox_unsent` unchanged; measured plans of the retention/unsent/forget statements unchanged.
- Plans pinned in BOTH lists: `test/floor-schema.test.ts` (Node 3.53.4) `["SEARCH wh_outbox USING INDEX wh_outbox_accepted (host_id=? AND device_id=? AND acked_at>?)"]` exactly + text check (8 reconcile statements now); `src-tauri/tests/local_db.rs` (shell 3.46) `RESTORE_REOPEN_WAREHOUSE` in `the_floors_repeating_reads_search_an_index` (array size 83 → 84). `test/warehouse-store-guards.test.ts` index list + column order updated.
- Tests: `restore-reconcile.test.ts` new describe (5): window edge in / one ms before out; refused kept + waiting untouched; other device/host untouched; rolls back with a later epoch; once per epoch. `host-link-restore.test.ts`: restore scenario — a restored host gets back the accepted reprint record (not the refused one), after blocks and facts (`link()` got an optional `sendWarehouse`).
- AGENTS «Backups and restore» sentence + spec §30 bullet «Восстановление хоста из копии».
- RED: mutant W1 (statement removed = base behaviour) fails 4 tests incl. the scenario.

## 2. I2 — own retry for the warehouse delivery (c8aead803)

- `src/app/host-link.ts`: `warehouseFailures` + `warehouseRetry` + `cancelWarehouseRetry` (cleared in `stopAll` and on a non-online status). The fact run sends the records only when `!more && route && warehouseRetry === null`; it never cancels `warehouseRetry` (`cancelFactRetry` touches only the facts). A non-restore warehouse failure arms only `warehouseRetry` (`nextSyncRetryMs(warehouseFailures)`); its end triggers `factSender` only `if (factRetry === null)` — a running facts' retry/hold sends the records after the facts at its own end, so the warehouse timer never cuts the facts' pause. `restore_pending` from the reprint route still arms the facts' hold (`factRetry` 60 s + `factsHeld = true`), as a facts hold (host-wide 503). Status dispatches unchanged (`facts_sent`, never `facts_failed` for the records). Docstring + AGENTS «Warehouse reprint» paragraph.
- ОЧ compatibility: warehouse errors never write `factRetry` (except the host-wide hold), so ОЧ's `if (factRetry !== null) return;` in `factsNow` cannot be fed by them. Probe: ОЧ's guard applied to the new code → `warehouse-sender.test.ts` 28/28 green (log `mut-OCH-probe-guard.log`); guard + old shared slot → 3 new tests fail (scan not sent at once).
- Tests (`warehouse-sender.test.ts`, new describe, fake timers): (a) failing route + two scans with `requestFacts` in the pause → facts sent at once, records NOT resent, `attempts` stays 1, then 2 at 2 s; (b) facts fail meanwhile (2 s, 4 s) while records' 8 s pause runs → facts go at 6 s, records still wait until 8 s; (c) records' pause ends at 8 s while facts' runs until 14 s → no fact send at 8 s, both at 14 s; (d) records' `restore_pending` holds a new fact too for the minute; (e) pause dropped on link-down and on unmount (`vi.getTimerCount`).
- RED (base code): (a) "expected vi.fn() to be called 1 times, but got 3 times", (b) failed — `c2-red.log`.

## 3. Gaps m2–m6 (d0fb48432)

- m2 `host/tests/warehouse.rs` `only_a_station_looks_up…`: office AND handheld (kind stored as on the records' test) → 403 `forbidden`, for codeHash and sscc, no code in body.
- m3 `warehouse-work-guards.test.ts`: `it.each` — night record after midnight Moscow (22:30Z), a week later, one-day shelf life, leap day (2028-02-28 + 2 → 29.02) — for unit/box/pallet: `date` = shift's production date, `expiry` = `shelfLifeExpiryDate` (inclusive); plus a literal pin (08.10.2026 / 17.10.2026).
- m4 `warehouse-screen-guards.test.tsx`: typed code with a held lookup → `gate.pending() > 0`, `touch` called, «Завершить сеанс» `aria-disabled`, a drain does not end before the answer, label printed after.
- m5: `src/local/outbox.ts` now exports `FORGET_UNSENT_SQL` / `FORGET_UNSENT_ANY_SQL` (texts unchanged). Exact plans pinned on Node (`floor-schema.test.ts`) and shell 3.46 (new `the_forget_counts_read_only_the_unsent_indexes` in `local_db.rs`, `assert_eq!` on whole plans) for both webview forms and both shell `count_unsent` wh_outbox forms; the any-pairing forms are a `SCAN … USING INDEX *_unsent` (partial index of waiting rows only — deliberate, commented). Text check: the pins appear in `local_db.rs`, and `src-tauri/src/local_db.rs` builds exactly those shell texts (`{table}` format + `UNSENT_TABLES`). Plans identical on 3.46 and 3.53.
- m6 `warehouse-work.ts` `lookUp`: found answer accepted only if identity matches AND kind fits (code → `unit`; SSCC → `box|pallet`), else `lookup_failed`; test with identity-matching wrong kinds + the three fitting kinds.

## 4. Docs m7–m10 (2d511fb38)

AGENTS «Warehouse reprint»: lookup STATION-ONLY (both routes `forbidden` for office/handheld); full code only in the answer's body, kept by the station in `wh_jobs.fields` (`km.code`) for verify/re-render; pallet label counts' two eras (Р15, m8); automatic-outcome record attribution (m7); never-finished / old-pairing sessions never purged (m9). Spec §30: same points in Russian, and the numbering sentence now says allocated numbers are final, no renumbering at merge.

## Mutant table (harness `/tmp/claude/impl-skl-fix/mut.py`: one-line edit, run, restore from copy, sha256 before==after and `cmp`, restored file touched; logs `/tmp/claude/impl-skl-fix/mut-<name>.log`)

| Mutant                                                  | Killed by                                                            | Restore           |
| ------------------------------------------------------- | -------------------------------------------------------------------- | ----------------- |
| I1-W1 reopen statement removed                          | 4 tests (window, other pairing, once per epoch, restore scenario)    | c99a8047191f== ok |
| I1-W2 `outcome = 'accepted'` → `IS NOT NULL`            | refused kept; restore scenario                                       | ok                |
| I1-W3 `(device_id = ? OR 1)`                            | other pairing                                                        | ok                |
| I1-W3b `(host_id = ? OR 1)`                             | other pairing                                                        | ok                |
| I1-W4 `>=` → `>`                                        | window edge                                                          | ok                |
| I1-W4b `(acked_at >= ? OR 1)`                           | window edge                                                          | ok                |
| I1-W5 reopen in its own transaction before the settling | rolls back with a later epoch                                        | ok                |
| I1-IX1 index not partial                                | index list; warehouse «search an index» (attracts unsent reads)      | 48fc6d199419== ok |
| I1-IX2 index removed (Node)                             | reconcile plan pin                                                   | ok                |
| I1-IX2-rust index removed (shell 3.46)                  | `the_floors_repeating_reads_search_an_index` (plan `SCAN wh_outbox`) | ok                |
| I2-M1 fact run ignores `warehouseRetry`                 | (a), (b)                                                             | 936b3a80fc45== ok |
| I2-M2 fact run also cancels `warehouseRetry`            | (a), (b)                                                             | ok                |
| I2-M3 pause end triggers regardless of `factRetry`      | (c)                                                                  | ok                |
| I2-M4 warehouse `restore_pending` does not hold facts   | (d) + existing hold test                                             | ok                |
| I2-M5 non-restore warehouse failure sets `factsHeld`    | 5 tests incl. (a)                                                    | ok                |
| I2-M6 link-down keeps `warehouseRetry`                  | (e)                                                                  | ok                |
| I2-M7 `stopAll` keeps `warehouseRetry`                  | (e)                                                                  | ok                |
| I2-M8 warehouse failure arms `factRetry` (shared slot)  | (a), (b)                                                             | ok                |
| OCH probe: ОЧ guard on new code                         | SURVIVES by design (guard harmless)                                  | ok                |
| OCH probe: ОЧ guard + shared slot                       | (a), (b), (c)                                                        | ok                |
| m2-R2 `!= Station` → `== Office` (lookup)               | `only_a_station_looks_up…` (warehouse.rs:399)                        | 1e22b11034cf== ok |
| m3-P productionDate from instant (UTC slice)            | 3 of the it.each cases                                               | 4299aa578478== ok |
| m3-P2 productionDate null (closedAt fallback, Moscow)   | all 4 cases + literal pin                                            | ok                |
| m4-X typed code `void reprint(...)`                     | typed code work in hand                                              | 7e0d44de557c== ok |
| m5-a webview count `NOT INDEXED`                        | plan pin + text check                                                | 6e84beb9734b== ok |
| m5-b shell `count_unsent` text reordered                | text check                                                           | ba6811398ef4== ok |
| m5-c `wh_outbox_unsent` column order (shell 3.46)       | `the_forget_counts_read_only_the_unsent_indexes`                     | 48fc6d199419== ok |
| m6-K1 kind check dropped                                | wrong-kind lookup test                                               | ok                |
| m6-K2 SSCC takes a unit                                 | same                                                                 | ok                |
| m6-K3 code takes a box/pallet                           | same                                                                 | ok                |

No survivor except the deliberate ОЧ probe.

## Gates (final state 2d511fb38)

- typecheck 0, lint 0, build 0 (after each commit: typecheck+lint; build after commit 1 and at the end).
- Focused verbose Vitest per commit, stderr empty (0 `stderr |`, 0 bytes): c1 123/123, c2 94/94, c3 147/147.
- Delayed-`setImmediate` stand (files created and deleted each time): c1 host-link-restore + restore-reconcile 55/55; c2 warehouse-sender + host-link-restore + host-link-facts 78/78; c3 warehouse-screen-guards + flows 62/62.
- Full Vitest `exec vitest run --testTimeout=60000 --hookTimeout=60000`: 159 files, 4889 tests passed, 0 `stderr |`. (+21 tests in this wave; the per-commit full `test` the rules ask for was run once at the end, not after each commit — load.)
- Parity: `test/warehouse-protocol.test.ts` 41/41; `cargo test -p markiro-proto --test warehouse` 6/6.
- Cargo: fmt --check 0; `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings; focused `-p markiro-standalone --test local_db` 36/36 (35 + new), `-p markiro-host --test warehouse` 34/34; ONE final full `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed: 73 suites, 1172 passed, 0 failed (the known restore.rs timing flake did not occur; no re-run needed).
- Prettier gate proved live (scratch mis-formatted file → rc 1, deleted), then green on every changed TS/TSX/MD; `git diff --check` clean; `\u04` grep only `src/host/pairing-code.ts:66`; `git status --short` empty.

## Files changed

`apps/standalone/src/local/restore-reconcile.ts`, `src/app/host-link.ts`, `src/floor/warehouse/warehouse-work.ts`, `src/local/outbox.ts`, `src-tauri/migrations/0012_warehouse_reprint.sql`, `src-tauri/tests/local_db.rs`, `host/tests/warehouse.rs`, `test/restore-reconcile.test.ts`, `test/host-link-restore.test.ts`, `test/floor-schema.test.ts`, `test/warehouse-store-guards.test.ts`, `test/warehouse-sender.test.ts`, `test/warehouse-work-guards.test.ts`, `test/warehouse-screen-guards.test.tsx`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`.

## Anchor adaptations

None of substance: the report's proposed statement was narrowed to `outcome = 'accepted'` (dispatch: never resurrect rejected), which also made the index-backed form possible.

## Concerns

1. **Migration 0012 edited.** The index-backed requirement needed a new index; WH has no other allocated shell number (0013 is ОЧ's, 0014 DRV's), so `wh_outbox_accepted` was added to WH's own `0012_warehouse_reprint.sql`. 0012 has never been released (not in `claude/integration`/main, no beta), but any dev or test station database that already applied the old 0012 will fail sqlx's checksum check and must be recreated. If the controller prefers not to touch 0012, the alternative is the report's option: keep a commented `SCAN wh_outbox` exception in both pin lists (no index).
2. ОЧ merge: ОЧ's `factsNow` guard is compatible (probe green); ОЧ's own m8-style tests that call `requestFacts()` during a facts' pause are its own concern. ОЧ's «Очередь отправки» should include `wh_outbox` refusals (m1), now also `subject_unknown` after a restore.
3. Fake-timer tests use `shouldAdvanceTime: true` like the existing ones; margins ≥ 1.8 s of real time between a check and the next timer, the same exposure as the suite's existing waits.
4. Not verified: Windows, a real host restore over a LAN, real printers (unchanged from the plan's «Не проверено»).
