# US-02 shared catalog persistence implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task. Preserve the isolated worktree and release lock.

**Goal:** Persist and expose tenant-scoped US catalog products without requiring GTIN, while keeping RU operational and offline contracts strict.

**Architecture:** Reuse `products`, never a second catalog. Nullable DDL ships with null-safe operational boundaries. An independent US store/controller resolves current membership/profile inside transactions, uses the existing GS1 policy and strict contracts, and writes atomic audit snapshots. No RU module is registered in the US runtime.

**Tech Stack:** TypeScript, NestJS, Drizzle/PostgreSQL, Zod, Vitest; existing dependencies only.

**Spec:** Approved catalog boundary in `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md`; `docs/us/mvp-contract.md` and `docs/us/development-isolation.md`.

**Execution status:** Both tasks implemented and task-reviewed locally on 2026-09-05; integrated review and the consolidated fix/rereview cycle are complete, with no open findings. The increment remains uncommitted and unreleased. The checklist below preserves implementation intent. Current proof and remaining validation limits are recorded in [implementation progress](../../us/implementation-plan.md#us-02-catalog-persistence-increment--2026-09-05).

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. The already approved checkpoint `043473f13` is pushed. This new increment stays uncommitted until verification; no further push, main merge, release or deployment.
- One shared product model; separate US/RU instances and databases. GTIN optional only for `US_FSMA204_PROCESSOR` and `US_GENERIC_LOT_TRACEABILITY`; required for RU. Unknown profiles fail closed. No invented GTIN, empty-string fallback or silent barcode omission.
- Keep RU request/response/OpenAPI, Station bundle, SQLite mirror and label contracts non-null. Do not alter RU readiness, archived-product rules or non-null GTIN replacement behavior.
- Missing GTIN in a GTIN-dependent operational boundary yields HTTP 422 with code `GTIN_REQUIRED`, before writes/provider calls. Preserve existing more-specific state/conflict behavior, including inventory snapshot mismatch at start. Missing/cross-tenant resources retain 404.
- Nullable migration and consumer guards are one deliverable. Use a new migration, preserve old SQL and indexes, and test an upgrade with existing records. No migration against the base US database or primary environment.
- Use Node 24 and repository pnpm. The only infrastructure is the explicit synthetic `US_TEST_DATABASE_URL` at `127.0.0.1:55432/markiro_us_dev`; fixtures create/drop only their own `markiro_us_profile_*` databases. Never load the primary `.env` or use its database.
- Source edits use apply_patch; generate migration metadata with Drizzle, never hand-edit the lockfile or generated snapshots. No .pen reads or edits.
- UI, browser proxy additions, FTL assessment, lots/CTEs, Station, export providers and hosted readiness remain outside this plan. `/health/ready` remains 503.

## Task 1: Nullable catalog storage with strict operational boundaries

**Files:**

- Modify `packages/db/src/schema/platform.ts`; generate `packages/db/migrations/0116_us_catalog_gtin.sql`, matching snapshot and journal entry (confirm next free number before generation).
- Create `packages/db/test/us-catalog-schema.test.ts` and `packages/db/test/us-catalog-migration.e2e.test.ts`.
- Create `apps/api/src/modules/products/require-product-gtin.ts` and `apps/api/test/require-product-gtin.test.ts`.
- Modify `apps/api/src/modules/products/products.service.ts`, `product-registry-invalidation.ts`, `apps/api/test/product-registry-invalidation.test.ts`.
- Modify affected boundaries in `apps/api/src/modules/shifts/shifts.service.ts`, `kiosks/kiosks.service.ts`, `pickup-orders/pickup-orders.service.ts`, `pickup-orders/box-order-resolver.ts`, `kiosk/box-registry.service.ts`, `boxes/boxes.service.ts`, `inventories/inventories.service.ts`, `inventories/inventory-lifecycle.service.ts`, `chz-exports/chz-export-runner.service.ts`, `chz-code-statuses/chz-code-status-ingest.service.ts`, `national-catalog/national-catalog-products.service.ts`, `exchange/commerceml/apply.ts` and `exchange/exchange.controller.ts` where the nullable type flows.
- Focused existing tests: `apps/api/test/kiosk-box-registry.test.ts`, `commerceml-apply.test.ts`, `national-catalog-products.service.test.ts`, `chz-export-job.test.ts`, `chz-code-status-ingest.service.test.ts`; add real isolated cases in `apps/api/test/us-catalog-operational-boundaries.e2e.test.ts`. Existing fixture/service builders may be reused from adjacent tests without source-text assertions.
- Compiler-confirmed fixture consumer: `apps/api/test/product-regulatory.e2e.test.ts` must narrow its two selected GTIN values through `requireProductGtin` before inserting required snapshots. Do not change its production module or weaken assertions.

**Interfaces:** `products.gtin14: string | null`; new `products.updatedAt: Date`; `requireProductGtin(gtin14: string | null): string`. The helper checks null only: supplied-value GS1 validation stays at existing write boundaries, avoiding an unrelated retroactive revalidation of RU data.

- [ ] Write focused RED tests before implementation. For the helper, use a minimal throwing scaffold only if needed to separate module setup errors from behavioral RED:

```ts
expect(requireProductGtin("10012345678902")).toBe("10012345678902");
expect(() => requireProductGtin(null)).toThrowError(UnprocessableEntityException);
try {
  requireProductGtin(null);
} catch (error) {
  expect(error).toBeInstanceOf(UnprocessableEntityException);
  if (error instanceof UnprocessableEntityException) {
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual({ code: "GTIN_REQUIRED" });
  }
}
```

- [ ] Add an upgrade test using `createUsProfileTestDatabase(url, 115)`: seed a valid old RU product, apply only new SQL, verify original column values unchanged; verify null storage, multiple active null GTINs, uniqueness of active non-null GTIN within one tenant, archived reuse, conflicting restore rejection, cross-tenant reuse and composite tenant FKs. Assert Station `product_mirror.gtin14` stays NOT NULL via existing schema metadata, not source text.
- [ ] Change `gtin14` to nullable and add `updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()`. Default stamps old rows at migration time; this is the start of timestamp tracking, not reconstructed RU modification history. The later US store maintains it on actual changes. RU DTO does not expose the new field. Generate only the intended DDL; do not absorb unrelated schema drift.
- [ ] Implement the helper:

```ts
export function requireProductGtin(gtin14: string | null): string {
  if (gtin14 === null) throw new UnprocessableEntityException({ code: "GTIN_REQUIRED" });
  return gtin14;
}
```

- [ ] Apply guards with current source/tests as authority:

| Boundary                                     | Required behavior                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy product list/get serialization        | Guard `rowToDto`; preserve strict RU DTO and required create/update validation.                                                                                                         |
| `createShift` and `getReferenceBundle`       | Guard creation before insert and independently guard current-product bundle serialization. Existing draft/archived responses stay unchanged.                                            |
| Kiosk `setProducts`                          | Select GTIN, reject null before replacement/assignment writes. Keep transaction-local validation where writes occur.                                                                    |
| Pickup bootstrap/allowlist/catalog GTIN maps | Exclude null from eligible products and narrow explicitly; no null in cached offline payloads. Do not widen transport DTOs.                                                             |
| Box registry candidates                      | Allow internal nullable candidate; null makes the candidate ineligible. Preserve candidates in delta queries so removals/tombstones are emitted.                                        |
| `BoxesService.getSellCodes`                  | Reject null or mismatched product/canonical GTIN before returning sell codes, using existing eligibility logic where possible.                                                          |
| Inventory create/edit/import                 | Reject null before parse/snapshot/manifest writes, including the transactional recheck. Start compares current GTIN with immutable snapshot and retains existing changed-GTIN conflict. |
| CHZ export context                           | Missing GTIN blocks context before provider calls.                                                                                                                                      |
| CHZ status ingestion                         | Null product GTIN cannot enter the match map.                                                                                                                                           |
| National Catalog repository/service          | Distinguish missing row from found-null; missing is 404, null is 422 GTIN_REQUIRED before token/provider work.                                                                          |
| CommerceML                                   | Internal catalog GTIN nullable; omit null from GTIN auto-link map, retain explicit externalRef matching for linked price/image updates.                                                 |
| Registry invalidation                        | Internal `ProductGtinVersion.gtin14` nullable; compare exact identities and GTIN values so null transitions invalidate too.                                                             |

- [ ] Add behavioral regression cases for active+null creation/assignment rejection, historical bundle refusal, null registry candidate removal, inventory rejection without side effects, CHZ/National Catalog no-provider denial, CommerceML externalRef update versus GTIN auto-link, and registry transitions null→value/value→null/null→null. Use real US disposable Postgres for persistence; test doubles only for genuinely external providers.
- [ ] Rebuild DB before API checks. Run focused new/affected tests, DB package test/typecheck/lint/build, API typecheck/lint/build and package tests without primary DATABASE_URL; explicitly report infrastructure skips. Existing API e2e fixtures needing a generic DATABASE_URL must not be pointed at the base US DB; use the dedicated new isolated test instead. Test null-capable paths against real SQL where applicable.
- [ ] Self-review source delta and generated SQL. No commit. Report RED/GREEN evidence, exact gates/counts/skips and any additional nullable-type consumer discovered by compilation.

## Task 2: US catalog store and isolated HTTP API

**Files:**

- Create `apps/api/src/modules/traceability/catalog/us-catalog-store.ts` and `us-catalog-support.ts`.
- Modify `apps/api/src/modules/traceability/master-data/us-master-data-support.ts` so `authorizeUsMasterData` returns the validated `valid.data.code`; existing callers may ignore the additive return value.
- In that same support module, extract named unique-constraint matching into `isUniqueConstraintViolation(error: unknown, constraint: string): boolean`; retain `isPartyNameConflict` as a wrapper for its existing constraint. Catalog reuses the matcher for `products_tenant_gtin_unarchived_uq`. Handle unknown/null errors safely; do not duplicate the wrapped-Postgres error parsing block.
- Extend `packages/platform-contracts/src/traceability/catalog.ts`, `packages/platform-contracts/src/index.ts`, and `packages/platform-contracts/test/us-catalog.test.ts` with list query/response contracts.
- Create `apps/api/src/deployment/us-catalog.controller.ts`; register only in `us-development.module.ts` and instantiate the store in `us-runtime.ts`.
- Extract the existing generic/400 OpenAPI error constants from `us-master-data.controller.ts` into `apps/api/src/deployment/us-master-data-openapi.ts` and import the same constants in both controllers. Preserve the existing response schemas byte-for-byte in meaning; do not duplicate their definition blocks or import one controller from another.
- Create `apps/api/test/us-catalog.e2e.test.ts` and `apps/api/test/us-catalog-http.e2e.test.ts`.
- Extend `.github/workflows/us-development.yml` to run the new contract, DB and API test files in the existing check-only workflow; preserve every lock and permission.

**Interfaces:** `UsCatalogStore(db)` exposes `listProducts(tenantId, actorUserId, query)`, `getProduct(tenantId, actorUserId, id)`, `createProduct(tenantId, actorUserId, input, requestId)`, `updateProduct(tenantId, actorUserId, id, input, requestId)`. Responses use existing `UsProduct` and new `UsProductList`. `UsRuntime.catalog` owns the store. Product identity remains the shared product UUID, never GTIN or name.

- [ ] Write focused failing contract/store tests, then implement list contracts by selecting the existing generic fields from `listUsPartiesQuerySchema` (search, archived, limit, offset) with `.pick(...).strict()`, avoiding a copy of canonical integer parsing. New `usProductListSchema` is strict with items max100, limit1..100, offset0..100000 and items.length≤limit. Export inferred `ListUsProductsQuery` and `UsProductList`.
- [ ] Implement each store operation in one transaction. First call `authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ or MASTER_DATA_WRITE)` and use its trusted returned profile with `normalizeCatalogGtin`; never accept tenant/profile/actor in client input. Reuse `parseMasterDataInput`, `escapeLikePattern` and existing access policy without registering RU modules.
- [ ] Create inserts only tenant, normalized GTIN, name and server timestamps. Leave existing RU defaults/fields untouched (`draft`, no CHZ group or capacities); those defaults do not govern US CTE readiness. Map only the strict US fields and validate stored response; corrupt rows fail closed, never become fabricated values.
- [ ] List filters by tenant, literal escaped search over name/GTIN and archived selection; stable name/id ordering, bounded limit/offset. Get uses tenant+id and 404 for absent/cross-tenant IDs. No delete endpoint and no external network work.
- [ ] Patch parses strict input, locks the tenant product `FOR UPDATE`, merges omission separately from explicit null, and returns unchanged response without audit/timestamp churn for a canonical no-op. On a real GTIN change, reject existing tenant-scoped shifts, kioskProducts or inventories referencing the product with 409 `product_gtin_locked`; this is a conservative US-only write rule, not a change to RU replacement semantics. The US runtime has no legacy operational writers. Future US synthetic/reference writers must coordinate on the same product row lock; this plan does not introduce those writers.
- [ ] On real change, update selected columns plus updatedAt. Enforce active non-null GTIN uniqueness using the existing DB index, mapping only its named 23505 conflict to 409 `product_gtin_taken`. Multiple null GTINs and duplicate product names are allowed. Archive/restore keeps UUID and historical rows; conflicting restore is atomic. SQL failures are not swallowed.
- [ ] Insert exact audit snapshots inside the same transaction: actions `traceability.product.created`, `.updated`, `.archived`, `.restored`; targetType `traceability_product`; tenant/actor/id/requestId/outcome success; before null on create, otherwise complete old US response, and complete new response after. If audit fails, product write rolls back. Registry invalidation is only needed if GTIN changes can affect existing boxes; the reference lock prohibits those US mutations rather than bypassing history.
- [ ] Add catalog routes under `/traceability/catalog/products`: GET/POST collection, GET/PATCH `/:id`, no DELETE. Use `UsSessionGuard`, server principal/request ID and `runtime.databaseOperation`. Example shape:

```ts
@Get()
@ApiZodQuery(listUsProductsQuerySchema)
@ApiZodResponse({ status: 200, schema: usProductListSchema })
list(@Req() request: UsRequest, @Query() query: unknown) {
  const principal = this.principal(request);
  return this.runtime.databaseOperation(() =>
    this.runtime.catalog.listProducts(principal.tenantId, principal.userId, query));
}
```

- [ ] Generate accurate OpenAPI schemas for request/response and observed 400/401/403/404/409/413/415/503 responses. Reuse the master-data validation error shape (the shared parser emits `invalid_master_data`); ensure body/parser errors and typed errors are unambiguous. Catalog endpoints stay absent from RU composition; browser proxy remains unchanged/closed until its own UI/client increment.
- [ ] Real disposable DB tests: both US profiles create/read null and canonical supplied GTIN; RU/missing/invalid profiles rejected; read/write role matrix, membership removal/demotion, foreign tenant IDs, invalid IDs/input, canonical no-op, explicit null patch versus omission, timestamp updates, duplicate/restore conflict, preserved old archived ID, reference locking, exact audit fields and rollback, concurrent same-GTIN creates/restore. Real HTTP tests use existing US MFA client/loopback helpers and verify host/origin/body limits, server-owned principal, role denial, cross-tenant, 404 on RU and future routes, no-store/request ID, live 200/ready503 and OpenAPI payload conformance. No real-browser claim from HTTP tests.
- [ ] Build dependencies and run focused tests, contract test/typecheck/lint/build, API test/typecheck/lint/build, existing US master-data/auth/profile HTTP regression, and all local isolation tests. Report infrastructure skips and existing test-runner warnings separately. No source edits outside scope without a concrete compilation/behavior reason reported to controller.
- [ ] Self-review and hand off for task and broad final review. No commit or push of this new increment.

## Controller-owned documentation and verification

After the implementation, update `docs/us/implementation-plan.md`, `docs/us/requirements-traceability.md`, `docs/us/development-isolation.md`, `docs/us/open-questions.md` and the approved catalog section of the US-02 design. Record runtime catalog coverage separately from missing FTL/lot/UI work and explain migration-time timestamp baseline. Preserve historical evidence without claiming old rows have reconstructed modification history. Run full formatting and diff checks, verify main checkout unchanged, and retain the local worktree.
