# Merge report: claude/m1 (plans ХП + ОЧ) into claude/integration

Status: DONE_WITH_CONCERNS. Worktree /tmp/claude/wt/integ, base 4843a1ae0, merge commit 0ca4d78d0, tree clean.
Logs: /tmp/claude/merge-m1/logs/. Mutant proof: /tmp/claude/merge-m1/mut/.

## Conflicts (7 files, all resolved as unions)

- src-tauri/tests/local_db.rs (5 hunks): journal message; device_records comment; RESTORE_REOPEN (ОЧ `AND resolved_at IS NULL`) + RESTORE_REOPEN_WAREHOUSE (СКЛ) both kept; `reads` array 84/99 -> 100 (both pin sets, QUEUE_* + wh_outbox_accepted).
- FloorApp.tsx / ShiftList.tsx: both views (`warehouse`, `queue`) and both buttons (`onWarehouse`, `onQueue`).
- floor-app.test.tsx / floor-shift-list.test.tsx: both option fields; both describes (СКЛ reprint entry, ОЧ queue entry).
- docs/runbooks/standalone-backup-restore.md (4 hunks): I1 structure (key / keyless copy) kept, ОЧ/ХП wording merged in (Вернула for reconnected stations, queue screen steps, "Записи прежнего подключения", checklist).
- pilot spec: sections in order 22, 23, 24, 25 (ХП), 26 (I1), 27 (ОЧ), 30 (СКЛ), 31 (ИМП). Stale "renumber at merge" prose fixed in §24, §27, §31 (allocated numbers are final).
- Auto-merged: host-link.ts (checked by hand: ОЧ `factRetry` guard in factsNow + СКЛ `warehouseRetry` both present; warehouse errors never write factRetry except the host-wide restore_pending hold), restore-reconcile.ts (REOPEN_SQL resolved_at guard + WAREHOUSE_REOPEN_SQL, same transaction), AGENTS.md (no duplicate headings), ru.json (keys unique, script-checked), backups.ts (`knownBlocksRequestSchema` keeps `.max(64)`), no_secrets_in_logs (facts_files == 18, import_files == 2 pass).

## Merge gate (1): failing warehouse batch must not hold a new fact

New test in test/warehouse-sender.test.ts: "send a new fact at once after the records' route failed three times in a row, under the outbox queue's guard" (fake timers; route fails 3x with 2 s/4 s back-off, then a new local write + requestFacts sends the fact with no timer advanced, warehouse not re-asked, no facts_failed; a second write goes at once too).
Mutant (one hunk): the warehouse failure arms `factRetry` instead of `warehouseRetry`. Result: 3 tests fail (the new one + 2 existing СКЛ tests). host-link.ts restored, sha256 4d79b248...a2 before == after, cmp equal.

## Fix found by the merge (mechanical, ОЧ precedent)

`FORGET_UNSENT_ANY_SQL` (and the shell's `UnsentGuard::AnyPairing` count) planned `SCAN outbox USING COVERING INDEX outbox_shift` after ХП 0010 (whole table incl. settled records) instead of `outbox_unsent`; СКЛ's pinned plan test failed in both lists. Fixed as ОЧ did for STRANDED_COUNT_SQL: `INDEXED BY outbox_unsent` (src/local/outbox.ts), `INDEXED BY {table}_unsent` (src-tauri/src/local_db.rs count_unsent), pins updated in BOTH lists (floor-schema.test.ts; local_db.rs counts array 4 -> 5 incl. the outbox shell form), text-agreement test extended. Same results, only the plan.

## (2) Migrations 0001-0010, 0012, 0013 (0011 absent)

Migrator/journal tests use MIGRATOR's own list (gaps legal). Added in local_db.rs: `a_station_of_0009_or_0010_takes_0012_and_0013_in_one_start` (0009->0010->0012+0013 and 0010->0012+0013, rows kept, journal == MIGRATOR) and `a_database_with_0012_and_0013_takes_0010_late` (resolved record stays resolved). Existing: 0010 test, 0013 test, СКЛ 0012-late test, TS floor-outbox-recovery-migration (0010->0013 without 0012). AGENTS migration paragraph and table count (25 -> 28; 12 Disposable) corrected.

## (3)/(4) pins and reconcile

Pins in both lists for ХП indexes, ОЧ QUEUE__, СКЛ wh__ incl. wh_outbox_accepted; no new duplicates (pre-existing paired entries only); text-agreement tests green. Added restore-reconcile test: a dismissed (resolved) refusal stays settled while the accepted wh_outbox record in the window is reopened, same reconcile.

## Gates (one run, after the last edit)

- turbo build (@markiro/standalone^..., @markiro/domain): 3 tasks ok. standalone typecheck, lint, build: exit 0.
- Full standalone Vitest (--testTimeout=60000 --hookTimeout=60000): 165 files, 5090 passed, 0 failed (includes export-parity and forms-parity). domain labels-import: 29 passed.
- pnpm test:standalone-export: 120 tests, 119 pass, 1 skipped (live Postgres), 0 fail.
- cargo fmt --check clean. `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed: 78 result lines, 1313 passed, 0 failed, 0 ignored, 0 warnings (restore.rs flake did not occur).
- Prettier: probe exit 1 (proven live), then 45 changed prettier-handled files clean (lockfiles/.rs/.sql/.toml excluded). git diff --check clean. git status empty.

Not exercised: Windows, hardware, browser, live Postgres export test.
Concerns: (a) the merge commit also carries the fixes above (INDEXED BY, new tests, AGENTS/spec/runbook edits), not only conflict text; (b) ОЧ review I-1 (mass post-restore refusals) was fixed in m1 per its own report, not re-reviewed here; (c) runbook union wording is a judgement call, worth a read.
