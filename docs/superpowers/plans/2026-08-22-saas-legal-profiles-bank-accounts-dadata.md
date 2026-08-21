# SaaS Legal Profiles, Bank Accounts, and DaData Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete legal and banking data for Markiro and every tenant, add safe DaData assistance, and freeze the selected accounts into commercial documents without blocking tenant production operations.

**Architecture:** Keep the existing append-only operator and tenant billing-profile histories. Add separate operator and tenant bank-account tables with transactional default selection and immutable used identifiers. A server-side DaData adapter maps provider data to shared internal contracts. Drafts reference a selected seller account; publication/issuance copies seller and buyer legal/account snapshots transactionally.

**Tech Stack:** PostgreSQL, Drizzle ORM, NestJS 11, Zod 4 shared platform contracts, React 19, React Hook Form, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-saas-admin-redesign-and-legal-profiles-design.md`

## Global Constraints

- Execute this plan only after `2026-08-22-saas-admin-contract-foundation.md` is complete.
- One Markiro legal entity; one current legal profile per tenant; multiple accounts on both sides.
- Profile saves create revisions; they never update a current revision in place.
- Never remove legacy `bankDetails` or rewrite an issued seller/buyer snapshot in this slice.
- No hard delete for accounts. Used account identifiers are immutable.
- Exactly one active default account per party after the first active account exists.
- Billing readiness can block offer publication and invoice issuance only; it cannot block tenant auth,
  subscriptions, station, kiosk, scanning, printing, or sync.
- DaData is optional, server-side, assistive, and never authoritative after operator confirmation.
- Never print or commit DaData tokens/secrets or raw provider payloads.
- All tenant account queries and writes must be structurally tenant-scoped and cross-tenant tested.

---

## Task 1: Strengthen versioned legal-profile contracts and persistence

**Files:**

- Modify: `packages/platform-contracts/src/commercial.ts`
- Create: `packages/platform-contracts/test/legal-profiles.test.ts`
- Modify: `packages/db/src/schema/billing.ts`
- Create: `packages/db/migrations/0060_saas_legal_profiles.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/test/saas-legal-profile-migration.test.ts`
- Modify: `packages/db/test/billing-schema.test.ts`
- Modify: `apps/api/src/modules/billing-profiles/dto.ts`
- Modify: `apps/api/src/modules/billing-profiles/billing-profiles.service.ts`
- Modify: `apps/api/src/modules/billing-profiles/billing-profiles.controller.ts`
- Create: `apps/api/test/billing-profiles.service.test.ts`

- [ ] **Step 1: Write failing discriminated-profile tests**

```ts
expect(
  billingProfileInputSchema.safeParse({
    kind: "legal_entity",
    fullName: "ООО Маркиро",
    displayName: "Маркиро",
    inn: "7700000000",
    kpp: "770001001",
    ogrn: "1027700000000",
    legalAddressRaw: "г Москва",
    postalAddress: { sameAsLegal: true },
    contact: { name: null, email: null, phone: null },
  }).success,
).toBe(true);
expect(
  billingProfileInputSchema.safeParse({ kind: "legal_entity", inn: "7700000000" }).success,
).toBe(false);
```

Cover required fields for all four kinds and prohibit KPP/OGRN requirements from leaking into an
individual profile.

- [ ] **Step 2: Write failing DB/service tests for revision and confirmation metadata**

Assert `revision + 1`, one `isCurrent`, `confirmedAt`, `confirmedByPlatformUserId`, normalized legal
and postal address objects, and exact audit actor/role/target/before/after fields.

- [ ] **Step 3: Add columns with a safe compatibility migration**

Add full name, legal/postal raw and normalized fields, `postalSameAsLegal`, confirmation state,
confirmer, and timestamp. Backfill `full_name` and legal address from current legacy fields, but do
not claim confirmation for migrated rows. Keep `addressRaw`, `address`, `bankDetails`, and `contact`
readable until a later verified cleanup migration. Generate the migration with
`corepack pnpm --filter @markiro/db db:generate --name saas_legal_profiles`, inspect the SQL, and
rename only if Drizzle does not preserve the requested deterministic name.

- [ ] **Step 4: Implement discriminated validation and typed service results**

The service writes both the new fields and compatibility fields in one transaction while old
deployments may still read them. Operator input is restricted to `legal_entity`; tenant input uses
the full discriminated union.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/db exec vitest run test/saas-legal-profile-migration.test.ts test/billing-schema.test.ts
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api exec vitest run test/billing-profiles.service.test.ts
```

Commit: `feat(billing): complete versioned legal profiles`

---

## Task 2: Add first-class operator and tenant bank-account tables

**Files:**

- Modify: `packages/db/src/schema/billing.ts`
- Create: `packages/db/migrations/0061_saas_bank_accounts.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/test/saas-bank-accounts-migration.test.ts`
- Modify: `packages/db/test/billing-schema.test.ts`
- Modify: `packages/db/test/tenant-isolation.test.ts`
- Modify: `packages/platform-contracts/src/commercial.ts`
- Create: `packages/platform-contracts/test/bank-accounts.test.ts`

- [ ] **Step 1: Write failing schema tests for both account tables**

Required model:

```ts
type BankAccountInput = {
  label: string;
  settlementAccount: string; // exactly 20 digits
  bic: string; // exactly 9 digits
  bankName: string;
  correspondentAccount: string; // exactly 20 digits
  currency: "RUB";
};
```

Assert tenant composite keys, audit actor fields, active/archived status, default flag, timestamps,
and migration provenance.

- [ ] **Step 2: Write migration tests for legacy `bankDetails`**

Cover complete recognized JSON, incomplete JSON, ambiguous JSON, already migrated rows, and
idempotent reruns. Complete data creates one default account; incomplete data stays only in profile
history and does not become ready.

- [ ] **Step 3: Implement the Drizzle schema and generated migration**

Create `operator_bank_accounts` and `tenant_bank_accounts`. Add partial unique indexes for one active
default per operator and tenant. Use checks for digits, RUB currency, active/default consistency,
and immutable stable IDs. Review generated SQL; do not hand-edit old migrations.
Generate with `corepack pnpm --filter @markiro/db db:generate --name saas_bank_accounts`.

- [ ] **Step 4: Implement bounded legacy import SQL**

Import only recognized key sets with exact lengths. Store `migration_source_profile_id` and do not
mark a profile confirmed as a side effect.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/db exec vitest run test/saas-bank-accounts-migration.test.ts test/billing-schema.test.ts test/tenant-isolation.test.ts
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/db build
```

Commit: `feat(db): add saas billing bank accounts`

---

## Task 3: Implement bank-account services, authorization, default transitions, and audit

**Files:**

- Create: `apps/api/src/modules/billing-accounts/billing-accounts.module.ts`
- Create: `apps/api/src/modules/billing-accounts/billing-accounts.controller.ts`
- Create: `apps/api/src/modules/billing-accounts/billing-accounts.service.ts`
- Create: `apps/api/src/modules/billing-accounts/dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/platform-auth/platform-access-policy.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Create: `apps/api/test/billing-accounts.service.test.ts`
- Create: `apps/api/test/billing-accounts.e2e.test.ts`
- Modify: `packages/platform-contracts/src/commercial.ts`

- [ ] **Step 1: Write failing service tests for the account lifecycle**

Cover first account becoming default, explicit default replacement under a party-scoped advisory or
row lock, non-default creation, archive with replacement, refusal to archive the only active default,
and refusal to edit account identifiers after use.

- [ ] **Step 2: Write failing cross-tenant and role tests**

`platform_admin` and `accountant` may mutate; `support` may not read financial account data unless
the approved capability matrix explicitly grants the read. A request for tenant B through tenant A's
account ID must return not-found/denied without disclosing ownership.

- [ ] **Step 3: Implement exact endpoints from shared contracts**

```text
GET    /platform/billing/operator/accounts
POST   /platform/billing/operator/accounts
PATCH  /platform/billing/operator/accounts/:accountId/default
POST   /platform/billing/operator/accounts/:accountId/archive
GET    /platform/billing/tenants/:tenantId/accounts
POST   /platform/billing/tenants/:tenantId/accounts
PATCH  /platform/billing/tenants/:tenantId/accounts/:accountId/default
POST   /platform/billing/tenants/:tenantId/accounts/:accountId/archive
```

Do not add hard-delete or generic update-by-ID endpoints.

- [ ] **Step 4: Record exact audit events**

Use actions `billing.operator_account.created`, `.default_changed`, `.archived` and tenant variants.
Before/after metadata contains IDs, labels, status, and default state, never full account numbers;
store only a masked suffix where operationally useful.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/billing-accounts.service.test.ts test/billing-accounts.e2e.test.ts test/subscription-route-inventory.test.ts
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
```

Commit: `feat(api): manage saas billing bank accounts`

---

## Task 4: Add the optional server-side DaData adapter

**Files:**

- Modify: `apps/api/src/env.ts`
- Modify: `.env.example`
- Modify: `.env.production.example`
- Create: `apps/api/src/integrations/dadata/dadata.types.ts`
- Create: `apps/api/src/integrations/dadata/dadata.mapper.ts`
- Create: `apps/api/src/integrations/dadata/dadata.client.ts`
- Create: `apps/api/src/integrations/dadata/dadata-cache.ts`
- Create: `apps/api/src/integrations/dadata/dadata.module.ts`
- Create: `apps/api/test/dadata-env.test.ts`
- Create: `apps/api/test/dadata-mapper.test.ts`
- Create: `apps/api/test/dadata-client.test.ts`
- Modify: `packages/platform-contracts/src/commercial.ts`
- Create: `packages/platform-contracts/test/dadata.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Define optional `DADATA_TOKEN` and `DADATA_SECRET`. Empty values mean unconfigured. Production may
boot without DaData. Reject a secret without a token and ensure parsed env objects never serialize
credentials into public diagnostics.

- [ ] **Step 2: Write deterministic mapper tests using minimized provider fixtures**

Cover organization, address, and bank results; map absent address components to `null`. Assert only
the internal DTO fields survive and raw provider fields do not.

- [ ] **Step 3: Write client tests for two-second abort, no result, non-2xx, malformed JSON, and no config**

Inject `fetch`, clock, and abort scheduling. Tests must not contact DaData.

- [ ] **Step 4: Implement the adapter and 15-minute successful-result cache**

Cache key is `{kind}:{normalizedQuery}`; only successful normalized results are cached. Limit input
to 300 chars before provider calls. Return typed statuses `ready`, `unconfigured`, `unavailable`, or
`no_results` to callers.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts exec vitest run test/dadata.test.ts
corepack pnpm --filter @markiro/api exec vitest run test/dadata-env.test.ts test/dadata-mapper.test.ts test/dadata-client.test.ts
```

Commit: `feat(api): add optional dadata adapter`

---

## Task 5: Expose bounded DaData suggestion endpoints

**Files:**

- Create: `apps/api/src/modules/platform-dadata/platform-dadata.module.ts`
- Create: `apps/api/src/modules/platform-dadata/platform-dadata.controller.ts`
- Create: `apps/api/src/modules/platform-dadata/platform-dadata.service.ts`
- Create: `apps/api/src/modules/platform-dadata/platform-dadata-rate-limit.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Create: `apps/api/test/platform-dadata.controller.test.ts`
- Create: `apps/api/test/platform-dadata-rate-limit.test.ts`

- [ ] **Step 1: Write failing endpoint tests for query validation and graceful statuses**

Routes:

```text
GET /platform/suggestions/organizations?q=
GET /platform/suggestions/addresses?q=
GET /platform/suggestions/banks?q=
GET /platform/suggestions/status
```

Queries start at three trimmed characters, except exact INN or BIC lengths. Reject over 300 chars.

- [ ] **Step 2: Write a failing per-principal limiter test**

Allow 60 requests per platform user in a rolling minute and return stable code
`dadata_rate_limited` with request ID on request 61. Do not use source IP as the identity.

- [ ] **Step 3: Implement capability checks and response contracts**

Grant legal/financial suggestion reads to `platform_admin` and `accountant`; `support` gets only the
status endpoint unless product policy is expanded separately. Never expose provider URLs or tokens.

- [ ] **Step 4: Add bounded audit metadata only when a suggestion is selected during a later save**

Suggestion queries themselves are not audit events. Profile confirmation may record provider kind,
normalized identifier, and suggestion-used boolean, never the raw payload or search phrase.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/platform-dadata.controller.test.ts test/platform-dadata-rate-limit.test.ts test/subscription-route-inventory.test.ts
corepack pnpm --filter @markiro/api typecheck
```

Commit: `feat(api): expose bounded dadata suggestions`

---

## Task 6: Build Our Organization and tenant legal-data surfaces

**Files:**

- Create: `apps/saas-admin/src/pages/settings/OrganizationPage.tsx`
- Create: `apps/saas-admin/src/pages/settings/api.ts`
- Create: `apps/saas-admin/src/pages/legal/LegalProfileForm.tsx`
- Create: `apps/saas-admin/src/pages/legal/AddressSuggestField.tsx`
- Create: `apps/saas-admin/src/pages/legal/OrganizationSuggestField.tsx`
- Create: `apps/saas-admin/src/pages/legal/BankSuggestField.tsx`
- Create: `apps/saas-admin/src/pages/legal/BankAccountsPanel.tsx`
- Create: `apps/saas-admin/src/pages/legal/BillingReadiness.tsx`
- Create: `apps/saas-admin/src/pages/legal/dadata.ts`
- Modify: `apps/saas-admin/src/pages/tenants/TenantPage.tsx`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/layout/NavigationGuard.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/legal-profile-form.test.tsx`
- Create: `apps/saas-admin/test/bank-accounts-panel.test.tsx`
- Create: `apps/saas-admin/test/dadata-fields.test.tsx`
- Create: `apps/saas-admin/test/organization-settings.test.tsx`

- [ ] **Step 1: Write failing form tests for all profile kinds and manual fallback**

Assert that selecting a suggestion fills visible fields but does not save; the operator must confirm.
Changing visible fields marks the form dirty; merely receiving suggestion results does not.

- [ ] **Step 2: Write failing DaData interaction tests**

Use fake timers for 250 ms debounce, abort superseded calls, start at three characters, permit exact
INN/BIC immediately, and keep manual fields editable for unconfigured/slow/no-result states.

- [ ] **Step 3: Write failing account/readiness tests**

Cover multiple accounts, exactly one default, archive confirmation, masked identifiers, permission
states, and readiness items linking to the missing field/account.

- [ ] **Step 4: Implement routes and stable tenant tabs**

Add `/settings/organization`; add tenant `legal` tab without replacing the existing overview and
subscription content. Include legal, postal, accounts, confirmation/revision history, and DaData
health. Show the explicit warning that billing incompleteness does not stop tenant operations.

- [ ] **Step 5: Verify and commit**

Run:

```bash
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/legal-profile-form.test.tsx test/bank-accounts-panel.test.tsx test/dadata-fields.test.tsx test/organization-settings.test.tsx test/tenant-detail.test.tsx
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
```

Commit: `feat(saas-admin): manage legal profiles and bank accounts`

---

## Task 7: Add document account selection, readiness, and frozen snapshots

**Files:**

- Modify: `packages/db/src/schema/billing.ts`
- Create: `packages/db/migrations/0062_document_account_snapshots.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/test/document-account-snapshots-migration.test.ts`
- Modify: `packages/platform-contracts/src/commercial.ts`
- Modify: `apps/api/src/modules/billing/dto.ts`
- Modify: `apps/api/src/modules/billing/billing.service.ts`
- Modify: `apps/api/src/modules/platform-offers/dto.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.service.ts`
- Modify: `apps/api/src/modules/billing/print-document-model.ts`
- Modify: `apps/api/src/modules/platform-offers/offer-documents.service.ts`
- Create: `apps/api/test/commercial-readiness.test.ts`
- Create: `apps/api/test/document-account-snapshot.test.ts`
- Modify: `apps/api/test/print-document-model.test.ts`
- Modify: `apps/saas-admin/src/pages/documents/DocumentComposer.tsx`
- Create: `apps/saas-admin/src/pages/documents/SellerAccountPicker.tsx`
- Modify: `apps/saas-admin/test/document-composer.test.tsx`

- [ ] **Step 1: Write failing readiness and race tests**

Draft creation succeeds without complete profiles. Publish/issue fails with exact missing requirement
codes. If the selected seller account is archived between draft and issue, the transaction refuses
issuance and leaves the draft unchanged.

- [ ] **Step 2: Write failing snapshot-invariance tests**

After issuance, revise both profiles, replace both defaults, and archive the selected account. The
stored seller profile/account and buyer profile/account snapshots and rendered document must remain
byte/field equivalent.

- [ ] **Step 3: Add selected account references and snapshot columns**

Draft offers/invoices store `sellerBankAccountId`. Issued/published records store
`sellerBankAccountSnapshot` and `buyerBankAccountSnapshot`. Preserve existing legal snapshots and
existing documents; do not backfill invented banking data. Generate with
`corepack pnpm --filter @markiro/db db:generate --name document_account_snapshots` and inspect the
issued-document compatibility checks before applying.

- [ ] **Step 4: Implement one transaction for readiness, locking, snapshots, status, and audit**

Lock the draft and selected/current account rows, re-check active/default/confirmed state, freeze all
four snapshots, change status, and record account IDs plus masked suffixes in audit metadata.

- [ ] **Step 5: Add UI selection and verify**

Preselect Markiro's default active account, allow another active account, show snapshot notice, and
link missing readiness items. Run:

```bash
corepack pnpm --filter @markiro/db exec vitest run test/document-account-snapshots-migration.test.ts
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api exec vitest run test/commercial-readiness.test.ts test/document-account-snapshot.test.ts test/print-document-model.test.ts
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/document-composer.test.tsx test/billing-editor.test.tsx test/offer-editor.test.tsx
```

Commit: `feat(billing): freeze bank accounts in commercial documents`

---

## Task 8: Match payment evidence to tenant accounts and close the legal slice

**Files:**

- Modify: `packages/db/src/schema/billing.ts`
- Create: `packages/db/migrations/0063_payment_account_evidence.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/test/payment-account-evidence-migration.test.ts`
- Modify: `packages/platform-contracts/src/commercial.ts`
- Modify: `apps/api/src/modules/billing-payments/dto.ts`
- Modify: `apps/api/src/modules/billing-payments/billing-payments.service.ts`
- Create: `apps/api/test/payment-account-matching.test.ts`
- Modify: `apps/saas-admin/src/pages/billing/api.ts`
- Create: `apps/saas-admin/src/pages/payments/PaymentsPage.tsx`
- Create: `apps/saas-admin/src/pages/payments/api.ts`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/payments.test.tsx`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Write failing known/unknown/archived payer-account tests**

Known active accounts may be auto-suggested. Archived known accounts remain historical evidence but
require review. Unknown accounts can be resolved manually without creating an account implicitly.

- [ ] **Step 2: Add immutable payer evidence**

Store matched tenant account ID when known plus a frozen masked payer-account evidence object. Do
not store unbounded raw bank rows outside the existing bounded import record. Generate the schema
change with `corepack pnpm --filter @markiro/db db:generate --name payment_account_evidence`.

- [ ] **Step 3: Implement payments UI and tenant payment tab data**

Provide list/import/match/review states, known-account evidence, manual resolution, and links to the
invoice and tenant legal data. Preserve existing invoice payment/application behavior.

- [ ] **Step 4: Run full slice gates**

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts typecheck
corepack pnpm --filter @markiro/platform-contracts lint
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
CI=true corepack pnpm --filter @markiro/saas-admin test
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
corepack pnpm --filter @markiro/saas-admin build
corepack pnpm format:check
git diff --check
```

- [ ] **Step 5: Refresh Graphify and commit**

Run: `graphify update .`

Commit: `feat(saas-admin): complete legal billing foundation`

## Slice Acceptance

- Markiro and each tenant have one versioned current legal profile and multiple first-class accounts.
- Default transitions and all tenant operations are transactionally and structurally scoped.
- DaData failure leaves every form editable and every unrelated operation available.
- Drafts may exist while incomplete; publication/issuance requires confirmed profiles and accounts.
- Issued documents and payment evidence never change when current legal/account data changes.
- A live DaData credential acceptance remains explicitly external and unrun by automated tests.
