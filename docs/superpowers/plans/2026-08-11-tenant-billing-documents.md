# Tenant Billing Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build direct tenant invoices, immutable billing history, downloadable rendered documents, payment reconciliation, and per-invoice subscription application.

**Architecture:** Extend the existing SaaS catalog/offer authority with a dedicated billing module. Database snapshots are authoritative for issued invoices, payment matches, document revisions, and application events; object storage holds rendered bytes only. Existing subscription lifecycle/entitlement locks remain the only path for applying catalog-linked lines.

**Tech Stack:** NestJS, Drizzle/PostgreSQL migrations, Zod DTOs, pg-boss, existing S3-compatible `ObjectStorageService`, React/Vite `apps/saas-admin` and `apps/admin`, Vitest, PDF renderer selected during Task 4 from repository-supported libraries.

## Global Constraints

- Never mutate or delete issued invoice lines, profile snapshots, payment facts, document revisions, or application events.
- Every query and mutation is tenant-scoped; platform routes require platform capabilities and customer routes require tenant identity.
- All money is exact PostgreSQL `numeric(14,2)` and validated as a two-decimal string; never use floating-point totals.
- Catalog-linked lines store exact published catalog version IDs; free-form lines have no entitlement effect.
- Payment confirmation and line application are idempotent; duplicate imports and duplicate idempotency keys are safe.
- Do not log raw bank files, secrets, session tokens, signed URLs, or unbounded imported fields.
- Add a new migration; do not edit migrations 0030–0033.
- Rebuild `@markiro/db` before API tests after schema changes.
- Preserve existing untracked `.playwright-mcp/` and `.pnpm-store/` directories and do not stage them.

---

### Task 1: Billing schema, profiles, and immutable facts

**Files:**
- Create: `packages/db/src/schema/billing.ts`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0034_tenant_billing_documents.sql`
- Create: `packages/db/test/billing-schema.test.ts`
- Modify: `packages/db/test/migration-runtime.test.ts`

**Interfaces:**
- Produces enums and tables exported through `schema.billing`:
  `billingProfileKind`, `invoiceStatus`, `invoiceLineKind`, `invoiceApplicationMode`,
  `invoiceActivationPolicy`, `documentStatus`, `paymentSource`, `paymentMatchStatus`.
- Produces tables: `operatorBillingProfiles`, `tenantBillingProfiles`, `invoices`,
  `invoiceLines`, `invoiceDocuments`, `paymentImports`, `paymentImportRows`,
  `paymentMatches`, and `invoiceApplicationEvents`.
- Every issued invoice row contains `sellerSnapshot` and `buyerSnapshot` JSONB plus exact totals;
  snapshots are written only by the issue transition.

- [ ] **Step 1: Write failing schema tests** for profile-kind checks, one current operator profile,
  one current tenant profile, invoice number uniqueness, issued snapshot presence, immutable event
  uniqueness, tenant composite foreign keys, document revision uniqueness, and payment-match status.
- [ ] **Step 2: Run the focused DB test** with `pnpm --filter @markiro/db exec vitest run test/billing-schema.test.ts`; confirm it fails because the schema/migration is absent.
- [ ] **Step 3: Add the Drizzle tables and enums** with explicit checks for money scale, nonnegative VAT, line quantities, snapshot requirements, and tenant-scoped foreign keys.
- [ ] **Step 4: Generate and inspect migration 0034**, including indexes for `(tenant_id, status, issued_at)`, invoice number, import checksum, source row identity, and document lookup.
- [ ] **Step 5: Run migration/runtime tests** against PostgreSQL and rebuild `@markiro/db`.
- [ ] **Step 6: Commit** `feat(db): add tenant billing document schema`.

### Task 2: Billing profiles API and address normalization boundary

**Files:**
- Create: `apps/api/src/modules/billing-profiles/billing-profiles.module.ts`
- Create: `apps/api/src/modules/billing-profiles/billing-profiles.controller.ts`
- Create: `apps/api/src/modules/billing-profiles/billing-profiles.service.ts`
- Create: `apps/api/src/modules/billing-profiles/dto.ts`
- Create: `apps/api/test/billing-profiles.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Platform endpoints: `GET/PUT /api/platform/billing/operator-profile` and
  `GET/PUT /api/platform/tenants/:tenantId/billing-profile`.
- Customer endpoint: `GET /api/tenant/billing-profile` returns only that tenant's confirmed profile.
- `BillingProfileService.getCurrent(tenantId)` and `BillingProfileService.snapshot(tenantId)` are
  consumed by invoice issuing.
- DTOs accept `individual`, `self_employed`, `sole_proprietor`, and `legal_entity`, validate
  type-specific fields, and preserve `addressRaw` plus normalized address fields.

- [ ] **Step 1: Write failing e2e tests** for all four profile kinds, invalid type-specific fields, cross-tenant denial, replacing a profile after an issued invoice, and exactly one current profile.
- [ ] **Step 2: Run the focused e2e test** and capture the missing route/module failure.
- [ ] **Step 3: Implement service/controller/module** with append-only profile revisions and current-pointer updates in one transaction.
- [ ] **Step 4: Add a pure `normalizeAddress` boundary** that accepts confirmed operator input and leaves a DaData adapter seam without network calls in core tests.
- [ ] **Step 5: Run focused e2e, API typecheck, lint, and build**.
- [ ] **Step 6: Commit** `feat(api): add operator and tenant billing profiles`.

### Task 3: Direct invoice creation and issue lifecycle

**Files:**
- Create: `apps/api/src/modules/billing/billing.module.ts`
- Create: `apps/api/src/modules/billing/invoices.controller.ts`
- Create: `apps/api/src/modules/billing/invoices.service.ts`
- Create: `apps/api/src/modules/billing/invoice-totals.ts`
- Create: `apps/api/src/modules/billing/dto.ts`
- Create: `apps/api/test/invoices.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Platform endpoints: `POST /api/platform/tenants/:tenantId/invoices`,
  `GET /api/platform/invoices`, `GET /api/platform/invoices/:id`,
  `POST /api/platform/invoices/:id/issue`, and `POST /api/platform/invoices/:id/cancel`.
- Customer endpoints: `GET /api/tenant/invoices`, `GET /api/tenant/invoices/:id`.
- `InvoicesService.createDraft`, `issue`, `cancel`, `detail`, and `list` return frozen DTOs.
- `calculateInvoiceTotals(lines)` returns string totals `{subtotal, vatTotal, total}` and rejects
  invalid VAT-included/excluded combinations.

- [ ] **Step 1: Write failing e2e tests** for mixed plan/add-on/service/custom lines, exact catalog-version validation, VAT included/excluded totals, draft edits, issue snapshots, invoice numbering, cancellation, and tenant isolation.
- [ ] **Step 2: Run the tests** and verify failure before implementation.
- [ ] **Step 3: Implement exact string money arithmetic** and draft creation with line snapshots; reject unpublished/retired catalog versions.
- [ ] **Step 4: Implement issue transaction**: lock draft, allocate number, load both current profiles, write snapshots/totals, freeze lines, append audit/event, enqueue render job.
- [ ] **Step 5: Implement cancellation and read endpoints** with platform capability checks and tenant ownership checks.
- [ ] **Step 6: Run focused e2e plus API static gates**.
- [ ] **Step 7: Commit** `feat(api): add direct tenant invoice lifecycle`.

### Task 4: PDF/HTML rendering and private document storage

**Files:**
- Create: `apps/api/src/modules/billing/invoice-renderer.ts`
- Create: `apps/api/src/modules/billing/invoice-document.service.ts`
- Create: `apps/api/src/modules/billing/invoice-render.job.ts`
- Create: `apps/api/test/invoice-renderer.test.ts`
- Create: `apps/api/test/invoice-documents.e2e.test.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Modify: `apps/api/src/modules/storage/object-storage.service.ts` only if a bounded read helper is required

**Interfaces:**
- `InvoiceRenderer.renderHtml(snapshot): Promise<string>` produces deterministic printable HTML.
- `InvoiceRenderer.renderPdf(snapshot): Promise<Buffer>` produces a PDF from the same snapshot.
- `InvoiceDocumentService.enqueueIssuedInvoice(invoiceId)`, `retry(invoiceId, format)`,
  `list(invoiceId)`, and `presign(invoiceId, documentId, principal)` enforce ownership/capabilities.
- Job name: `billing.invoice.render.v1`; job payload contains only invoice ID and document revision.

- [ ] **Step 1: Write renderer tests** asserting seller/buyer snapshots, invoice number/date, mixed lines, VAT, totals, and absence of mutable live catalog/profile reads.
- [ ] **Step 2: Run renderer tests** and capture the missing renderer failure.
- [ ] **Step 3: Implement deterministic HTML and the repository-approved PDF path** with bounded output size and explicit RU font support.
- [ ] **Step 4: Implement document metadata and object-storage writes** under `tenants/<tenantId>/billing/invoices/<invoiceId>/<revision>.<format>`; store checksum and renderer version.
- [ ] **Step 5: Implement retryable job states** so storage/render failure leaves invoice/payment state intact.
- [ ] **Step 6: Add e2e tests** for ready/failed/retry/download, tenant isolation, five-minute URL expiry, and immutable prior revisions.
- [ ] **Step 7: Run DB/API build and focused document tests; commit** `feat(api): render and store invoice documents`.

### Task 5: Manual payments, 1C import, and matching registry

**Files:**
- Create: `apps/api/src/modules/billing-payments/billing-payments.module.ts`
- Create: `apps/api/src/modules/billing-payments/payments.controller.ts`
- Create: `apps/api/src/modules/billing-payments/payments.service.ts`
- Create: `apps/api/src/modules/billing-payments/client-bank-exchange.parser.ts`
- Create: `apps/api/src/modules/billing-payments/matching.service.ts`
- Create: `apps/api/test/client-bank-exchange.parser.test.ts`
- Create: `apps/api/test/payment-matching.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Platform endpoints: `POST /api/platform/payments/manual`,
  `POST /api/platform/payment-imports`, `GET /api/platform/payment-imports/:id`,
  `POST /api/platform/payment-matches/:id/confirm`, and `POST /api/platform/payment-matches/:id/reject`.
- `ClientBankExchangeParser.parse(input): ParsedBankRow[]` returns bounded row errors without
  leaking the full source file.
- `MatchingService.suggest(row)` ranks exact invoice number/reference before tenant, amount,
  currency, and date candidates; ambiguous matches are never auto-confirmed.
- `PaymentsService.confirmInvoicePayment` is idempotent by `Idempotency-Key` and invoice ID.

- [ ] **Step 1: Write parser tests** for encoding, section boundaries, exact amounts, dates, currencies, duplicate rows, malformed rows, and bounded field lengths.
- [ ] **Step 2: Run parser tests** and capture the missing parser failure.
- [ ] **Step 3: Implement parser and import-batch checksum/idempotency**; store row-level errors and source-row identities.
- [ ] **Step 4: Write matching e2e tests** for exact invoice-number match, amount/date fallback, ambiguous candidates, duplicate import, manual resolve, and cross-tenant denial.
- [ ] **Step 5: Implement matching and manual payment confirmation** in one transaction with invoice status, payment fact, audit, and application enqueue.
- [ ] **Step 6: Run affected API tests and static gates; commit** `feat(api): add payment registry and 1c import matching`.

### Task 6: Per-invoice application of plans, add-ons, and services

**Files:**
- Create: `apps/api/src/modules/billing/invoice-application.service.ts`
- Create: `apps/api/test/invoice-application.e2e.test.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.service.ts` only to extract/reuse safe fulfilment primitives
- Modify: `apps/api/src/subscriptions/subscription-lifecycle.service.ts` only where an explicit invoice source/event hook is needed

**Interfaces:**
- `InvoiceApplicationService.applyPaidInvoice(invoiceId, mode)` is idempotent per invoice line.
- Plan policy `immediate` replaces current plan; `after_current` schedules a successor when current
  is live; `manual` creates pending application rows only.
- Add-ons attach to the selected parent subscription and preserve exact version/quantity.
- Services create ordered-service records without entitlement changes.

- [ ] **Step 1: Write failing e2e tests** for automatic/manual modes, immediate replacement, after-current scheduling, add-on parent binding, service fulfilment, retry after failure, and duplicate payment/application.
- [ ] **Step 2: Run tests** and verify the missing application behavior or incorrect existing offer coupling.
- [ ] **Step 3: Extract a transaction-safe fulfilment primitive** that receives an invoice line source and uses the existing tenant timeline/entitlement locks.
- [ ] **Step 4: Implement line application events** with before/after snapshots and terminal success/failure state.
- [ ] **Step 5: Add manual apply endpoint** for accountant/platform admin and a retry endpoint for failed lines.
- [ ] **Step 6: Run subscription, entitlement, payment, and application suites; commit** `feat(api): apply paid invoice catalog lines`.

### Task 7: Platform billing UI

**Files:**
- Create: `apps/saas-admin/src/pages/billing/InvoicesPage.tsx`
- Create: `apps/saas-admin/src/pages/billing/InvoiceEditorPanel.tsx`
- Create: `apps/saas-admin/src/pages/billing/InvoiceDetailPage.tsx`
- Create: `apps/saas-admin/src/pages/billing/PaymentsPage.tsx`
- Create: `apps/saas-admin/src/pages/billing/api.ts`
- Create: `apps/saas-admin/test/billing.test.tsx`
- Modify: `apps/saas-admin/src/app.tsx`, navigation, i18n, and styles

**Interfaces:**
- Routes: `/billing/invoices`, `/billing/invoices/new`, `/billing/invoices/:id`, `/billing/payments`.
- UI supports line type/catalog version selection, custom rows, VAT, application mode/policy,
  issue/cancel, document download, manual payment, import upload, match review, and manual apply.
- All destructive/financial actions use existing confirmation/dialog patterns and capability gates.

- [ ] **Step 1: Write failing component tests** for invoice creation, mixed lines, issue confirmation, document status/download, payment import, ambiguous match review, and role boundaries.
- [ ] **Step 2: Implement typed API client/Zod response boundary.**
- [ ] **Step 3: Implement invoice editor/detail and payment registry screens.**
- [ ] **Step 4: Add RU/EN copy, loading/error/empty states, keyboard navigation, and mobile containment.
- [ ] **Step 5: Run SaaS-admin tests, typecheck, lint, build, and browser inspection; commit** `feat(saas-admin): add invoice and payment operations`.

### Task 8: Customer cabinet billing UI

**Files:**
- Create: `apps/admin/src/pages/billing/InvoicesPage.tsx`
- Create: `apps/admin/src/pages/billing/InvoiceDetailPage.tsx`
- Create: `apps/admin/src/pages/billing/api.ts`
- Create: `apps/admin/test/billing.test.tsx`
- Modify: `apps/admin/src/app.tsx`, navigation, i18n, and styles

**Interfaces:**
- Customer routes: `/billing/invoices` and `/billing/invoices/:id`.
- Customer view exposes only issued/paid/cancelled invoice summaries, line snapshots, totals, status,
  and document download; it never exposes bank import rows, platform actors, or internal audit.

- [ ] **Step 1: Write failing tests** for tenant-scoped list/detail, download, empty state, pending render, and cross-tenant denial.
- [ ] **Step 2: Implement API client and routes** using the existing customer session/tenant guard.
- [ ] **Step 3: Add bilingual copy and responsive document/status presentation.**
- [ ] **Step 4: Run admin tests, typecheck, lint, build, and browser inspection; commit** `feat(admin): add tenant invoice cabinet`.

### Task 9: Integrated verification and documentation

**Files:**
- Create: `apps/api/test/billing-flow.e2e.test.ts`
- Modify: `docs/superpowers/specs/2026-08-11-tenant-billing-documents-design.md` only for accepted implementation clarifications
- Create: `.superpowers/sdd/2026-08-11-tenant-billing-documents/task-report.md` (ignored report convention)

- [ ] **Step 1: Add one configured PostgreSQL flow**: profile -> direct invoice -> issue -> render -> 1C import -> match -> payment -> automatic application -> customer download.
- [ ] **Step 2: Add negative tests** for cross-tenant access, duplicate import/payment, malformed rows, document failure/retry, changed profile/catalog snapshots, and conflicting payment matches.
- [ ] **Step 3: Run package gates**: DB test/typecheck/lint/build; API focused/affected/full configured tests plus typecheck/lint/build; admin and saas-admin tests/typecheck/lint/build; format and diff checks.
- [ ] **Step 4: Run production contract tests** and report skipped infrastructure/browser checks explicitly.
- [ ] **Step 5: Review staged diff, update the task report, and commit** `test: verify tenant billing flow`.
