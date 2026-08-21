# SaaS Admin Interface Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current catalog-first horizontal console with the approved operational SaaS admin experience from `saas.pen`, including overview, monitoring, stable tenant tabs, redesigned commerce pages, and consistent Markiro authentication.

**Architecture:** Keep business behavior in existing services and shared platform contracts. Add bounded overview/monitoring endpoints sourced from existing facts, extend `@markiro/ui` with reusable operational primitives and tokens, and rebuild `apps/saas-admin` around a responsive left rail. Migrate one route group at a time with component, accessibility, and browser evidence before removing old styles.

**Tech Stack:** React 19, React Router 8, TanStack Query 5, `@markiro/ui`, IBM Plex Sans/Mono, CSS, NestJS 11, Playwright production-browser checks, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-saas-admin-redesign-and-legal-profiles-design.md`

**Visual source:** `docs/design-briefs/saas.pen`

## Global Constraints

- Execute this plan only after the contract and legal-foundation plans are complete.
- Treat `saas.pen` as the approved composition source and `packages/ui` as production token truth.
- Preserve the real Markiro logo assets; do not replace them with a synthetic letter or generated mark.
- Keep warm paper surfaces, dark rail, square geometry, dense tables, restrained green, and Plex type.
- Do not introduce glass, gradients, soft-bento cards, excessive rounding, or decorative dashboard data.
- Overview metrics must come from explicit server contracts and documented formulas; never invent
  throughput, health, incident, restriction, or financial numbers in the browser.
- One primary action and one dominant content region per page.
- RU and EN must ship together. Status is text plus color, never color alone.
- Billing/DaData incompleteness remains non-blocking for tenant production access.
- Preserve keyboard focus, semantic landmarks, reduced motion, and the existing navigation guard.
- Do not change customer admin, kiosk, station, or landing visual systems in this plan.

---

## Task 1: Add truthful overview and monitoring contracts and API endpoints

**Files:**

- Create: `packages/platform-contracts/src/operations.ts`
- Create: `packages/platform-contracts/test/operations.test.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Create: `apps/api/src/modules/platform-operations/platform-operations.module.ts`
- Create: `apps/api/src/modules/platform-operations/platform-operations.controller.ts`
- Create: `apps/api/src/modules/platform-operations/platform-operations.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Create: `apps/api/test/platform-operations.service.test.ts`
- Create: `apps/api/test/platform-operations.e2e.test.ts`

- [ ] **Step 1: Write failing contracts for facts and provenance**

```ts
const overviewSummarySchema = z.object({
  generatedAt: platformTimestampSchema,
  activeTenants: z.number().int().nonnegative(),
  tenantsApproachingRestriction: z.number().int().nonnegative(),
  overdueInvoices: z.number().int().nonnegative(),
  decisionQueue: z.array(decisionItemSchema),
  recentActivity: z.array(auditEventSummarySchema),
  health: platformHealthSchema,
});
```

Every derived count includes a named formula/version or an exact status definition in code tests.

- [ ] **Step 2: Write failing service tests for boundaries**

Freeze the clock and assert active tenant, subscription ending inside the approved window, overdue
issued unpaid invoice, legal-readiness decision, and recent audit ordering. Ensure incomplete billing
never changes the active-tenant count or operational access state.

- [ ] **Step 3: Implement bounded aggregate queries and reuse `ReadinessService`**

Expose:

```text
GET /platform/operations/overview
GET /platform/operations/monitoring
```

Monitoring returns database/jobs/SMTP/storage status and checked time from the existing cached probe,
plus DaData status from the adapter. It does not return hosts, credentials, bucket names, stack traces,
or raw provider errors.

- [ ] **Step 4: Apply capabilities and OpenAPI contracts**

All platform roles may read overview. Monitoring details require the diagnostics read capability;
financial amounts remain protected by billing read capability if introduced later.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts exec vitest run test/operations.test.ts
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api exec vitest run test/platform-operations.service.test.ts test/platform-operations.e2e.test.ts test/readiness.service.test.ts test/subscription-route-inventory.test.ts
```

Commit: `feat(api): add platform operations overview`

---

## Task 2: Establish production operational tokens and reusable UI primitives

**Files:**

- Modify: `packages/ui/src/tokens.css`
- Modify: `packages/ui/src/components.css`
- Modify: `packages/ui/src/styles.css`
- Create: `packages/ui/src/components/OperationalRail.tsx`
- Create: `packages/ui/src/components/MetricStrip.tsx`
- Create: `packages/ui/src/components/DataTabs.tsx`
- Create: `packages/ui/src/components/DefinitionGrid.tsx`
- Create: `packages/ui/src/components/SectionHeader.tsx`
- Modify: `packages/ui/src/components/index.ts`
- Modify: `packages/ui/src/index.ts`
- Create: `packages/ui/test/operational-components.test.tsx`

- [ ] **Step 1: Write failing semantic and interaction tests**

Assert nav landmarks, active item semantics, keyboard tab operation, focus return, text labels on
status, and reduced-motion class behavior. Component APIs must describe intent, not SaaS route names.

- [ ] **Step 2: Inventory current hardcoded SaaS values before adding tokens**

Run: `rg -n '#[0-9A-Fa-f]{3,8}|border-radius|box-shadow|transition:' apps/saas-admin/src/global.css`

Map approved values to semantic tokens such as `--mk-surface-paper`, `--mk-rail-bg`,
`--mk-border-operational`, `--mk-accent-operational`, and dense table spacing. Do not copy the Pencil
file or handoff CSS into production.

- [ ] **Step 3: Implement small square-geometry primitives**

Use existing Button/Table/StatusChip/Alert where possible. New components compose them and expose
slots; they do not fork color systems or button variants.

- [ ] **Step 4: Add Storybook-independent render tests and package verification**

Run:

```bash
corepack pnpm --filter @markiro/ui test
corepack pnpm --filter @markiro/ui typecheck
corepack pnpm --filter @markiro/ui lint
corepack pnpm --filter @markiro/ui build
```

- [ ] **Step 5: Commit**

Commit: `feat(ui): add operational console primitives`

---

## Task 3: Replace the shell and make Overview the start page

**Files:**

- Create: `apps/saas-admin/src/pages/overview/OverviewPage.tsx`
- Create: `apps/saas-admin/src/pages/overview/api.ts`
- Create: `apps/saas-admin/src/pages/overview/DecisionQueue.tsx`
- Create: `apps/saas-admin/src/pages/overview/HealthSummary.tsx`
- Modify: `apps/saas-admin/src/layout/AppShell.tsx`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Modify: `apps/saas-admin/test/shell.test.tsx`
- Create: `apps/saas-admin/test/overview.test.tsx`

- [ ] **Step 1: Rewrite shell tests against the approved information architecture**

Assert `/` renders `Обзор`, a persistent dark left rail with groups Operations/Commerce/Platform/
Settings, one main landmark and H1, real logo, role/session controls, and no oversized horizontal nav.

- [ ] **Step 2: Write overview state tests**

Cover loading, truthful empty decision queue, contract error in activity while health remains visible,
permission state, degraded health, and retry. Do not derive counts from list pages client-side.

- [ ] **Step 3: Implement route and shell structure**

Routes become Overview, Tenants, Catalog, Offers, Invoices, Payments, Monitoring, Team, Audit, and
Our Organization. Use canonical paths `/`, `/tenants`, `/catalog`, `/offers`, `/invoices`,
`/payments`, `/monitoring`, `/team`, `/audit`, and `/settings/organization`; keep `/billing` as a
temporary redirect to `/invoices` so existing links do not break. Desktop rail is persistent; at
1024 px it remains usable without hiding the main action; narrower widths use an accessible
disclosure with focus management.

- [ ] **Step 4: Implement overview from the shared response contract**

Decision items link to the exact tenant/invoice/settings surface. Recent activity and health are
independent query panels. Preserve the skip link and navigation guard.

- [ ] **Step 5: Verify and commit**

Run:

```bash
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/shell.test.tsx test/overview.test.tsx test/api-client.test.ts
corepack pnpm --filter @markiro/saas-admin typecheck
```

Commit: `feat(saas-admin): launch operational overview shell`

---

## Task 4: Redesign tenant list and stable tenant-detail tabs

**Files:**

- Modify: `apps/saas-admin/src/pages/tenants/TenantsPage.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/CreateTenantPanel.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/TenantPage.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/SubscriptionPanel.tsx`
- Create: `apps/saas-admin/src/pages/tenants/TenantOverviewTab.tsx`
- Create: `apps/saas-admin/src/pages/tenants/TenantDocumentsTab.tsx`
- Create: `apps/saas-admin/src/pages/tenants/TenantPaymentsTab.tsx`
- Create: `apps/saas-admin/src/pages/tenants/TenantUsageTab.tsx`
- Create: `apps/saas-admin/src/pages/tenants/TenantEventsTab.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Modify: `apps/saas-admin/test/tenants.test.tsx`
- Modify: `apps/saas-admin/test/tenant-detail.test.tsx`
- Create: `apps/saas-admin/test/tenant-tabs.test.tsx`

- [ ] **Step 1: Write failing tenant-table and tab tests**

Assert compact columns, search/filter/status, one create action, real empty state, stable URL-backed
tabs `overview`, `legal`, `subscription`, `documents`, `payments`, `usage`, and `events`, plus deep-link
restoration after reload.

- [ ] **Step 2: Preserve the short creation flow**

Creation still asks only name, slug, and owner email. Success navigates to the new tenant overview
and shows readiness tasks for legal data, default account, and subscription; it does not add password
or legal fields to creation.

- [ ] **Step 3: Compose existing business panels into the new hierarchy**

Reuse the legal components from the previous plan and the existing subscription mutations. Documents,
payments, usage, and events load independently and show their own loading/error/empty states.

- [ ] **Step 4: Verify keyboard tabs and permission behavior**

Support users see operational tenant data and read-only diagnostics; financial tabs/actions follow
server capabilities. Hidden actions must still be denied by direct API requests.

- [ ] **Step 5: Verify and commit**

Run:

```bash
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/tenants.test.tsx test/tenant-detail.test.tsx test/tenant-tabs.test.tsx test/legal-profile-form.test.tsx
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
```

Commit: `feat(saas-admin): redesign tenant operations`

---

## Task 5: Migrate catalog, offers, invoices, and payments to the operational system

**Files:**

- Modify: `apps/saas-admin/src/pages/catalog/CatalogPage.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx`
- Modify: `apps/saas-admin/src/pages/offers/OffersPage.tsx`
- Modify: `apps/saas-admin/src/pages/offers/CreateOfferPage.tsx`
- Modify: `apps/saas-admin/src/pages/billing/BillingPage.tsx`
- Modify: `apps/saas-admin/src/pages/billing/CreateInvoicePage.tsx`
- Modify: `apps/saas-admin/src/pages/billing/InvoiceDetailPage.tsx`
- Modify: `apps/saas-admin/src/pages/billing/InvoiceFlowSteps.tsx`
- Modify: `apps/saas-admin/src/pages/payments/PaymentsPage.tsx`
- Modify: `apps/saas-admin/src/pages/documents/DocumentComposer.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/test/catalog.test.tsx`
- Modify: `apps/saas-admin/test/offer-editor.test.tsx`
- Modify: `apps/saas-admin/test/billing-editor.test.tsx`
- Modify: `apps/saas-admin/test/billing-flow.test.tsx`
- Modify: `apps/saas-admin/test/payments.test.tsx`

- [ ] **Step 1: Add failing page-level hierarchy and state tests**

Each list has one dominant dense table, meaningful filters, one primary action, and explicit loading,
empty, network, permission, contract, and mutation-success states. Status/money/date columns use
tabular/mono formatting.

- [ ] **Step 2: Redesign catalog without changing version-control semantics**

Keep plan/add-on/service kinds, draft/publish/retire/archive behavior, demo plan, and financial
validation. Replace the oversized type-strip/table frame with the approved compact filter and detail
drawer hierarchy.

- [ ] **Step 3: Redesign offers and invoices around the shared composer**

Keep catalog refresh/stale-version checks, negotiated price reasons, VAT, activation policy, and
unsaved-change guard. Display seller account selection and readiness before review; drafts remain
possible while incomplete.

- [ ] **Step 4: Redesign detail/payment flows without changing fulfilment rules**

Invoice detail shows document, payment, and application timelines independently. Payments surface
known/unknown payer evidence and review status. Never auto-apply a paid subscription when the
selected application mode/policy requires a decision.

- [ ] **Step 5: Verify and commit**

Run:

```bash
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx test/document-composer.test.tsx test/offer-editor.test.tsx test/billing-editor.test.tsx test/billing-flow.test.tsx test/payments.test.tsx
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
```

Commit: `feat(saas-admin): redesign commerce operations`

---

## Task 6: Add Monitoring and migrate Team, Audit, and Our Organization

**Files:**

- Create: `apps/saas-admin/src/pages/monitoring/MonitoringPage.tsx`
- Create: `apps/saas-admin/src/pages/monitoring/api.ts`
- Modify: `apps/saas-admin/src/pages/team/TeamPage.tsx`
- Modify: `apps/saas-admin/src/pages/audit/AuditPage.tsx`
- Modify: `apps/saas-admin/src/pages/settings/OrganizationPage.tsx`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/monitoring.test.tsx`
- Modify: `apps/saas-admin/test/platform-pages-api.test.ts`
- Modify: `apps/saas-admin/test/organization-settings.test.tsx`

- [ ] **Step 1: Write failing monitoring tests from real health statuses**

Cover healthy, degraded SMTP/storage, unavailable database/jobs, stale check timestamp, DaData
unconfigured, and per-panel contract failure. Never label the whole platform healthy from one
successful catalog call.

- [ ] **Step 2: Migrate Team and Audit with capability-aware actions**

Keep invite, role, suspend, activation renewal, and 2FA recovery flows. Audit keeps pagination and
shows actor, tenant, action, outcome, target, timestamp, and bounded before/after disclosure.

- [ ] **Step 3: Apply approved frame 16 to Our Organization**

Use legal profile, addresses, accounts, readiness, revision history, and integration status from the
legal plan. Never show/edit API tokens or DaData secrets.

- [ ] **Step 4: Verify RU/EN empty, error, permission, and success copy**

Run:

```bash
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/monitoring.test.tsx test/platform-pages-api.test.ts test/organization-settings.test.tsx
corepack pnpm --filter @markiro/saas-admin typecheck
```

- [ ] **Step 5: Commit**

Commit: `feat(saas-admin): complete platform and settings surfaces`

---

## Task 7: Bring login, activation, recovery, and 2FA to final visual parity

**Files:**

- Modify: `apps/saas-admin/src/pages/auth/AuthFrame.tsx`
- Modify: `apps/saas-admin/src/pages/auth/Login.tsx`
- Modify: `apps/saas-admin/src/pages/auth/ActivatePlatformUser.tsx`
- Modify: `apps/saas-admin/src/pages/auth/Recovery.tsx`
- Modify: `apps/saas-admin/src/pages/auth/TwoFactor.tsx`
- Modify: `apps/saas-admin/src/components/MarkiroLogo.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Modify: `apps/saas-admin/test/auth.test.tsx`
- Create: `apps/saas-admin/test/two-factor-enrollment.test.tsx`

- [ ] **Step 1: Write/retain failing identity and enrollment assertions**

Assert the production Markiro logo image, approved split-screen landmarks, a QR generated from the
exact server `totpURI`, accessible manual fallback, backup codes shown only in enrollment state,
copy/save action, verification errors, and no console/log calls containing URI or codes.

- [ ] **Step 2: Preserve the working QR path while changing composition**

Keep `qrcode.react` and `QRCodeSVG value={enrollment.totpURI}`. Do not rasterize or replace the QR
with a design mock. The mock in the handoff assets is visual reference only.

- [ ] **Step 3: Implement final split-screen hierarchy and responsive collapse**

At desktop, use the dark identity field and focused form workspace from `saas.pen`. At narrow widths,
retain logo/product identity without pushing the active form below an entire decorative panel.

- [ ] **Step 4: Verify secret lifecycle and redirects**

Successful 2FA returns to `/`, not `/catalog`. Backup codes disappear after verified enrollment or
navigation and are never persisted locally. Recovery and challenge errors remain precise.

- [ ] **Step 5: Verify and commit**

Run:

```bash
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/auth.test.tsx test/two-factor-enrollment.test.tsx
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
```

Commit: `feat(saas-admin): complete markiro authentication surfaces`

---

## Task 8: Browser, accessibility, responsive, and production release gates

**Files:**

- Create: `tools/production-browser/tests/saas-admin-redesign.spec.ts`
- Modify: `tools/production-browser/package.json`
- Modify: `deploy/production/smoke.mjs`
- Modify: `deploy/production/test/smoke-route-table.test.mjs`
- Modify: `deploy/production/test/edge-contract.test.mjs`
- Create: `docs/verification/2026-08-22-saas-admin-redesign.md`

- [ ] **Step 1: Add failing browser coverage for exact release surfaces**

Cover login, 2FA enrollment QR/manual fallback, overview, tenants, tenant legal readiness, Our
Organization, invoice account selection, payments, monitoring, and contract-error retry. Run at
1024 and 1440 px in RU and EN.

- [ ] **Step 2: Add keyboard and accessibility assertions**

Verify skip link, rail disclosure focus, tab arrow keys, dialogs/drawers, forms, tables, visible
focus, non-color status, 44 px primary targets, and reduced motion. Record remaining manual review
items rather than asserting browser automation proves full WCAG conformance.

- [ ] **Step 3: Update production smoke and release-SHA assertions**

Smoke exact routes `/`, `/tenants`, `/settings/organization`, `/invoices/new`, `/login`, and
`/two-factor?mode=enroll`; assert the expected `x-markiro-release-sha` and no client-side fatal error.

- [ ] **Step 4: Run full repository-proportionate gates**

```bash
corepack pnpm --filter @markiro/ui test
corepack pnpm --filter @markiro/ui typecheck
corepack pnpm --filter @markiro/ui lint
corepack pnpm --filter @markiro/ui build
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
CI=true corepack pnpm --filter @markiro/saas-admin test
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
corepack pnpm --filter @markiro/saas-admin build
corepack pnpm test:production-bundle:contract
corepack pnpm test:production-docs:browser
corepack pnpm format:check
git diff --check
```

Record test skips caused by missing DB/browser infrastructure separately.

- [ ] **Step 5: Perform manual visual review, refresh Graphify, and commit**

Compare every implemented route against the approved `saas.pen` frames at 1024/1440, RU/EN, and
light/dark where supported. Verify browser flows with deterministic fake DaData; record live DaData
acceptance as external. Run `graphify update .`.

Commit: `test(saas-admin): verify redesigned platform console`

## Slice Acceptance

- `/` is the truthful operational overview and all approved routes are reachable from the left rail.
- The visual system matches the approved warm-paper/dark-rail Markiro direction, not the old
  horizontal console or a generic dashboard style.
- Every surface has loading, empty, network, permission, contract, success, and integration-degraded
  states where applicable.
- Tenant creation remains immediate and short; legal/billing readiness is a follow-up checklist.
- Login and 2FA use the real Markiro identity and render a scannable QR from the server URI.
- Automated results are reported separately from manual browser review, live DaData, and production
  deployment. Deployment itself still requires explicit approval after the exact release SHA passes.
