# Recurring Services P2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell monthly service packages, create one paid allowance period per applied invoice line, let authorized platform users append auditable work and external approvals, and show the resulting ledger to the tenant.

**Architecture:** Commercial protocol V4 carries immutable monthly service terms through catalog, offer, invoice and document snapshots. Payment application creates a non-overlapping `service_periods` row, while append-only usage and approval ledgers derive the balance under a locked period revision. Platform and tenant controllers expose separate authorization boundaries and projections over the same service-ledger read model.

**Tech Stack:** TypeScript 6, Zod 4, NestJS, Drizzle ORM, PostgreSQL, React 19, TanStack Query 5, React Hook Form, i18next, Vitest, Testing Library, Playwright-compatible browser harnesses.

**Spec:** `docs/superpowers/specs/2026-09-14-recurring-services-p2a-design.md`

## Global Constraints

- Support monthly billing and monthly allowance replenishment only.
- Set `includedMinutes` to an integer from 1 through 100,000.
- Set `carryover` to `none` and `excessPolicy` to `external_approval`.
- Do not create an allowance until its invoice payment is applied.
- Do not carry unused minutes forward or create an automatic overage charge.
- Require an external approval reference and bounded approved-minute delta before excess work can consume more capacity.
- Keep one-time services and commercial protocol V1 through V3 behavior unchanged.
- Return `client_update_required` when an older protocol requests a recurring-service representation.
- Use `Europe/Moscow`, calendar month boundaries and `after_current` activation.
- Keep recurring-service quantity equal to one.
- Derive balance from immutable period terms and append-only ledgers; never persist a mutable balance.
- Validate work by `performedAt`; permit a later posting date for work performed inside the selected period.
- Lock tenant scope, period and referenced rows in the order defined by the spec.
- Keep platform, cabinet, public API and device credentials in their existing trust domains.
- Do not expose internal notes, platform actor IDs or approval internals in tenant responses.
- Add populated-table constraints as `NOT VALID` and validate them in the following migration.
- Before creating migrations, fetch `origin/main` and confirm 0157 is still the next free index; if main has advanced, renumber 0157–0159 as one contiguous sequence without changing their order.
- Rebuild `@markiro/db` and `@markiro/platform-contracts` before consumer tests.
- Preserve the unrelated files in the main checkout; perform all work in `/private/tmp/markiro-recurring-services-p2a`.

## File and responsibility map

- `packages/platform-contracts/src/commercial-terms.ts`: V4 line terms and monthly service policy.
- `packages/platform-contracts/src/catalog.ts`, `tenants.ts`: recurring service catalog projections.
- `packages/platform-contracts/src/service-periods.ts`: shared platform and tenant ledger API schemas.
- `packages/platform-contracts/src/platform-auth.ts`: `services.read` and `services.write` role capabilities.
- `packages/db/src/schema/service-periods.ts`: period, usage and approval tables.
- `packages/db/migrations/0157_recurring_services.sql`: additive tables, indexes and unvalidated constraints.
- `packages/db/migrations/0158_validate_recurring_services.sql`: deferred validation.
- `apps/api/src/platform-http/commercial-version.ts`: V4 negotiation and downgrade rejection.
- `apps/api/src/modules/platform-catalog/`: catalog persistence and publication validation.
- `apps/api/src/modules/billing/`: commercial snapshots and paid period activation.
- `apps/api/src/modules/service-periods/`: platform ledger mutations and read model.
- `apps/api/src/modules/tenant-billing/`: tenant-only service-period projection.
- `apps/api/src/modules/billing-acts/`: immutable links from acts to usage entries.
- `apps/saas-admin/src/pages/catalog/`: monthly-package editor.
- `apps/saas-admin/src/pages/service-periods/`: service workspace and mutation recovery.
- `apps/admin/src/pages/billing/`: tenant service-period list and detail.
- `docs/operations/recurring-services.md`: rollout and recovery runbook.
- `docs/acceptance/recurring-services-p2a.md`: verification ledger with proof boundaries.

---

### Task 1: Define commercial V4 and service-period contracts

**Files:**

- Modify: `packages/platform-contracts/src/commercial-terms.ts`
- Modify: `packages/platform-contracts/src/catalog.ts`
- Modify: `packages/platform-contracts/src/catalog-validation.ts`
- Modify: `packages/platform-contracts/src/tenants.ts`
- Modify: `packages/platform-contracts/src/platform-auth.ts`
- Create: `packages/platform-contracts/src/service-periods.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Create: `packages/platform-contracts/test/catalog-v4.test.ts`
- Create: `packages/platform-contracts/test/service-periods.test.ts`
- Modify: `packages/platform-contracts/test/commercial-terms.test.ts`
- Modify: `packages/platform-contracts/test/platform-auth.test.ts`

**Interfaces:**

- Produces: `monthlyServiceTermsSchema`, `commercialLineTermsV4Schema`, `servicePeriodRevisionSchema`, `platformServicePeriodContracts`, `tenantServicePeriodContracts`, `ServicePeriodDetail`, `ServiceUsagePostInput` and the two new platform capabilities.
- Consumes: existing primitive schemas, V1–V3 catalog schemas and `platformCapabilitiesForRole` ordering.

- [x] **Step 1: Write failing V4 catalog and line-term tests**

```ts
const recurring = catalogVersionCreateV4Schema.parse({
  nameRu: "Сервисное сопровождение",
  nameEn: "Service support",
  unit: "месяц",
  unitPrice: "30000.00",
  vatRateBps: null,
  vatIncluded: false,
  billingMode: "recurring",
  billingPeriod: "month",
  service: {
    cadence: "month",
    includedMinutes: 180,
    carryover: "none",
    excessPolicy: "external_approval",
    scopeRu: "Консультации и настройка",
    scopeEn: "Consulting and configuration",
    operatingHoursRu: null,
    operatingHoursEn: null,
    schedulingTermsRu: null,
    schedulingTermsEn: null,
  },
});
expect(recurring.service.includedMinutes).toBe(180);
expect(() => catalogVersionCreateSchema.parse(recurring)).toThrow();
expect(() => catalogVersionCreateV4Schema.parse({ ...recurring, billingPeriod: "year" })).toThrow();
```

- [x] **Step 2: Write failing ledger-contract and role tests**

```ts
expect(platformCapabilitiesForRole.support).toEqual(
  expect.arrayContaining(["services.read", "services.write"]),
);
expect(platformCapabilitiesForRole.accountant).toContain("services.read");
expect(platformCapabilitiesForRole.accountant).not.toContain("services.write");

expect(
  serviceUsagePostSchema.parse({
    requestId: crypto.randomUUID(),
    expectedRevision: 3,
    classification: "customer_service",
    performedAt: "2026-09-20T09:00:00+03:00",
    actualMinutes: 45,
    allowanceMinutes: 45,
    workReference: "SUP-42",
    description: "Настройка интеграции",
    internalNote: null,
  }),
).toMatchObject({ actualMinutes: 45, allowanceMinutes: 45 });
```

- [x] **Step 3: Run the contract tests and confirm they fail on missing exports**

Run: `corepack pnpm@11.22.0 --filter @markiro/platform-contracts exec vitest run test/catalog-v4.test.ts test/service-periods.test.ts test/commercial-terms.test.ts test/platform-auth.test.ts`

Expected: FAIL because V4 and service-period schemas do not exist.

- [x] **Step 4: Implement strict monthly-service and ledger schemas**

```ts
export const monthlyServiceTermsSchema = z
  .object({
    cadence: z.literal("month"),
    includedMinutes: z.number().int().min(1).max(100_000),
    carryover: z.literal("none"),
    excessPolicy: z.literal("external_approval"),
    scopeRu: z.string().trim().min(1).max(4_000),
    scopeEn: z.string().trim().min(1).max(4_000).nullable(),
    operatingHoursRu: z.string().trim().min(1).max(1_000).nullable(),
    operatingHoursEn: z.string().trim().min(1).max(1_000).nullable(),
    schedulingTermsRu: z.string().trim().min(1).max(1_000).nullable(),
    schedulingTermsEn: z.string().trim().min(1).max(1_000).nullable(),
  })
  .strict();

export const commercialLineTermsV4Schema = z.discriminatedUnion("version", [
  commercialLineTermsSchema,
  commercialLineTermsSchema
    .omit({ version: true })
    .extend({
      version: z.literal(2),
      subject: z.enum(["service", "development_work"]),
      billingPeriod: z.literal("month"),
      billingTimezone: z.literal("Europe/Moscow"),
      activationRule: z.literal("after_current"),
      serviceTerms: monthlyServiceTermsSchema,
    })
    .strict(),
]);
```

Define cursor-bound list schemas, derived states `upcoming | active | expired`, balance fields, usage/correction/approval/withdrawal inputs and strict response schemas in `service-periods.ts`. Set every request ID to UUID, every expected revision to a positive PostgreSQL integer, descriptions to 1–4,000 trimmed characters, internal notes to 0–4,000 nullable characters and list limits to 1–100.

```ts
export const servicePeriodRevisionSchema = z.number().int().min(1).max(2_147_483_647);
export type ServicePeriodDetail = z.output<typeof platformServicePeriodDetailSchema>;
export type ServiceUsagePostInput = z.output<typeof serviceUsagePostSchema>;
```

- [x] **Step 5: Add V4 catalog unions and exact role capability ordering**

Keep `catalogVersionCreateSchema` and existing response schemas unchanged. Export new `catalogVersionCreateV4Schema`, `catalogVersionPatchV4Schema` and `catalogVersionV4Schema` unions that add the monthly service branch. Insert `services.read` and `services.write` in `platformCapabilitySchema`; use the same order in every role array so `platformPrincipalSchema` remains exact.

- [x] **Step 6: Run all affected contract tests**

Run: `corepack pnpm@11.22.0 --filter @markiro/platform-contracts test`

Expected: PASS, including explicit rejection of annual services, carryover, auto-overage, quantity outside one and unknown fields.

- [x] **Step 7: Commit the contract boundary**

```bash
git add packages/platform-contracts
git commit -m "feat: define recurring service contracts"
```

### Task 2: Add service-period persistence and migration invariants

**Files:**

- Create: `packages/db/src/schema/service-periods.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/schema/saas.ts`
- Create: `packages/db/migrations/0157_recurring_services.sql`
- Create: `packages/db/migrations/0158_validate_recurring_services.sql`
- Create: `packages/db/migrations/meta/0157_snapshot.json`
- Create: `packages/db/migrations/meta/0158_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/test/recurring-services-schema.test.ts`
- Create: `packages/db/test/recurring-services-migration.test.ts`

**Interfaces:**

- Produces: `servicePeriods`, `serviceUsageEntries`, `serviceExcessApprovals` and their `$inferSelect` types.
- Consumes: `orderedServices`, `invoiceLines`, `billingPayments`, `catalogItemVersions`, `organization` and `platformUsers` composite identities.

- [x] **Step 1: Write failing schema tests for tenant keys, append-only rows and bounds**

```ts
expect(schema.servicePeriods).toBeDefined();
expect(schema.serviceUsageEntries).toBeDefined();
expect(schema.serviceExcessApprovals).toBeDefined();

expect(readMigration("0157_recurring_services.sql")).toContain(
  'EXCLUDE USING gist ("tenant_id" WITH =, "catalog_item_id" WITH =, tstzrange("starts_at", "ends_at", \'[)\') WITH &&)',
);
expect(readMigration("0157_recurring_services.sql")).toContain("NOT VALID");
expect(readMigration("0158_validate_recurring_services.sql")).toContain(
  'VALIDATE CONSTRAINT "catalog_item_versions_kind_billing_check"',
);
```

- [x] **Step 2: Run the focused DB tests and confirm missing-schema failure**

Run: `corepack pnpm@11.22.0 --filter @markiro/db exec vitest run test/recurring-services-schema.test.ts test/recurring-services-migration.test.ts`

Expected: FAIL because the tables and migrations do not exist.

- [x] **Step 3: Define the Drizzle tables with explicit constraints**

Use a focused schema module. The table columns must encode these exact durable facts:

```ts
export const servicePeriods = pgTable("service_periods", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull(),
  orderedServiceId: uuid("ordered_service_id").notNull(),
  catalogItemId: uuid("catalog_item_id").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  invoiceId: uuid("invoice_id").notNull(),
  invoiceLineId: uuid("invoice_line_id").notNull(),
  paymentId: uuid("payment_id").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  billingTimezone: text("billing_timezone").notNull(),
  renewalAnchor: jsonb("renewal_anchor").notNull(),
  commercialSnapshot: jsonb("commercial_snapshot").notNull(),
  allowanceSnapshot: jsonb("allowance_snapshot").notNull(),
  includedMinutes: integer("included_minutes").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Add `serviceTerms: jsonb("service_terms")` to `catalogItemVersions`. The widened
catalog check requires it to be null for plans, add-ons and one-time services,
and a JSON object for a monthly recurring service. Task 3 performs the strict
field-level Zod parse when data crosses the application boundary.

Usage stores `actual_minutes_delta`, `allowance_minutes_delta`, `performed_at`, `posted_at`, actor, request hash and stored response. Approval stores `kind`, signed `minute_delta`, external reference/URL, approval date, original approval ID, actor, request hash and stored response. Add unique `(tenant_id, id)` and `(tenant_id, request_id)` keys and composite tenant foreign keys.

```ts
export type ServicePeriodRow = typeof servicePeriods.$inferSelect;
export type ServiceUsageEntryRow = typeof serviceUsageEntries.$inferSelect;
export type ServiceExcessApprovalRow = typeof serviceExcessApprovals.$inferSelect;
```

- [x] **Step 4: Generate migration metadata and review the SQL**

Run: `corepack pnpm@11.22.0 --filter @markiro/db db:generate`

Rename the generated migration to `0157_recurring_services.sql`, then add the catalog billing constraint replacement, finite-time checks, JSON-object checks, request hash checks and the GIST exclusion constraint. Put only populated-table foreign keys/checks behind `NOT VALID`; new-table constraints are valid at creation.

- [x] **Step 5: Add the deferred validation migration**

```sql
BEGIN;
ALTER TABLE "catalog_item_versions"
  VALIDATE CONSTRAINT "catalog_item_versions_kind_billing_check";
COMMIT;
```

Run `corepack pnpm@11.22.0 --filter @markiro/db db:generate -- --custom --name validate_recurring_services` after the schema migration exists, replace only that custom migration's empty SQL body with the transaction above and retain the generated snapshot and journal entry.

- [x] **Step 6: Run DB package verification**

Run: `corepack pnpm@11.22.0 --filter @markiro/db test && corepack pnpm@11.22.0 --filter @markiro/db typecheck && corepack pnpm@11.22.0 --filter @markiro/db lint && corepack pnpm@11.22.0 --filter @markiro/db build`

Expected: PASS. Database-backed cases may skip only when `DATABASE_URL` is absent; record that separately.

- [x] **Step 7: Commit the persistence layer**

```bash
git add packages/db
git commit -m "feat: persist recurring service periods and ledgers"
```

### Task 3: Negotiate V4 and persist recurring catalog services

**Files:**

- Modify: `apps/api/src/platform-http/commercial-version.ts`
- Modify: `apps/api/src/modules/billing-profiles/billing-profiles.controller.ts`
- Modify: `apps/api/src/modules/billing/billing.controller.ts`
- Modify: `apps/api/src/modules/platform-billing-requests/platform-billing-requests.controller.ts`
- Modify: `apps/api/src/modules/platform-catalog/dto.ts`
- Modify: `apps/api/src/modules/platform-catalog/platform-catalog.controller.ts`
- Modify: `apps/api/src/modules/platform-catalog/platform-catalog.service.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.controller.ts`
- Modify: `apps/api/src/modules/platform-tenants/platform-tenants.controller.ts`
- Create: `apps/api/test/commercial-v4.integration.test.ts`
- Modify: `apps/api/test/commercial-version.test.ts`
- Modify: `apps/api/test/platform-catalog.e2e.test.ts`

**Interfaces:**

- Produces: `CommercialVersion = 1 | 2 | 3 | 4`, V4 catalog create/read/update/publish behavior and explicit downgrade rejection.
- Consumes: Task 1 schemas and Task 2 catalog constraint.

- [x] **Step 1: Write failing negotiation and downgrade tests**

```ts
expect(commercialVersion({ headers: { "x-markiro-commercial-version": "4" } })).toBe(4);

await request(app.getHttpServer())
  .get(`/platform/catalog/${serviceId}/versions/${versionId}`)
  .set("X-Markiro-Commercial-Version", "3")
  .expect(409)
  .expect(({ body }) => expect(body.code).toBe("client_update_required"));
```

Also prove V1–V3 can still create and read one-time services byte-for-byte through their existing response schemas.

- [x] **Step 2: Run the focused API tests and confirm V4 is rejected**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/commercial-version.test.ts test/commercial-v4.integration.test.ts test/platform-catalog.e2e.test.ts`

Expected: FAIL because header value `4` and recurring service payloads are unsupported.

- [x] **Step 3: Extend version selection without changing older schemas**

```ts
export type CommercialVersion = 1 | 2 | 3 | 4;

if (version === "2") return 2;
if (version === "3") return 3;
if (version === "4") return 4;
```

Make `projectCommercialResponse(4, value)` return the full value. For versions 1–3, detect an object with `kind === "service" && billingMode === "recurring"` or a non-null `serviceTerms` field and throw `ConflictException({ code: "client_update_required" })` before schema parsing.

Extend `commercialResponse` with an optional V4 schema while retaining current
argument behavior for every existing caller:

```ts
export function commercialResponse<T1, T2, T3 = T2, T4 = T3>(
  version: CommercialVersion,
  legacy: ZodType<T1>,
  v2: ZodType<T2>,
  value: unknown,
  v3?: ZodType<T3>,
  v4?: ZodType<T4>,
): T1 | T2 | T3 | T4 {
  const projected = projectCommercialResponse(version, value);
  if (version === 4) return (v4 ?? v3 ?? v2).parse(projected);
  if (version === 3) return (v3 ?? v2).parse(projected);
  return version === 2 ? v2.parse(projected) : legacy.parse(projected);
}
```

Update every controller that reads the version header so value `4` reaches its
V4 schema rather than falling through to the legacy branch. Routes without new
fields reuse their V3/V2 schema explicitly.

- [x] **Step 4: Store and map the recurring service payload**

Persist Task 1's service policy in `catalog_item_versions.service_terms`. Parse every declared payload with `monthlyServiceTermsSchema`; null means a one-time service, while malformed stored JSON raises a data-integrity error and never becomes `{}`.

Publication must reject annual recurrence, missing English scope when English document metadata exists, quantity semantics other than one and any unsupported policy value.

- [x] **Step 5: Run API catalog and compatibility tests**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/commercial-version.test.ts test/commercial-v4.integration.test.ts test/platform-catalog.e2e.test.ts test/commercial-catalog-review.test.ts test/catalog-sales-without-lifecycle-policy.test.ts`

Expected: PASS with V4 recurring behavior and unchanged V1–V3 one-time behavior.

- [x] **Step 6: Commit protocol negotiation and catalog persistence**

```bash
git add apps/api/src/platform-http apps/api/src/modules/platform-catalog apps/api/test/commercial-version.test.ts apps/api/test/commercial-v4.integration.test.ts apps/api/test/platform-catalog.e2e.test.ts
git commit -m "feat: add recurring services to commercial v4"
```

### Task 4: Freeze recurring service terms into offers, invoices and documents

**Files:**

- Modify: `apps/api/src/modules/billing/commercial-line-terms.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offer-draft.ts`
- Modify: `apps/api/src/modules/platform-offers/offer-preview-model.ts`
- Modify: `apps/api/src/modules/platform-offers/offer-terms.ts`
- Modify: `apps/api/src/modules/platform-offers/offer-documents.service.ts`
- Modify: `apps/api/src/modules/billing/billing.service.ts`
- Modify: `apps/api/src/modules/billing/print-document-model.ts`
- Modify: `packages/platform-contracts/src/offer-draft.ts`
- Modify: `packages/platform-contracts/src/commercial.ts`
- Modify: `packages/platform-contracts/src/offer-workspace.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Modify: `apps/api/test/billing-offer-snapshot.test.ts`
- Modify: `apps/api/test/offer-preview-documents.test.ts`
- Modify: `apps/api/test/billing-invoices.test.ts`
- Create: `apps/api/test/recurring-service-documents.test.ts`

**Interfaces:**

- Produces: `platformCommercialV4Contracts`, `platformOfferWorkspaceV4Contracts`, immutable V4 `commercialTerms.version === 2` snapshots on offer and invoice lines and bilingual document rows.
- Consumes: the published catalog policy from Task 3.

- [x] **Step 1: Write failing snapshot and reprint tests**

```ts
expect(offer.lines[0]?.commercialTerms).toMatchObject({
  version: 2,
  billingPeriod: "month",
  billingTimezone: "Europe/Moscow",
  activationRule: "after_current",
  serviceTerms: { includedMinutes: 180, carryover: "none" },
});

await changeCatalogDraftPrice("45000.00");
expect(await renderStoredInvoice(invoice.id)).toEqual(firstRenderedBytes);
```

Assert English document issuance fails when `scopeEn` is null, while Russian issuance remains available.

- [x] **Step 2: Run the focused document tests and confirm missing snapshots**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/billing-offer-snapshot.test.ts test/offer-preview-documents.test.ts test/billing-invoices.test.ts test/recurring-service-documents.test.ts`

Expected: FAIL because service terms are not frozen or rendered.

- [x] **Step 3: Extend line freezing for recurring services**

```ts
if (line.kind === "service" && version.billingMode === "recurring") {
  if (line.quantity !== 1) {
    throw new BadRequestException({ code: "commercial_service_quantity_invalid" });
  }
  return commercialLineTermsV4Schema.parse({
    version: 2,
    subject: version.subject,
    documentNameRu: version.documentNameRu,
    documentNameEn: version.documentNameEn,
    sellerPolicyRevision: version.sellerPolicyRevision,
    billingPeriod: "month",
    billingTimezone: "Europe/Moscow",
    activationRule: "after_current",
    serviceTerms: version.service,
  });
}
```

Use the stored line snapshot for every preview, offer, invoice and reprint. Do not reconstruct terms from the current catalog version.

Create V4 offer/invoice line unions by replacing V2's
`commercialLineTermsSchema` field with `commercialLineTermsV4Schema`. Export
`platformCommercialV4Contracts` and `platformOfferWorkspaceV4Contracts`; pass
them as the V4 schema argument from platform offer, billing and billing-request
controllers. Leave the V2 contract objects unchanged.

- [x] **Step 4: Render exact service terms in RU and retain the complete EN snapshot**

Add rows for cadence, included minutes, scope, operating hours, scheduling terms, no carryover and external approval. Keep price and VAT rendering on the existing money/tax path. Do not claim response time or 24/7 coverage when the corresponding field is null.

Implementation note: the current legal commercial-document renderer has only a
Russian issuance surface. V4 freezes every English field and catalog publication
rejects a missing English scope whenever an English document name is configured;
an English document route remains outside this task rather than being implied by
the existing Russian render endpoint.

- [x] **Step 5: Run offer, invoice and document regression suites**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/billing-offer-snapshot.test.ts test/offer-preview-documents.test.ts test/billing-invoices.test.ts test/recurring-service-documents.test.ts test/offer-terms.test.ts test/offer-preview-model.test.ts`

Expected: PASS, including stored-snapshot reprints after catalog edits.

- [x] **Step 6: Commit commercial snapshots**

```bash
git add packages/platform-contracts/src/offer-draft.ts packages/platform-contracts/src/commercial.ts apps/api/src/modules/platform-offers apps/api/src/modules/billing apps/api/test
git commit -m "feat: snapshot recurring service commercial terms"
```

### Task 5: Create one paid service period during payment application

**Files:**

- Create: `apps/api/src/modules/service-periods/service-period-activation.ts`
- Create: `apps/api/src/modules/service-periods/service-period-observability.ts`
- Modify: `apps/api/src/modules/billing/billing-application.service.ts`
- Modify: `apps/api/src/modules/billing/billing.module.ts`
- Modify: `apps/api/test/billing-application-flow.test.ts`
- Create: `apps/api/test/service-period-activation.integration.test.ts`

**Interfaces:**

- Produces: `activatePaidServicePeriod(tx, input): Promise<ServicePeriodRow>`.
- Consumes: invoice line V4 snapshot, existing `resolveCommercialPeriod`, Task 2 tables and current invoice/payment lock order.

- [x] **Step 1: Write failing activation and idempotency tests**

```ts
const first = await applyPaidInvoice(recurringInvoice.id, payment.id);
const retry = await applyPaidInvoice(recurringInvoice.id, payment.id);

expect(await readPeriods(recurringInvoice.id)).toHaveLength(1);
expect(first.lines[0]?.result).toEqual(retry.lines[0]?.result);
expect(first.lines[0]?.result).toMatchObject({ includedMinutes: 180, revision: 1 });
```

Add a concurrency case applying two advance-renewal invoice lines for the same tenant and catalog item; assert consecutive, non-overlapping intervals.

- [x] **Step 2: Run activation tests and confirm no period is created**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/billing-application-flow.test.ts test/service-period-activation.integration.test.ts`

Expected: FAIL because only `ordered_services` is inserted.

- [x] **Step 3: Implement the locked activation function**

```ts
await tx.execute(
  sql`select pg_advisory_xact_lock(hashtextextended(${`service-period:${input.tenantId}:${input.catalogItemId}`}, 0))`,
);

const latest = await readLatestPaidServicePeriod(tx, input.tenantId, input.catalogItemId);
const anchorAt = latest?.renewalAnchor.anchorAt ?? input.operationAt.toISOString();
const cycle = latest ? latest.renewalAnchor.cycle + 1 : 0;
const period = resolveCommercialPeriod({
  billingPeriod: "month",
  billingTimezone: "Europe/Moscow",
  calendarPolicyVersion: 1,
  anchorAt,
  cycle,
});
```

Create `ordered_services` first, then `service_periods`, then the existing successful application event in one transaction. Use the invoice-line unique constraint for exact replay and map only that matching constraint to the stored result.

Return whether the activation inserted a new period. After the enclosing payment
application transaction commits, emit `period_created` once through
`ServicePeriodObservability`; an exact payment replay emits no event.

- [x] **Step 4: Cover unpaid and rollback behavior**

Add assertions that document generation, invoice issuance and unapplied payments create no period. Force the period insert to fail and assert the ordered service and application success event are also absent.

- [x] **Step 5: Run payment and period tests**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/billing-application-flow.test.ts test/service-period-activation.integration.test.ts test/billing-workflow-locks.test.ts test/commercial-paid-period.test.ts`

Expected: PASS with exactly one period per paid recurring line and unchanged one-time service fulfilment.

- [x] **Step 6: Commit paid period activation**

```bash
git add apps/api/src/modules/service-periods/service-period-activation.ts apps/api/src/modules/billing apps/api/test/billing-application-flow.test.ts apps/api/test/service-period-activation.integration.test.ts
git commit -m "feat: activate paid recurring service periods"
```

### Task 6: Implement the platform service ledger API

**Files:**

- Create: `apps/api/src/modules/service-periods/platform-service-periods.module.ts`
- Create: `apps/api/src/modules/service-periods/platform-service-periods.controller.ts`
- Create: `apps/api/src/modules/service-periods/service-periods.service.ts`
- Create: `apps/api/src/modules/service-periods/service-period-read-model.ts`
- Create: `apps/api/src/modules/service-periods/service-period-locks.ts`
- Create: `apps/api/src/modules/service-periods/service-period-request-replay.ts`
- Create: `apps/api/src/modules/service-periods/dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/service-periods.service.test.ts`
- Create: `apps/api/test/service-periods.integration.test.ts`
- Create: `apps/api/test/service-periods.authorization.test.ts`

**Interfaces:**

- Produces: cursor list, detail, usage, correction, approval and withdrawal routes under `/platform/service-periods`, registered only inside the `setup.platformAuth` branch.
- Consumes: Task 1 contracts, Task 2 ledgers, `PlatformAuthGuard`, `@RequirePlatformCapabilities` and platform audit conventions.

- [x] **Step 1: Write failing balance, correction and concurrency tests**

```ts
const usage = await service.postUsage(support, period.id, {
  requestId,
  expectedRevision: 1,
  classification: "customer_service",
  performedAt: insidePeriod,
  actualMinutes: 45,
  allowanceMinutes: 45,
  workReference: "SUP-42",
  description: "Настройка интеграции",
  internalNote: "Диагностика завершена",
});
expect(usage.balance).toEqual({
  included: 180,
  externallyApproved: 0,
  consumed: 45,
  remaining: 135,
});
expect(usage.revision).toBe(2);
```

Race two 100-minute posts against 180 minutes and assert one succeeds and one returns `SERVICE_ALLOWANCE_EXCEEDED`. Add defect usage with zero allowance, a negative correction, exact request replay and changed-body request conflict.

- [x] **Step 2: Write failing capability and reference-isolation tests**

Assert support can post usage, accountant cannot post usage, accountant can register approval through `billing.write`, support cannot register approval, platform admin can do both, cross-period references return the established not-found envelope, and the controller module is absent without platform auth.

Implementation note: platform operators are intentionally cross-tenant. This task denies
cross-period correction and withdrawal references without exposing the referenced row;
customer-session tenant isolation is applied to the tenant projection in Task 7.

- [x] **Step 3: Run focused service API tests and confirm module absence**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/service-periods.service.test.ts test/service-periods.integration.test.ts test/service-periods.authorization.test.ts`

Expected: FAIL because the service-period module is not registered.

- [x] **Step 4: Implement transactionally consistent reads and mutations**

```ts
await lockServiceNamespace(tx, tenantId);
const replay = await readServiceRequestReplay(tx, tenantId, input.requestId);
if (replay) return assertReplayHashAndParse(replay, input);
const period = await lockServicePeriod(tx, tenantId, periodId);
assertRevision(period.revision, input.expectedRevision);
assertPerformedInsidePeriod(input.performedAt, period.startsAt, period.endsAt);
const balance = await readServiceBalance(tx, period);
assertAllowance(balance.remaining, input.allowanceMinutes);
const entry = await insertUsageEntry(tx, period, actor, input);
const [updated] = await tx
  .update(schema.servicePeriods)
  .set({ revision: sql`${schema.servicePeriods.revision} + 1` })
  .where(and(eq(schema.servicePeriods.tenantId, tenantId), eq(schema.servicePeriods.id, periodId)))
  .returning();
```

For corrections and withdrawals, lock the referenced row after the period and reject a cross-period reference. A correction records its resulting classification; changing `customer_service` to `product_defect` uses a negative allowance delta that returns the original charge. Store canonical request hash and exact response. Map only the matching `(tenant_id, request_id)` unique violation to request conflict; rethrow all other database errors.

- [x] **Step 5: Add exact audit facts and bounded pagination**

Audit actor, role, tenant, target, request ID, source period, deltas and before/after aggregates. List SQL must apply cursor boundary and `limit + 1`; compute balance aggregates separately so pagination never changes totals. Detail returns the complete chronological ledger ordered by posting time and ID.

After a transaction commits a new row, emit exactly one structured event through
`ServicePeriodObservability`: `period_created`, `usage_posted`,
`defect_work_posted`, `correction_posted`, `allowance_blocked`,
`excess_approved` or `approval_withdrawn`. Include separate `count: 1` and
minute fields; an idempotent replay emits nothing. Test event name and numeric
fields with an injected observability fake rather than matching log text.

- [x] **Step 6: Run service API and authorization suites**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/service-periods.service.test.ts test/service-periods.integration.test.ts test/service-periods.authorization.test.ts test/platform-auth.guard.test.ts test/platform-auth.e2e.test.ts test/platform-audit.service.test.ts`

Expected: PASS with exact audit assertions and no platform controller when platform auth is not configured.

- [x] **Step 7: Commit the platform ledger API**

```bash
git add apps/api/src/modules/service-periods apps/api/src/app.module.ts apps/api/test/service-periods.service.test.ts apps/api/test/service-periods.integration.test.ts apps/api/test/service-periods.authorization.test.ts
git commit -m "feat: add platform recurring service ledger"
```

### Task 7: Expose the tenant-safe service ledger

**Files:**

- Modify: `apps/api/src/modules/tenant-billing/dto.ts`
- Modify: `apps/api/src/modules/tenant-billing/tenant-billing.controller.ts`
- Modify: `apps/api/src/modules/tenant-billing/tenant-billing-read.service.ts`
- Modify: `apps/api/src/modules/tenant-billing/tenant-billing.module.ts`
- Modify: `apps/api/test/tenant-billing-read.service.test.ts`
- Modify: `apps/api/test/tenant-billing-read.integration.test.ts`
- Modify: `apps/api/test/tenant-billing-read.authorization.test.ts`

**Interfaces:**

- Produces: `GET /billing/service-periods` and `GET /billing/service-periods/:id`.
- Consumes: Task 6 read model and existing `BILLING_READ`, tenant, subscription-read-only guards.

- [ ] **Step 1: Write failing own-tenant projection tests**

```ts
const detail = await readServicePeriod(tenantA, periodA.id);
expect(detail.entries[0]).toMatchObject({
  workReference: "SUP-42",
  actualMinutes: 45,
  allowanceMinutes: 45,
});
expect(detail.entries[0]).not.toHaveProperty("internalNote");
expect(detail.entries[0]).not.toHaveProperty("actorPlatformUserId");
expect(detail).not.toHaveProperty("approvals");
```

Request `periodA.id` under tenant B and assert 404 with no tenant A names, balance or timestamps. Verify restricted-subscription read-only access still permits these GET routes.

- [ ] **Step 2: Run tenant billing tests and confirm missing routes**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/tenant-billing-read.service.test.ts test/tenant-billing-read.integration.test.ts test/tenant-billing-read.authorization.test.ts`

Expected: FAIL with route or service method missing.

- [ ] **Step 3: Add cursor-bound tenant queries and customer projection**

The list accepts `state`, period boundary, cursor and limit; tenant ID always comes from `RequestWithTenant`. Reuse aggregate calculations but map entries through an explicit customer projection that includes performance/posting dates, work reference, description, actual and allowance minutes, classification and corrections only.

- [ ] **Step 4: Register guarded routes**

```ts
@Get("service-periods")
@ApiZodQuery(tenantServicePeriodContracts.list.query)
@ApiZodResponse({ status: 200, schema: tenantServicePeriodContracts.list.response })
listServicePeriods(@Req() req: RequestWithTenant, @Query(pipe) query: TenantServicePeriodListQuery) {
  return this.billing.listServicePeriods(req.tenantId!, query);
}

@Get("service-periods/:id")
@ApiZodResponse({ status: 200, schema: tenantServicePeriodContracts.detail.response })
servicePeriod(@Req() req: RequestWithTenant, @Param(pipe) params: { id: string }) {
  return this.billing.servicePeriod(req.tenantId!, params.id);
}
```

- [ ] **Step 5: Run tenant read and route inventory suites**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/tenant-billing-read.service.test.ts test/tenant-billing-read.integration.test.ts test/tenant-billing-read.authorization.test.ts test/subscription-route-inventory.test.ts`

Expected: PASS with tenant isolation and internal-field absence.

- [ ] **Step 6: Commit tenant ledger reads**

```bash
git add apps/api/src/modules/tenant-billing apps/api/test/tenant-billing-read.service.test.ts apps/api/test/tenant-billing-read.integration.test.ts apps/api/test/tenant-billing-read.authorization.test.ts
git commit -m "feat: expose tenant recurring service ledger"
```

### Task 8: Add monthly packages to the SaaS catalog editor

**Files:**

- Modify: `apps/saas-admin/src/api/client.ts`
- Modify: `apps/saas-admin/src/pages/catalog/api.ts`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogPayablePreview.tsx`
- Create: `apps/saas-admin/src/pages/catalog/MonthlyServiceTermsFields.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/recurring-service-catalog.test.tsx`
- Modify: `apps/saas-admin/test/catalog.test.tsx`
- Modify: `apps/saas-admin/test/catalog-v3-client.test.ts`

**Interfaces:**

- Produces: a V4 monthly-package editor and exact customer-term preview.
- Consumes: Task 1 V4 schemas and Task 3 catalog endpoints.

- [ ] **Step 1: Write failing editor behavior tests**

```tsx
await user.selectOptions(screen.getByLabelText("Тип услуги"), "recurring");
await user.clear(screen.getByLabelText("Минут включено"));
await user.type(screen.getByLabelText("Минут включено"), "180");
await user.type(screen.getByLabelText("Состав услуги"), "Консультации и настройка");
expect(screen.getByText("Минуты не переносятся на следующий месяц")).toBeVisible();
expect(
  screen.getByText("Дополнительные работы — только после внешнего согласования"),
).toBeVisible();
```

Assert annual selection is disabled with explanatory copy, dirty navigation is blocked, RU/EN fields retain values between modes and a one-time service request remains V3-compatible.

- [ ] **Step 2: Run catalog UI tests and confirm missing monthly controls**

Run: `corepack pnpm@11.22.0 --filter @markiro/saas-admin exec vitest run test/recurring-service-catalog.test.tsx test/catalog.test.tsx test/catalog-v3-client.test.ts`

Expected: FAIL because the service editor always submits `one_time` and the client uses version 3.

- [ ] **Step 3: Add V4 requests and focused service fields**

Set `CURRENT_COMMERCIAL_VERSION = "4"`. Render `MonthlyServiceTermsFields` only for `kind === "service" && billingMode === "recurring"`; keep fixed policies as read-only explanatory text and submit exact literal values. Validate English scope when the English document name is present.

- [ ] **Step 4: Add accessible preview and localization**

Use existing UI inputs, field errors, drawer dirty state and focus behavior. Add complete RU and EN keys for cadence, included minutes, scope, hours, scheduling, no carryover, external approval and annual-unavailable explanation. The preview must show the same values sent to the API.

- [ ] **Step 5: Run SaaS catalog package gates**

Run: `corepack pnpm@11.22.0 --filter @markiro/saas-admin exec vitest run test/recurring-service-catalog.test.tsx test/catalog.test.tsx test/catalog-v3-client.test.ts && corepack pnpm@11.22.0 --filter @markiro/saas-admin typecheck && corepack pnpm@11.22.0 --filter @markiro/saas-admin lint`

Expected: PASS with no one-time service regression.

- [ ] **Step 6: Commit the catalog interface**

```bash
git add apps/saas-admin/src/api/client.ts apps/saas-admin/src/pages/catalog apps/saas-admin/src/i18n apps/saas-admin/test
git commit -m "feat: edit monthly service packages in catalog"
```

### Task 9: Build the SaaS service-period workspace

**Files:**

- Create: `apps/saas-admin/src/pages/service-periods/api.ts`
- Create: `apps/saas-admin/src/pages/service-periods/attempt-state.ts`
- Create: `apps/saas-admin/src/pages/service-periods/ServicePeriodsPage.tsx`
- Create: `apps/saas-admin/src/pages/service-periods/ServicePeriodDrawer.tsx`
- Create: `apps/saas-admin/src/pages/service-periods/PostUsageForm.tsx`
- Create: `apps/saas-admin/src/pages/service-periods/CorrectUsageForm.tsx`
- Create: `apps/saas-admin/src/pages/service-periods/ExternalApprovalForm.tsx`
- Modify: `apps/saas-admin/src/App.tsx`
- Modify: `apps/saas-admin/src/layout/AppShell.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/service-periods.test.tsx`
- Create: `apps/saas-admin/test/service-period-api.test.ts`

**Interfaces:**

- Produces: capability-gated `/service-periods` workspace with recoverable mutations.
- Consumes: Task 6 platform routes and existing `platformApiFetch` error envelope.

- [ ] **Step 1: Write failing role, balance and retry tests**

```tsx
expect(renderForRole("support").getByRole("link", { name: "Услуги" })).toBeVisible();
expect(
  renderForRole("support").queryByRole("button", { name: "Добавить согласование" }),
).toBeNull();
expect(
  renderForRole("accountant").getByRole("button", { name: "Добавить согласование" }),
).toBeVisible();
expect(renderForRole("accountant").queryByRole("button", { name: "Списать работу" })).toBeNull();
```

Simulate a lost response after `platformApiFetch` starts. Assert the form retains the exact body and request ID, blocks edits, retries the same request and clears dirty state only after a definitive response. Assert local Zod validation never creates an uncertain attempt.

- [ ] **Step 2: Run workspace tests and confirm missing route/components**

Run: `corepack pnpm@11.22.0 --filter @markiro/saas-admin exec vitest run test/service-periods.test.tsx test/service-period-api.test.ts`

Expected: FAIL because the service workspace is absent.

- [ ] **Step 3: Implement cursor pagination and derived balance UI**

Use `useInfiniteQuery` with each page's `nextCursor`, flatten pages and preserve the complete query key including filters. Show paid source, interval, included, externally approved, consumed, remaining, revision and chronological ledger. Use status text in addition to color.

- [ ] **Step 4: Implement mutation forms and recovery state**

```ts
type ServiceAttempt<T> =
  | { notice: "uncertain"; requestId: string; input: Readonly<T> }
  | { notice: "domain"; requestId: string; input: Readonly<T>; code: string };
```

Create an attempt only immediately before `platformApiFetch`. On an uncertain response, preserve immutable input and disable editing/closing until retry. Clear cached identity only for a valid domain envelope or valid authorization envelope with its expected status; malformed responses remain recoverable.

- [ ] **Step 5: Verify keyboard and localization behavior**

Test labels, error summaries, focus after opening/closing, dirty navigation guard, RU/EN copy and narrow-layout DOM order. Do not make an automated DOM assertion stand in for a browser screenshot.

- [ ] **Step 6: Run the SaaS workspace gates**

Run: `corepack pnpm@11.22.0 --filter @markiro/saas-admin test && corepack pnpm@11.22.0 --filter @markiro/saas-admin typecheck && corepack pnpm@11.22.0 --filter @markiro/saas-admin lint && corepack pnpm@11.22.0 --filter @markiro/saas-admin build`

Expected: PASS.

- [ ] **Step 7: Commit the service workspace**

```bash
git add apps/saas-admin
git commit -m "feat: add recurring service workspace"
```

### Task 10: Show service periods in the tenant cabinet

**Files:**

- Modify: `apps/admin/src/pages/billing/api.ts`
- Modify: `apps/admin/src/pages/billing/BillingLayout.tsx`
- Modify: `apps/admin/src/pages/billing/BillingSubscriptionPage.tsx`
- Create: `apps/admin/src/pages/billing/ServicePeriodsPage.tsx`
- Create: `apps/admin/src/pages/billing/ServicePeriodDetailPage.tsx`
- Modify: `apps/admin/src/pages/billing/billing.css`
- Modify: `apps/admin/src/App.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/service-periods.test.tsx`
- Modify: `apps/admin/test/browser/tenant-billing-harness.tsx`

**Interfaces:**

- Produces: tenant-owned service cards and a customer-safe ledger detail route.
- Consumes: Task 7 tenant endpoints and existing `BILLING_READ` route boundary.

- [ ] **Step 1: Write failing tenant card and detail tests**

```tsx
expect(await screen.findByText("Сервисное сопровождение")).toBeVisible();
expect(screen.getByText("180 мин включено")).toBeVisible();
expect(screen.getByText("45 мин использовано")).toBeVisible();
expect(screen.getByText("135 мин осталось")).toBeVisible();
expect(screen.getByText("Не списывается из пакета")).toBeVisible();
expect(screen.queryByText("Диагностика завершена")).toBeNull();
```

Add active, upcoming, expired, exhausted, corrected and external-approval fixtures. Assert no purchase or automatic-upgrade CTA appears for an exhausted package.

- [ ] **Step 2: Run tenant UI tests and confirm missing service period views**

Run: `corepack pnpm@11.22.0 --filter @markiro/admin exec vitest run test/service-periods.test.tsx test/subscription-page.test.tsx test/billing-routing.test.tsx`

Expected: FAIL because the routes and API helpers are absent.

- [ ] **Step 3: Add list/detail routes and customer-safe rendering**

Add `/billing/services` and `/billing/services/:periodId` under `BillingLayout`. Separate service periods visually and semantically from software subscription entitlements. Render performance date and posting date distinctly; display corrections beneath their original entry and label defect work without relying on color.

- [ ] **Step 4: Add responsive and translated states**

Cover loading, retry, empty, exhausted and history states in RU and EN. At narrow width, keep service name, period and balance before secondary commercial metadata. Preserve visible focus and table semantics or use a labelled definition list where rows collapse.

- [ ] **Step 5: Run tenant cabinet gates**

Run: `corepack pnpm@11.22.0 --filter @markiro/admin exec vitest run test/service-periods.test.tsx test/subscription-page.test.tsx test/billing-routing.test.tsx && corepack pnpm@11.22.0 --filter @markiro/admin typecheck && corepack pnpm@11.22.0 --filter @markiro/admin lint && corepack pnpm@11.22.0 --filter @markiro/admin build`

Expected: PASS.

- [ ] **Step 6: Commit the tenant ledger interface**

```bash
git add apps/admin
git commit -m "feat: show recurring service usage to tenants"
```

### Task 11: Link service usage snapshots to acts

**Files:**

- Modify: `packages/platform-contracts/src/commercial.ts`
- Modify: `packages/db/src/schema/billing.ts`
- Create: `packages/db/migrations/0159_service_usage_acts.sql`
- Create: `packages/db/migrations/meta/0159_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `apps/api/src/modules/billing-acts/billing-acts.service.ts`
- Modify: `apps/api/src/modules/billing-acts/dto.ts`
- Modify: `apps/saas-admin/src/pages/billing-acts/CreateBillingActPage.tsx`
- Modify: `apps/saas-admin/src/pages/billing-acts/BillingActDetailPage.tsx`
- Modify: `apps/saas-admin/src/pages/billing-acts/api.ts`
- Modify: `apps/api/test/billing-acts.service.test.ts`
- Modify: `apps/api/test/billing-act-print-document.test.ts`
- Modify: `apps/saas-admin/test/billing-acts-workflow.test.tsx`

**Interfaces:**

- Produces: immutable act-to-usage snapshots and uniqueness among non-void acts.
- Consumes: Task 6 customer-service usage entries and existing billing act issue/void lifecycle.

- [ ] **Step 1: Write failing act selection and duplicate-use tests**

```ts
const act = await createAct({
  tenantId,
  orderedServiceId,
  serviceUsageEntryIds: [usageA.id, usageB.id],
});
expect(act.serviceUsageSnapshot).toEqual([
  expect.objectContaining({ entryId: usageA.id, actualMinutes: 45, allowanceMinutes: 45 }),
  expect.objectContaining({
    entryId: usageB.id,
    classification: "product_defect",
    allowanceMinutes: 0,
  }),
]);
await expect(
  createAct({ tenantId, orderedServiceId, serviceUsageEntryIds: [usageA.id] }),
).rejects.toMatchObject({
  response: { code: "service_usage_already_acted" },
});
```

- [ ] **Step 2: Run act tests and confirm the request schema rejects usage IDs**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/billing-acts.service.test.ts test/billing-act-print-document.test.ts`

Expected: FAIL because acts only link the ordered service.

- [ ] **Step 3: Add immutable act usage rows and issuance validation**

Store one row per selected usage entry with tenant, act, period, entry ID, sequence, customer-visible snapshot JSON and nullable `released_at`. Validate all entries belong to the same tenant, period and ordered service. Create a partial unique index on `service_usage_entry_id` where `released_at is null`. In the same transaction that voids an act, set `released_at` on its link rows; never update the usage ledger or the stored act snapshot.

- [ ] **Step 4: Render and expose snapshotted work**

List work reference, description, performance date, actual minutes, allowance minutes and defect/correction label from the act snapshot. Reissue uses the stored snapshot even if later service corrections exist. Voiding or reissuing never changes service-period balance.

- [ ] **Step 5: Update the SaaS act picker**

Load eligible unacted customer-service entries after an ordered service is selected. Keep selection within one period, show total actual and allowance minutes and preserve dirty state. Hide internal notes from print preview.

- [ ] **Step 6: Run API and SaaS act regression suites**

Run: `corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/billing-acts.service.test.ts test/billing-act-print-document.test.ts && corepack pnpm@11.22.0 --filter @markiro/saas-admin exec vitest run test/billing-acts-workflow.test.tsx`

Expected: PASS, including duplicate prevention and void/reissue invariants.

- [ ] **Step 7: Commit act linkage**

```bash
git add packages/platform-contracts packages/db apps/api/src/modules/billing-acts apps/api/test/billing-acts.service.test.ts apps/api/test/billing-act-print-document.test.ts apps/saas-admin/src/pages/billing-acts apps/saas-admin/test/billing-acts-workflow.test.tsx
git commit -m "feat: snapshot recurring service work in acts"
```

### Task 12: Complete operational docs, browser evidence and workspace gates

**Files:**

- Create: `docs/operations/recurring-services.md`
- Create: `docs/acceptance/recurring-services-p2a.md`
- Modify: `apps/admin/test/browser/tenant-billing-harness.tsx`
- Modify: `tools/production-browser/tests/tenant-billing.visual.spec.ts`
- Create: `tools/production-browser/service-periods.playwright.config.ts`
- Create: `tools/production-browser/service-periods-tests/workspace.spec.ts`
- Create: `tools/production-browser/service-periods-tests/fixture.ts`
- Modify: `tools/production-browser/package.json`
- Modify: `tools/ci/affected.mjs` only if a focused new path is not already mapped to API, Admin or SaaS Admin jobs

**Interfaces:**

- Produces: deploy order, recovery procedure, evidence ledger and final verification record.
- Consumes: all previous tasks.

- [ ] **Step 1: Write the acceptance ledger before broad verification**

Record AC-43 through AC-48 with exact test file and test name, plus separate rows for V1–V3 compatibility, tenant isolation, role capability, request replay, concurrent overspend, late posting, document snapshots, act uniqueness and migration validation. Use `PASS`, `FAIL`, `NOT RUN` or `BLOCKED`; never infer production, hardware or customer acceptance from local tests.

- [ ] **Step 2: Document rollout and rollback boundaries**

Specify this order: deploy migrations 0157–0159, validate constraints, deploy V4-capable API, deploy SaaS Admin and tenant Admin, verify reads, then explicitly publish the first recurring service. State that rollback to an older writer is prohibited after first V4 publication or period creation, while no seed or deployment command creates production commercial data.

- [ ] **Step 3: Add browser harness states**

Extend the tenant billing visual suite for the customer ledger. Add a SaaS Admin service-period config modeled on `offers.playwright.config.ts`, using port 43186 and `service-periods-tests`. Render Russian and English monthly catalog and service workspace at 1280×800 and 390×844. Include active balance, exhausted balance, product-defect row, external approval and correction.

Add these scripts to `tools/production-browser/package.json`:

```json
{
  "test:tenant-billing": "playwright test --config tenant-billing.playwright.config.ts",
  "test:service-periods": "playwright test --config service-periods.playwright.config.ts"
}
```

Run: `corepack pnpm@11.22.0 --dir tools/production-browser test:tenant-billing && corepack pnpm@11.22.0 --dir tools/production-browser test:service-periods`

Expected: PASS with screenshots retained only on failure under the Playwright output directories.

- [ ] **Step 4: Run focused package verification with rebuilt dependencies**

```bash
corepack pnpm@11.22.0 turbo run build --filter='@markiro/api^...' --filter='@markiro/saas-admin^...' --filter='@markiro/admin^...'
corepack pnpm@11.22.0 --filter @markiro/platform-contracts test
corepack pnpm@11.22.0 --filter @markiro/db test
corepack pnpm@11.22.0 --filter @markiro/api test
corepack pnpm@11.22.0 --filter @markiro/saas-admin test
corepack pnpm@11.22.0 --filter @markiro/admin test
```

Expected: all executed tests pass. Record database-backed skips caused by missing `DATABASE_URL` as unverified infrastructure coverage.

- [ ] **Step 5: Run the broad repository gate**

```bash
corepack pnpm@11.22.0 turbo lint typecheck test build --concurrency=1 --force
corepack pnpm@11.22.0 format:check
git diff --check
```

Expected: PASS. If an unrelated pre-existing failure appears, capture its exact command and output in the acceptance ledger and keep the P2A evidence separate.

- [ ] **Step 6: Inspect the complete branch diff and CI ownership**

Run: `git fetch origin main && git diff --check origin/main...HEAD && git diff --stat origin/main...HEAD && git diff origin/main...HEAD -- tools/ci/affected.mjs .github/workflows/ci.yml`

Confirm contract, DB, API, SaaS Admin and Admin paths activate their required jobs. Modify `tools/ci/affected.mjs` only if the actual classification omits one of those surfaces.

- [ ] **Step 7: Commit verification artifacts**

```bash
git add docs/operations/recurring-services.md docs/acceptance/recurring-services-p2a.md apps/admin/test/browser/tenant-billing-harness.tsx tools/production-browser/tests/tenant-billing.visual.spec.ts tools/production-browser/service-periods.playwright.config.ts tools/production-browser/service-periods-tests tools/production-browser/package.json tools/ci/affected.mjs
git commit -m "docs: record recurring service rollout evidence"
```

- [ ] **Step 8: Prepare branch completion**

Invoke `superpowers:verification-before-completion`, rerun every gate claimed in the acceptance ledger, then invoke `superpowers:finishing-a-development-branch`. Do not push or open a PR until the user authorizes that external Git action or prior authorization still applies.
