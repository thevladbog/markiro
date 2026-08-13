# Task 4 report: compact kiosk box registry

Base: `b444df3a`

## RED

- Command: `apps/api/node_modules/.bin/vitest run apps/api/test/kiosk-box-registry.test.ts --reporter=verbose`
- Result: 1 failed suite, 0 tests collected. Expected `ERR_MODULE_NOT_FOUND` for the absent `box-registry.dto` production boundary.
- The repository's `pnpm --filter @markiro/api exec vitest ...` wrapper produced no output and had to be interrupted in this shell; the same bundled package Vitest binary was used directly for deterministic evidence.

## GREEN

- Focused pure cursor/evaluator plus guard tests: 2 files, 24/24 passed.
- Subscription route inventory: 2/2 passed with the repository development environment plus local test-only `PLATFORM_AUTH_URL` and `SAAS_ADMIN_ORIGIN` values.
- API typecheck: passed with `apps/api/node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit`.
- Scoped ESLint: passed.
- Scoped Prettier check: passed.
- API Nest build: passed with `apps/api/node_modules/.bin/nest build` from `apps/api`.
- `git diff --check`: passed.

## Database e2e coverage and explicit gap

`apps/api/test/kiosk-box-registry.e2e.test.ts` compiles and covers:

- tenant-only full snapshots and no kiosk-product/location filter;
- 12-member upserts without canonical raw KM or crypto tails;
- strict two-page `(updatedAt,id)` paging with immutable bounds;
- delta removal after disassembly;
- cabinet-cookie, station-key, unknown-token, and archived-kiosk denial.

The real local-PostgreSQL run was intentionally not made green by changing shared state. It failed before fixtures with the explicit message:

`Shared development DB schema drift: migration 0037 is not applied (boxes.updated_at missing); kiosk box registry e2e cannot run safely`

Result: 1 failed suite, 4 tests skipped. This is the expected infrastructure boundary inherited from Tasks 2-3, not a claimed green database gate.

## Query, cursor, and security reasoning

- First-page `until` is obtained from PostgreSQL `clock_timestamp()` and callers cannot supply it.
- A versioned canonical base64url cursor binds `{v,since|null,until,updatedAt,id}`. Follow-up requests must repeat the same `until` and the same presence/value of `since`; only `limit` may change.
- Candidate paging is tenant-scoped, lower-exclusive, upper-inclusive, and strictly ordered by `(boxes.updatedAt, boxes.id)`. Progress is based on candidates, so an empty output page can still return `nextCursor`.
- Membership resolution is bounded to 500 rows per box and uses two set-based queries for all candidates: count first, then exact `(tenant,box)` membership joined to current `(tenant,hash)` ownership and canonical `(tenant,hash,scannedAt)` code rows. No N+1 reads and oversized boxes never load member payloads.
- The shared framework-independent resolver/evaluator accepts a DB select-capable executor so Task 5 can use the identical evidence and eligibility rule inside its transaction without a Nest module cycle.
- Eligibility fails closed for open/disassembled/changed/missing/mixed/malformed/ambiguous/oversized boxes. Active owners must match the box membership scan exactly and have server `updatedAt <= closureReceivedAt`; post-close removal/displacement invalidates the whole box.
- API output contains only sorted unique KM keys, never `canonicalRaw`, raw KM, or crypto tails. Every query and join includes tenant identity. Box eligibility is tenant-wide and does not consult kiosk products, shift location, terminal, or warehouse.
- Closed box SSCCs are immutable in the current lifecycle: closure sets the value and disassembly never clears it. The delta-removal test pins that invariant, which makes the candidate `sscc is not null` bound compatible with remove deltas.

## Commit

`3d6da35d` — `feat(api): expose kiosk box registry`

## Fix round 1: committed revision snapshots

### Review RED

- API combined cursor/evaluator/budget/mutation/OpenAPI run: 10 failed, 27 passed. The expected failures pinned revision cursor/window semantics, exact owner tuples, aggregate candidate-prefix budget/progress, atomic mutation revision allocation, and the absent explicit OpenAPI query contract.
- DB combined schema/runtime migration run: 4 failed, 19 passed, 2 skipped. The failures pinned the absent tenant revision table, absent `boxes.registry_version`, the old timestamp cursor index, and the missing 0037 revision/backfill protocol.
- These failures were recorded before changing production schema, migration, mutation, registry, or controller code.

### Fix GREEN

- Registry cursor/evaluator/OpenAPI/station mutation unit tests: 3 files, 37/37 passed.
- Subscription route inventory: 2/2 passed.
- DB focused schema/runtime migration: 23 passed, 2 skipped; full DB: 70 passed, 51 infrastructure-dependent tests skipped.
- API and DB TypeScript checks passed; full API and DB ESLint passed; API Nest build and DB build passed.
- Scoped Prettier and `git diff --check` passed.
- A repeated `drizzle-kit generate` reported `No schema changes, nothing to migrate`; the generated 0037 snapshot/journal and schema are in parity. The migration was not applied to the shared development database.

### Commit-atomic revision protocol

- `box_registry_versions` stores one `bigint` counter per tenant; existing organizations are backfilled at revision `0`, while a missing new-tenant row is created lazily by the same atomic upsert that allocates revision `1`.
- A non-empty changed-box set increments the tenant row and stamps every changed `boxes.registry_version` in the caller's transaction. PostgreSQL serializes concurrent increments on the tenant primary key. The counter and box stamps therefore become visible together at commit.
- A first page reads the currently committed tenant revision (missing row means `0`). A mutation that started before this read but has not committed either remains invisible, or commits with a revision above the fixed cut; it cannot be advertised by the old cut. The pure concurrency model test and the real DB e2e scenario cover the uncommitted-allocation case.
- Revisions remain `bigint` in DB/application logic and cross HTTP/cursors only as canonical unsigned decimal strings. There is no lossy conversion through JavaScript `number`.
- Cursor v2 binds `{v:2,since|null,until,registryVersion,id}`. Candidate paging is tenant-scoped and strictly `(registryVersion,id)`, lower-exclusive and upper-inclusive. A follow-up must repeat the exact lower/upper bounds; only `limit` may vary.
- Task 3 e2e assertions now require successful closure/membership/disassembly changes to increase `registryVersion`, while replay, stale exceptions, late print-only updates, and guarded lifecycle no-ops preserve it.

### Bounds, ownership, and OpenAPI

- Each box remains capped at 500 membership rows. A separate deterministic candidate-prefix budget caps a page at 1,000 member keys (at most 1,024,000 source/key bytes before bounded response overhead). Three 500-member candidates split 2/1. An oversized candidate loads no payload and still advances the cursor; an ineligible/empty output page can likewise advance.
- Candidate counts are loaded once in a set-based query and passed into the shared fact resolver; details are fetched only for the chosen bounded prefix, without N+1 reads or a duplicate count query.
- Current ownership now requires the full null-safe station scan identity `(shiftId, terminalId, scannedAt)`, not timestamp alone. Same timestamp with a different shift or terminal is ineligible.
- The endpoint publishes explicit query, 200 change-union, 400, and 401 OpenAPI metadata; the exact revision/string/union contract has a focused OpenAPI regression test.

### Database e2e boundary after the fix

The focused real-PostgreSQL registry e2e compiles, connects, and then stops before fixtures with the deliberate error:

`Shared development DB schema drift: migration 0037 is not applied (boxes.registry_version missing); kiosk box registry e2e cannot run safely`

Result: 1 failed suite, 5 tests skipped. This is not reported as GREEN and the migration was not applied. Once 0037 is applied in an isolated database, the suite covers the 12-bottle upsert, revision-tie paging, immutable bounds, uncommitted revision visibility, disassembly removal, tenant isolation, and device-auth denial.

### Fix commit

This commit — `fix(api): stabilize kiosk box registry snapshots`

## Fix round 2: restart fence and GTIN invalidation

### RED

- Combined registry/OpenAPI/GTIN run before production edits: 3 failed files; 2 failed tests, 31 passed, and the missing GTIN module suite collected 0 tests.
- Expected failures pinned the absent exact-revision restart fence, absent `409 registry_snapshot_changed` OpenAPI response, and absent product GTIN registry invalidation boundary.

### GREEN and protocol

- Focused registry, OpenAPI, product-invalidation, and station mutation tests: 4 files, 45/45 passed. Route inventory: 2/2 passed. The service-boundary tests exercise the real `ProductsService.updateProduct` transaction callback: GTIN change invalidates, while name-only and canonical same-GTIN updates do not.
- A cursor page is accepted only while the tenant counter equals its bound `until`. The service checks once before candidate reads and again after all candidate/count/fact reads. Either mismatch returns HTTP 409 with stable body `{ "code": "registry_snapshot_changed" }`; Task 6 must discard staging and restart from a new first page.
- The post-read fence closes the page-internal READ COMMITTED race: a mutation committed between candidate and fact statements cannot produce a mixed-revision page. A commit after the final fence cannot rewrite reads already completed for that page; it instead makes any next request fail its preflight fence.
- The DB e2e now models page 1, a committed mutation to an unpaged box, page 2 conflict, then restart at the new cut with the correct current state.
- `ProductsService.updateProduct` now normalizes before entry, then transactionally locks and rereads the tenant product with `FOR UPDATE`, merges the patch, updates it, and invalidates only when the persisted canonical GTIN actually changed. This avoids a concurrent GTIN flip being overwritten without a registry revision.
- GTIN invalidation uses one tenant revision and a set-based `UPDATE boxes ... FROM shifts` for every matching closed SSCC box. It does not materialize an unbounded historical box-ID array. A tenant/product-scoped existence probe avoids counter-only revisions when there are no affected boxes.
- Production write-path audit: ProductsService is the sole path that writes `gtin14`; CommerceML Exchange changes `unitPrice` only, while Integrations link/unlink changes `externalRef` only. Those unrelated writes intentionally do not invalidate the box registry. Same-GTIN and name-only product updates likewise do not allocate a revision.

### Verification and explicit DB boundary

- API TypeScript, scoped ESLint, Nest build, scoped Prettier, and `git diff --check` passed. No DB schema changed, so migration generation was not run.
- Focused PostgreSQL registry e2e: 1 failed suite, 6 skipped, stopping deliberately because shared DB migration 0037 is unapplied (`boxes.registry_version missing`). The database was not modified and this is not reported as GREEN.

### Fix commit

This commit — `fix(api): fence registry pages and invalidate product GTIN changes`

## Fix round 3: tenant lock ordering and unconditional GTIN revisions

### RED

- Focused product/station run before production edits: 2 failed files, 7 failed and 6 passed.
- Failures pinned the racy no-box `EXISTS` shortcut, missing tenant-registry lock before product/device-box rows, missing SQL builder, and PostgreSQL-invalid qualified `SET` targets.

### GREEN and final invariants

- Every actual persisted canonical GTIN change now allocates exactly one tenant revision, including when zero boxes match, then performs one set-based tenant/product update for all currently closed SSCC boxes. A concurrent first closure cannot fall through an `EXISTS` gap: the tenant lock orders the closure and GTIN revision.
- `lockTenantBoxRegistry` uses transaction advisory key `box-registry:<tenantId>`. A newly claimed station batch acquires it before entitlement shift locks, device-box locks, code locks, mutations, counter, and stamps. Exact replays return before it. Product updates carrying a GTIN field acquire it before `FOR UPDATE`; name-only/price/linkage updates do not contend, while a canonical same-GTIN request locks and then correctly avoids a revision.
- Cross-tenant work uses distinct advisory keys and remains parallel. Registry-affecting work for one tenant serializes; this is an accepted correctness/deadlock tradeoff.
- Product box stamping remains one set-based `UPDATE boxes ... FROM shifts`, with static unqualified `registry_version` and `updated_at` SET targets. The PgDialect regression test pins valid LHS syntax plus tenant/product predicates while allowing qualified RHS expressions.
- Focused registry/OpenAPI/product/station tests: 4 files, 47/47 passed, including lock order, replay non-locking, unconditional no-box revision, name-only/no-op behavior, and exact SQL generation. Snapshot 409 tests remain green.

### Verification and operational Minor

- Route inventory 2/2, API typecheck, scoped lint, Nest build, Prettier, and diff-check passed.
- Continuous registry mutation can repeatedly force safe 409 restarts. This is accepted instead of serving an inconsistent snapshot; Task 6 should keep the last active registry, discard only staging, use bounded retry/backoff, and expose refresh status rather than blocking kiosk operation.
- Shared PostgreSQL still lacks migration 0037. Focused e2e remains explicitly NOT GREEN and the database was not changed.

### Fix commit

This commit — `fix(api): serialize box registry mutations`
