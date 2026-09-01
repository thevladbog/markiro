# Category Attributes Foundation Implementation Plan

> **Superseded foundation contract (2026-09-01).** This file remains implementation
> history for the original foundation. New work must follow
> `docs/superpowers/specs/2026-09-01-national-catalog-foundation-hardening-design.md` and
> `docs/superpowers/plans/2026-09-01-national-catalog-foundation-hardening.md`; in
> particular, do not reuse the legacy requirement-rule shape, proposal diff/sourceRef
> semantics, lifecycle shortcuts, or snapshot identity described below.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the versioned category-schema, tenant product-profile, provenance, EGAIS, proposal, category-change, and readiness foundation without calling the National Catalog or changing Station.

**Architecture:** Pure schema/condition/readiness rules live in `@markiro/domain`; Postgres stores global immutable schema versions and tenant-scoped product state; a focused Nest module exposes manual profile/readiness/proposal routes. Existing product and Station contracts remain compatible, while later National Catalog and admin slices consume the new interfaces.

**Tech Stack:** TypeScript 6, Zod 4, Drizzle/Postgres, NestJS 11, Vitest/Supertest.

**Spec:** `docs/superpowers/specs/2026-08-31-category-product-attributes-national-catalog-design.md`

## Global Constraints

- Current next migration on the rebased branch is `0107`; generate it with Drizzle and do not hand-edit snapshots.
- Global schema/mapping tables contain no tenant values; every product value/proposal/snapshot table has `tenant_id` and composite tenant foreign keys.
- `products.status`, `products.egais_code`, and `products.shelf_life_days` remain present for rolling compatibility.
- Only exact reviewed mappings can write stable operational fields.
- Category change and proposal apply lock the product row and reject a stale `baseRevision`.
- Attribute values are superseded, never destructively rewritten; snapshots and proposals are immutable apart from lifecycle status/timestamps.
- Source values are `manual`, `1c`, `national_catalog`, or `migration`.
- Run `pnpm --filter @markiro/db build` before API tests so consumers do not execute stale DB output.
- This plan adds no National Catalog network calls, admin UI, Station schema, or CommerceML regulatory mapping.

---

## File Structure

| File                                                                       | Responsibility                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/domain/src/product-attributes/model.ts`                          | Zod schemas and shared regulatory/readiness types                |
| `packages/domain/src/product-attributes/conditions.ts`                     | Deterministic conditional-required evaluation                    |
| `packages/domain/src/product-attributes/readiness.ts`                      | Four-dimension readiness evaluation                              |
| `packages/domain/src/product-attributes/index.ts`                          | Product-attribute public exports                                 |
| `packages/domain/test/product-attributes.test.ts`                          | Pure condition/readiness coverage                                |
| `packages/db/src/schema/product-regulatory.ts`                             | Global schemas/mappings and tenant product regulatory tables     |
| `packages/db/migrations/0107_product_regulatory_foundation.sql`            | New tables, constraints, and valid legacy EGAIS backfill         |
| `packages/db/test/product-regulatory-schema.test.ts`                       | Constraint and tenant-FK assertions                              |
| `apps/api/src/modules/product-regulatory/dto.ts`                           | Strict request/response schemas and OpenAPI objects              |
| `apps/api/src/modules/product-regulatory/product-regulatory.service.ts`    | Profile reads, manual values, proposals, category changes, audit |
| `apps/api/src/modules/product-regulatory/readiness.service.ts`             | Loads facts and delegates to domain readiness                    |
| `apps/api/src/modules/product-regulatory/product-regulatory.controller.ts` | Cabinet routes and authorization                                 |
| `apps/api/src/modules/product-regulatory/product-regulatory.module.ts`     | Nest assembly and exported services                              |
| `apps/api/test/product-regulatory.e2e.test.ts`                             | Tenant, mutation, audit, stale revision, and readiness tests     |

### Task 1: Shared schema, value, condition, and readiness model

**Files:**

- Create: `packages/domain/src/product-attributes/model.ts`
- Create: `packages/domain/src/product-attributes/conditions.ts`
- Create: `packages/domain/src/product-attributes/readiness.ts`
- Create: `packages/domain/src/product-attributes/index.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/product-attributes.test.ts`

**Interfaces:**

- Produces: `categorySchemaDefinitionSchema`, `productAttributeValueSchema`, `isAttributeRequired`, `evaluateProductReadiness`, and the types named in the roadmap.
- Consumed by: Tasks 3–5 and every later plan.

- [ ] **Step 1: Write failing model and condition tests**

Create `packages/domain/test/product-attributes.test.ts` with explicit beer, dairy, water, and sweetener branches:

```ts
import { describe, expect, it } from "vitest";
import {
  categorySchemaDefinitionSchema,
  evaluateProductReadiness,
  isAttributeRequired,
  type CategoryAttributeDefinition,
} from "../src/index.js";

const conditional: CategoryAttributeDefinition = {
  id: "sweetenerName",
  label: "Наименование подсластителя",
  valueType: "string_list",
  multiplicity: "many",
  requiredLayers: [],
  requiredWhen: [{ attributeId: "hasSweetener", operator: "equals", value: true }],
  presets: [],
};
const trigger: CategoryAttributeDefinition = {
  id: "hasSweetener",
  label: "Содержит подсластитель",
  valueType: "boolean",
  multiplicity: "one",
  requiredLayers: ["circulation"],
  requiredWhen: [],
  presets: [],
};

describe("category attributes", () => {
  it("accepts a versioned strict schema", () => {
    expect(
      categorySchemaDefinitionSchema.parse({
        categoryId: "234225",
        scopeKey: "category:234225|tnved:none",
        attributes: [trigger, conditional],
      }),
    ).toBeDefined();
  });

  it("activates a condition only when its trigger matches", () => {
    expect(
      isAttributeRequired(
        conditional,
        { hasSweetener: { type: "boolean", value: true } },
        "circulation",
      ),
    ).toBe(true);
    expect(
      isAttributeRequired(
        conditional,
        { hasSweetener: { type: "boolean", value: false } },
        "circulation",
      ),
    ).toBe(false);
  });

  it("keeps production ready while circulation is incomplete", () => {
    const result = evaluateProductReadiness({
      schemaVersionId: "schema-1",
      schema: {
        categoryId: "softdrinks",
        scopeKey: "category:softdrinks|tnved:none",
        attributes: [trigger, conditional],
      },
      values: { hasSweetener: { type: "boolean", value: true } },
      production: { chzProductGroupCode: 23, boxCapacity: 12, palletCapacity: 60 },
      egais: { applicable: false, codes: [], primaryCode: null },
      schemaStale: false,
    });
    expect(result.find((one) => one.dimension === "production")?.state).toBe("ready");
    expect(result.find((one) => one.dimension === "circulation")).toMatchObject({
      state: "not_ready",
      reasons: [{ code: "ATTRIBUTE_REQUIRED", attributeId: "sweetenerName" }],
    });
    expect(result.find((one) => one.dimension === "egais")?.state).toBe("not_applicable");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing exports**

Run: `pnpm --filter @markiro/domain exec vitest run test/product-attributes.test.ts`

Expected: FAIL because `categorySchemaDefinitionSchema` and the evaluators do not exist.

- [ ] **Step 3: Implement the strict domain model**

In `model.ts`, define values as a discriminated union so values never depend on JavaScript coercion:

```ts
import { z } from "zod";

export const productAttributeValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), value: z.string() }).strict(),
  z.object({ type: z.literal("string_list"), value: z.array(z.string()).min(1) }).strict(),
  z
    .object({
      type: z.literal("decimal"),
      value: z.string().regex(/^-?\d+(\.\d+)?$/),
      unit: z.string().nullable(),
    })
    .strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("date"), value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ type: z.literal("enum"), value: z.string() }).strict(),
  z.object({ type: z.literal("enum_list"), value: z.array(z.string()).min(1) }).strict(),
]);

export const attributeConditionSchema = z
  .object({
    attributeId: z.string().min(1),
    operator: z.enum(["equals", "includes"]),
    value: z.union([z.string(), z.boolean()]),
  })
  .strict();

export const categoryAttributeDefinitionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    valueType: z.enum(["string", "string_list", "decimal", "boolean", "date", "enum", "enum_list"]),
    multiplicity: z.enum(["one", "many"]),
    requiredLayers: z.array(z.enum(["code_ordering", "circulation"])),
    requiredWhen: z.array(attributeConditionSchema),
    presets: z.array(z.object({ value: z.string(), label: z.string() }).strict()),
  })
  .strict();

export const categorySchemaDefinitionSchema = z
  .object({
    categoryId: z.string().min(1),
    scopeKey: z.string().min(1),
    attributes: z.array(categoryAttributeDefinitionSchema),
  })
  .strict()
  .superRefine((schema, context) => {
    const ids = new Set(schema.attributes.map((attribute) => attribute.id));
    if (ids.size !== schema.attributes.length)
      context.addIssue({ code: "custom", message: "Duplicate attribute id" });
    for (const attribute of schema.attributes) {
      for (const condition of attribute.requiredWhen) {
        if (!ids.has(condition.attributeId))
          context.addIssue({
            code: "custom",
            message: `Unknown condition attribute ${condition.attributeId}`,
          });
      }
    }
  });
```

Export inferred types plus `ProductAttributeSource`, readiness types, and `ProductAttributeValues = Record<string, ProductAttributeValue>`.

- [ ] **Step 4: Implement deterministic condition and readiness evaluation**

`conditions.ts` must treat missing triggers as false and compare without coercion:

```ts
export function isAttributeRequired(
  definition: CategoryAttributeDefinition,
  values: ProductAttributeValues,
  layer: "code_ordering" | "circulation",
): boolean {
  if (definition.requiredLayers.includes(layer)) return true;
  return definition.requiredWhen.some((condition) => {
    const actual = values[condition.attributeId];
    if (!actual) return false;
    if (condition.operator === "equals")
      return "value" in actual && actual.value === condition.value;
    return Array.isArray(actual.value) && actual.value.includes(String(condition.value));
  });
}
```

`readiness.ts` evaluates all four dimensions, emits one `ATTRIBUTE_REQUIRED` reason per missing active field, validates EGAIS with `/^\d{19}$/`, emits `EGAIS_PRIMARY_REQUIRED` for multiple codes without a primary, and changes code-ordering/circulation to `stale` when `schemaStale` is true. Production uses the existing non-null group/box/pallet rule.

- [ ] **Step 5: Export and verify the domain package**

Add `export * from "./product-attributes/index.js";` to `packages/domain/src/index.ts`, then run:

```bash
pnpm --filter @markiro/domain exec vitest run test/product-attributes.test.ts
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/product-attributes packages/domain/src/index.ts packages/domain/test/product-attributes.test.ts
git commit -m "feat(domain): model product category readiness"
```

### Task 2: Postgres regulatory foundation and legacy backfill

**Files:**

- Create: `packages/db/src/schema/product-regulatory.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/drizzle.config.ts`
- Create (generated): `packages/db/migrations/0107_product_regulatory_foundation.sql`
- Modify (generated): `packages/db/migrations/meta/_journal.json`
- Create (generated): `packages/db/migrations/meta/0107_snapshot.json`
- Test: `packages/db/test/product-regulatory-schema.test.ts`

**Interfaces:**

- Produces global tables `nationalCatalogSchemaVersions`, `nationalCatalogCategoryGroupMappings`, `nationalCatalogAttributeMappings`; tenant tables `productRegulatoryProfiles`, `productRegulatoryAttributeValues`, `productEgaisCodes`, `nationalCatalogCardSnapshots`, `productRegulatoryProposals`.
- Tasks 3–5 use these exact exports.

- [ ] **Step 1: Write failing structural tests**

Assert exact table names, product composite FKs, one active schema per `scope_key`, one current value per product/attribute, and one primary EGAIS code per product. Use `getTableConfig` as in `packages/db/test/schema.test.ts`:

```ts
expect(getTableName(schema.productRegulatoryProfiles)).toBe("product_regulatory_profiles");
expect(getTableName(schema.productRegulatoryAttributeValues)).toBe(
  "product_regulatory_attribute_values",
);
expect(getTableName(schema.productEgaisCodes)).toBe("product_egais_codes");
expect(getTableName(schema.productRegulatoryProposals)).toBe("product_regulatory_proposals");
```

Run: `pnpm --filter @markiro/db exec vitest run test/product-regulatory-schema.test.ts`

Expected: FAIL because the exports are absent.

- [ ] **Step 2: Declare enums and global tables**

Create enums with these exact persisted values:

```ts
export const nationalCatalogSchemaStatus = pgEnum("national_catalog_schema_status", [
  "observed",
  "validated",
  "active",
  "retired",
]);
export const productAttributeSource = pgEnum("product_attribute_source", [
  "manual",
  "1c",
  "national_catalog",
  "migration",
]);
export const productAttributeState = pgEnum("product_attribute_state", ["active", "inapplicable"]);
export const productRegulatoryProposalStatus = pgEnum("product_regulatory_proposal_status", [
  "preview",
  "applied",
  "rejected",
  "stale",
]);
```

`national_catalog_schema_versions` stores `id`, `scope_key`, `category_id`, `category_name`, `selectors jsonb`, `source_version`, `etag`, `content_hash char(64)`, `definition jsonb`, lifecycle timestamps, and a partial unique index on `scope_key where status = 'active'`.

`national_catalog_category_group_mappings` stores `chz_product_group_code`, nullable National Catalog category/schema references, `state` (`exact`, `ambiguous`, `unmapped`), and review metadata. `unmapped` rows have null category/schema references; ambiguous groups can have several candidate rows. `national_catalog_attribute_mappings` stores schema version, source attribute ID, target field, conversion JSON, and mapping version; unique on `(schema_version_id, source_attribute_id, target_field)`.

- [ ] **Step 3: Declare tenant tables and constraints**

Use `(tenant_id, product_id)` composite FKs to `products(tenant_id, id)` everywhere. Profiles have one row per product, `revision integer not null default 1`, confirmed category/TN VED/OKPD2/schema/source/user/times. Attribute values use an append-only UUID row and a partial unique index on `(tenant_id, product_id, attribute_id) where superseded_at is null`.

EGAIS codes use `(tenant_id, product_id, code)` as the primary key, `char(19)`, a digits-only check, and a partial unique index on `(tenant_id, product_id) where is_primary`.

Snapshots store tenant/product, GTIN-14, card ID/status, ETag/hash, `payload jsonb`, and `fetched_at`; unique on `(tenant_id, product_id, content_hash)`. Proposals store tenant/product, nullable snapshot, source/sourceRef, base revision, immutable `diff jsonb`, lifecycle, creator/applier, and timestamps.

- [ ] **Step 4: Generate and review migration 0107**

```bash
set -a
source .env
set +a
pnpm --filter @markiro/db db:generate
```

Rename the generated SQL/tag to `0107_product_regulatory_foundation`, preserving generated snapshot metadata. Append the valid legacy backfill after table creation:

```sql
INSERT INTO "product_egais_codes" ("tenant_id", "product_id", "code", "is_primary", "source")
SELECT "tenant_id", "id", "egais_code", true, 'migration'
FROM "products"
WHERE "egais_code" ~ '^[0-9]{19}$'
ON CONFLICT DO NOTHING;
```

Do not clear or alter `products.egais_code`; invalid values remain visible to compatibility readers and readiness.

- [ ] **Step 5: Build, test, apply, and inspect**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db db:migrate
```

Expected: all pass and migration applies. Query `information_schema.table_constraints` to confirm composite FKs, then verify no invalid legacy EGAIS value was removed from `products`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/product-regulatory.ts packages/db/src/schema.ts packages/db/drizzle.config.ts packages/db/migrations packages/db/test/product-regulatory-schema.test.ts
git commit -m "feat(db): add product regulatory foundation"
```

### Task 3: Regulatory profile, manual values, and readiness API

**Files:**

- Create: `apps/api/src/modules/product-regulatory/dto.ts`
- Create: `apps/api/src/modules/product-regulatory/readiness.service.ts`
- Create: `apps/api/src/modules/product-regulatory/product-regulatory.service.ts`
- Create: `apps/api/src/modules/product-regulatory/product-regulatory.controller.ts`
- Create: `apps/api/src/modules/product-regulatory/product-regulatory.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/product-regulatory.e2e.test.ts`
- Modify: `apps/api/test/openapi-coverage.test.ts` only if its explicit route inventory requires it

**Interfaces:**

- Produces `GET /products/:id/regulatory-profile`, `GET /products/:id/regulatory-category-options`, `GET /products/:id/readiness`, and `PATCH /products/:id/regulatory-attributes`.
- Exports `ProductRegulatoryService` and `ProductReadinessService` for later plans.

- [ ] **Step 1: Write failing tenant/readiness tests**

Seed one active schema/profile and assert:

```ts
const profile = await cabinet.get(`/products/${productId}/regulatory-profile`).expect(200);
expect(profile.body).toMatchObject({ productId, revision: 1, categoryId: "234225" });

const readiness = await cabinet.get(`/products/${productId}/readiness`).expect(200);
expect(readiness.body.dimensions).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ dimension: "production", state: "ready" }),
    expect.objectContaining({ dimension: "egais", state: "not_applicable" }),
  ]),
);

await otherTenant.get(`/products/${productId}/regulatory-profile`).expect(404);
```

Add a PATCH assertion that a manual boolean value is stored with source `manual`, increments profile revision, and writes one exact `tenant_audit_events` row.

- [ ] **Step 2: Run the e2e file and confirm 404 routes**

Run: `pnpm --filter @markiro/api exec vitest run test/product-regulatory.e2e.test.ts`

Expected: FAIL because the module/routes do not exist.

- [ ] **Step 3: Define strict DTOs**

The manual write body is:

```ts
export const updateRegulatoryAttributesSchema = z
  .object({
    baseRevision: z.number().int().positive(),
    values: z
      .array(
        z
          .object({
            attributeId: z.string().min(1),
            value: productAttributeValueSchema.nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
```

Response DTOs include confirmed binding, current schema metadata, current values with source/observed/applied timestamps, EGAIS codes, readiness dimensions, and pending proposal count. OpenAPI schemas set `additionalProperties: false` for fixed response objects.

`regulatory-category-options` returns active schema ID, category ID/name, applicable TN VED selectors, and mapping state for the product's current coarse group. It omits incompatible schemas and marks ambiguous candidates so the UI can require explicit acknowledgement.

- [ ] **Step 4: Implement tenant-scoped profile and value writes**

`ProductRegulatoryService.getProfile` first selects the product with both tenant and ID. Missing product returns 404 even if another tenant owns the UUID. Manual update transaction:

1. locks product and profile;
2. checks `baseRevision`;
3. validates every attribute exists in the active pinned schema and parses the discriminated value;
4. supersedes the current row and inserts a new `manual` row, or supersedes without replacement for `null`;
5. increments profile revision once for the whole mutation;
6. inserts `tenant_audit_events` action `product.regulatory_attributes.updated`, target type `product`, exact before/after attribute IDs and values;
7. returns the committed profile.

Throw `409 { code: "PRODUCT_REGULATORY_REVISION_STALE" }` on revision mismatch and `400 { code: "PRODUCT_ATTRIBUTE_INVALID", attributeId }` on schema/type failure.

- [ ] **Step 5: Implement readiness loading and routes**

`ProductReadinessService.getReadiness(tenantId, productId)` loads product production fields including the legacy EGAIS scalar, pinned schema definition, current values, EGAIS collection, and active schema ID for the scope. It calls `evaluateProductReadiness`; a pinned/active mismatch sets `schemaStale: true`. When no collection row exists, a non-empty legacy scalar is passed as an untrusted EGAIS candidate so the 19-digit rule produces a visible reason instead of hiding invalid migrated data.

Without a confirmed profile, production is still evaluated, code-ordering/circulation return `not_ready` with `CATEGORY_NOT_CONFIRMED`, and EGAIS applicability follows the coarse pilot group rule until a schema is confirmed. A missing external service never changes production readiness.

Controller routes use `TenantGuard`, `AuthorizationGuard`, `SubscriptionAccessGuard`, cabinet auth, `OPERATIONS_READ` for GET, and subscription write plus `OPERATIONS_WRITE` for PATCH.

- [ ] **Step 6: Verify API gates and commit**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/product-regulatory.e2e.test.ts test/openapi-coverage.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Expected: all pass.

```bash
git add apps/api/src/modules/product-regulatory apps/api/src/app.module.ts apps/api/test/product-regulatory.e2e.test.ts apps/api/test/openapi-coverage.test.ts
git commit -m "feat(api): expose product regulatory profiles"
```

### Task 4: Persisted category-change preview and atomic apply

**Files:**

- Modify: `apps/api/src/modules/product-regulatory/dto.ts`
- Modify: `apps/api/src/modules/product-regulatory/product-regulatory.service.ts`
- Modify: `apps/api/src/modules/product-regulatory/product-regulatory.controller.ts`
- Test: `apps/api/test/product-regulatory.e2e.test.ts`

**Interfaces:**

- Produces `POST /products/:id/category-change-previews` and `POST /products/:id/regulatory-proposals/:proposalId/apply` with body `{ acceptedEntryIds: string[] }`.
- Produces the generic persisted proposal/apply boundary consumed by National Catalog and future 1C work.

- [ ] **Step 1: Add failing exact/ambiguous/incompatible/stale tests**

Create mappings for two schema versions and assert:

```ts
const preview = await cabinet
  .post(`/products/${productId}/category-change-previews`)
  .send({
    baseRevision: 1,
    targetSchemaVersionId,
    tnVedCode: "2202991900",
    okpd2Code: null,
  })
  .expect(201);
expect(preview.body.diff.values).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ attributeId: "brand", disposition: "transferable" }),
    expect.objectContaining({ attributeId: "egais", disposition: "inapplicable" }),
  ]),
);
```

Assert an `incompatible` group mapping returns 409 `CATEGORY_GROUP_INCOMPATIBLE`; an ambiguous mapping requires an explicit `mappingConfirmed: true`; editing the product/profile before apply returns 409 and marks the proposal `stale`; another tenant gets 404 for the proposal.

- [ ] **Step 2: Run and confirm failures**

Run: `pnpm --filter @markiro/api exec vitest run test/product-regulatory.e2e.test.ts`

Expected: FAIL on missing preview/apply routes.

- [ ] **Step 3: Build a deterministic category diff**

The preview body is strict and the persisted diff uses these dispositions:

```ts
type CategoryValueDisposition = "transferable" | "convertible" | "inapplicable" | "conflict";
interface CategoryChangeDiffValue {
  entryId: string;
  attributeId: string;
  disposition: CategoryValueDisposition;
  currentValue: ProductAttributeValue;
  proposedValue?: ProductAttributeValue;
  mappingId?: string;
}
```

Transfer is allowed when the same attribute ID has the same value type/multiplicity. Conversion requires an active reviewed mapping whose source/target types and unit conversion match. Every other current value is inapplicable or conflict; label similarity is never consulted.

- [ ] **Step 4: Implement atomic apply and audit**

Apply transaction locks product, profile, and proposal; checks tenant, `preview` status, and base revision; closes old profile binding; supersedes all current values; inserts only accepted transferable/convertible values; changes schema/category/TN VED/OKPD2; increments revision; marks proposal applied; writes `product.regulatory_category.changed` audit with old/new binding and disposition counts.

Apply accepts only entry IDs present in the immutable diff; category/binding entries that are mandatory for a category change cannot be deselected. Replaying an already applied proposal with the same accepted-entry set returns the current profile without inserting duplicate values or audit rows. A replay with a different set, or a rejected/stale proposal ID, returns 409 with a stable code.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/product-regulatory.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: all pass.

```bash
git add apps/api/src/modules/product-regulatory apps/api/test/product-regulatory.e2e.test.ts
git commit -m "feat(api): preview product category changes"
```

### Task 5: Multi-code EGAIS compatibility and CommerceML write guard

**Files:**

- Modify: `apps/api/src/modules/product-regulatory/dto.ts`
- Modify: `apps/api/src/modules/product-regulatory/product-regulatory.service.ts`
- Modify: `apps/api/src/modules/product-regulatory/product-regulatory.controller.ts`
- Modify: `apps/api/src/modules/products/products.service.ts`
- Test: `apps/api/test/product-regulatory.e2e.test.ts`
- Test: `apps/api/test/commerceml-apply.test.ts`

**Interfaces:**

- Produces `PUT /products/:id/egais-codes` with `{ baseRevision, codes, primaryCode }`.
- Keeps existing `ProductDto.egaisCode` synchronized to the selected primary code.

- [ ] **Step 1: Write failing EGAIS and CommerceML regression tests**

Assert two 19-digit codes persist, exactly one primary is selected, `products.egais_code` equals that primary, and readiness becomes ready. Assert invalid length, duplicate codes, or a primary not in the list returns 400 without partial changes. Then process an existing CommerceML fixture and assert regulatory attribute/value/proposal row counts remain unchanged.

- [ ] **Step 2: Run the focused tests**

```bash
pnpm --filter @markiro/api exec vitest run test/product-regulatory.e2e.test.ts test/commerceml-apply.test.ts
```

Expected: FAIL on the missing EGAIS route/assertions.

- [ ] **Step 3: Implement one transactional EGAIS write path**

Validate with:

```ts
const egaisCodesBodySchema = z
  .object({
    baseRevision: z.number().int().positive(),
    codes: z
      .array(z.string().regex(/^\d{19}$/))
      .max(20)
      .superRefine((codes, ctx) => {
        if (new Set(codes).size !== codes.length)
          ctx.addIssue({ code: "custom", message: "Duplicate EGAIS code" });
      }),
    primaryCode: z
      .string()
      .regex(/^\d{19}$/)
      .nullable(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.codes.length > 0 && (!body.primaryCode || !body.codes.includes(body.primaryCode))) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryCode"],
        message: "Primary EGAIS code must be selected",
      });
    }
    if (body.codes.length === 0 && body.primaryCode !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryCode"],
        message: "Primary EGAIS code requires a code",
      });
    }
  });
```

Lock/check revision, replace the product EGAIS collection, update the legacy scalar to `primaryCode`, increment revision, and write `product.egais_codes.updated` audit. Existing `ProductsService` create/update remains compatible for rolling clients; when it receives `egaisCode`, refactor that write into the same DB transaction and route it through a shared internal helper that accepts one legacy code only if it is 19 digits, rather than bypassing the collection. Product creation inserts the product first and the code collection second inside one transaction; an invalid code rolls the whole create back.

- [ ] **Step 4: Verify compatibility and commit**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/product-regulatory.e2e.test.ts test/products.e2e.test.ts test/commerceml-apply.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Expected: all pass; CommerceML does not write regulatory tables.

```bash
git add apps/api/src/modules/product-regulatory apps/api/src/modules/products/products.service.ts apps/api/test/product-regulatory.e2e.test.ts apps/api/test/products.e2e.test.ts apps/api/test/commerceml-apply.test.ts
git commit -m "feat(products): support multiple EGAIS codes"
```

### Task 6: Foundation completion gate

**Files:**

- Modify only files required by failures caused by Tasks 1–5; do not broaden scope.

**Interfaces:**

- Produces the stable foundation consumed by the next implementation plan.

- [ ] **Step 1: Run package gates in dependency order**

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm format:check
git diff --check
```

Expected: all pass. Database-backed skips must be listed rather than treated as coverage.

- [ ] **Step 2: Review invariants**

Confirm with targeted queries/tests: another tenant cannot read any profile/value/proposal; invalid legacy EGAIS remains on `products`; no bearer-like value exists in snapshots/audit; Station and SQLite have zero diff; `products.status` behavior is unchanged.

- [ ] **Step 3: Commit only scoped fixes if the gate required them**

If the gate required a scoped correction, stage each corrected file by its exact path and commit `test: close product regulatory foundation gates`. If no fix was required, do not create an empty commit.
