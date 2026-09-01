# National Catalog Foundation Hardening Implementation Plan

> **For agentic workers:** Execute this plan sequentially with test-first changes. Keep
> the entire implementation in one pull request. Do not start the read-only import jobs,
> platform schema-refresh routes, admin UI, or production Lockbox changes in this plan.

**Goal:** Make the merged category-attribute and National Catalog foundations safe for a
complete read-only import by correcting schema semantics, proposal persistence/apply,
client bounds and freshness primitives, and production diagnostic behavior.

**Architecture:** `@markiro/domain` owns the versioned category-definition compatibility
boundary and deterministic readiness rules. Postgres owns immutable observations plus
tenant-safe proposal, history, and freshness state. The API parses every persisted
proposal before use and applies accepted operations in one locked transaction. The
National Catalog client remains server-only and read-only. Diagnostic v3 separates
operational compatibility from provider-contract degradation and is promoted with its
strict host validator in the same deployment artifact.

**Tech stack:** TypeScript 6, Zod 4, NestJS 11, Drizzle/Postgres, Vitest/Supertest,
Node test runner, pnpm 11.

**Spec:**
`docs/superpowers/specs/2026-09-01-national-catalog-foundation-hardening-design.md`

## Baseline and constraints

- Branch: `codex/national-catalog-foundation-hardening`, based on `origin/main` at
  `ae9c997f0` when this plan was written.
- Starting focused checks: domain 7/7, DB schema 7/7, National Catalog client 11/11,
  diagnostic 22/22.
- Generate migration `0108` with Drizzle. Do not edit `0107` or hand-edit the generated
  `0108_snapshot.json`.
- Generated SQL may be augmented only for the documented forward data migrations that
  Drizzle cannot express; review every such statement in migration tests.
- Rebuild `@markiro/db` before API tests.
- Never run a DB-backed test against production. Use the configured development/test
  `DATABASE_URL`; if absent, report the explicit skip.
- Do not log or place in fixtures a production token, tenant ID, GTIN, card ID, provider
  payload, database error, or provider rejection message.
- Preserve the existing `products.egais_code`, `products.shelf_life_days`, Station
  contracts, and offline payload shapes.
- Keep the provider integration read-only: GET methods only.

## Planned file map

| Area                 | Files                                                                                                  | Responsibility                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Domain               | `packages/domain/src/product-attributes/model.ts`                                                      | v2 definition, legacy parser, units, requirements                  |
| Domain               | `packages/domain/src/product-attributes/conditions.ts`                                                 | typed condition and requirement evaluation                         |
| Domain               | `packages/domain/src/product-attributes/readiness.ts`                                                  | mandatory state plus recommendations                               |
| Domain tests         | `packages/domain/test/product-attributes.test.ts`                                                      | v1 compatibility, v2 validation, layered readiness                 |
| DB                   | `packages/db/src/schema/product-regulatory.ts`                                                         | corrected constraints, proposal metadata, history/freshness tables |
| Migration            | `packages/db/migrations/0108_*.sql`, `packages/db/migrations/meta/0108_snapshot.json`, `_journal.json` | forward schema and data migration                                  |
| DB tests             | `packages/db/test/product-regulatory-schema.test.ts`                                                   | Drizzle shape and tenant keys                                      |
| DB tests             | `packages/db/test/product-regulatory-hardening-migration.test.ts`                                      | migrate real 0107-era rows through 0108                            |
| Proposal contract    | `apps/api/src/modules/product-regulatory/proposal-schema.ts`                                           | strict persisted proposal union and selection hash                 |
| API DTO              | `apps/api/src/modules/product-regulatory/dto.ts`                                                       | strict bodies/responses/OpenAPI                                    |
| API controller       | `apps/api/src/modules/product-regulatory/product-regulatory.controller.ts`                             | binding preview, retrieve, reject, apply routes                    |
| API service          | `apps/api/src/modules/product-regulatory/product-regulatory.service.ts`                                | transactional lifecycle and provenance                             |
| API readiness        | `apps/api/src/modules/product-regulatory/readiness.service.ts`                                         | v1/v2 schema parsing and recommendation response                   |
| Proposal tests       | `apps/api/test/product-regulatory-proposal.test.ts`                                                    | pure persisted-diff and replay-selection validation                |
| API e2e              | `apps/api/test/product-regulatory.e2e.test.ts`                                                         | tenant, initial binding, stale, apply, reject, audit               |
| Client               | `apps/api/src/modules/national-catalog/national-catalog.types.ts`                                      | selectors, usage, content hash, etagslist types                    |
| Client               | `apps/api/src/modules/national-catalog/national-catalog.client.ts`                                     | bounded GET transport and strict parsers                           |
| Client tests         | `apps/api/test/national-catalog.client.test.ts`                                                        | selectors, bounds, headers, status and payload coverage            |
| Diagnostic           | `apps/api/src/national-catalog-live-diagnostic.ts`                                                     | v3 collector and one pure decision evaluator                       |
| Diagnostic tests     | `apps/api/test/national-catalog-live-diagnostic.test.ts`                                               | independent capabilities and sanitized evidence                    |
| Host diagnostic      | `deploy/yandex/national-catalog-diagnostics.mjs`                                                       | strict v3 evidence/exit validator                                  |
| Host tests           | `deploy/yandex/test/national-catalog-diagnostics.test.mjs`                                             | closed schema and remote execution contract                        |
| Deployment contracts | `deploy/production/test/api-image-contract.test.mjs`, related Yandex contract tests if needed          | image/host promotion compatibility                                 |

---

## Task 1: Version the category-definition model and fix requirement semantics

**Files:**

- Modify: `packages/domain/src/product-attributes/model.ts`
- Modify: `packages/domain/src/product-attributes/conditions.ts`
- Modify: `packages/domain/src/product-attributes/readiness.ts`
- Modify: `packages/domain/test/product-attributes.test.ts`

**Interfaces:**

```ts
type RequirementLevel = "mandatory" | "recommended" | "optional";

type AttributeRequirementRule = {
  layer: "code_ordering" | "circulation";
  level: RequirementLevel;
  when: AttributeCondition | null;
};

type AttributeUnitDefinition = {
  canonical: string;
  allowed: string[];
} | null;

type CategorySchemaDefinitionV2 = {
  formatVersion: 2;
  categoryId: string;
  scopeKey: string;
  attributes: CategoryAttributeDefinitionV2[];
};

function parseCategorySchemaDefinition(value: unknown): CategorySchemaDefinitionV2;
function validateProductAttributeValue(
  definition: CategoryAttributeDefinitionV2,
  value: ProductAttributeValue,
): boolean;
```

- [ ] **Step 1: Write failing v2 and compatibility tests**

Extend `product-attributes.test.ts` with cases proving:

- an unconditional mandatory code-ordering rule affects only code ordering;
- a conditional mandatory circulation rule activates only for the matching trigger;
- a recommended rule appears in `recommendations` but leaves readiness `ready`;
- optional rules do not appear as missing;
- an unknown trigger, incompatible `includes`/scalar combination, duplicate equivalent
  rule, invalid unit, duplicate allowed unit, and decimal value with an unapproved unit
  fail;
- preset modes distinguish no presets, suggested guidance, and reviewed restricted
  values; legacy non-empty presets normalize to suggested;
- a format-v1 definition normalizes `requiredLayers` to unconditional mandatory rules and
  `requiredWhen` to conditional mandatory circulation rules;
- format-v1 input cannot pass the v2 persistence schema directly.

- [ ] **Step 2: Run the focused test and confirm the expected failure**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run test/product-attributes.test.ts
```

Expected: FAIL because `formatVersion`, requirement levels, units, recommendations, and
the legacy parser do not exist.

- [ ] **Step 3: Implement strict v2 schemas and the closed legacy parser**

Replace `requiredLayers`/`requiredWhen` in the v2 attribute schema with
`requirementRules`. Keep a private strict legacy schema containing exactly the current v1
keys. `parseCategorySchemaDefinition` must:

1. parse v2 directly;
2. otherwise parse the exact legacy form;
3. normalize legacy unconditional layers and circulation conditions deterministically;
4. reject every other shape.

Do not add `.passthrough()`, casts, or silent defaults for provider types.

- [ ] **Step 4: Add cross-field validation and deterministic value validation**

Validate trigger existence, operator compatibility, preset/value type compatibility,
multiplicity, and unit metadata in `superRefine`. Implement one value validator used by
API writes and proposal apply; do not reproduce value-type checks in the service.

- [ ] **Step 5: Update readiness output**

Return `recommendations: ProductReadinessReason[]` on every readiness dimension. Only
missing mandatory rules determine `ready`/`not_ready`. Keep production, EGAIS, and stale
semantics unchanged.

- [ ] **Step 6: Run domain gates**

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
```

Expected: PASS with no compatibility regression.

- [ ] **Step 7: Commit the domain contract**

```bash
git add packages/domain/src/product-attributes packages/domain/test/product-attributes.test.ts
git commit -m "fix(domain): version regulatory requirement rules"
```

---

## Task 2: Add forward-only proposal, history, snapshot, and freshness persistence

**Files:**

- Modify: `packages/db/src/schema/product-regulatory.ts`
- Modify: `packages/db/test/product-regulatory-schema.test.ts`
- Create: `packages/db/test/product-regulatory-hardening-migration.test.ts`
- Create: `packages/db/migrations/0108_<generated-name>.sql`
- Create: `packages/db/migrations/meta/0108_snapshot.json`
- Create: `packages/db/migrations/0109_<generated-name>.sql` when the post-review snapshot
  deduplication correction is generated separately
- Create: `packages/db/migrations/meta/0109_snapshot.json` in that case
- Modify: `packages/db/migrations/meta/_journal.json`

**Schema additions:**

- `product_regulatory_proposal_kind` enum: `category_binding`, `category_change`,
  `national_catalog_import`;
- `national_catalog_card_source_method` enum: `legacy_unknown`, `feed_product`,
  `product`;
- proposal columns: `kind`, `expires_at`, `terminal_reason`, `applied_selection`,
  `applied_selection_hash`, `rejected_by`;
- snapshot columns: `source_method`, `payload_format_version`;
- `product_regulatory_binding_history` append-only table;
- `national_catalog_card_freshness` mutable cursor table;
- composite freshness/snapshot identity across tenant, product, card, and source method;
- snapshot content uniqueness within tenant, product, card, and source method;
- composite proposal identity needed by tenant/product/proposal foreign keys;
- `(scope_key, content_hash)` schema-version uniqueness replacing global hash uniqueness.

- [ ] **Step 1: Write failing Drizzle schema tests**

Extend the schema test to assert exact enums, columns, unique indexes, checks, and
composite tenant/product foreign keys. Assert history and freshness tables are exported.
Assert new snapshots permit `legacy_unknown`, while application tests later forbid it for
new writes.

- [ ] **Step 2: Write the failing 0107-to-0108 migration test**

Create a scratch database through migration 0107, then seed:

- one schema version with a known content hash;
- one active format-v1 schema/profile;
- one applied manual category-change proposal whose `source_ref` is the current sorted
  UUID JSON selection;
- one preview proposal old enough to expire;
- one legacy whole-envelope card snapshot.

Apply all migrations and assert:

- inserting the same hash in a second scope is now permitted but duplicate scope/hash is
  not;
- the profile revision/value remains unchanged;
- one migration binding-history row exists with source `migration` and no invented source
  reference;
- applied selection is backfilled with manual `source_ref` cleared; its legacy selection
  hash remains null without requiring `pgcrypto`;
- the legacy preview has deterministic expiry;
- the legacy snapshot has payload format 1 and `legacy_unknown` method;
- no source product compatibility field was rewritten.

- [ ] **Step 3: Run the two tests and confirm missing schema/migration failures**

```bash
pnpm --filter @markiro/db exec vitest run \
  test/product-regulatory-schema.test.ts \
  test/product-regulatory-hardening-migration.test.ts
```

- [ ] **Step 4: Implement the Drizzle schema**

Use the repository composite-FK pattern for every product-owned row. History must include
prior/next category and schema IDs, resulting revision, source/sourceRef, actor,
proposal ID, and timestamp. Freshness must include last snapshot, provider ETag, content
hash, last checked/changed timestamps, source method, and bounded last outcome.

- [ ] **Step 5: Generate migration 0108**

Load the development environment only if present, without overwriting it, then run:

```bash
set -a
source .env
set +a
pnpm --filter @markiro/db db:generate
```

If `.env` is absent, provide a non-production development `DATABASE_URL` only for the
generator. Verify the generated index is 0108. Do not edit snapshot JSON.

- [ ] **Step 6: Add the bounded data migration statements**

Augment only the generated SQL to:

- classify all existing proposals as `category_change`;
- derive expiry from `created_at` using the fixed 24-hour application TTL;
- parse only a valid JSON array of UUID strings from applied manual `source_ref`, copy it
  to `applied_selection`, leave its legacy hash null, and clear that scratch reference;
- leave an unparsable legacy row intact with no replay selection;
- backfill one history row per existing profile;
- mark existing snapshots format 1 and `legacy_unknown`;
- replace the old global content-hash unique constraint after checking there is no
  duplicate `(scope_key, content_hash)` pair.

Do not normalize or rewrite stored schema-definition JSON.

- [ ] **Step 7: Run DB verification**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
```

Report if migration tests skipped due to absent `DATABASE_URL`; do not call them covered.

- [ ] **Step 8: Commit persistence changes**

```bash
git add packages/db/src/schema/product-regulatory.ts \
  packages/db/test/product-regulatory-schema.test.ts \
  packages/db/test/product-regulatory-hardening-migration.test.ts \
  packages/db/migrations/0108_*.sql \
  packages/db/migrations/meta/0108_snapshot.json \
  packages/db/migrations/meta/_journal.json
git commit -m "fix(db): harden regulatory proposal persistence"
```

---

## Task 3: Define a strict persisted proposal contract

**Files:**

- Create: `apps/api/src/modules/product-regulatory/proposal-schema.ts`
- Create: `apps/api/test/product-regulatory-proposal.test.ts`
- Modify: `apps/api/src/modules/product-regulatory/dto.ts`
- Modify: `apps/api/src/modules/product-regulatory/readiness.service.ts`

**Contract:**

The persisted diff is a discriminated union on `version` and `kind`. New rows use version

1. A private legacy category-change schema accepts only the exact 0107 shape.

Common entry targets are closed unions:

- `attribute`: target schema/attribute plus current and proposed typed values;
- `egais_codes`: whole validated code collection plus primary code;
- `stable_field`: a fixed allowlist, reviewed mapping ID/version, current value, proposed
  value, and exact conversion metadata.

Category binding/change contains a target binding. National Catalog import pins
`snapshotId` and the exact `national-catalog-snapshot:<snapshot UUID>` `sourceRef` through
the proposal row and cannot carry another source inside the diff.

- [ ] **Step 1: Write failing pure proposal tests**

Cover valid binding/change/import shapes and reject:

- unknown kind/version/key;
- duplicate entry ID;
- duplicate EGAIS code or invalid primary;
- incompatible typed attribute value;
- stable field outside the allowlist or without exact mapping identity;
- source/kind mismatch;
- legacy JSON widened with an extra key.

Test `canonicalProposalSelection` with sorted unique UUIDs and SHA-256 hashing. Duplicate
accepted IDs must fail instead of being silently deduplicated.

- [ ] **Step 2: Confirm the focused failure**

```bash
pnpm --filter @markiro/api exec vitest run test/product-regulatory-proposal.test.ts
```

- [ ] **Step 3: Implement proposal schemas and helpers**

Expose only typed parse/normalize helpers. Do not export raw Zod internals to the service.
The legacy normalizer must preserve current category-change semantics and must not create
source provenance that was absent.

- [ ] **Step 4: Tighten DTO and OpenAPI contracts**

- reject duplicate `acceptedEntryIds`;
- allow `baseRevision: 0` only for initial binding preview;
- add strict response schemas for preview, proposal retrieval, rejection, and apply;
- remove `additionalProperties: true` from category preview responses;
- add `recommendations` to readiness OpenAPI output.

- [ ] **Step 5: Make every schema consumer use the compatibility parser**

Replace direct `categorySchemaDefinitionSchema.parse(...)` calls in regulatory and
readiness services with `parseCategorySchemaDefinition(...)`. New schema persistence in
later PR 2 will accept v2 only.

- [ ] **Step 6: Run focused API unit/type checks**

```bash
pnpm --filter @markiro/api exec vitest run test/product-regulatory-proposal.test.ts
pnpm --filter @markiro/api typecheck
```

- [ ] **Step 7: Commit the proposal contract**

```bash
git add apps/api/src/modules/product-regulatory/proposal-schema.ts \
  apps/api/src/modules/product-regulatory/dto.ts \
  apps/api/src/modules/product-regulatory/readiness.service.ts \
  apps/api/test/product-regulatory-proposal.test.ts
git commit -m "fix(api): validate persisted regulatory proposals"
```

---

## Task 4: Implement initial binding and atomic source-aware proposal lifecycle

**Files:**

- Modify: `apps/api/src/modules/product-regulatory/product-regulatory.service.ts`
- Modify: `apps/api/src/modules/product-regulatory/product-regulatory.controller.ts`
- Modify: `apps/api/test/product-regulatory.e2e.test.ts`

**Routes:**

```text
POST /products/:id/category-binding-previews
POST /products/:id/category-change-previews        # compatibility alias/explicit change
GET  /products/:id/regulatory-proposals/:proposalId
POST /products/:id/regulatory-proposals/:proposalId/reject
POST /products/:id/regulatory-proposals/:proposalId/apply
```

- [ ] **Step 1: Expand e2e fixtures without bypassing production validation**

Create helpers for an active v2 schema, exact/ambiguous/incompatible mapping, product with
no profile, manual category-change proposal, and National Catalog snapshot/import
proposal. Seed through Drizzle only where no public producer exists yet.

- [ ] **Step 2: Write failing initial-binding and authorization tests**

Assert:

- revision 0 creates profile revision 1 and one binding-history row;
- revision 0 conflicts when a profile already exists;
- positive revision requires an existing profile;
- incompatible group and unconfirmed ambiguity fail before proposal creation;
- another tenant cannot retrieve, reject, or apply the proposal;
- archived/missing products follow the documented route behavior.

- [ ] **Step 3: Write failing lifecycle/revalidation tests**

Assert:

- retrieve returns the closed stored proposal;
- reject is idempotent only for an already rejected preview;
- applied/stale reject conflicts;
- expired apply marks stale and writes no product values;
- revision mismatch and changed `currentValue` mark stale;
- inactive target schema or mapping-version drift writes nothing;
- a selected entry outside the diff and duplicate selection fail;
- identical applied selection replays without another history/value/audit row;
- different replay selection conflicts.
- a legacy applied proposal with an unparseable selection remains auditable but refuses
  replay instead of guessing what was accepted.

- [ ] **Step 4: Write failing source/provenance and atomicity tests**

Seed a National Catalog import proposal and assert accepted values use
`source: national_catalog`, retain the snapshot/source reference, and record the exact
selection hash. Inject a late invalid entry and prove profile, values, EGAIS, stable
fields, proposal state, history, and audit all remain unchanged.

Audit assertions must verify exact actor, tenant, action, target, result, source, source
reference, prior/resulting revision, proposal kind, and selected IDs/hash.

- [ ] **Step 5: Run the e2e file and confirm failures**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/product-regulatory.e2e.test.ts
```

- [ ] **Step 6: Implement preview/retrieve/reject**

Use one internal preview builder for initial binding and category change. Keep the old
category-change route operational, but give initial binding a correctly named route.
Every query includes tenant and product scope. Retrieval parses the persisted diff before
returning it.

- [ ] **Step 7: Refactor apply into one locked transaction**

Inside the transaction:

1. lock the tenant product;
2. lock proposal and current profile if present;
3. handle exact replay from stored selection hash;
4. reject terminal/expired/stale state;
5. parse diff and revalidate source/kind/snapshot;
6. validate revision-0 versus positive-revision semantics;
7. reload active schema, group mapping, attribute mappings, and current values;
8. validate every selected operation before the first business write;
9. write profile/value/EGAIS/stable-field changes with proposal provenance;
10. append binding history when binding changes;
11. store applied selection/hash and terminal timestamps;
12. write exact audit metadata.

Do not hard-code `manual`; source comes from the proposal. Do not use `sourceRef` as replay
storage.

- [ ] **Step 8: Run API package gates**

```bash
pnpm --filter @markiro/api exec vitest run \
  test/product-regulatory-proposal.test.ts \
  test/product-regulatory.e2e.test.ts
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Record any DB-dependent skip separately.

- [ ] **Step 9: Commit lifecycle changes**

```bash
git add apps/api/src/modules/product-regulatory \
  apps/api/test/product-regulatory.e2e.test.ts
git commit -m "fix(api): make regulatory proposals atomic and source aware"
```

---

## Task 5: Complete the bounded read-only National Catalog client contract

**Files:**

- Modify: `apps/api/src/modules/national-catalog/national-catalog.types.ts`
- Modify: `apps/api/src/modules/national-catalog/national-catalog.client.ts`
- Modify: `apps/api/test/national-catalog.client.test.ts`

**Interfaces:**

```ts
type NationalCatalogUsage = {
  total: { used: number; limit: number } | null;
  method: { used: number; limit: number } | null;
};

type NationalCatalogOk<T> = {
  status: "ok";
  value: T;
  etag: string | null;
  contentHash: string;
  usage: NationalCatalogUsage;
};

type NationalCatalogCategoriesRequest = {
  catId?: number;
  gismtCode?: number;
  tnved?: string;
  ifNoneMatch?: string;
};

type NationalCatalogEtagsRequest = {
  brandId?: number;
  ownerInn?: string;
  catId?: number;
  offset?: number;
};
```

`/v3/etagslist` returns `goodsCount`, `offset`, `lastProductNumber`, `total`, and at most
100 `{ goodId, etag }` entries.

- [ ] **Step 1: Write failing selector and etagslist tests**

Assert exact URL encoding for categories `cat_id`, `gismt_code`, and `tnved`; validate
positive numeric IDs and TN VED digits. Assert etagslist filter/offset encoding, 100-item
response bound, pagination consistency, malformed ETag rows, and invalid owner INN.

- [ ] **Step 2: Write failing metadata and body-bound tests**

Assert:

- `API-Usage-Limit: 1/500` and `API-Method-Usage-Limit: 1/10` parse exactly;
- absent or malformed headers become `null` rather than failing valid data;
- successful bytes produce deterministic lowercase SHA-256;
- a response at the configured method bound succeeds;
- a response one byte over the bound returns `invalid_response` without parsing;
- invalid UTF-8/JSON and a truncated stream return `invalid_response`;
- cancellation still runs after overflow or transport failure.

- [ ] **Step 3: Write failing per-card raw retention tests**

The normalized product item must retain its own raw record. The response must not expose
the full envelope as the snapshot payload. Categories/attributes may retain bounded raw
items needed for future schema normalization. Verify authorization and usage headers are
never copied into raw data.

- [ ] **Step 4: Confirm focused failures**

```bash
pnpm --filter @markiro/api exec vitest run test/national-catalog.client.test.ts
```

- [ ] **Step 5: Implement the bounded transport once**

Read `Response.body` incrementally, reject overflow before concatenating an unbounded
body, compute the hash from exact successful bytes, decode/parse once, and attach optional
ETag/usage metadata. Keep 304 body-free and content-hash-free. Preserve stable error union
semantics.

Use explicit per-method maximum response sizes as named constants. Do not make the bound
environment-configurable in this PR; changing it requires code review and tests.

- [ ] **Step 6: Implement selectors, etagslist, and strict parsers**

Use official query names and response keys. Do not infer GTIN from good ID or vice versa.
Enforce the documented maximum of 100 etagslist goods in one response.

- [ ] **Step 7: Run client and API gates**

```bash
pnpm --filter @markiro/api exec vitest run test/national-catalog.client.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

- [ ] **Step 8: Commit client changes**

```bash
git add apps/api/src/modules/national-catalog \
  apps/api/test/national-catalog.client.test.ts
git commit -m "feat(api): complete bounded National Catalog reads"
```

---

## Task 6: Replace live diagnostic v2 with independent, sanitized v3 evidence

**Files:**

- Modify: `apps/api/src/national-catalog-live-diagnostic.ts`
- Modify: `apps/api/test/national-catalog-live-diagnostic.test.ts`

**Evidence shape:**

```ts
type NationalCatalogDiagnosticEvidence = {
  version: 3;
  passed: boolean;
  sourceStatus: NationalCatalogDiagnosticSourceStatus;
  contractStatus: "conformant" | "degraded";
  capabilities: {
    schemaRead: "available" | "unavailable" | "not_checked";
    ownedCardRead: "available" | "unavailable" | "not_checked";
    publishedCardRead: "available" | "unavailable" | "not_checked";
  };
  checks: NationalCatalogDiagnosticCheck[];
  violations: NationalCatalogDiagnosticViolation[];
};
```

Checks contain only closed method, outcome, result count, cache observation, and usage
presence fields. They contain no identifiers or free-form messages.

- [ ] **Step 1: Replace success-fixture tests with a decision table**

Write pure evaluator cases for:

- ETag + 304 conformant success;
- missing categories ETag + equal repeat hash operational success/degraded contract;
- ETag + unchanged 200 operational success/degraded contract;
- valid empty feed and product reads as available capabilities;
- private-only and published-only visibility;
- both card methods valid but empty;
- authorization, malformed response, rate limit, and transport failures per capability;
- schema failure as operational failure;
- source acquisition failure with no provider checks.

- [ ] **Step 2: Write collector continuation and sanitization tests**

Assert a missing ETag does not stop attributes/card checks; feed and published checks are
independent; repeated hash is attempted only when needed; the output recursively contains
none of the supplied tenant/GTIN/card/token/provider-message sentinels.

- [ ] **Step 3: Confirm v2 implementation fails v3 tests**

```bash
pnpm --filter @markiro/api exec vitest run test/national-catalog-live-diagnostic.test.ts
```

- [ ] **Step 4: Implement one pure evaluator and phase collector**

The collector gathers bounded observations. A single pure function derives capabilities,
violations, contract status, and `passed`. The CLI only serializes evidence and maps
`passed` to exit 0/1; it must not contain a second decision tree.

Keep production source loading bounded to at most two active tokens and one tenant GTIN.
The GTIN is a probe input, not an evidence field. Do not require the same probe to be
visible in both card scopes.

- [ ] **Step 5: Run diagnostic and API gates**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run \
  test/national-catalog.client.test.ts \
  test/national-catalog-live-diagnostic.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

- [ ] **Step 6: Commit API diagnostic v3**

```bash
git add apps/api/src/national-catalog-live-diagnostic.ts \
  apps/api/test/national-catalog-live-diagnostic.test.ts
git commit -m "fix(api): make National Catalog diagnostics capability based"
```

---

## Task 7: Promote the strict v3 host validator with the API image

**Files:**

- Modify: `deploy/yandex/national-catalog-diagnostics.mjs`
- Modify: `deploy/yandex/test/national-catalog-diagnostics.test.mjs`
- Modify: `apps/api/test/national-catalog-live-diagnostic.test.ts`
- Modify: `deploy/production/test/api-image-contract.test.mjs` only if an image-copy/build
  assertion is needed by the final implementation
- Modify: `deploy/yandex/test/runtime-diagnostics.test.mjs` only if the workflow contract
  changes

- [ ] **Step 1: Write failing host-schema tests**

Replace the v2 fixture with v3 evidence. Assert rejection of:

- version 2 or any unknown version;
- extra top-level, capability, check, or violation keys;
- unknown enums and impossible primitive bounds;
- identifiers/messages inserted at any level;
- oversized output, malformed JSON, missing final newline, or extra output;
- exit 0 with `passed: false` and exit 1 with `passed: true`.

The host validator validates the closed evidence schema and exit agreement. It does not
reimplement the API evaluator's capability decision table.

- [ ] **Step 2: Keep remote command security tests unchanged**

Preserve authenticated known-hosts handling, fixed deploy login, exact active-container
selection, shell-safe argument arrays, bounded stdout, failure-stage classification, and
workspace cleanup tests.

- [ ] **Step 3: Implement strict v3 validation**

Use exact-key checks at every object depth and explicit array/count bounds. Accept checks
in the phase order produced by the collector while allowing independent skipped/failing
capabilities represented by the closed contract.

- [ ] **Step 4: Keep the cross-boundary contract test**

The API diagnostic test dynamically imports the host validator and proves real API v3
evidence is accepted. Add a version-2 rejection assertion so image/host drift cannot be
hidden by a compatibility union.

- [ ] **Step 5: Run deployment contracts**

```bash
node --test deploy/yandex/test/national-catalog-diagnostics.test.mjs
pnpm --filter @markiro/api exec vitest run test/national-catalog-live-diagnostic.test.ts
pnpm test:yandex-runtime
pnpm test:production-bundle:contract
```

- [ ] **Step 6: Commit host/deployment contract changes**

```bash
git add deploy/yandex/national-catalog-diagnostics.mjs \
  deploy/yandex/test/national-catalog-diagnostics.test.mjs \
  apps/api/test/national-catalog-live-diagnostic.test.ts \
  deploy/production/test/api-image-contract.test.mjs \
  deploy/yandex/test/runtime-diagnostics.test.mjs
git commit -m "fix(deploy): validate National Catalog diagnostic v3"
```

Stage only files actually changed; omit untouched optional files from `git add`.

---

## Task 8: Reconcile documentation, run final verification, and open one PR

**Files:**

- Modify if necessary:
  `docs/superpowers/specs/2026-09-01-national-catalog-foundation-hardening-design.md`
- Add: `docs/superpowers/plans/2026-09-01-national-catalog-foundation-hardening.md`
- Modify only if behavior changed from their claims:
  `docs/superpowers/plans/2026-08-31-category-attributes-foundation.md`
  and `docs/superpowers/plans/2026-08-31-national-catalog-readonly-import.md`

- [ ] **Step 1: Audit the implementation against every acceptance criterion**

Check each spec section against code/tests. Update the old plans only with a short
supersession note where their instructions would otherwise cause an unsafe future
implementation. Do not rewrite historical completed steps.

- [ ] **Step 2: Update the local code graph**

The graph is ignored and exists in the main checkout rather than this worktree. Reuse it
through an ignored worktree-local symlink, then update it against the changed worktree:

```bash
ln -s ../../graphify-out graphify-out
graphify update .
```

If the symlink already exists, validate its exact target instead of replacing it. Verify
important Graphify findings in current source; do not commit `graphify-out/` or alter
unrelated generated state.

- [ ] **Step 3: Run final focused and package checks**

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build

pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint

pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build

pnpm test:yandex-runtime
pnpm test:production-bundle:contract
pnpm format:check
git diff --check
```

If broad changes affect another package reported by Turbo/Graphify, run that consumer's
focused gate before completion.

- [ ] **Step 4: Review repository state and staged diff**

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git diff --cached --stat
```

Confirm there are no `.env` files, tokens, raw production evidence, node_modules, build
outputs, Graphify output, or unrelated changes.

- [ ] **Step 5: Commit plan/spec reconciliation**

```bash
git add docs/superpowers/specs/2026-09-01-national-catalog-foundation-hardening-design.md \
  docs/superpowers/plans/2026-09-01-national-catalog-foundation-hardening.md
git commit -m "docs: define National Catalog foundation hardening"
```

Include old plan files only if Step 1 changed them.

- [ ] **Step 6: Request a final code review and address only verified findings**

Review the full branch diff against the approved spec, tenant isolation, migration safety,
provenance, body bounds, and diagnostic sanitization. Re-run the narrow checks for every
accepted correction.

- [ ] **Step 7: Push and open one pull request**

Push `codex/national-catalog-foundation-hardening` and open a single PR describing:

- behavior and migration changes;
- why diagnostic v3 may pass with `contractStatus: degraded`;
- automated checks and any DB skips;
- no live production claim yet;
- explicit PR 2 boundary.

- [ ] **Step 8: Deploy only after merge through the protected workflow**

After required CI/review and merge, use `.github/workflows/deploy-production.yml`. Then
run `.github/workflows/diagnose-production.yml` with National Catalog enabled. Record only
the sanitized v3 evidence and workflow links. Do not use ad-hoc server commands or expose
provider data.

PR 2 begins only after this production diagnostic is reviewed.

## Completion report contract

The final handoff must separately list:

- changed behavior;
- schema/migration/API/client/diagnostic areas changed;
- focused and package checks with counts/results;
- database-backed checks that ran versus skipped;
- protected deployment and live diagnostic evidence, if performed;
- external checks not performed;
- the exact remaining boundary for PR 2.
