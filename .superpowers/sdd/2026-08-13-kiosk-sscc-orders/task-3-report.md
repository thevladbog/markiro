# Task 3 implementation report

## Result

- Commit: `b444df3a` (`feat(api): version box registry changes`).
- Every station-ingest or offline-exception write that actually changes a box's active membership or lifecycle now advances that box's `updatedAt` in the same existing transaction.
- Registry versions use tenant-scoped set updates and the monotonic PostgreSQL expression `GREATEST(clock_timestamp(), boxes.updated_at + interval '1 millisecond')`, so a JavaScript millisecond cursor advances strictly even for several changes in one transaction.
- Exact replays, stale undo/clear/disassemble attempts, unrelated boxes, inactive membership inserts, and audit-only print/reprint paths do not advance the cursor.
- No registry endpoint or other Task 4 behavior was added.

## Mutation inventory

All actual writes are in `StationScansService`; `BoxExceptionsService` is read-only and was deliberately not changed.

| Mutation | Changed-row evidence | Version behavior |
| --- | --- | --- |
| New active membership / reactivation | membership upsert uses `setWhere` plus `returning(boxId)` | returned boxes are stamped; an exact conflict replay returns no rows |
| Losing membership in the current batch | fresh inactive insert and guarded active-to-displaced update both return `boxId` | newly inserted or newly displaced boxes are stamped; exact conflicts/replays return no rows |
| Retroactive displacement | guarded active-to-displaced update returns `boxId` | only the displaced membership's box is stamped |
| Equal-owner duplicate reconciliation | guarded set-based update returns `boxId` | only duplicate active memberships actually displaced are stamped |
| Close | the guarded close update sets `updatedAt` with the monotonic expression itself | a closure no-op does not execute the update; later print verification does not restamp |
| Undo | guarded active-to-removed update returns `boxId` | only a membership actually removed is stamped |
| Clear | `emptyBox` returns whether its guarded update returned any rows | only a box with active memberships removed is stamped |
| Disassemble | guarded membership removal and guarded lifecycle update return change evidence | one deduplicated stamp covers either/both changes; stale/open/already-disassembled attempts do not stamp |
| Reprint | audit insert only | never stamps |

`advanceBoxRegistryVersions` deduplicates and sorts box IDs, returns early for an empty set, scopes the update by both tenant and IDs, and receives the current transaction rather than opening another one.

## RED evidence

The focused non-DB service test was added before production changes and exercised the real closure-only `applyBatch` path with the existing mock transaction harness.

Command:

```text
/Users/thevladbog/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --filter @markiro/api exec vitest run test/station-scans.service.test.ts
```

Observed before production changes:

```text
Test Files  1 failed (1)
Tests       1 failed | 4 passed (5)
```

The single expected failure was `expected undefined to be an instance of SQL`: the closure update had no `updatedAt` expression. Production code was not edited until this RED was observed.

## GREEN and final focused verification

The same non-DB file passed after implementation:

```text
Test Files  1 passed (1)
Tests       5 passed (5)
```

Final focused unit plus DB-backed e2e command, run without loading a database environment:

```text
./node_modules/.bin/vitest run test/station-scans.service.test.ts test/station-scans.e2e.test.ts
```

Result:

```text
Test Files  1 passed | 1 skipped (2)
Tests       5 passed | 72 skipped (77)
```

The focused unit test compiles the captured Drizzle `SQL` through `PgDialect` and asserts the monotonic query shape. The e2e additions cover membership add/reactivation, retroactive and duplicate displacement, undo, clear, close, disassemble, exact replay, stale exceptions, audit-only print/reprint, and an unrelated box. Change cases assert `after.getTime() > before.getTime()`; no-op cases assert equality.

Final successful gates on the final diff:

- DB package build was run first and exited successfully.
- API typecheck: `./node_modules/.bin/tsc -p tsconfig.json --noEmit`.
- API lint: repository ESLint over `apps/api`.
- API build: `./node_modules/.bin/nest build`.
- Prettier check over all three changed files.
- `git diff --check`.

## Full API suite and PostgreSQL limitation

The full API suite was also run with the repository development environment plus the documented local auth/origin variables. It reached PostgreSQL and completed rather than hanging:

```text
Test Files  12 failed | 110 passed | 1 skipped (123)
Tests       83 failed | 1173 passed | 19 skipped (1275)
Duration    196.04s
```

The 12 failed files are grouped by one shared-database schema-drift condition, not by an assertion failure in this change:

- station/box ingestion failed at PostgreSQL with `column "updated_at" of relation "boxes" does not exist`;
- pickup-order suites failed with `column "order_box_id" of relation "pickup_order_items" does not exist` (PostgreSQL `42703`).

Both columns are introduced by Task 2 migration 0037, which is present in the checkout but not applied to the shared development database. Station endpoints consequently returned 500 before reaching the new timestamp assertions. Per repository safety rules, this task did not apply migrations to, drop, or rewrite the shared database. Therefore the real-PostgreSQL `after > before` assertions remain present and typechecked but are explicitly reported as not executed successfully in this environment.

Intermediate runs without the complete documented environment either skipped DB suites or failed required environment validation; they are not claimed as product verification.

## Changed files

- `apps/api/src/modules/station-scans/station-scans.service.ts`
- `apps/api/test/station-scans.service.test.ts`
- `apps/api/test/station-scans.e2e.test.ts`

## Scope and external checks

- No schema or migration files were changed.
- No `BoxExceptionsService` changes were made because it contains no mutation path.
- No browser, kiosk, scanner, physical-device, printer, or live deployment check applies to this backend mutation-versioning slice and none was claimed.

## Integrated fix round 1: fresh losing membership

### RED

- Before production edits, focused box-membership and station tests produced 1 failed and 9 passed.
- The expected failure was the missing fresh-loser insertion boundary. The test requires an inserted inactive membership to return its box ID while an exact `ON CONFLICT DO NOTHING` redelivery returns none.

### Fix

- Fresh losing `box_items` insertion now uses `RETURNING box_id`; returned IDs join the existing sorted/deduplicated `membershipChangedBoxIds` set before the tenant revision helper runs.
- The following guarded active-only displacement remains necessary for an already-active membership. It cannot report a row that was inserted with `displaced_at` already set, so the two changed-row sources are deliberately combined.
- Exact conflict/replay inserts return no rows and the active-only update also returns no rows, preserving the no-op/no-revision guarantee.
- Tenant registry advisory locking, transaction scope, and sorted revision dedupe are unchanged.

### Verification and DB boundary

- Focused box membership, station mutation, registry, and product tests: 4 files, 50/50 passed; API typecheck passed.
- The added PostgreSQL e2e closes an otherwise eligible box, delivers a real fresh losing boxed scan whose authoritative earlier owner is elsewhere, requires box and tenant revisions to increase plus a registry remove delta, then redelivers the exact scan under a fresh batch ID and requires both revisions unchanged.
- Targeted DB run is explicitly NOT GREEN: 1 failed, 72 skipped because shared DB lacks migration 0037 (`boxes.registry_version`, PostgreSQL 42703). The database was not modified.
- API scoped lint, Nest build, Prettier, and diff-check passed.

### Commit

This commit — `fix(api): version fresh losing box memberships`
