# SaaS Invoice Commercial Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the canonical SaaS commercial flow from an issued invoice through payment, manual or automatic application, exact per-line fulfilment results, ordered services, and immutable audit history.

**Architecture:** Keep invoices and payments as the authoritative commercial facts, then apply each paid invoice line through the existing subscription timeline lock inside the payment/application transaction. Persist the invoice line as the idempotent source of every created subscription, add-on, or ordered service; expose one aggregate invoice-detail contract to a dedicated SaaS-admin detail route that renders the waiting-payment, awaiting-operator, and applied states.

**Tech Stack:** Node 24, TypeScript 6, NestJS 11, Drizzle/PostgreSQL, React 19, TanStack Query, React Router, Zod, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-11-tenant-billing-documents-design.md`

## Global Constraints

- Platform billing stays under the separate `/api/platform/*` trust boundary and the separate `apps/saas-admin` application.
- Payment confirmation is accepted only for an issued invoice, for its exact RUB total, with one durable idempotency key.
- Paying an invoice in `manual` application mode never changes tenant entitlements until an authorized operator applies it.
- A plan/add-on/service/custom line produces an explicit application state; no line may be silently treated as fulfilled.
- Plan and add-on fulfilment uses the tenant subscription timeline lock and exact published catalog version captured by the invoice.
- `after_current` preserves the current subscription and creates a scheduled successor; its add-ons bind to that successor.
- Service lines create first-class ordered-service rows; custom lines have an explicit no-entitlement result.
- Every financial or application mutation records exact actor, tenant, action, target, outcome, reason, and bounded before/after metadata.
- Existing offer fulfilment, tenant isolation, production 2FA defaults, and customer/factory continuity behavior must remain unchanged.
- The first slice excludes bank-import review UI, customer-cabinet billing redesign, automatic recurring invoicing, refunds, credits, and the remaining SaaS-admin visual redesign.

## Verified gap matrix

| Requirement                            | Current implementation                                    | Work in this plan                                        |
| -------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Exact catalog version on invoice lines | Implemented in `BillingService.create`                    | Preserve and expose in detail DTO                        |
| Frozen profiles and issued documents   | Implemented at issue time                                 | Preserve; expose document state                          |
| Payment only for issued invoice        | Missing; drafts are currently payable                     | Enforce `issued` and idempotent replay                   |
| Manual payment leaves access unchanged | Partially implemented                                     | Persist pending line applications for every paid invoice |
| Automatic application                  | Missing; only pending rows are inserted                   | Apply eligible lines in the payment transaction          |
| Manual operator application            | Backend endpoint exists, UI absent                        | Add reasoned apply contract and detail action            |
| Idempotent plan/add-on fulfilment      | Unsafe gap between lifecycle transaction and event insert | Use one transaction and invoice-line source identity     |
| Service fulfilment                     | Missing; line is marked applied with `null` result        | Create an ordered-service row                            |
| Custom-line result                     | Implicit `null` result                                    | Record explicit no-entitlement result                    |
| Per-line status/results                | Stored incompletely, not returned to UI                   | Return ordered attempts and result identifiers           |
| Payment/application audit              | Payment and aggregate application audit missing           | Record immutable audit events                            |
| Screens 11-13                          | Billing list uses an inline generic card                  | Add `/billing/:invoiceId` lifecycle detail route         |

---

### Task 1: Persist invoice-line fulfilment identity

**Files:**

- Modify: `packages/db/src/schema/saas.ts`
- Modify: `packages/db/src/schema/billing.ts`
- Create: `packages/db/migrations/0057_funny_wiccan.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/test/saas-schema.test.ts`
- Modify: `packages/db/test/billing-schema.test.ts`
- Modify: `packages/db/test/saas-migration.test.ts`

**Interfaces:**

- `subscription_source` gains `paid_invoice_line`.
- `tenant_subscriptions` and `subscription_addons` gain nullable `source_invoice_line_id` with one-source checks and tenant-scoped uniqueness.
- `ordered_services` accepts either the existing offer/payment pair or the new invoice-line/billing-payment pair, never both.
- The SQL migration owns cross-module foreign keys from SaaS tables to `invoice_lines` and `billing_payments`; Drizzle exposes the columns without creating a runtime module cycle.

- [x] **Step 1: Write failing schema tests** asserting `paid_invoice_line`, invoice source columns, and the exact-one-commercial-source constraints.
- [x] **Step 2: Run** `corepack pnpm --filter @markiro/db exec vitest run test/saas-schema.test.ts test/billing-schema.test.ts` **and verify failure because the columns and enum member do not exist.**
- [x] **Step 3: Add the Drizzle fields and checks** while preserving existing offer-backed rows and names.
- [x] **Step 4: Add migration `0057_funny_wiccan.sql`** to extend the enum, add nullable invoice-source columns, relax offer-only `NOT NULL` fields on ordered services, add tenant-composite foreign keys, and install partial unique indexes for invoice-line fulfilment.
- [x] **Step 5: Add migration coverage** that inserts one invoice-backed plan/add-on/service source, rejects mixed offer+invoice sources, and rejects duplicate fulfilment of one invoice line.
- [x] **Step 6: Run DB build and focused tests**, then inspect the generated/applied SQL and migration journal.

### Task 2: Make payment and application one correct state machine

**Files:**

- Modify: `apps/api/src/modules/billing-payments/billing-payments.module.ts`
- Modify: `apps/api/src/modules/billing-payments/billing-payments.service.ts`
- Modify: `apps/api/src/modules/billing/billing.module.ts`
- Modify: `apps/api/src/modules/billing/billing.controller.ts`
- Modify: `apps/api/src/modules/billing/billing-application.service.ts`
- Modify: `apps/api/src/modules/billing/dto.ts`
- Modify: `apps/api/src/subscriptions/subscription-lifecycle.service.ts`
- Create: `apps/api/test/billing-application-flow.test.ts`

**Interfaces:**

- `BillingPaymentsService.recordManual(principal, invoiceId, input)` accepts only `issued`, returns the existing payment for an exact idempotent replay, and rejects key reuse for another fact.
- `BillingApplicationService.initializeAfterPayment(tx, principal, invoice, payment)` creates attempt 1 for every line and applies eligible automatic lines before commit.
- `BillingApplicationService.apply(principal, invoiceId, input)` consumes `{ reason, lines: [{ lineId, activationPolicy? }] }`; an activation policy is required only for lines whose stored policy is `manual`.
- `SubscriptionLifecycleService.assignPaidInvoicePlan(tx, ...)` and `assignPaidInvoiceAddon(tx, ...)` reuse the same lock/timeline rules without granting direct manual-assignment authority to an accountant.
- Application response shape:

```ts
interface InvoiceApplicationResult {
  invoiceId: string;
  status: "pending" | "applied" | "partial_failure";
  results: Array<{
    lineId: string;
    attempt: number;
    status: "pending" | "applied" | "failed" | "skipped";
    kind: "plan" | "addon" | "service" | "custom";
    result: unknown | null;
    errorCode: string | null;
  }>;
}
```

- [x] **Step 1: Write the database-backed failing flow tests** for draft-payment rejection, exact idempotent replay, manual-mode pending state, automatic immediate application, after-current scheduling, same-invoice add-on parent binding, ordered service creation, explicit custom no-op, accountant authority through paid fulfilment, failed-line retry, and duplicate-apply safety.
- [x] **Step 2: Run the focused test with the development database** and verify each new assertion fails for the current behavior rather than fixture/setup errors.
- [x] **Step 3: Refactor subscription lifecycle internals** so the existing direct platform methods and paid-invoice methods share transaction-aware plan/add-on primitives and the same timeline lock.
- [x] **Step 4: Implement payment initialization and automatic application** inside the payment transaction; insert/update the pending attempt instead of creating an unrelated attempt record.
- [x] **Step 5: Implement manual apply and retry** with required reason, explicit decisions for `manual` timing policies, monotonic attempts, and stable skip behavior for already-applied lines.
- [x] **Step 6: Create invoice-backed ordered services and explicit custom results** using the invoice line and billing payment as the immutable source.
- [x] **Step 7: Record payment and aggregate application audits** with exact actor/tenant/target/outcome and bounded result identifiers.
- [x] **Step 8: Run billing flow, subscription lifecycle, platform authorization, and offer fulfilment tests** to prove the refactor preserves existing behavior.

### Task 3: Expose an honest invoice lifecycle detail contract

**Files:**

- Modify: `apps/api/src/modules/billing/billing.service.ts`
- Modify: `apps/api/src/modules/billing/billing.controller.ts`
- Modify: `apps/api/test/billing-application-flow.test.ts`

**Interfaces:**

- `GET /api/platform/invoices/:id` returns the invoice, ordered lines, document revisions, payment fact, and ordered application attempts.
- The response derives no false global `applied` flag: the client receives exact latest status per line and can distinguish `paid`, `pending`, `partial_failure`, and complete application.
- Bank reference remains inside billing capability scope; no tenant/customer endpoint is widened.

- [x] **Step 1: Add failing detail-contract assertions** for issued/unpaid, paid/pending, partial failure, applied results, ordering, and cross-tenant/source identifiers.
- [x] **Step 2: Run the focused API test and verify the aggregate fields are absent.**
- [x] **Step 3: Implement ordered aggregate reads** with tenant-consistent joins/filters and bounded JSON snapshots.
- [x] **Step 4: Re-run the flow test and the platform route/capability inventory tests.**

### Task 4: Implement SaaS-admin screens 11-13

**Files:**

- Modify: `apps/saas-admin/src/pages/billing/api.ts`
- Create: `apps/saas-admin/src/pages/billing/InvoiceDetailPage.tsx`
- Create: `apps/saas-admin/src/pages/billing/InvoiceFlowSteps.tsx`
- Modify: `apps/saas-admin/src/pages/billing/BillingPage.tsx`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Modify: `apps/saas-admin/src/global.css`
- Create: `apps/saas-admin/test/billing-flow.test.tsx`

**Interfaces:**

- Route: `/billing/:invoiceId`.
- Client functions: `getInvoice(id)`, `recordInvoicePayment(id, input)`, and `applyInvoice(id, input)` parse unknown responses with Zod.
- The detail page maps server facts to exactly three commercial states: issued/waiting payment, paid/waiting operator or automatic completion, and applied/partial failure.
- The payment mutation retains one idempotency key across retries for the mounted action instead of generating a new key per click.

- [x] **Step 1: Write failing component tests** for list-to-detail navigation, issued invoice with unchanged subscription copy, payment confirmation without entitlement-change claims, manual apply confirmation/reason, per-line applied/failed results, read-only capability state, retry-safe mutation keys, and accessible loading/error states.
- [x] **Step 2: Run** `corepack pnpm --filter @markiro/saas-admin exec vitest run test/billing-flow.test.tsx` **and verify failure because the route and typed contract are missing.**
- [x] **Step 3: Implement and validate the Zod detail/payment/application boundary.**
- [x] **Step 4: Implement the lifecycle page** using semantic headings, table markup, visible focus, non-color status labels, and explicit copy that payment does not equal activation in manual mode.
- [x] **Step 5: Add the approved operational-workbench styling** using existing Markiro tokens, IBM Plex fonts, flat surfaces, and responsive containment; do not copy raw design-handoff HTML.
- [x] **Step 6: Re-run focused tests, the full SaaS-admin suite, typecheck, lint, and build.**

### Task 5: Integrated verification and design reconciliation

**Files:**

- Modify: `docs/superpowers/specs/2026-08-11-tenant-billing-documents-design.md` only if implementation requires an accepted clarification
- Modify: `docs/superpowers/plans/2026-08-21-saas-invoice-commercial-flow.md` to mark completed steps

**Interfaces:**

- The implemented path must reconcile screens 08-13 with the original billing lifecycle and preserve screens 05-07 as separate administrative override behavior.

- [x] **Step 1: Run focused DB/API/UI tests** with the development database and report any infrastructure skips separately.
- [x] **Step 2: Run package gates** for `@markiro/db`, `@markiro/api`, and `@markiro/saas-admin`: test, typecheck, lint, and build.
- [x] **Step 3: Run** `corepack pnpm format:check`, `git diff --check`, and inspect the complete diff against both approved specs.
- [x] **Step 4: Run `graphify update .`** because the repository has a local graph, then query the invoice-to-subscription path and verify the payment, application, ordered-service, subscription-lifecycle, and UI-detail nodes against source where the graph cannot cross the HTTP boundary.
- [x] **Step 5: Perform browser acceptance at 1440 px** for the complete issued → paid-pending → applied interaction; cover partial-failure, loading, and error rendering in component tests, and record that this is browser proof, not live bank/object-storage/customer acceptance.
