# Tenant Admin Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an owner/admin-only tenant billing workspace with subscription and limit visibility, invoices and confirmed payments, acts and commercial offers, and structured requests that Markiro staff can process end to end.

**Architecture:** Extend the existing billing and SaaS commercial models instead of creating a parallel ledger. A dedicated tenant-billing module exposes tenant-scoped read models and idempotent tenant actions, while existing platform billing and offer services remain the authority for issuing documents and confirming payments. `apps/admin` consumes the tenant API through a billing feature shell; `apps/saas-admin` gains the minimum operational surfaces needed to answer requests, revise offers, create linked invoices, and issue acts.

**Tech Stack:** Node.js 24+, TypeScript 6, NestJS, Drizzle/Postgres, Zod, React 19, React Router, TanStack Query, `@markiro/ui`, React Email, Vitest, Testing Library, Playwright/Storybook where available.

**Spec:** `docs/superpowers/specs/2026-08-27-tenant-admin-billing-experience-design.md`

## Global Constraints

- This is the tenant customer cabinet in `apps/admin`, not the platform shell in `apps/saas-admin`.
- Only current tenant roles `owner` and `admin` may discover or access billing routes.
- Every database read, write, download, event, and attachment must be tenant-scoped and tested for cross-tenant denial.
- Subscription, entitlement, invoice, payment, and act data are read-only to tenant actors.
- Tenant actions are limited to creating/replying to requests, accepting the current offer version, and requesting offer changes.
- `Оплачен` is derived only from authoritative Markiro reconciliation; tenant attachments never change payment state.
- An overdue invoice does not automatically block production.
- Reuse `@markiro/ui`, existing `apps/admin` i18n, IBM Plex fonts, and production tokens; do not copy styles from the `.pen` file.
- Preserve strict TypeScript, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, explicit Zod validation, idempotency, audit facts, and composite tenant foreign keys.
- Add a forward-only Postgres migration; do not rewrite applied migrations or add tenant billing tables to station SQLite.
- Rebuild `@markiro/db` before API consumer tests so they do not execute stale `dist` output.
- Partial payments are an explicit ledger expansion: migrate existing one-payment-per-invoice data safely and never infer a partial payment client-side.

---

## File Structure

### Domain and persistence

- Modify `packages/domain/src/access/cabinet.ts`: add billing capabilities and grant them only to owner/admin.
- Modify `packages/domain/test/cabinet-access.test.ts`: prove role-to-capability mapping and denial.
- Create `packages/db/src/schema/tenant-billing.ts`: request, event, attachment, offer-decision, act, act-document, and relation tables.
- Modify `packages/db/src/schema.ts`: export the new schema module.
- Modify `packages/db/src/schema/billing.ts`: permit `partially_paid`, multiple confirmed payments, and optional source-offer/source-request links.
- Create `packages/db/test/tenant-billing-schema.test.ts`: schema constraints and composite tenant keys.
- Create `packages/db/test/tenant-billing-migration.test.ts`: upgrade existing invoice/payment rows and apply the new migration on a scratch database.
- Generate `packages/db/migrations/0090_tenant_billing_experience.sql` and its Drizzle metadata.

### API

- Create `apps/api/src/modules/tenant-billing/dto.ts`: all tenant request/query/action schemas and response types.
- Create `apps/api/src/modules/tenant-billing/tenant-billing-read.service.ts`: overview, subscription, invoice/payment, offer, document, and attention projections.
- Create `apps/api/src/modules/tenant-billing/tenant-billing-requests.service.ts`: request creation, replies, attachments, links, and tenant audit writes.
- Create `apps/api/src/modules/tenant-billing/tenant-billing-offers.service.ts`: accept/change-request concurrency rules.
- Create `apps/api/src/modules/tenant-billing/tenant-billing.controller.ts`: guarded tenant routes.
- Create `apps/api/src/modules/tenant-billing/tenant-billing.module.ts`: module wiring.
- Remove `apps/api/src/modules/billing/tenant-billing.controller.ts` and `tenant-billing.service.ts` after their invoice behavior moves into the new module.
- Modify `apps/api/src/modules/billing/billing.module.ts`: stop owning tenant routes.
- Modify `apps/api/src/modules/billing/billing.service.ts` and `dto.ts`: link invoices to accepted offers/requests.
- Modify `apps/api/src/modules/billing-payments/billing-payments.service.ts`: aggregate multiple confirmed payments transactionally.
- Create `apps/api/src/modules/platform-billing-requests/*`: platform list/detail/comment/status/link endpoints.
- Create `apps/api/src/modules/billing-acts/*`: platform act issue/upload and tenant-safe download services.
- Modify `apps/api/src/app.module.ts`: register the new modules.
- Modify `apps/api/test/subscription-route-inventory.test.ts`: inventory and subscription-access policy for every new route.
- Create focused API tests listed under each task below.

### Shared platform contracts and operator UI

- Modify `packages/platform-contracts/src/commercial.ts`: request/act platform contracts plus optional invoice source IDs.
- Modify `packages/platform-contracts/test/commercial.test.ts`: strict request/response parsing.
- Create `apps/saas-admin/src/pages/billing-requests/api.ts` and `BillingRequestsPage.tsx`.
- Create `apps/saas-admin/src/pages/billing-acts/api.ts` and `CreateBillingActPage.tsx`.
- Modify offer and invoice pages so only a current accepted offer can seed a linked invoice.
- Modify SaaS-admin i18n, routing, and styles for the new operational surfaces.

### Tenant admin UI

- Replace `apps/admin/src/pages/billing/api.ts` with typed query/mutation functions for the complete tenant billing contract.
- Create `apps/admin/src/pages/billing/BillingLayout.tsx` and `billing.css`.
- Create overview, subscription, invoices, documents, requests, request-detail, and create-request page modules under `apps/admin/src/pages/billing/`.
- Modify `apps/admin/src/layout/AppShell.tsx`, `apps/admin/src/app.tsx`, `apps/admin/src/subscription/SubscriptionBanner.tsx`, and RU/EN translations.
- Replace the old `settings/subscription` entry with a redirect to `/billing/subscription` after the new page is live.

### Notifications and evidence

- Create `packages/email/src/tenant-billing-notification.tsx` and tests.
- Modify `packages/email/src/index.ts` and API mail validation for the new template kind.
- Create `apps/api/src/modules/tenant-billing/tenant-billing-notifications.service.ts` to enqueue owner/admin mail and compute actionable attention.
- Add admin/SaaS-admin component tests and one authenticated browser flow covering the critical tenant journey.

---

### Task 1: Owner/Admin Billing Capabilities

**Files:**

- Modify: `packages/domain/src/access/cabinet.ts:1-48`
- Modify: `packages/domain/test/cabinet-access.test.ts:1-70`
- Modify: `apps/admin/test/auth-query-boundary.test.tsx:20-50`

**Interfaces:**

- Produces: `CABINET_CAPABILITY.BILLING_READ = "billing.read"`
- Produces: `CABINET_CAPABILITY.BILLING_REQUEST = "billing.request"`
- Owner/admin receive both; manager/member receive neither.

- [ ] **Step 1: Write failing capability tests**

```ts
it("grants billing only to tenant owners and admins", () => {
  for (const role of ["owner", "admin"] as const) {
    expect(resolveCabinetAccess(role).capabilities).toEqual(
      expect.arrayContaining([C.BILLING_READ, C.BILLING_REQUEST]),
    );
  }
  for (const role of ["manager", "member"] as const) {
    expect(resolveCabinetAccess(role).capabilities).not.toEqual(
      expect.arrayContaining([C.BILLING_READ, C.BILLING_REQUEST]),
    );
  }
});
```

- [ ] **Step 2: Run the focused domain test and confirm the missing constants fail**

Run: `pnpm --filter @markiro/domain exec vitest run test/cabinet-access.test.ts`

Expected: FAIL because `BILLING_READ` and `BILLING_REQUEST` do not exist.

- [ ] **Step 3: Add the two capabilities and role mappings**

```ts
export const CABINET_CAPABILITY = {
  // existing capabilities
  BILLING_READ: "billing.read",
  BILLING_REQUEST: "billing.request",
} as const;

const ROLE_CAPABILITIES = {
  member: [],
  manager: [C.OPERATIONS_READ, C.OPERATIONS_WRITE],
  admin: [...existingAdminCapabilities, C.BILLING_READ, C.BILLING_REQUEST],
  owner: CAPABILITY_ORDER,
} satisfies Record<CabinetRole, readonly CabinetCapability[]>;
```

Place both billing capabilities in `CAPABILITY_ORDER` after tenant settings and before credential/member administration so serialized access documents remain deterministic.

- [ ] **Step 4: Update full-capability fixtures and run domain/admin tests**

Run: `pnpm --filter @markiro/domain exec vitest run test/cabinet-access.test.ts && pnpm --filter @markiro/admin exec vitest run test/auth-query-boundary.test.tsx`

Expected: PASS; full owner/admin fixtures contain both new values.

- [ ] **Step 5: Run package gates and commit**

Run: `pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint && pnpm --filter @markiro/domain build`

```bash
git add packages/domain/src/access/cabinet.ts packages/domain/test/cabinet-access.test.ts apps/admin/test/auth-query-boundary.test.tsx
git commit -m "feat(domain): add tenant billing capabilities"
```

### Task 2: Tenant Billing Persistence and Migration

**Files:**

- Create: `packages/db/src/schema/tenant-billing.ts`
- Modify: `packages/db/src/schema.ts:1-16`
- Modify: `packages/db/src/schema/billing.ts:24-520`
- Create: `packages/db/test/tenant-billing-schema.test.ts`
- Create: `packages/db/test/tenant-billing-migration.test.ts`
- Create: `packages/db/migrations/0090_tenant_billing_experience.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/migrations/meta/0090_snapshot.json`

**Interfaces:**

- Produces enums `BillingRequestType`, `BillingRequestStatus`, `BillingRequestEventKind`, `BillingActorKind`, `BillingResponsibleSide`, `OfferDecisionKind`, and `BillingActStatus`.
- Produces tables `tenantBillingRequests`, `tenantBillingRequestEvents`, `tenantBillingRequestAttachments`, `tenantBillingRequestLinks`, `commercialOfferDecisions`, `billingActs`, and `billingActDocuments`.
- Modifies `InvoiceStatus` to include `partially_paid`.
- Adds nullable `invoices.sourceOfferId` and `invoices.sourceRequestId` with composite tenant foreign keys.
- Removes one-payment-per-invoice uniqueness and adds an ordered tenant/invoice/payment index.

- [ ] **Step 1: Write the failing schema contract**

```ts
it("stores tenant billing workflow with composite tenant ownership", () => {
  expect(getTableName(schema.tenantBillingRequests)).toBe("tenant_billing_requests");
  expect(getTableName(schema.tenantBillingRequestEvents)).toBe("tenant_billing_request_events");
  expect(getTableName(schema.commercialOfferDecisions)).toBe("commercial_offer_decisions");
  expect(getTableName(schema.billingActs)).toBe("billing_acts");
  expect(schema.invoiceStatus.enumValues).toContain("partially_paid");
  expect(schema.invoices.sourceOfferId).toBeDefined();
  expect(schema.invoices.sourceRequestId).toBeDefined();
});
```

Also assert named tenant composite foreign keys, event actor-shape checks, positive attachment sizes, a unique accepted decision per offer, and one current document revision per act.

- [ ] **Step 2: Run the schema test and confirm exports are missing**

Run: `pnpm --filter @markiro/db exec vitest run test/tenant-billing-schema.test.ts`

Expected: FAIL on the first missing table export.

- [ ] **Step 3: Implement the focused schema module**

Use these exact value sets:

```ts
export const BILLING_REQUEST_TYPES = [
  "renewal",
  "capacity_change",
  "additional_service",
  "documents",
  "other",
] as const;
export const BILLING_REQUEST_STATUSES = [
  "new",
  "under_review",
  "clarification_required",
  "offer_prepared",
  "awaiting_payment",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export const BILLING_REQUEST_EVENT_KINDS = [
  "created",
  "status_changed",
  "tenant_reply",
  "platform_comment",
  "offer_linked",
  "offer_accepted",
  "offer_changes_requested",
  "invoice_linked",
  "payment_confirmed",
  "service_linked",
  "act_linked",
] as const;
export const BILLING_ACT_STATUSES = ["draft", "issued", "cancelled"] as const;
export const BILLING_RESPONSIBLE_SIDES = ["tenant", "markiro", "none"] as const;
```

Use `tenantBillingRequestNumberSequence = pgSequence("tenant_billing_request_number_seq")` and format returned values as `BR-${value.padStart(6, "0")}` in the API. Store attachment metadata only after `ObjectStorageService.putVerified` succeeds. Every child table includes `tenantId` and a composite FK back to its tenant-owned parent.

`tenantBillingRequests` stores a required UUID `idempotencyKey`, a server-owned `responsibleSide`, and a unique `(tenantId, idempotencyKey)` constraint. `tenantBillingRequestEvents` and `commercialOfferDecisions` use the same tenant-scoped idempotency shape so retries return the original result instead of appending duplicate history.

- [ ] **Step 4: Expand invoice/payment persistence without rewriting history**

Add `partially_paid` to `INVOICE_STATUSES`. Remove `billing_payments_invoice_uq`, retain idempotency uniqueness, and add:

```ts
index("billing_payments_tenant_invoice_paid_idx").on(
  table.tenantId,
  table.invoiceId,
  table.paidAt,
  table.id,
);
```

Add `sourceOfferId` and `sourceRequestId` to invoices plus named composite FKs to `commercialOffers` and `tenantBillingRequests`. Keep both nullable so direct invoices remain valid.

- [ ] **Step 5: Generate and review the forward migration**

Run: `pnpm --filter @markiro/db db:generate -- --name tenant_billing_experience`

Rename the generated SQL/snapshot tag to `0090_tenant_billing_experience` only if Drizzle does not honor the name. Review that it adds enum values before using them, drops only `billing_payments_invoice_uq`, creates the replacement index, creates all composite tenant keys, and does not touch SQLite or unrelated tables.

- [ ] **Step 6: Write and run the migration upgrade test**

The test must migrate a pre-0066 scratch database containing one paid invoice and payment, apply 0066, then assert the row is preserved, a second payment can be inserted for another issued invoice, and cross-tenant request links fail.

Run: `pnpm --filter @markiro/db exec vitest run test/tenant-billing-schema.test.ts test/tenant-billing-migration.test.ts`

Expected: PASS with `DATABASE_URL`; if unavailable, report the database-backed skip separately and do not claim migration execution.

- [ ] **Step 7: Build and run DB gates, then commit**

Run: `pnpm --filter @markiro/db test && pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint && pnpm --filter @markiro/db build && git diff --check`

```bash
git add packages/db/src/schema.ts packages/db/src/schema/billing.ts packages/db/src/schema/tenant-billing.ts packages/db/test/tenant-billing-schema.test.ts packages/db/test/tenant-billing-migration.test.ts packages/db/migrations/0090_tenant_billing_experience.sql packages/db/migrations/meta/_journal.json packages/db/migrations/meta/0090_snapshot.json
git commit -m "feat(db): add tenant billing workflow records"
```

### Task 3: Multiple Confirmed Payments and Exact Invoice State

**Files:**

- Modify: `apps/api/src/modules/billing-payments/billing-payments.service.ts:1-520`
- Modify: `apps/api/src/modules/billing/billing.service.ts:150-250`
- Modify: `packages/platform-contracts/src/commercial.ts:1276-1510`
- Create: `apps/api/test/billing-payments.service.test.ts`
- Create: `apps/api/test/billing-invoices.test.ts`
- Modify: `packages/platform-contracts/test/commercial.test.ts`

**Interfaces:**

- Produces `InvoicePaymentSummary = { confirmedAmount: string; remainingAmount: string; status: "issued" | "partially_paid" | "paid" }`.
- `BillingPaymentsService.recordManual` remains idempotent by key but accepts an amount no greater than the locked remaining balance.
- Invoice detail returns ordered `payments: BillingPayment[]` and `paymentSummary`; remove singular `payment` only after all consumers migrate in the same task.

- [ ] **Step 1: Add failing service tests for partial, final, duplicate, and overpayment cases**

```ts
it("records a partial payment without applying entitlements", async () => {
  const result = await service.recordManual(actor, invoiceId, "pay-1", {
    amount: "20000.00",
    currency: "RUB",
    paidAt: "2026-08-27T09:00:00.000Z",
    bankReference: "BANK-1",
  });
  expect(result.invoiceStatus).toBe("partially_paid");
  expect(result.remainingAmount).toBe("28000.00");
  expect(application.apply).not.toHaveBeenCalled();
});
```

Add a second payment test that reaches exactly `48000.00`, changes the invoice to `paid`, and applies invoice lines once. Add a `409 payment_amount_exceeds_remaining` assertion and an idempotent replay assertion.

- [ ] **Step 2: Run focused tests and confirm the one-payment constraint behavior fails**

Run: `pnpm --filter @markiro/api exec vitest run test/billing-payments.service.test.ts test/billing-invoices.test.ts`

- [ ] **Step 3: Implement locked aggregate reconciliation**

Inside one transaction, lock the invoice, sum its confirmed payments in integer cents, validate the new payment, insert it, recompute totals, and update the invoice to `partially_paid` or `paid`. Invoke `BillingApplicationService` only on the transition to fully paid. Preserve the existing idempotency-key mismatch conflict.

- [ ] **Step 4: Update contracts and invoice detail consumers**

```ts
export const invoicePaymentSummarySchema = z.strictObject({
  confirmedAmount: moneySchema,
  remainingAmount: moneySchema,
  status: z.enum(["issued", "partially_paid", "paid"]),
});
```

Return payments ordered by `paidAt, id`; never expose bank-import raw fields to tenant clients.

- [ ] **Step 5: Run API/contract gates and commit**

Run: `pnpm --filter @markiro/platform-contracts test && pnpm --filter @markiro/platform-contracts typecheck && pnpm --filter @markiro/api exec vitest run test/billing-payments.service.test.ts test/billing-invoices.test.ts && pnpm --filter @markiro/api typecheck`

```bash
git add apps/api/src/modules/billing-payments/billing-payments.service.ts apps/api/src/modules/billing/billing.service.ts apps/api/test/billing-payments.service.test.ts apps/api/test/billing-invoices.test.ts packages/platform-contracts/src/commercial.ts packages/platform-contracts/test/commercial.test.ts
git commit -m "feat(api): support confirmed partial invoice payments"
```

### Task 4: Tenant Billing Read API

**Files:**

- Create: `apps/api/src/modules/tenant-billing/dto.ts`
- Create: `apps/api/src/modules/tenant-billing/tenant-billing-read.service.ts`
- Create: `apps/api/src/modules/tenant-billing/tenant-billing.controller.ts`
- Create: `apps/api/src/modules/tenant-billing/tenant-billing.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/modules/billing/billing.module.ts`
- Delete after migration: `apps/api/src/modules/billing/tenant-billing.controller.ts`
- Delete after migration: `apps/api/src/modules/billing/tenant-billing.service.ts`
- Create: `apps/api/test/tenant-billing-read.service.test.ts`
- Create: `apps/api/test/tenant-billing-read.e2e.test.ts`

**Interfaces:**

- `GET /billing/overview -> TenantBillingOverviewDto`
- `GET /billing/subscription -> TenantSubscriptionBillingDto`
- `GET /billing/invoices?status=&from=&to= -> { items: TenantInvoiceDto[] }`
- `GET /billing/invoices/:id -> TenantInvoiceDetailDto`
- `GET /billing/documents?type=offer|act&from=&to= -> { items: TenantDocumentDto[] }`
- `GET /billing/offers/:id -> TenantOfferDetailDto`
- Download routes return `{ url: string }` with at most a five-minute private URL.

- [ ] **Step 1: Define strict Zod query schemas and response DTOs**

Use ISO dates, UUIDs, decimal money strings, explicit status unions, and a shared `billingPaginationSchema` capped at 100 rows. The overview contains `subscription`, `scheduledSubscription`, `limits`, `actionableOffer`, `recentOperations`, `activeRequest`, and `attentionCount`.

- [ ] **Step 2: Write failing tenant-isolation and projection tests**

The service test must seed two tenants and prove every list/detail/download query includes both the tenant ID and entity ID. The e2e test must verify owner/admin `200`, manager/member `403`, and a foreign entity `404`.

- [ ] **Step 3: Run focused tests and confirm routes/services are missing**

Run: `pnpm --filter @markiro/api exec vitest run test/tenant-billing-read.service.test.ts test/tenant-billing-read.e2e.test.ts`

- [ ] **Step 4: Implement one read-model service**

Reuse `tenantSubscriptions`, catalog versions, entitlements, `billingPayments`, offers and snapshots, invoice/offer documents, acts, requests, and ordered services. Derive overdue from `dueDate < now` only for presentation. Return confirmed payment sums from Task 3 and do not expose platform audit records, bank import rows, bank references, or other tenants' identifiers.

- [ ] **Step 5: Guard all routes with billing capability and read-only subscription access**

```ts
@Controller("billing")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.BILLING_READ)
export class TenantBillingController {}
```

Mutation methods added later override the required capability with `BILLING_REQUEST` while remaining available during subscription read-only recovery.

- [ ] **Step 6: Move existing invoice methods without changing their URLs**

Keep `/billing/invoices`, `/billing/invoices/:id`, and document download URLs compatible. Replace local string statuses with the new DTO unions and include payment summaries.

- [ ] **Step 7: Run focused and route-inventory tests, then commit**

Run: `pnpm --filter @markiro/db build && pnpm --filter @markiro/api exec vitest run test/tenant-billing-read.service.test.ts test/tenant-billing-read.e2e.test.ts test/subscription-route-inventory.test.ts && pnpm --filter @markiro/api typecheck`

```bash
git add apps/api/src/app.module.ts apps/api/src/modules/tenant-billing apps/api/src/modules/billing/billing.module.ts apps/api/src/modules/billing/tenant-billing.controller.ts apps/api/src/modules/billing/tenant-billing.service.ts apps/api/test/tenant-billing-read.service.test.ts apps/api/test/tenant-billing-read.e2e.test.ts apps/api/test/subscription-route-inventory.test.ts
git commit -m "feat(api): expose tenant billing read model"
```

### Task 5: Requests, Replies, Attachments, and Offer Decisions

**Files:**

- Create: `apps/api/src/modules/tenant-billing/tenant-billing-requests.service.ts`
- Create: `apps/api/src/modules/tenant-billing/tenant-billing-offers.service.ts`
- Modify: `apps/api/src/modules/tenant-billing/dto.ts`
- Modify: `apps/api/src/modules/tenant-billing/tenant-billing.controller.ts`
- Modify: `apps/api/src/modules/tenant-billing/tenant-billing.module.ts`
- Create: `apps/api/src/modules/tenant-billing/billing-attachment-upload.filter.ts`
- Create: `apps/api/test/tenant-billing-requests.service.test.ts`
- Create: `apps/api/test/tenant-billing-offers.service.test.ts`
- Create: `apps/api/test/tenant-billing-actions.e2e.test.ts`

**Interfaces:**

- `POST /billing/requests` body `{ type, description, desiredAt?, context?, idempotencyKey }`.
- `GET /billing/requests` and `GET /billing/requests/:id`.
- `POST /billing/requests/:id/replies` body `{ message, idempotencyKey }` only when clarification is awaited.
- `POST /billing/requests/:id/attachments` multipart field `file`, maximum 5 MiB, allowed PDF/PNG/JPEG/TXT.
- `GET /billing/requests/:id/attachments/:attachmentId/download` returns a tenant-scoped signed URL.
- `POST /billing/offers/:id/accept` body `{ idempotencyKey }`.
- `POST /billing/offers/:id/change-request` body `{ message, idempotencyKey }`.

- [ ] **Step 1: Write failing request lifecycle tests**

Assert server-generated `BR-000001`, initial `created` event, tenant audit row, idempotent reply, forbidden reply outside `clarification_required`, bounded text, safe attachment metadata, and `404` for foreign request IDs.

- [ ] **Step 2: Write failing offer concurrency tests**

```ts
it("accepts only the current published non-expired family revision", async () => {
  await expect(service.accept(tenantId, userId, oldRevisionId, "decision-1")).rejects.toMatchObject(
    {
      response: { code: "offer_version_stale" },
    },
  );
  await expect(service.accept(tenantId, userId, currentId, "decision-2")).resolves.toMatchObject({
    decision: "accepted",
  });
});
```

Also test two administrators accepting concurrently produce one accepted decision and an idempotent result, while reused keys with different payloads return `409 idempotency_key_reused`.

- [ ] **Step 3: Implement request creation and event writes transactionally**

Insert the request, initial event, and `tenant_audit_events` row in one transaction. Format the sequence value, store normalized optional context, and return the request detail projection. Never let the client set status or linked commercial IDs.

- [ ] **Step 4: Implement attachment upload with verified storage**

Use `memoryStorage`, a 5 MiB limit, MIME allowlist, SHA-256, and key `tenant-billing/{tenantId}/requests/{requestId}/{attachmentId}`. Call `putVerified` before committing metadata; on DB failure delete the uploaded object best-effort without hiding the original error.

- [ ] **Step 5: Implement offer acceptance and change requests**

Lock the current offer family, confirm `status === "published"`, `expiresAt` is absent or future, no later published revision exists, and no conflicting accepted decision exists. Insert the decision, request event when linked, and tenant audit event in one transaction. Change requests require a trimmed 1-2000 character message and leave the immutable offer intact.

- [ ] **Step 6: Run action tests and security gates**

Run: `pnpm --filter @markiro/api exec vitest run test/tenant-billing-requests.service.test.ts test/tenant-billing-offers.service.test.ts test/tenant-billing-actions.e2e.test.ts`

Expected: PASS including manager/member `403`, cross-tenant `404`, stale offer `409`, and attachment validation.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/tenant-billing apps/api/test/tenant-billing-requests.service.test.ts apps/api/test/tenant-billing-offers.service.test.ts apps/api/test/tenant-billing-actions.e2e.test.ts
git commit -m "feat(api): add tenant billing requests and offer decisions"
```

### Task 6: Platform Request Workflow, Linked Invoices, and Acts

**Files:**

- Modify: `packages/platform-contracts/src/commercial.ts`
- Modify: `packages/platform-contracts/test/commercial.test.ts`
- Create: `apps/api/src/modules/platform-billing-requests/dto.ts`
- Create: `apps/api/src/modules/platform-billing-requests/platform-billing-requests.controller.ts`
- Create: `apps/api/src/modules/platform-billing-requests/platform-billing-requests.service.ts`
- Create: `apps/api/src/modules/platform-billing-requests/platform-billing-requests.module.ts`
- Create: `apps/api/src/modules/billing-acts/dto.ts`
- Create: `apps/api/src/modules/billing-acts/billing-acts.controller.ts`
- Create: `apps/api/src/modules/billing-acts/billing-acts.service.ts`
- Create: `apps/api/src/modules/billing-acts/billing-acts.module.ts`
- Modify: `apps/api/src/modules/billing/billing.service.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.controller.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.service.ts`
- Create: `apps/api/test/platform-billing-requests.service.test.ts`
- Create: `apps/api/test/billing-acts.service.test.ts`
- Modify: `apps/api/test/platform-offers.service.test.ts`
- Modify: `apps/api/test/platform-contract-openapi.test.ts`

**Interfaces:**

- Platform requests: list/detail, `POST :id/comments`, `POST :id/status`, and `POST :id/links` guarded by `billing.read`/`billing.write`; every mutation body carries a UUID `idempotencyKey`.
- `POST /platform/offers/:id/revise` creates the next draft in the same offer family only after the current published revision has a tenant `changes_requested` decision.
- Invoice creation accepts optional `{ sourceOfferId, sourceRequestId }`; if supplied, the offer must have a current tenant `accepted` decision and all sources must share the invoice tenant.
- Act creation accepts `{ tenantId, requestId?, invoiceId?, orderedServiceId?, number, periodStart, periodEnd }` and multipart PDF issue upload.
- Issuing an act stores a verified PDF, sets `issuedAt`, links it to the request, and emits platform plus tenant-visible events.

- [ ] **Step 1: Add strict platform contracts and failing parse tests**

Reject unknown keys, invalid status transitions, cross-tenant link shapes, non-PDF act uploads, and invoice source IDs without UUIDs. Add exact response schemas for request events and act document metadata.

- [ ] **Step 2: Implement and test server-owned request transitions**

Allowed platform transitions are:

```ts
const transitions = {
  new: ["under_review", "cancelled"],
  under_review: ["clarification_required", "offer_prepared", "in_progress", "cancelled"],
  clarification_required: ["under_review", "cancelled"],
  offer_prepared: ["under_review", "awaiting_payment", "cancelled"],
  awaiting_payment: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
} as const;
```

Every transition and comment writes `tenantBillingRequestEvents` and `platformAuditEvents` in one transaction.

Set `responsibleSide` deterministically: `new` and `under_review` to `markiro`, `clarification_required`, `offer_prepared`, and `awaiting_payment` to `tenant`, `in_progress` to `markiro`, and terminal states to `none`.

- [ ] **Step 3: Link accepted offers and source invoices safely**

When creating an invoice from an offer, lock the offer and accepted decision, copy source IDs into the invoice, and reject `offer_not_accepted`, `offer_version_stale`, or `billing_source_tenant_mismatch`. After issue, link the invoice and set the request to `awaiting_payment` if the transition is valid.

Add the revise endpoint by locking the current published offer and its latest tenant decision, then inserting a draft with the same `familyId`, `revision + 1`, `previousRevisionId`, copied terms, and copied lines. Reject revisions without a current `changes_requested` decision and reject a second draft for the same family. Publishing the new revision makes prior revisions stale for tenant decisions without deleting their snapshots or documents.

- [ ] **Step 4: Implement act issue/upload**

Store only PDF, maximum 5 MiB, under `tenant-billing/{tenantId}/acts/{actId}/{documentId}.pdf`. An act may be issued only once; cancellation never deletes the document. Period end must be on or after period start. Permit issue only when a linked ordered service is `completed` or, for a period act without a service, `periodEnd` is earlier than the current business date. Tenant download lookup uses tenant plus act plus document IDs.

- [ ] **Step 5: Run contract, service, OpenAPI, and cross-tenant tests**

Run: `pnpm --filter @markiro/platform-contracts test && pnpm --filter @markiro/api exec vitest run test/platform-billing-requests.service.test.ts test/billing-acts.service.test.ts test/platform-offers.service.test.ts test/platform-contract-openapi.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/platform-contracts/src/commercial.ts packages/platform-contracts/test/commercial.test.ts apps/api/src/modules/platform-billing-requests apps/api/src/modules/billing-acts apps/api/src/modules/billing/billing.service.ts apps/api/src/modules/platform-offers/platform-offers.controller.ts apps/api/src/modules/platform-offers/platform-offers.service.ts apps/api/src/app.module.ts apps/api/test/platform-billing-requests.service.test.ts apps/api/test/billing-acts.service.test.ts apps/api/test/platform-offers.service.test.ts apps/api/test/platform-contract-openapi.test.ts
git commit -m "feat(api): add billing request operations and acts"
```

### Task 7: Tenant Admin Billing Shell and Routing

**Files:**

- Modify: `apps/admin/src/layout/AppShell.tsx:15-210`
- Modify: `apps/admin/src/app.tsx:60-440`
- Modify: `apps/admin/src/subscription/SubscriptionBanner.tsx:14-48`
- Create: `apps/admin/src/pages/billing/BillingLayout.tsx`
- Create: `apps/admin/src/pages/billing/billing.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/billing-routing.test.tsx`

**Interfaces:**

- Canonical section route is `/billing`.
- Child routes: `subscription`, `invoices`, `invoices/:id`, `documents`, `offers/:id`, `requests`, `requests/new`, and `requests/:id`.
- `settings/subscription` redirects to `/billing/subscription`.
- Sidebar item uses `BILLING_READ`; request controls use `BILLING_REQUEST`.

- [ ] **Step 1: Write failing route and navigation tests**

Render owner/admin, manager, and member access documents. Assert owner/admin see `Биллинг`, manager/member do not, direct routes render forbidden through `RequireCapability`, and `settings/subscription` redirects.

- [ ] **Step 2: Run the routing test and confirm the billing navigation is absent**

Run: `pnpm --filter @markiro/admin exec vitest run test/billing-routing.test.tsx`

- [ ] **Step 3: Add the navigation item and guarded route tree**

```tsx
{
  to: "/billing",
  key: "nav.billing",
  sectionKey: "shell.sections.organization",
  capability: C.BILLING_READ,
}
```

Teach the existing capability filter to recognize `BILLING_READ`. Wrap the route tree in `RequireCapability capability={C.BILLING_READ}` and the create/action components in `BILLING_REQUEST` checks.

- [ ] **Step 4: Build the shared billing layout**

Render `PageHeader`, `Создать заявку`, and accessible `NavLink` tabs. Use CSS classes backed by existing variables (`--surface-1`, `--line`, `--fg-1`, `--fg-3`, `--accent`) with 12px card radii and no new token layer. At narrow widths stack card grids; retain keyboard focus and `aria-current` from `NavLink`.

- [ ] **Step 5: Redirect the subscription banner and legacy route**

Change the banner link to `/billing/subscription`; retain a route redirect so saved links remain valid.

- [ ] **Step 6: Run route, i18n, typecheck, and commit**

Run: `pnpm --filter @markiro/admin exec vitest run test/billing-routing.test.tsx && pnpm --filter @markiro/admin typecheck`

```bash
git add apps/admin/src/layout/AppShell.tsx apps/admin/src/app.tsx apps/admin/src/subscription/SubscriptionBanner.tsx apps/admin/src/pages/billing/BillingLayout.tsx apps/admin/src/pages/billing/billing.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/billing-routing.test.tsx
git commit -m "feat(admin): add tenant billing navigation shell"
```

### Task 8: Tenant Billing Queries, Overview, Subscription, and Limits

**Files:**

- Modify: `apps/admin/src/pages/billing/api.ts`
- Create: `apps/admin/src/pages/billing/format.ts`
- Create: `apps/admin/src/pages/billing/BillingOverviewPage.tsx`
- Create: `apps/admin/src/pages/billing/BillingSubscriptionPage.tsx`
- Delete after replacement: `apps/admin/src/pages/settings/SubscriptionPage.tsx`
- Create: `apps/admin/test/billing-overview.test.tsx`
- Replace/modify: `apps/admin/test/subscription-page.test.tsx`

**Interfaces:**

- Query keys start with `tenantBillingKeys.all = ["tenant-billing"]`.
- `useBillingOverview()` and `useBillingSubscription()` return Task 4 DTOs.
- `formatMoney(value, currency, locale)` and `formatBillingDate(value, locale)` are the only billing formatting boundaries.

- [ ] **Step 1: Write failing overview and subscription component tests**

Test loaded, empty/unmanaged, loading, API error, approaching limit, reached limit, scheduled subscription, actionable offer, recent operations, and active request. Assert every status has readable text and contextual request links prefill `type=capacity_change` plus `contextType/contextId`.

- [ ] **Step 2: Run focused tests and confirm the components are missing**

Run: `pnpm --filter @markiro/admin exec vitest run test/billing-overview.test.tsx test/subscription-page.test.tsx`

- [ ] **Step 3: Implement typed query functions**

Use `apiFetch` and separate functions for overview/subscription; do not duplicate subscription values from `AccessDocument` in page state. Invalidate the overview, subscription, documents, requests, and offers prefixes after any successful tenant action.

- [ ] **Step 4: Implement the approved overview composition**

Render current subscription, current offer, four limits, recent operations, and active request in the hierarchy shown in `docs/design-briefs/tenant-admin-billing.pen`. Use `Card`, `StatusChip`, `Button`, `Spinner`, and `EmptyState`; keep financial values in mono typography through CSS.

- [ ] **Step 5: Replace the settings subscription page**

Show plan dates, billing period, price, add-ons/services, scheduled change, and server-provided limit states. The page may create a request link but never mutates entitlements.

- [ ] **Step 6: Run tests, typecheck, lint, and commit**

Run: `pnpm --filter @markiro/admin exec vitest run test/billing-overview.test.tsx test/subscription-page.test.tsx && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint`

```bash
git add apps/admin/src/pages/billing apps/admin/src/pages/settings/SubscriptionPage.tsx apps/admin/test/billing-overview.test.tsx apps/admin/test/subscription-page.test.tsx
git commit -m "feat(admin): show tenant subscription and billing overview"
```

### Task 9: Tenant Invoices, Payments, Documents, and Offer Actions

**Files:**

- Replace: `apps/admin/src/pages/billing/InvoicesPage.tsx`
- Create: `apps/admin/src/pages/billing/DocumentsPage.tsx`
- Create: `apps/admin/src/pages/billing/OfferDetailPage.tsx`
- Modify: `apps/admin/src/pages/billing/api.ts`
- Create: `apps/admin/test/billing-invoices.test.tsx`
- Create: `apps/admin/test/billing-documents.test.tsx`
- Create: `apps/admin/test/billing-offer-actions.test.tsx`

**Interfaces:**

- Invoice list filters serialize as `status`, `from`, and `to` query parameters.
- Offer actions generate `crypto.randomUUID()` idempotency keys once per user submission and retain the key across retries.
- Download helpers open only API-returned signed URLs with `noopener,noreferrer`.

- [ ] **Step 1: Write failing registry/detail/action tests**

Cover issued, overdue, partially paid, paid, and cancelled invoices; payment summary and ordered payments; pending/failed/ready documents; expired and superseded offers; accepted action lock; change-request validation; and failed downloads.

- [ ] **Step 2: Run focused tests and confirm the old invoice-only UI fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/billing-invoices.test.tsx test/billing-documents.test.tsx test/billing-offer-actions.test.tsx`

- [ ] **Step 3: Implement invoice and payment views**

Use semantic tables at desktop widths and a detail card at narrow widths. Show invoice and payment state separately. For partial payment, show confirmed amount and remaining amount. Never render a bank reference or bank-import payload.

- [ ] **Step 4: Implement documents and offer detail**

Filter by offer/act, period, and status. A ready artifact downloads; pending and failed statuses are textual. `Принять` requires confirmation and disables immediately while pending. `Запросить изменения` requires 1-2000 characters and returns to the offer/request history after success.

- [ ] **Step 5: Run tests and package gates, then commit**

Run: `pnpm --filter @markiro/admin exec vitest run test/billing-invoices.test.tsx test/billing-documents.test.tsx test/billing-offer-actions.test.tsx && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint`

```bash
git add apps/admin/src/pages/billing apps/admin/test/billing-invoices.test.tsx apps/admin/test/billing-documents.test.tsx apps/admin/test/billing-offer-actions.test.tsx
git commit -m "feat(admin): add tenant billing documents and offer actions"
```

### Task 10: Tenant Request List, Creation, Detail, and Attachments

**Files:**

- Create: `apps/admin/src/pages/billing/RequestsPage.tsx`
- Create: `apps/admin/src/pages/billing/CreateRequestPage.tsx`
- Create: `apps/admin/src/pages/billing/RequestDetailPage.tsx`
- Create: `apps/admin/src/pages/billing/requestForm.ts`
- Modify: `apps/admin/src/pages/billing/api.ts`
- Create: `apps/admin/test/billing-requests.test.tsx`
- Create: `apps/admin/test/billing-request-detail.test.tsx`

**Interfaces:**

- `BillingRequestFormValues = { type; description; desiredAt; contextType; contextId; files }`.
- Context query parameters are validated against known types before being sent.
- Reply controls render only for `clarification_required` and actors with `BILLING_REQUEST`.

- [ ] **Step 1: Write failing form and detail tests**

Test all five request types, required 1-4000 character description, optional ISO desired date, contextual prefill, successful navigation to the server-assigned number, retry-safe submission, attachment type/size errors, empty list, filters, chronological events, and hidden reply controls outside clarification.

- [ ] **Step 2: Run tests and confirm pages are missing**

Run: `pnpm --filter @markiro/admin exec vitest run test/billing-requests.test.tsx test/billing-request-detail.test.tsx`

- [ ] **Step 3: Implement request creation in two deterministic phases**

Create the JSON request first using one retained idempotency key. Upload selected attachments sequentially only after the request exists; show per-file success/failure without losing the created request. Navigate to `/billing/requests/:id` after the queue settles.

- [ ] **Step 4: Implement list and compact event history**

The list filters by status and type. Detail displays description, desired date, responsible side, linked objects, attachments, and events ordered oldest to newest. Use an event list, not chat bubbles. Each event exposes side, timestamp, action, and body.

- [ ] **Step 5: Implement clarification replies and recovery**

Retain reply text on network failure, reuse its idempotency key for retry, clear only after success, and invalidate the request detail/list/overview keys.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm --filter @markiro/admin exec vitest run test/billing-requests.test.tsx test/billing-request-detail.test.tsx && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint`

```bash
git add apps/admin/src/pages/billing apps/admin/test/billing-requests.test.tsx apps/admin/test/billing-request-detail.test.tsx
git commit -m "feat(admin): add structured tenant billing requests"
```

### Task 11: Platform Operator Request and Act UI

**Files:**

- Create: `apps/saas-admin/src/pages/billing-requests/api.ts`
- Create: `apps/saas-admin/src/pages/billing-requests/BillingRequestsPage.tsx`
- Create: `apps/saas-admin/src/pages/billing-acts/api.ts`
- Create: `apps/saas-admin/src/pages/billing-acts/CreateBillingActPage.tsx`
- Modify: `apps/saas-admin/src/pages/offers/OffersPage.tsx`
- Modify: `apps/saas-admin/src/pages/offers/api.ts`
- Modify: `apps/saas-admin/src/pages/billing/CreateInvoicePage.tsx`
- Modify: `apps/saas-admin/src/pages/billing/sourceOfferDraft.ts`
- Modify: `apps/saas-admin/src/pages/billing/api.ts`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/layout/AppShell.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Modify: `apps/saas-admin/src/global.css:801-880`
- Create: `apps/saas-admin/test/billing-requests.test.tsx`
- Create: `apps/saas-admin/test/billing-acts.test.tsx`
- Modify: `apps/saas-admin/test/document-composer.test.tsx`

**Interfaces:**

- Operators with `billing.read` can inspect requests; `billing.write` can comment, transition, link, create offers/invoices, and issue acts.
- Invoice draft seeded from an offer carries `sourceOfferId` and `sourceRequestId` through `toInvoiceCreateInput`.

- [ ] **Step 1: Write failing platform workflow tests**

Assert capability denial, request filters/detail, comment and status actions, create-offer prefill, revision creation after a tenant change request, accepted-offer-only invoice button, source ID preservation, act PDF upload, and action cache invalidation.

- [ ] **Step 2: Run focused tests and confirm pages are missing**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/billing-requests.test.tsx test/billing-acts.test.tsx test/document-composer.test.tsx`

- [ ] **Step 3: Implement a billing-request operations page**

Use the existing SaaS-admin commerce ledger/detail pattern. Show tenant, request number/type/status, latest event, and linked offer/invoice/payment/act. Provide only server-allowed transitions. Add buttons to create a tenant-bound offer, open an accepted offer, seed a linked invoice, and issue an act.

On a current offer with `changes_requested`, expose `Создать новую версию`; call the revise endpoint and navigate to the returned draft. Do not mutate or republish the superseded revision in place.

- [ ] **Step 4: Preserve source identity through invoice creation**

Extend `DocumentDraft` with optional source IDs, set them in `sourceOfferDraft`, include them in the validated create body, and reject navigation from an unaccepted offer. Keep direct invoice creation unchanged.

- [ ] **Step 5: Implement act issue form**

Collect number, period, tenant/request/invoice/service links, and one PDF. Display upload progress and do not mark the act issued until the API returns issued metadata.

- [ ] **Step 6: Run SaaS-admin tests, typecheck, lint, and commit**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/billing-requests.test.tsx test/billing-acts.test.tsx test/document-composer.test.tsx && pnpm --filter @markiro/saas-admin typecheck && pnpm --filter @markiro/saas-admin lint`

```bash
git add apps/saas-admin/src apps/saas-admin/test
git commit -m "feat(saas-admin): process tenant billing requests"
```

### Task 12: Billing Notifications and Attention Count

**Files:**

- Create: `packages/email/src/tenant-billing-notification.tsx`
- Modify: `packages/email/src/index.ts`
- Create: `packages/email/test/tenant-billing-notification.test.tsx`
- Modify: `apps/api/src/modules/mail/mail-jobs.service.ts:88-168`
- Create: `apps/api/src/modules/tenant-billing/tenant-billing-notifications.service.ts`
- Modify: tenant billing and platform workflow services to enqueue events after their authoritative transaction.
- Create: `apps/api/test/tenant-billing-notifications.service.test.ts`
- Modify: `apps/admin/src/layout/AppShell.tsx` to show actionable billing count only.
- Modify: `apps/admin/test/billing-routing.test.tsx`

**Interfaces:**

- Email kind `tenant-billing-notification` with `{ locale, recipientName, organizationName, eventKind, subjectName, actionUrl }`.
- Notify current owner/admin members only.
- Produces `BILLING_DUE_SOON_DAYS = 7` in `tenant-billing-notifications.service.ts`.
- Attention count includes clarification required, current offer awaiting decision, and an unpaid due date from now through the next seven calendar days; it excludes history-only events.

- [ ] **Step 1: Write failing email render and recipient tests**

Test RU/EN subject/body, safe action URL, owner/admin recipients, manager/member exclusion, deduplication by user, and no delivery on idempotent replay.

- [ ] **Step 2: Run focused tests and confirm the template/service are missing**

Run: `pnpm --filter @markiro/email exec vitest run test/tenant-billing-notification.test.tsx && pnpm --filter @markiro/api exec vitest run test/tenant-billing-notifications.service.test.ts`

- [ ] **Step 3: Add the typed email template and mail-job schema branch**

Use the established email layout. Include organization, event text, and one cabinet deep link; exclude financial bank references, imported payloads, attachment bytes, and comments beyond the bounded subject name.

- [ ] **Step 4: Enqueue through the existing email outbox**

Resolve current organization members whose role string contains owner/admin, enqueue one delivery per user with `sourceId = billing:{eventKind}:{entityId}:{revision}`, and rely on the existing encrypted delivery/outbox pipeline. Create deliveries in the same database transaction as the event whenever the caller already owns a transaction.

- [ ] **Step 5: Show only actionable count in tenant navigation**

Use overview data or a small `GET /billing/attention` projection. Render a sidebar badge only when count is greater than zero; keep the billing page itself usable if the count query fails.

- [ ] **Step 6: Run email/API/admin gates and commit**

Run: `pnpm --filter @markiro/email test && pnpm --filter @markiro/email typecheck && pnpm --filter @markiro/api exec vitest run test/tenant-billing-notifications.service.test.ts && pnpm --filter @markiro/admin exec vitest run test/billing-routing.test.tsx`

```bash
git add packages/email apps/api/src/modules/mail/mail-jobs.service.ts apps/api/src/modules/tenant-billing apps/api/test/tenant-billing-notifications.service.test.ts apps/admin/src/layout/AppShell.tsx apps/admin/test/billing-routing.test.tsx
git commit -m "feat: notify tenant administrators about billing actions"
```

### Task 13: Integrated Verification and Visual Acceptance

**Files:**

- Create: `apps/admin/test/billing-flow.test.tsx`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Modify: `apps/api/test/platform-contract-openapi.test.ts`
- Create or update the existing deterministic billing stories under the repository's Storybook convention if Storybook is configured for `apps/admin`; otherwise document the app-level screenshot exception in the test.
- Modify: public OpenAPI artifacts only through the repository's established generation command if they are tracked.

**Interfaces:**

- One deterministic journey: owner creates capacity request, platform requests clarification, owner replies, platform links an offer, owner requests changes, platform publishes a revision, owner accepts, platform issues linked invoice, two confirmed payments reach paid, platform issues act, request completes.

- [ ] **Step 1: Write the integrated component/API contract test**

Use MSW with strict unhandled-request failure for the admin flow, and database-backed API tests for state transitions and cross-tenant denial. Assert that every linked object appears once in request history and that stale retries are idempotent.

- [ ] **Step 2: Run narrow full-feature tests**

Run: `pnpm --filter @markiro/db build && pnpm --filter @markiro/api exec vitest run test/tenant-billing-read.e2e.test.ts test/tenant-billing-actions.e2e.test.ts test/platform-billing-requests.service.test.ts test/billing-acts.service.test.ts && pnpm --filter @markiro/admin exec vitest run test/billing-flow.test.tsx`

- [ ] **Step 3: Run package gates**

Run:

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/platform-contracts test
pnpm --filter @markiro/platform-contracts typecheck
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
pnpm --filter @markiro/saas-admin test
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
pnpm --filter @markiro/saas-admin build
pnpm --filter @markiro/email test
pnpm --filter @markiro/email typecheck
pnpm --filter @markiro/email lint
pnpm --filter @markiro/email build
pnpm format:check
git diff --check
```

Report database-backed skips explicitly.

- [ ] **Step 4: Perform browser and accessibility verification**

At 1440x1024 compare the tenant overview against `docs/design-briefs/tenant-admin-billing.pen`. Also check 1280px and a narrow viewport: keyboard tab order, visible focus, dialog focus return, non-color status text, table/card transition, loading/error/empty/forbidden states, and no clipped content. This proves browser rendering, not external mail delivery or accounting acceptance.

- [ ] **Step 5: Verify external boundaries separately**

With local Mailpit and MinIO, verify one notification delivery, one request attachment upload/download, one invoice download, and one act PDF download. Do not claim production SMTP, bank reconciliation, 1C import, legal validity of the act, DNS/TLS, or production object storage from these checks.

- [ ] **Step 6: Review the final diff against every spec acceptance criterion and commit evidence**

```bash
git add apps/admin/test/billing-flow.test.tsx apps/api/test/subscription-route-inventory.test.ts apps/api/test/platform-contract-openapi.test.ts
git commit -m "test: verify tenant billing workflow"
```

The completion report must separate automated checks, browser checks, local Mailpit/MinIO checks, database-backed skips, and unrun external/accounting acceptance.
