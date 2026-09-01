# National Catalog Complete Read-Only Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan sequentially. Keep the implementation in one pull request and use test-driven development at every behavior boundary.

**Goal:** Deliver the complete server-side, tenant-safe, read-only National Catalog import: reviewed schema discovery and activation, classifier coverage reporting, GTIN lookup with immutable snapshots, snapshot-backed proposals, and bounded freshness jobs.

**Architecture:** `NationalCatalogModule` owns the provider client and read-only services. Platform-authenticated operations discover and activate immutable schema versions using one configured source tenant. Tenant routes resolve a product before acquiring its True API token, store one immutable snapshot per returned card, and create strict `national_catalog_import` proposals that the existing product-regulatory state machine applies atomically. pg-boss jobs carry only tenant/product identifiers and use the mutable freshness cursor for bounded retries; tokens remain server-side.

**Tech Stack:** TypeScript 6, NestJS 11, Zod 4, Drizzle/Postgres, pg-boss, Vitest/Supertest, Node test runner, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-09-01-national-catalog-foundation-hardening-design.md`

## Global constraints

- Base this PR on the merged and production-deployed PR 1 contract.
- Keep every provider call read-only and limited to documented `GET` endpoints.
- Never log, return, persist in jobs, or place in fixtures a decrypted token or production identifier.
- Resolve tenant-owned products before token access so cross-tenant identifiers return 404 without revealing integration state.
- Discover attribute definitions per category. Do not request the account-wide attribute envelope.
- Use the singular `gtin` selector for one GTIN and `gtins` only for batches.
- Persist each provider card as its own immutable snapshot; unchanged content updates only the freshness cursor.
- Never auto-activate a schema or auto-approve an ambiguous classifier or attribute mapping.
- Use only active, strictly parsed format-v2 schemas for tenant proposals.
- Reuse the PR 1 proposal retrieval/reject/apply endpoints and transaction; do not create a second apply path.
- Do not add admin UI, Station/kiosk/1C changes, or National Catalog write operations.
- Add only production variable inventory and safe defaults in Git. Actual Lockbox values and deployment remain separately approved external actions.
- Preserve unrelated work and stage only files listed by this plan.

## Final scope decisions

- Import previews require an existing active regulatory profile. Initial category
  binding remains in the existing reviewed binding flow rather than being inferred
  from a National Catalog card.
- National Catalog attribute identifiers map directly only to attributes in the
  activated schema generated from that same catalog observation. Stable product
  fields (`name`, `print_name`, `shelf_life_days`) require separately reviewed,
  version-scoped mappings.
- EGAIS identifiers are not inferred from National Catalog attributes and are not
  imported automatically. They remain in the existing explicit regulatory flow.
- The API/service test suite is the tenant and contract boundary for this server-only
  change; no admin UI was added, so a separate National Catalog browser flow is out
  of scope.

## Task 1: Correct the production-observed request contract

**Files:**

- Modify: `apps/api/src/modules/national-catalog/national-catalog.client.ts`
- Modify: `apps/api/src/national-catalog-live-diagnostic.ts`
- Modify: `apps/api/test/national-catalog.client.test.ts`
- Modify: `apps/api/test/national-catalog-live-diagnostic.test.ts`

- [ ] Add failing client tests proving one GTIN serializes as `gtin=<value>` and two through twenty-five serialize as `gtins=<semicolon-list>` for both card endpoints.
- [ ] Add a failing diagnostic test proving it chooses one deterministic positive category ID from the category response and calls attributes with `{ catId }`.
- [ ] Implement the smallest request-builder and diagnostic changes. If categories contain no usable ID, classify schema read as unavailable without exposing payload data.
- [ ] Run the two focused test files and preserve the sanitized diagnostic v3 output contract.

## Task 2: Normalize discovered schemas and persist immutable observations

**Files:**

- Create: `apps/api/src/modules/national-catalog/national-catalog-schema-normalizer.ts`
- Create: `apps/api/src/modules/national-catalog/national-catalog-schema.service.ts`
- Create: `apps/api/test/national-catalog-schema-normalizer.test.ts`
- Create: `apps/api/test/national-catalog-schema.service.test.ts`

- [ ] Write table tests for supported scalar/list/enum/date/decimal definitions, units, preset modes, requirement rules, deterministic ordering and canonical hashing.
- [ ] Write rejection tests for unsupported provider types, unique multiplicity, unresolved dependencies, conflicting units, duplicate identifiers, and malformed category references.
- [ ] Normalize only into strict format-v2 `CategorySchemaDefinition`; retain the bounded raw provider evidence in an observed schema row when activation is blocked.
- [ ] Fetch categories once and attributes separately for each eligible category, with bounded sequential/concurrency behavior and explicit partial-failure results.
- [ ] Deduplicate by `(scopeKey, contentHash)`, persist new rows as `observed`, preserve active versions, and return added/changed/unchanged/blocked comparison counts.
- [ ] Unit-test repository interactions, partial failures, repeat idempotency, and absence of decrypted credentials in results/errors.

## Task 3: Add reviewed platform refresh and activation contracts

**Files:**

- Create: `packages/platform-contracts/src/national-catalog.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Create: `packages/platform-contracts/test/national-catalog.test.ts`
- Modify: `apps/api/src/modules/platform-operations/platform-operations.controller.ts`
- Modify: `apps/api/src/modules/platform-operations/platform-operations.module.ts`
- Modify: `apps/api/src/modules/platform-operations/platform-operations.service.ts`
- Modify: `apps/api/test/platform-operations.e2e.test.ts`
- Modify: `apps/api/test/openapi-coverage.test.ts`

- [ ] Define strict request/response schemas for schema refresh, comparison, activation, and classifier coverage without raw card/token fields.
- [ ] Add platform-only `POST /platform/operations/national-catalog/schema-refresh` and `POST /platform/operations/national-catalog/schema-versions/:id/activate`.
- [ ] Refresh validates the source tenant and active token; the tenant ID appears only in the protected platform audit event.
- [ ] Activation reparses the stored definition, requires reviewed exact category/group and attribute mappings, retires the prior active version in one transaction, and audits before/after IDs and comparison counts.
- [ ] Test platform authentication, invalid source tenant/token, blocked definition, missing/ambiguous mappings, repeat activation, transaction rollback, exact audit metadata, and OpenAPI coverage.

## Task 4: Add tenant-scoped GTIN lookup and per-card snapshots

**Files:**

- Create: `apps/api/src/modules/national-catalog/national-catalog.module.ts`
- Create: `apps/api/src/modules/national-catalog/national-catalog-products.service.ts`
- Create: `apps/api/src/modules/national-catalog/national-catalog.controller.ts`
- Create: `apps/api/src/modules/national-catalog/dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/national-catalog-products.service.test.ts`
- Create: `apps/api/test/national-catalog.e2e.test.ts`
- Modify: `apps/api/test/openapi-coverage.test.ts`

- [ ] Write failing tests for found, empty and multiple-card responses; feed-product-first/product-fallback order; missing/expired/undecryptable token; rate limit; provider unavailable; invalid card; and absent product GTIN.
- [ ] Prove cross-tenant/archived product IDs return 404 before token lookup and require the existing tenant product read capability.
- [ ] Implement `POST /products/:id/national-catalog/lookups` with a strict response containing outcome and sanitized snapshot summaries only.
- [ ] Validate every returned card independently, compute a canonical per-card hash, and insert immutable snapshots with exact tenant/product/card/source-method identity.
- [ ] Deduplicate unchanged cards, update the mutable freshness cursor transactionally, and never overwrite snapshot payloads.
- [ ] Treat zero cards as a valid empty lookup; treat multiple valid cards as an explicit selection-required result rather than choosing silently.

## Task 5: Create snapshot-backed import proposals

**Files:**

- Create: `apps/api/src/modules/national-catalog/national-catalog-proposal.service.ts`
- Modify: `apps/api/src/modules/national-catalog/national-catalog.controller.ts`
- Modify: `apps/api/src/modules/national-catalog/dto.ts`
- Create: `apps/api/test/national-catalog-proposal.service.test.ts`
- Modify: `apps/api/test/national-catalog.e2e.test.ts`
- Modify: `apps/api/test/product-regulatory.e2e.test.ts`

- [ ] Add a preview route that accepts one tenant/product-owned snapshot ID and target active schema version.
- [ ] Normalize only reviewed exact mappings; classify ambiguous/unmapped/category-incompatible values explicitly and exclude them from selectable entries.
- [ ] Map stable fields and EGAIS only through reviewed version-compatible mappings; validate all proposed values with the domain schema.
- [ ] Persist a strict `national_catalog_import` proposal whose source reference is exactly `national-catalog-snapshot:<snapshot UUID>` and whose base revision matches the existing active profile.
- [ ] Return the existing proposal view. Applying, rejecting, replaying, expiring and staling continue through the PR 1 product-regulatory endpoints.
- [ ] Test the existing-profile requirement, selection subset, stale revision/value, inactive schema, cross-tenant snapshot, malformed persisted payload, exact provenance/history/audit, atomic rollback, and idempotent replay.

## Task 6: Add bounded freshness jobs and classifier coverage report

**Files:**

- Create: `apps/api/src/modules/national-catalog/national-catalog-freshness.service.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Create: `apps/api/test/national-catalog-freshness.service.test.ts`
- Create: `apps/api/scripts/report-national-catalog-matrix.mjs`
- Create: `apps/api/test/report-national-catalog-matrix.test.mjs`
- Modify: `apps/api/package.json`

- [ ] Define schema-refresh and per-tenant product-freshness jobs with bounded batch sizes, retry/backoff and stable singleton keys; payloads contain identifiers only.
- [ ] Disable scheduled schema refresh when `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID` is absent and record only a sanitized disabled outcome.
- [ ] Refresh cards with provider ETag when available and canonical content hash otherwise; 304/unchanged updates the cursor only, changed cards append snapshots, and errors preserve the last good observation.
- [ ] Ensure one tenant's missing token/rate limit/failure does not stop other tenant batches and no job crosses tenant ownership.
- [ ] Produce a deterministic read-only full-classifier report with exact, ambiguous and unmapped category/group/attribute counts plus machine-readable exit semantics; never mutate mappings.
- [ ] Test scheduling idempotency, tenant isolation, batch bounds, retry classification, hash fallback, legacy snapshot exclusion, and deterministic report output.

## Task 7: Add production inventory and operational documentation

**Files:**

- Modify: `.env.production.example`
- Modify: `deploy/production/docker-compose.yml`
- Modify: `deploy/production/test/compose-contract.test.mjs`
- Modify: `deploy/yandex/runtime-env.mjs`
- Modify: `deploy/yandex/test/runtime-env.test.mjs`
- Modify: `docs/runbooks/production.md`
- Modify: relevant Yandex/deployment contract tests discovered from current source

- [ ] Add `NATIONAL_CATALOG_BASE_URL`, `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID`, and `NATIONAL_CATALOG_REQUEST_TIMEOUT_MS` to the closed production inventory with safe validation and no values committed.
- [ ] Document the out-of-band Lockbox version update, protected deployment approval, schema refresh, classifier report review, explicit activation, tenant lookup smoke, and recovery/disable sequence.
- [ ] Keep live Lockbox mutation and deployment outside the PR; they require a separate explicit production approval after merge.
- [ ] Run production compose/runtime/runbook contracts and confirm diagnostics remain sanitized.

## Task 8: Complete verification and one-PR delivery

- [ ] Run focused tests after every task and rebuild `@markiro/domain` and `@markiro/db` before API consumers.
- [ ] Run package test/typecheck/lint/build gates for domain, DB, platform-contracts, and API; report DB-backed skips when `DATABASE_URL` is absent.
- [ ] Run affected deployment/Yandex contracts, `pnpm format:check`, and `git diff --check`.
- [ ] Run `graphify update .` and verify generated `graphify-out/` remains ignored.
- [ ] Inspect the complete diff for tenant scope, secret leakage, provider writes, migration changes, and unrelated files.
- [ ] Commit only scoped files, push `codex/national-catalog-complete-import`, and open exactly one pull request for this implementation.
- [ ] After merge, use only protected production workflows for Lockbox inventory verification, deployment, schema refresh, activation and tenant smoke evidence.
