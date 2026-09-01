# National Catalog Read-Only Import Implementation Plan

> **Superseded before Task 2 (2026-09-01).** Task 1 below is retained as implementation
> history. Continue the import only from
> `docs/superpowers/specs/2026-09-01-national-catalog-foundation-hardening-design.md` and
> `docs/superpowers/plans/2026-09-01-national-catalog-foundation-hardening.md`, after the
> hardened PR 1 production diagnostic is reviewed. The newer contract requires bounded
> byte reads, per-card raw snapshots, content-hash fallback, a separate freshness cursor,
> and strict source-aware proposals; the earlier ETag-only and whole-envelope instructions
> below must not be implemented.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read categories, schemas, and product cards from the National Catalog; persist immutable observations; and apply user-confirmed field proposals without outbound card mutation.

**Architecture:** A dedicated server-only client reuses the decrypted tenant True API token but takes its National Catalog base URL from explicit configuration. Schema refresh and tenant card freshness are retry-safe services; all product changes use the foundation plan's persisted proposal/apply transaction.

**Tech Stack:** NestJS 11, native fetch, Drizzle/Postgres, pg-boss 12, Zod 4, Vitest/Supertest.

**Spec:** `docs/superpowers/specs/2026-08-31-category-product-attributes-national-catalog-design.md`

## Global Constraints

- Requires completed `2026-08-31-category-attributes-foundation.md` and its exported DB/domain/service interfaces.
- v1 calls only documented category, attribute, and read-product methods; it never calls card mutation/publication methods.
- Product methods handle at most 25 GTIN/card identifiers per request; Markiro's single-product UI sends one.
- Existing `ChzTokenService.getActiveToken(tenantId)` is the only decryption path; plaintext tokens never enter DB, jobs, logs, audit, or responses.
- `NATIONAL_CATALOG_BASE_URL` is explicit configuration. The integration is disabled when it is absent; do not guess a production URL in code.
- Global schema refresh authenticates with an explicitly selected tenant token. Scheduled refresh is disabled unless `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID` is configured.
- 401, 403, 404, 429, 5xx/network/timeout, invalid payload, and no-card results remain distinct stable outcomes.
- ETag/content hash suppresses duplicate snapshots and duplicate user notifications.
- Schema activation is a platform operation; tenants can import only against active schemas.

---

## File Structure

| File                                                                          | Responsibility                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/api/src/modules/national-catalog/national-catalog.types.ts`             | Client inputs/results and normalized external records         |
| `apps/api/src/modules/national-catalog/national-catalog.client.ts`            | Bounded authenticated HTTP reads and payload validation       |
| `apps/api/src/modules/national-catalog/national-catalog-schema.service.ts`    | Fetch, compare, validate, persist, and activate schemas       |
| `apps/api/src/modules/national-catalog/national-catalog-products.service.ts`  | GTIN lookup, card snapshots, proposal diff, and apply handoff |
| `apps/api/src/modules/national-catalog/national-catalog-freshness.service.ts` | ETag-based product refresh batches                            |
| `apps/api/src/modules/national-catalog/national-catalog.module.ts`            | Dynamic module configured from `Env`                          |
| `apps/api/src/modules/national-catalog/dto.ts`                                | Tenant lookup/preview response schemas                        |
| `apps/api/src/modules/national-catalog/national-catalog.controller.ts`        | Product lookup/refresh endpoints                              |
| `apps/api/scripts/report-national-catalog-matrix.mjs`                         | Read-only exact/ambiguous/unmapped classifier report          |
| `docs/runbooks/national-catalog-live-validation.md`                           | Real-token gate without recording secrets                     |

### Task 1: Configuration and a typed, bounded National Catalog client

**Files:**

- Modify: `apps/api/src/env.ts`
- Modify: `.env.example`
- Modify: `.env.production.example`
- Create: `apps/api/src/modules/national-catalog/national-catalog.types.ts`
- Create: `apps/api/src/modules/national-catalog/national-catalog.client.ts`
- Test: `apps/api/test/national-catalog.client.test.ts`
- Create: `apps/api/test/national-catalog.live.test.ts`
- Create: `docs/runbooks/national-catalog-live-validation.md`

**Interfaces:**

- Produces `NationalCatalogClient.listCategories`, `getAttributes`, `getFeedProducts`, and `getPublishedProducts`.
- Produces `NationalCatalogResult<T>` consumed by Tasks 2–5.

- [ ] **Step 1: Write failing client tests**

Use injected fetch/abort dependencies, matching `true-api.client.ts`. Assert bearer header, ETag/`If-None-Match`, one-to-25 identifier bound, timeout cancellation, and status mapping:

```ts
type NationalCatalogResult<T> =
  | { status: "ok"; value: T; etag: string | null }
  | { status: "not_modified" }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "forbidden"; message: string }
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  | { status: "invalid_response" }
  | { status: "unavailable" };
```

Run: `pnpm --filter @markiro/api exec vitest run test/national-catalog.client.test.ts`

Expected: FAIL because the client does not exist.

- [ ] **Step 2: Add explicit optional configuration**

Add `NATIONAL_CATALOG_BASE_URL` as a trimmed valid HTTPS URL or empty/undefined, `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID` as an optional non-empty organization ID, and `NATIONAL_CATALOG_REQUEST_TIMEOUT_MS` as an integer defaulting to `15000`. `.env.example` also documents optional test-only `NATIONAL_CATALOG_LIVE_GTIN`; it is not required by production runtime. Example env files use empty URL/source-tenant values with a comment that deployment must select an authorized test/production tenant after live validation.

- [ ] **Step 3: Implement HTTP and strict boundary parsing**

Every method receives `{ baseUrl, token }`, builds paths only from fixed method constants, sends `Authorization: Bearer`, and never accepts an arbitrary URL. Product identifier arrays validate `1..25` and digit GTINs before fetch. Response parsers return normalized categories, attribute definitions, or card records; unknown extra source fields remain only in the raw payload returned alongside the normalized value.

Map `304`, `401`, `403`, `404`, `429`, other 4xx, 5xx, abort, and network errors to the union above. Bound rejection text to 500 characters and never include request headers.

- [ ] **Step 4: Add the opt-in live contract and safe runbook**

`national-catalog.live.test.ts` skips unless `NATIONAL_CATALOG_BASE_URL`, `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID`, and `NATIONAL_CATALOG_LIVE_GTIN` are set. It obtains the tenant token through `ChzTokenService`, then checks categories, attributes, the configured known GTIN, and an immediate ETag repeat. It records only method, outcome, result count, and ETag presence. `NATIONAL_CATALOG_LIVE_GTIN` is test data, not a credential.

The runbook documents secret-safe environment setup and the expected role/right evidence. It forbids printing the bearer or raw card payload.

- [ ] **Step 5: Verify mocked behavior and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/national-catalog.client.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: all pass.

```bash
git add apps/api/src/env.ts apps/api/src/modules/national-catalog/national-catalog.types.ts apps/api/src/modules/national-catalog/national-catalog.client.ts apps/api/test/national-catalog.client.test.ts apps/api/test/national-catalog.live.test.ts docs/runbooks/national-catalog-live-validation.md .env.example .env.production.example
git commit -m "feat(api): add National Catalog read client"
```

- [ ] **Step 6: Pass the real-token entry gate before Task 2**

Run: `pnpm --filter @markiro/api exec vitest run test/national-catalog.live.test.ts`

Expected: PASS against an authorized test environment, including ETag behavior. If it skips or reports forbidden/unsupported method access, stop this plan before persistence/feature work; foundation work may continue independently. Do not replace the documented methods or log a token to force the gate green.

### Task 2: Schema discovery, version comparison, and controlled activation

**Files:**

- Create: `apps/api/src/modules/national-catalog/national-catalog-schema.service.ts`
- Create: `apps/api/src/modules/national-catalog/national-catalog.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/modules/platform-operations/platform-operations.service.ts`
- Modify: `apps/api/src/modules/platform-operations/platform-operations.controller.ts`
- Test: `apps/api/test/national-catalog-schema.service.test.ts`
- Test: `apps/api/test/platform-operations.e2e.test.ts`

**Interfaces:**

- Produces `refreshSchemas(sourceTenantId: string): Promise<SchemaRefreshSummary>` and `activateSchemaVersion(actor, id)`.
- Active definitions are consumed by foundation readiness and Tasks 3–5.

- [ ] **Step 1: Write failing refresh/version tests**

Mock two category/attribute responses. First refresh inserts `observed`; same ETag/content inserts nothing; changed required field inserts a second observed version and reports `{ added: [], removed: [], newlyRequired: ["attribute-id"], changed: [] }`. Invalid condition references return `invalid_response` and persist no activatable version.

The representative fixtures pin the approved pilot anchors: beer attribute `15844` is multi-value EGAIS AP code; keg packaging activates attribute `23052`; dairy includes variable quantity and veterinary-control branches; water includes OKPD2/underground-water licence branching; soft drinks include sweetener-name and keg branching; non-alcoholic beer does not inherit beer EGAIS requiredness.

- [ ] **Step 2: Normalize official attributes into the domain schema**

Map official data types only to the foundation's supported discriminated types. Preserve unknown/unsupported definitions in raw JSON but fail validation with `UNSUPPORTED_ATTRIBUTE_TYPE` instead of weakening them to strings. Canonicalize object key order before SHA-256 hashing so equivalent payload order does not create versions.

- [ ] **Step 3: Persist observed versions and activate transactionally**

`refreshSchemas(sourceTenantId)` validates that the organization exists, obtains its active server-side token, and writes immutable `observed` rows keyed by `scopeKey + contentHash`. The source tenant is included only in the protected platform operation audit, not in the global schema row. Activation validates definition and reviewed group mappings, retires the previous active row for the same scope, marks the target active, and writes a platform audit event `national_catalog.schema.activated` with before/after version IDs and comparison counts.

Expose platform-authenticated routes:

```text
POST /platform/operations/national-catalog/schema-refresh
POST /platform/operations/national-catalog/schema-versions/:id/activate
```

The refresh body is `{ sourceTenantId: string }`. Do not expose refresh/activation through tenant cabinet guards. The scheduled job uses only `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID`; if absent, it records `disabled` and makes no request.

- [ ] **Step 4: Assemble module using the existing token/crypto pattern**

`NationalCatalogModule.forRoot(env)` provides the client factory, `ChzTokenService`, and `ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY)`. It exports the schema/product/freshness services but never exports decrypted auth.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/national-catalog-schema.service.test.ts test/platform-operations.e2e.test.ts test/openapi-coverage.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: all pass.

```bash
git add apps/api/src/modules/national-catalog apps/api/src/modules/platform-operations apps/api/src/app.module.ts apps/api/test/national-catalog-schema.service.test.ts apps/api/test/platform-operations.e2e.test.ts
git commit -m "feat(api): version National Catalog schemas"
```

### Task 3: Tenant GTIN lookup and immutable card snapshots

**Files:**

- Create: `apps/api/src/modules/national-catalog/dto.ts`
- Create: `apps/api/src/modules/national-catalog/national-catalog-products.service.ts`
- Create: `apps/api/src/modules/national-catalog/national-catalog.controller.ts`
- Modify: `apps/api/src/modules/national-catalog/national-catalog.module.ts`
- Test: `apps/api/test/national-catalog-products.e2e.test.ts`

**Interfaces:**

- Produces `POST /products/:id/national-catalog/lookups` and a snapshot-backed lookup DTO.
- Task 4 consumes snapshot ID and normalized card/category proposal.

- [ ] **Step 1: Write failing lookup outcome and tenant tests**

Assert exact results for card found, no card, multiple cards, missing/expired/undecryptable token, forbidden role, rate limit, unavailable service, and invalid card payload. Cross-tenant product IDs always return 404 before token lookup.

- [ ] **Step 2: Implement lookup order and snapshot deduplication**

Lookup locks nothing and does not mutate product values. It:

1. reads the tenant product/GTIN;
2. obtains the tenant token;
3. calls feed-product first, falling back to published-product only when visibility semantics require it;
4. persists each observed raw card once by content hash with ETag/status/fetched time;
5. resolves active schema candidates by category/TN VED;
6. checks the coarse product-group mapping;
7. returns `found`, `multiple`, `not_found`, `category_unmapped`, or the stable external error.

The response contains snapshot/card/category identifiers and normalized display fields, never the full raw payload or token.

- [ ] **Step 3: Add route guards and audit only sensitive successful reads**

Use cabinet `OPERATIONS_READ`. Write `product.national_catalog.looked_up` with product/snapshot/result metadata; exclude raw card JSON. Failed external attempts are captured as bounded integration events, not product mutation audit rows.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/national-catalog-products.e2e.test.ts test/openapi-coverage.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: all pass.

```bash
git add apps/api/src/modules/national-catalog apps/api/test/national-catalog-products.e2e.test.ts
git commit -m "feat(api): look up National Catalog product cards"
```

### Task 4: Snapshot-to-product diff and confirmed apply

**Files:**

- Modify: `apps/api/src/modules/national-catalog/dto.ts`
- Modify: `apps/api/src/modules/national-catalog/national-catalog-products.service.ts`
- Modify: `apps/api/src/modules/national-catalog/national-catalog.controller.ts`
- Test: `apps/api/test/national-catalog-products.e2e.test.ts`

**Interfaces:**

- Produces `POST /products/:id/national-catalog/import-previews`.
- Reuses foundation `POST /products/:id/regulatory-proposals/:proposalId/apply` unchanged.

- [ ] **Step 1: Write failing diff/provenance/idempotency tests**

Assert additions, equal values, exact mapped operational suggestions, unit mismatch conflicts, category mismatch, per-field accept/reject selection, source `national_catalog`, snapshot linkage, stale base revision, atomic apply, and idempotent replay.

- [ ] **Step 2: Normalize only against the snapshot's active schema**

Reject a preview when no active schema matches the card scope. For each schema attribute, parse the source value into the domain discriminated type. `diff` entries contain `currentValue`, `proposedValue`, `disposition` (`addition`, `same`, `conflict`, `mapped`, `ignored`), source attribute ID, and optional reviewed mapping ID.

- [ ] **Step 3: Persist a generic proposal and delegate apply**

Create `product_regulatory_proposals` with source `national_catalog`, source reference/snapshot, base revision, and immutable diff. The existing foundation apply service receives the user's accepted entry IDs, revalidates revision/mapping/schema, applies in one transaction, sets provenance/snapshot IDs, and audits exact accepted/rejected fields.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/national-catalog-products.e2e.test.ts test/product-regulatory.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Expected: all pass.

```bash
git add apps/api/src/modules/national-catalog apps/api/src/modules/product-regulatory apps/api/test/national-catalog-products.e2e.test.ts apps/api/test/product-regulatory.e2e.test.ts
git commit -m "feat(api): preview National Catalog imports"
```

### Task 5: ETag freshness jobs and complete classifier report

**Files:**

- Create: `apps/api/src/modules/national-catalog/national-catalog-freshness.service.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Create: `apps/api/test/national-catalog-jobs.test.ts`
- Create: `apps/api/scripts/report-national-catalog-matrix.mjs`
- Test: `apps/api/test/national-catalog-matrix-report.test.ts`

**Interfaces:**

- Produces scheduled schema refresh and tenant card freshness checks plus a read-only mapping report.

- [ ] **Step 1: Write failing unchanged/changed/retry tests**

Assert `304` creates no snapshot/proposal; changed ETag creates one snapshot and one pending preview; repeated same content is idempotent; 429 honors bounded retry time; missing token records a recoverable outcome without touching product readiness/projection.

- [ ] **Step 2: Implement bounded freshness batches**

`runBatch(limit = 50)` selects distinct tenant/product latest snapshots ordered by oldest check, obtains tokens per tenant, sends `If-None-Match`, and commits each product independently. No job payload contains a token. Return counts `{ checked, unchanged, changed, unavailable, forbidden }`.

- [ ] **Step 3: Wire pg-boss schedules**

Add queues before schedule/work registration:

```ts
const NATIONAL_CATALOG_SCHEMA_REFRESH_QUEUE = "national-catalog-schema-refresh";
const NATIONAL_CATALOG_SCHEMA_REFRESH_CRON = "43 2 * * *";
const NATIONAL_CATALOG_FRESHNESS_QUEUE = "national-catalog-product-freshness";
const NATIONAL_CATALOG_FRESHNESS_CRON = "17 */6 * * *";
```

Run one bounded pass at startup and each schedule. A failed external call completes the job with service counters; only infrastructure/programming failures throw for pg-boss retry.

- [ ] **Step 4: Add the classifier matrix report**

The script reads active schema versions and `chz_product_groups`, prints Markdown plus JSON summary with every group classified as `exact`, `ambiguous`, or `unmapped`, and exits non-zero if any group has no row. Tests seed all three states and assert deterministic ordering/no tenant data.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/national-catalog-jobs.test.ts test/national-catalog-matrix-report.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Expected: all pass.

```bash
git add apps/api/src/modules/national-catalog apps/api/src/jobs/jobs.module.ts apps/api/scripts/report-national-catalog-matrix.mjs apps/api/test/national-catalog-jobs.test.ts apps/api/test/national-catalog-matrix-report.test.ts
git commit -m "feat(api): refresh National Catalog observations"
```

### Task 6: Live-token revalidation and plan completion

**Files:**

- Modify only the runbook when observed official behavior differs from its recorded expectations; never record credentials or raw card payloads.

**Interfaces:**

- Produces explicit external evidence before production enablement; no automated test substitutes for it.

- [ ] **Step 1: Re-run the opt-in live contract**

Run: `pnpm --filter @markiro/api exec vitest run test/national-catalog.live.test.ts`

Expected: PASS against the same authorized test environment used after Task 1.

- [ ] **Step 2: Run automated package gates**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm format:check
git diff --check
```

Expected: all pass.

- [ ] **Step 3: Record the external result**

Follow the runbook evidence format. If any method now returns forbidden/unsupported, keep production integration disabled and record the exact role/right requirement; do not switch to card mutation methods or log credentials as a workaround. Commit a runbook correction only when the observed official contract changed; otherwise create no completion commit.
