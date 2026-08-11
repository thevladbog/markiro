# SaaS Catalog, Tenant Provisioning, and Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate, 2FA-protected platform application that provisions tenants with
activation-timed demos, manages immutable catalog terms and enforceable entitlements, and converts
one fully paid commercial offer into versioned subscriptions, add-ons, and ordered services exactly
once.

**Architecture:** Add a separate platform-auth trust domain and `/api/platform/*` NestJS surface,
backed by normalized Postgres catalog/subscription/commercial tables. A single
`EntitlementsService` owns quota and feature decisions for every customer surface. A new
`apps/saas-admin` React/Vite application consumes platform DTOs; the existing customer admin only
receives subscription status/usage and banners.

**Tech Stack:** Node.js 24+, pnpm 11.10.0, TypeScript 6, NestJS 11, Better Auth 1.6.23 with TOTP,
Drizzle ORM/PostgreSQL 17, React 19, Vite 8, TanStack Query 5, React Hook Form/Zod, Vitest, and
Playwright production-browser contracts.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-08-09-saas-catalog-subscriptions-design.md`.
- Keep platform identities/sessions separate from customer Better Auth tables and cookies.
- Every `/platform/*` route fails closed without an explicit platform capability policy.
- Published catalog versions, published offer revisions, subscription events, payment facts,
  fulfilment facts, and platform audit facts are immutable.
- Tenant subscriptions reference exact published plan versions; catalog edits never change assigned
  terms retroactively.
- Add-ons may only add positive quota or enable features.
- Quota check and resource creation share one transaction and tenant/entitlement advisory lock.
- Existing resources survive downgrade; only new creation is blocked.
- Expired demos retain reads/exports and eligible offline recovery but deny new business writes.
- Never log or return passwords, activation URLs/tokens, TOTP secrets, backup codes, session tokens,
  or raw device credentials.
- Use exact dependency versions and `workspace:*`; update `pnpm-lock.yaml` with pnpm only.
- Add new Postgres migrations; never rewrite an applied migration.
- Rebuild `@markiro/db` before API tests.
- Report database skips, browser checks, SMTP, DNS/TLS, and live-cloud checks separately.

## Delivery and review boundaries

1. Tasks 1-4: platform schema/auth/catalog foundation and a usable catalog UI.
2. Tasks 5-6: tenant provisioning and activation-timed demo.
3. Tasks 7-9: effective entitlements, quotas, feature/read-only enforcement, and customer UX.
4. Tasks 10-11: commercial offers, payment, fulfilment, and SaaS tenant UI.
5. Task 12: production routing, docs, and final verification.

Do not start the next boundary until the focused checks and code review for the current boundary pass.

---

### Task 1: Add the immutable SaaS schema and migration

**Files:**

- Create: `packages/db/src/schema/platform-auth.ts`
- Create: `packages/db/src/schema/saas.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/drizzle.config.ts`
- Create: `packages/db/test/saas-schema.test.ts`
- Create: `packages/db/test/saas-migration.test.ts`
- Generate: `packages/db/migrations/0030_saas_catalog_subscriptions.sql`
- Generate: `packages/db/migrations/meta/0030_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

**Interfaces:**

- Produces the tables/enums named in design sections 5, 6, 8, and 12.
- Produces exported types `SaasEntitlementKey`, `PlatformRole`, `CatalogItemKind`,
  `CatalogVersionStatus`, `SubscriptionStatus`, `OfferStatus`, and `FulfilmentKind`.
- All later tasks consume these exports through `schema` from `@markiro/db`.

- [ ] **Step 1: Write structural tests for the schema**

Create `saas-schema.test.ts` with assertions that pin exact table names, FK targets, unique indexes,
partial-current-subscription indexes, positive add-on checks, and immutable-source columns. The core
shape must include:

```ts
expect(getTableName(schema.catalogItems)).toBe("catalog_items");
expect(getTableName(schema.catalogItemVersions)).toBe("catalog_item_versions");
expect(getTableName(schema.planEntitlements)).toBe("plan_entitlements");
expect(getTableName(schema.addonEntitlements)).toBe("addon_entitlements");
expect(getTableName(schema.tenantSubscriptions)).toBe("tenant_subscriptions");
expect(getTableName(schema.subscriptionAddons)).toBe("subscription_addons");
expect(getTableName(schema.subscriptionEvents)).toBe("subscription_events");
expect(getTableName(schema.commercialOffers)).toBe("commercial_offers");
expect(getTableName(schema.commercialOfferLines)).toBe("commercial_offer_lines");
expect(getTableName(schema.payments)).toBe("payments");
expect(getTableName(schema.offerLineFulfilments)).toBe("offer_line_fulfilments");
expect(getTableName(schema.orderedServices)).toBe("ordered_services");
expect(getTableName(schema.platformAuditEvents)).toBe("platform_audit_events");
```

Assert `commercial_offer_lines.catalog_version_id` is nullable only for `service`, payment
idempotency is unique, fulfilment is unique per offer line, and tenant-owned commercial tables use
composite tenant FKs where they reference tenant-owned rows.

- [ ] **Step 2: Run the schema test and verify RED**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/saas-schema.test.ts
```

Expected: FAIL because `schema.catalogItems` and the remaining SaaS tables do not exist.

- [ ] **Step 3: Implement `saas.ts`**

Use explicit columns rather than untyped entitlement JSON. Define the shared keys exactly:

```ts
export const SAAS_ENTITLEMENT_KEYS = [
  "lines",
  "stations",
  "kiosks",
  "cabinetUsers",
  "labelEditor",
  "publicApi",
  "pallets",
] as const;
export type SaasEntitlementKey = (typeof SAAS_ENTITLEMENT_KEYS)[number];

export const PLATFORM_ROLES = ["platform_admin", "support", "accountant"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
```

Implement stable catalog items plus immutable numbered versions. Keep monetary values as
`numeric(14, 2)` and DTO-facing strings. Model plan quota columns as nullable positive integers and
feature columns as booleans. Model add-on effects as one row per key with exactly one of
`quota_increment > 0` or `feature_enabled = true`, enforced by SQL checks.

Create separate platform-auth tables in `platform-auth.ts`: `platform_users`, `platform_sessions`,
`platform_accounts`, `platform_verifications`, and `platform_two_factors`. Use no FK from customer
`user` to `platform_users`.

Use a one-row `platform_settings` table with key `default_demo_catalog_version_id`. Create partial
unique indexes for one current subscription (`pending_activation`, `trial`, `active`) and one
`scheduled` successor per tenant. Do not use cascades that would delete published commercial or
subscription history.

- [ ] **Step 4: Generate and review migration 0030**

Run:

```bash
pnpm --filter @markiro/db db:generate -- --name saas_catalog_subscriptions
```

Review the generated SQL. Add the minimum hand-written SQL that Drizzle cannot express:

- partial unique indexes for current/scheduled subscription rows;
- immutability triggers rejecting UPDATE/DELETE for published catalog versions and their plan/add-on
  effects;
- immutability triggers for published offer revisions, payments, fulfilments, subscription events,
  and platform audit;
- cross-column checks for catalog kind/billing period, demo duration, add-on effect shape, and
  exact-positive quantities.

Do not edit migrations 0000-0029.

- [ ] **Step 5: Add migration behavior tests**

In `saas-migration.test.ts`, apply migrations to the configured test DB and prove:

```ts
await expect(updatePublishedCatalogVersion(db, versionId)).rejects.toThrow();
await expect(deletePublishedCatalogVersion(db, versionId)).rejects.toThrow();
await expect(insertSecondCurrentSubscription(db, tenantId)).rejects.toThrow();
await expect(insertNegativeAddon(db, versionId)).rejects.toThrow();
```

Also insert an existing organization with no subscription and assert migrations preserve it as an
unmanaged tenant.

- [ ] **Step 6: Run DB gates and commit**

Run:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
git diff --check
```

Expected: all non-infrastructure tests pass; DB-backed tests pass when `DATABASE_URL` is present and
are reported as skipped otherwise.

Commit:

```bash
git add packages/db/src/schema/platform-auth.ts packages/db/src/schema/saas.ts \
  packages/db/src/schema.ts packages/db/drizzle.config.ts \
  packages/db/test/saas-schema.test.ts packages/db/test/saas-migration.test.ts \
  packages/db/migrations/0030_saas_catalog_subscriptions.sql \
  packages/db/migrations/meta/0030_snapshot.json packages/db/migrations/meta/_journal.json
git commit -m "feat(db): add SaaS catalog and subscription schema"
```

---

### Task 2: Build separate platform authentication, 2FA, roles, and audit guard

**Files:**

- Create: `packages/db/src/platform-auth-config.ts`
- Modify: `packages/db/src/index.ts`
- Create: `apps/api/src/platform-auth/platform-auth.setup.ts`
- Create: `apps/api/src/platform-auth/platform-auth.module.ts`
- Create: `apps/api/src/platform-auth/platform-auth.guard.ts`
- Create: `apps/api/src/platform-auth/platform-access-policy.ts`
- Create: `apps/api/src/platform-auth/platform-audit.service.ts`
- Create: `apps/api/src/platform-auth/platform-audit.controller.ts`
- Create: `apps/api/src/platform-auth/platform-me.controller.ts`
- Create: `apps/api/src/platform-auth/platform-activation.service.ts`
- Create: `apps/api/src/platform-auth/platform-activation.controller.ts`
- Create: `apps/api/src/platform-auth/platform-team.service.ts`
- Create: `apps/api/src/platform-auth/platform-team.controller.ts`
- Create: `apps/api/src/cli/provision-platform-admin.ts`
- Create: `apps/api/scripts/provision-platform-admin.mjs`
- Modify: `apps/api/src/auth/auth.setup.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/package.json`
- Create: `apps/api/test/platform-auth.guard.test.ts`
- Create: `apps/api/test/platform-auth.e2e.test.ts`
- Create: `apps/api/test/platform-team.e2e.test.ts`
- Create: `apps/api/test/provision-platform-admin.e2e.test.ts`
- Create: `packages/email/src/emails/platform-user-activation.tsx`
- Create: `packages/email/test/platform-user-activation.test.tsx`
- Modify: `packages/email/src/index.ts`
- Modify: `.env.example`
- Modify: `.env.production.example`

**Interfaces:**

- Produces `PlatformPrincipal { userId, role, capabilities, twoFactorReady }`.
- Produces `@RequirePlatformCapabilities(...capabilities)` and `PlatformAuthGuard`.
- Produces `GET /platform/me` and mounts Better Auth at `/api/platform-auth/*`.
- Produces one-time platform activation plus `/platform/team` invitation, role, suspension, and
  recovery APIs.
- Produces role-filtered, bounded `/platform/audit` queries.
- Produces `PlatformAuditService.record(tx, event)` for all later platform mutations.

- [ ] **Step 1: Write fail-closed guard tests**

Use the existing `authorization.guard.test.ts` style. Pin missing metadata, customer session, missing
2FA, and insufficient role:

```ts
class PlatformPolicyController {
  unclassified(): void {}

  @RequirePlatformCapabilities("tenants.write")
  createTenant(): void {}

  @RequirePlatformCapabilities("billing.write")
  recordPayment(): void {}
}

await expect(guard.canActivate(contextFor(customerRequest, createTenant))).rejects.toThrow(
  ForbiddenException,
);
await expect(guard.canActivate(contextFor(platformAdminWithout2fa, createTenant))).rejects.toThrow(
  ForbiddenException,
);
await expect(guard.canActivate(contextFor(supportWith2fa, recordPayment))).rejects.toThrow(
  ForbiddenException,
);
```

Assert every denial writes exact platform audit fields without a session token or TOTP secret.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/platform-auth.guard.test.ts
```

Expected: FAIL because platform auth policy and guard modules do not exist.

- [ ] **Step 3: Build the separate Better Auth instance**

In `platform-auth-config.ts`, configure `betterAuth` with a Drizzle schema object mapping Better Auth
model keys to the `platform_*` tables. Enable `twoFactor({ issuer: "Markiro Platform", totpOptions:
{} })`; do not enable organization or API-key plugins. Use the existing declaration-emit workaround
pattern but expose only the platform methods actually consumed.

Add validated environment fields:

```ts
PLATFORM_AUTH_SECRET: z.string().min(32),
PLATFORM_AUTH_URL: canonicalHttpUrlSchema,
SAAS_ADMIN_ORIGIN: canonicalOriginSchema,
```

Mount the handler before JSON parsing at `/api/platform-auth/*splat`. Explicitly return 404 for
`/api/platform-auth/sign-up/email` outside `NODE_ENV=test`. Use a unique cookie prefix and do not add
`SAAS_ADMIN_ORIGIN` to customer Better Auth trusted origins.

- [ ] **Step 4: Implement roles and platform bootstrap**

Define capabilities as literals:

```ts
export type PlatformCapability =
  | "tenants.read"
  | "tenants.write"
  | "catalog.read"
  | "catalog.write"
  | "billing.read"
  | "billing.write"
  | "platformTeam.write"
  | "audit.read";
```

Map roles exactly to the design table. `PlatformAuthGuard` loads the platform user/role from the DB
on every protected request and requires verified TOTP state. Never trust a role stored only in a
cookie or client payload.

Implement `provision:platform-admin` with `--email`, no password argument, one-time activation, and
idempotent email/user locks matching `provisionTenantOwner`. Output identifiers only.

The bootstrap command and later team invitations both call `PlatformActivationService`; the
recipient chooses a password from a single-use, expiring token and is then forced into TOTP
enrollment. `PlatformTeamService` supports invite, role change, suspension, activation renewal, and
2FA recovery for `platform_admin` only. Every mutation and denied attempt writes bounded audit
metadata. Never send activation mail while holding the database transaction.

Expose paginated audit queries with allowlisted tenant/actor/action/outcome/time filters. Platform
admins see all allowed metadata, support sees tenant operations only, and accountants see financial
operations only. The response serializer must drop secret-shaped metadata keys even if a producer
attempted to store them.

- [ ] **Step 5: Add e2e isolation and 2FA tests**

Prove:

```ts
expect(await customerAgent.get("/platform/me")).toHaveStatus(401);
expect(await platformAgentWithoutTotp.get("/platform/me")).toHaveStatus(403);
expect(await platformAdminWithTotp.get("/platform/me")).toHaveStatus(200);
expect(await supportWithTotp.post("/platform/team")).toHaveStatus(403);
```

Also assert customer auth cookies do not authenticate platform routes, platform cookies do not
authenticate customer routes, public platform sign-up is 404, and `/platform/me` reports role and
capabilities without sensitive 2FA data. Exercise single-use activation, expired/reissued tokens,
mandatory enrollment after activation, role reload on each request, suspension, recovery, and the
last-active-platform-admin invariant. Cover accepted exact `SAAS_ADMIN_ORIGIN`, rejected sibling/
suffix origins, preflight behavior, secure cookie name/domain/path/SameSite attributes, and absence
of platform credentials from the customer origin.

- [ ] **Step 6: Run checks and commit**

Run API focused tests, then build DB before API gates:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/platform-auth.guard.test.ts \
  test/platform-auth.e2e.test.ts test/platform-team.e2e.test.ts \
  test/provision-platform-admin.e2e.test.ts
pnpm --filter @markiro/email test
pnpm --filter @markiro/email typecheck
pnpm --filter @markiro/email lint
pnpm --filter @markiro/email build
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Commit all explicit Task 2 paths with:

```bash
git commit -m "feat(api): add isolated platform authentication"
```

---

### Task 3: Implement immutable catalog APIs and default demo selection

**Files:**

- Create: `apps/api/src/modules/platform-catalog/dto.ts`
- Create: `apps/api/src/modules/platform-catalog/platform-catalog.service.ts`
- Create: `apps/api/src/modules/platform-catalog/platform-catalog.controller.ts`
- Create: `apps/api/src/modules/platform-catalog/platform-catalog.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/platform-catalog.e2e.test.ts`

**Interfaces:**

- Produces CRUD/publish contracts under `/platform/catalog/items` and
  `/platform/catalog/items/:id/versions`.
- Produces `GET/PATCH /platform/settings/demo-plan`.
- Produces `CatalogVersionDto` whose `unitPrice` and totals are decimal strings.

- [ ] **Step 1: Write catalog e2e tests**

Seed three platform roles and assert:

```ts
const draft = await admin.post("/platform/catalog/items/plan-basic/versions").send({
  nameRu: "Базовый",
  nameEn: "Basic",
  unit: "month",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "15000.00",
  vatRateBps: 2000,
  vatIncluded: true,
  plan: {
    maxLines: 2,
    maxStations: 3,
    maxKiosks: 1,
    maxCabinetUsers: 5,
    labelEditorEnabled: true,
    publicApiEnabled: false,
    palletsEnabled: false,
    demoDurationDays: null,
  },
});
expect(draft.status).toBe(201);
expect((await accountant.post(`${draft.path}/publish`)).status).toBe(200);
expect((await accountant.patch(draft.path).send({ unitPrice: "1.00" })).status).toBe(409);
expect((await support.get(draft.path)).body).not.toHaveProperty("unitPrice");
```

Cover invalid kind/effect combinations, add-on negative deltas, service entitlements, archive rules,
published-version retirement, and replacement of the exact default demo setting.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/platform-catalog.e2e.test.ts
```

Expected: FAIL with 404/module-not-found for platform catalog routes.

- [ ] **Step 3: Implement DTOs and transaction service**

Use discriminated Zod schemas for `plan`, `addon`, and `service`; never accept an arbitrary
entitlement key/value object. Publishing runs one transaction that validates the entire version,
sets `publishedAt/publishedBy`, and writes `catalog.version.published` audit. Return 409 code
`catalog_version_immutable` on attempts to modify a published version.

Default-demo mutation accepts one exact version ID and verifies `kind=plan`, `status=published`, and
positive `demoDurationDays`. Audit before/after IDs.

- [ ] **Step 4: Run package gates and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/platform-catalog.e2e.test.ts
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Commit:

```bash
git commit -m "feat(api): add versioned commercial catalog"
```

---

### Task 4: Create the SaaS-admin shell, 2FA flow, and catalog UI

**Files:**

- Create: `apps/saas-admin/package.json`
- Create: `apps/saas-admin/tsconfig.json`
- Create: `apps/saas-admin/tsconfig.test.json`
- Create: `apps/saas-admin/vite.config.ts`
- Create: `apps/saas-admin/index.html`
- Create: `apps/saas-admin/src/main.tsx`
- Create: `apps/saas-admin/src/app.tsx`
- Create: `apps/saas-admin/src/api/client.ts`
- Create: `apps/saas-admin/src/auth/client.ts`
- Create: `apps/saas-admin/src/auth/PlatformAuthBoundary.tsx`
- Create: `apps/saas-admin/src/pages/auth/Login.tsx`
- Create: `apps/saas-admin/src/pages/auth/ActivatePlatformUser.tsx`
- Create: `apps/saas-admin/src/pages/auth/TwoFactor.tsx`
- Create: `apps/saas-admin/src/pages/auth/Recovery.tsx`
- Create: `apps/saas-admin/src/layout/AppShell.tsx`
- Create: `apps/saas-admin/src/pages/catalog/api.ts`
- Create: `apps/saas-admin/src/pages/catalog/CatalogPage.tsx`
- Create: `apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx`
- Create: `apps/saas-admin/src/i18n/index.ts`
- Create: `apps/saas-admin/src/i18n/ru.json`
- Create: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/src/global.css`
- Create: `apps/saas-admin/test/auth.test.tsx`
- Create: `apps/saas-admin/test/catalog.test.tsx`
- Create: `apps/saas-admin/test/shell.test.tsx`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes `/api/platform-auth/*`, `/api/platform/me`, and Task 3 catalog DTOs.
- Produces a buildable `@markiro/saas-admin` workspace and tested catalog management surface.

- [ ] **Step 1: Scaffold package configuration without copying customer-only dependencies**

Use exact versions already present in `apps/admin`. Depend on React, React Router, TanStack Query,
React Hook Form, Zod, i18next, Better Auth, fontsource, and `@markiro/ui`. Do not depend on
`@markiro/db` from the browser package. Configure Vite proxies in this order:

```ts
proxy: {
  "/api/platform-auth": { target: "http://localhost:3000", changeOrigin: true },
  "/api/platform": {
    target: "http://localhost:3000",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, ""),
  },
}
```

Run `pnpm install --no-lockfile` only for an isolated local bootstrap if the known frozen-config
mismatch blocks installation; once the package manifest is final, update and review the root
`pnpm-lock.yaml` with pnpm and commit its new importer with this task.

- [ ] **Step 2: Write auth and catalog component tests**

Test one-time activation, login redirect to `/two-factor`, forced enrollment, successful TOTP
challenge, recovery, support price redaction, draft editing, publish confirmation, immutable
published panel, and default-demo switch.
Use the existing admin QueryClient/fetch stubbing pattern:

```tsx
renderSaasApp({ me: { role: "accountant", twoFactorReady: true } });
expect(await screen.findByRole("heading", { name: "Каталог" })).toBeDefined();
expect(screen.getByRole("tab", { name: "Тарифы" })).toBeDefined();
expect(screen.getByRole("tab", { name: "Дополнения" })).toBeDefined();
expect(screen.getByRole("tab", { name: "Услуги" })).toBeDefined();
```

- [ ] **Step 3: Verify RED**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/auth.test.tsx test/catalog.test.tsx
```

Expected: FAIL because the app components do not exist.

- [ ] **Step 4: Implement the smallest accessible UI**

Use `@markiro/ui` inputs, buttons, dialogs/panels, tables, status chips, and tokens. The auth boundary
must distinguish unauthenticated, enrollment-required, challenge-required, forbidden, loading, and
network-error states. Never persist a TOTP URI or backup codes outside the enrollment screen.

Catalog forms use discriminated fields by kind. Publishing shows the exact version and explains
that it cannot be edited. Support sees names/effects only and no price placeholders that reveal
redacted values.

The activation route accepts the token only from the URL, exchanges it once, removes it from browser
history, and never persists it. Recovery success invalidates existing sessions and requires fresh
TOTP enrollment before operational routes become available.

- [ ] **Step 5: Run app gates and commit**

```bash
pnpm --filter @markiro/ui build
pnpm --filter @markiro/saas-admin test
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
pnpm --filter @markiro/saas-admin build
```

Commit:

```bash
git commit -m "feat(saas-admin): add secure catalog application"
```

---

### Task 5: Refactor tenant provisioning and create activation-timed demos

**Files:**

- Create: `apps/api/src/modules/platform-tenants/dto.ts`
- Create: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts`
- Create: `apps/api/src/subscriptions/subscription-lifecycle.service.ts`
- Create: `apps/api/src/modules/platform-tenants/platform-tenants.service.ts`
- Create: `apps/api/src/modules/platform-tenants/platform-tenants.controller.ts`
- Create: `apps/api/src/modules/platform-tenants/platform-tenants.module.ts`
- Modify: `apps/api/src/cli/provision-tenant-owner.ts`
- Create: `apps/api/src/cli/report-unmanaged-tenants.ts`
- Create: `apps/api/scripts/report-unmanaged-tenants.mjs`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/modules/tenant-owner-activation/tenant-owner-activation.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/test/provision-tenant-owner.e2e.test.ts`
- Modify: `apps/api/test/tenant-owner-activation.e2e.test.ts`
- Create: `apps/api/test/platform-tenants.e2e.test.ts`
- Create: `apps/api/test/report-unmanaged-tenants.e2e.test.ts`

**Interfaces:**

- Produces `TenantProvisioningService.provision(input, options)` used by CLI and platform API.
- Produces platform tenant list/detail/create/renew-activation routes.
- Produces explicit plan/add-on assignment and scheduling operations with immutable event history.
- Activation atomically transitions `pending_activation -> trial` using one server timestamp.

- [ ] **Step 1: Extend provisioning tests before refactoring**

Add assertions to the existing e2e tests:

```ts
expect(subscriptions).toEqual([
  expect.objectContaining({
    tenantId: first.tenantId,
    planVersionId: demoVersionId,
    status: "pending_activation",
    startsAt: null,
    endsAt: null,
  }),
]);
expect(subscriptionEvents).toEqual([
  expect.objectContaining({ kind: "demo.provisioned", tenantId: first.tenantId }),
]);
```

Concurrent/repeated provisioning must still create one organization, one owner membership, one
activation delivery, one pending subscription, and one provisioning event.

Pin migration-window compatibility behavior: without a valid default demo the CLI fails before any
tenant write, unless the operator passes the exact explicit `--allow-unmanaged-without-demo` flag.
That exceptional path creates an unmanaged tenant, records the reason in audit, and never applies to
the platform UI. Test the `report:unmanaged-tenants` command outputs stable tenant identifiers and
subscription state without credentials or activation data.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/provision-tenant-owner.e2e.test.ts \
  test/tenant-owner-activation.e2e.test.ts test/platform-tenants.e2e.test.ts \
  test/report-unmanaged-tenants.e2e.test.ts
```

Expected: FAIL because default demo configuration and pending subscription creation are absent.

- [ ] **Step 3: Extract one provisioning service**

Move transaction logic from the CLI function into `TenantProvisioningService`. Preserve lock order,
activation renewal rules, secret handling, idempotency, and exact tenant audit. Before inserting the
organization, load and lock the default demo version; fail with `default_demo_not_configured` before
any tenant row if invalid.

The CLI resolves the Nest-independent dependencies and delegates. The platform controller delegates
with platform actor data. Neither path accepts a password. Keep the compatibility flag outside the
shared API input so it cannot be enabled by a browser request.

- [ ] **Step 4: Start demo in activation transaction**

Inject a subscription lifecycle service or implement a focused helper that accepts the existing
transaction. Capture `const activatedAt = now()` once, update user/account/token as today, then:

```ts
await activatePendingDemo(tx, {
  tenantId: subject.tenantId,
  activatedAt,
  sourceUserId: subject.userId,
});
```

The helper locks the pending row, reads immutable `demoDurationDays`, sets `trial`, `startsAt`, and
`endsAt`, and appends one `demo.activated` event. A consumed token cannot reach this code twice.

- [ ] **Step 5: Implement tenant list/detail/create API**

List uses bounded pagination and filters by subscription status, including `unmanaged` so it is the
interactive reconciliation report. Detail includes owner activation
delivery status, exact current/scheduled plan versions, active add-ons, usage summary, and event
history; support responses omit price/payment fields. Renew activation reuses the existing safe
delivery lock path.

Add `POST /platform/tenants/:id/subscription/plan` and
`POST /platform/tenants/:id/subscription/addons` through `SubscriptionLifecycleService`. Accept only
exact published version IDs, an `immediate` or `after_current` activation policy, bounded effective
dates where applicable, and a mandatory reason. Never edit the current assignment: supersede it and
append an immutable event, or insert a scheduled successor. Add-ons must be compatible with the
selected subscription and may only increase entitlements. Restrict these direct operations to
platform admins; accountants assign through paid offer fulfilment and support is read-only. Test
cross-tenant denial, concurrent schedule attempts, exact audit before/after, and that published
catalog changes cannot affect an assigned subscription.

- [ ] **Step 6: Run focused and package gates, then commit**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/provision-tenant-owner.e2e.test.ts \
  test/tenant-owner-activation.e2e.test.ts test/platform-tenants.e2e.test.ts \
  test/report-unmanaged-tenants.e2e.test.ts
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Commit:

```bash
git commit -m "feat(api): provision tenants with activation-timed demos"
```

---

### Task 6: Add tenant and subscription screens to SaaS-admin

**Files:**

- Create: `apps/saas-admin/src/pages/tenants/api.ts`
- Create: `apps/saas-admin/src/pages/tenants/TenantsPage.tsx`
- Create: `apps/saas-admin/src/pages/tenants/CreateTenantPanel.tsx`
- Create: `apps/saas-admin/src/pages/tenants/TenantPage.tsx`
- Create: `apps/saas-admin/src/pages/tenants/SubscriptionPanel.tsx`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/layout/AppShell.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/tenants.test.tsx`
- Create: `apps/saas-admin/test/tenant-detail.test.tsx`

**Interfaces:**

- Consumes Task 5 platform tenant DTOs.
- Produces tenant creation, activation status, subscription history, usage, and renew-activation UI.
- Produces platform-admin controls for reasoned plan/add-on assignment and scheduling.

- [ ] **Step 1: Write tenant UI tests**

Cover empty/loading/error, search/filter, create success, duplicate slug/email conflict, missing demo
configuration, pending activation, resend confirmation, trial dates, scheduled plan, over-limit
usage, direct plan/add-on assignment with mandatory reason, and role visibility:

```tsx
await user.click(screen.getByRole("button", { name: "Создать тенанта" }));
await user.type(screen.getByLabelText("Название"), "Первый завод");
await user.type(screen.getByLabelText("Slug"), "first-factory");
await user.type(screen.getByLabelText("Email владельца"), "owner@example.com");
await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));
expect(await screen.findByText("Ожидает активации владельца")).toBeDefined();
```

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/tenants.test.tsx \
  test/tenant-detail.test.tsx
```

- [ ] **Step 3: Implement routes and screens**

Use route-backed panels and unsaved-change blocking established in `apps/admin`. Support can create
tenants and renew activation but sees no prices/offers. Subscription timeline shows exact catalog
item/version, source, dates, and event reasons. Usage bars always include text counts; color is not
the only status signal.

Only platform admins see direct assignment controls. The confirmation repeats the exact immutable
version, activation policy, resulting limits/features, and reason before submission. Accountant UI
routes users to an offer instead of exposing a bypass around payment fulfilment.

- [ ] **Step 4: Run app gates and commit**

```bash
pnpm --filter @markiro/saas-admin test
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
pnpm --filter @markiro/saas-admin build
git commit -m "feat(saas-admin): add tenant subscription management"
```

---

### Task 7: Implement effective entitlements and race-safe quantitative quotas

**Files:**

- Create: `apps/api/src/subscriptions/entitlements.types.ts`
- Create: `apps/api/src/subscriptions/entitlements.service.ts`
- Create: `apps/api/src/subscriptions/subscription-errors.ts`
- Create: `apps/api/src/subscriptions/subscription-status.job.ts`
- Create: `apps/api/src/subscriptions/subscriptions.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/modules/lines/lines.service.ts`
- Modify: `apps/api/src/modules/station-devices/station-devices.service.ts`
- Modify: `apps/api/src/modules/kiosks/kiosks.service.ts`
- Modify: `apps/api/src/modules/team/team.service.ts`
- Create: `apps/api/test/entitlements.service.test.ts`
- Create: `apps/api/test/subscription-status.job.test.ts`
- Create: `apps/api/test/subscription-quotas.e2e.test.ts`
- Modify: `.env.example`
- Modify: `.env.production.example`

**Interfaces:**

- Produces `EffectiveEntitlements`, `EntitlementUsage`, and
  `EntitlementsService.resolve(tenantId, tx?, at?)`.
- Produces `EntitlementsService.withQuotaSlot(tx, tenantId, key, create)` for four quota writes.
- Produces stable errors `subscription_limit_reached` and `subscription_unmanaged`.
- Produces an idempotent pg-boss materializer for due activation/expiration statuses and events;
  request-time access never depends on the job running.

- [ ] **Step 1: Write resolver and boundary tests**

Pin plan-plus-add-on math, unlimited `null`, scheduled rows excluded before start, expired rows
excluded at request time, and exact usage definitions. Then test every last slot and concurrency:

```ts
const attempts = await Promise.allSettled([
  createLine(tenantId, { name: "Линия A" }),
  createLine(tenantId, { name: "Линия B" }),
]);
expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
```

Repeat for station, kiosk, and invitation. Assert pending invitations count, and
cancelled/expired/rejected invitations release capacity.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/entitlements.service.test.ts \
  test/subscription-quotas.e2e.test.ts
```

- [ ] **Step 3: Implement entitlement resolution**

Return the exact typed shape:

```ts
export interface EffectiveEntitlements {
  tenantId: string;
  access: "managed" | "read_only" | "unmanaged";
  subscription: {
    id: string;
    planVersionId: string;
    status: "pending_activation" | "trial" | "active" | "expired";
    startsAt: Date | null;
    endsAt: Date | null;
  } | null;
  quotas: Record<"lines" | "stations" | "kiosks" | "cabinetUsers", number | null>;
  features: Record<"labelEditor" | "publicApi" | "pallets", boolean>;
}
```

Derive expiry from timestamps before stored status. Sum only active additive effects. A feature is
enabled by the plan OR at least one active add-on. Validate
`SUBSCRIPTION_ENFORCEMENT_MODE=managed_only|all`; ship `managed_only` so migrated legacy tenants are
observe-only while every newly provisioned tenant is enforced. Do not silently treat a managed
tenant with broken subscription data as unlimited.

- [ ] **Step 4: Refactor quota writes into one transaction**

Change each create/invite method to pass a transaction into `withQuotaSlot`; do not perform a
pre-check followed by a separate service insert. Lock key uses tenant ID plus entitlement key in a
fixed order. Preserve tenant-scoped validation and exact existing audit behavior inside the same
transaction where required.

Unmanaged legacy tenants remain observe-only during rollout. Newly provisioned managed tenants are
authoritative immediately.

- [ ] **Step 5: Materialize due statuses and history idempotently**

Register one pg-boss job that selects due scheduled subscriptions/add-ons and ended subscriptions/
add-ons with row locking, transitions stored reporting status, and appends the matching event under
unique event identity. Test concurrent/retried workers and prove `EntitlementsService` still denies
expired access when the job has not executed.

- [ ] **Step 6: Run affected e2e suites and commit**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/subscription-status.job.test.ts \
  test/subscription-quotas.e2e.test.ts \
  test/lines.e2e.test.ts test/station-devices.e2e.test.ts test/kiosks.e2e.test.ts test/team.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
git commit -m "feat(api): enforce subscription quotas transactionally"
```

---

### Task 8: Enforce feature entitlements and subscription read-only recovery rules

**Files:**

- Create: `apps/api/src/subscriptions/subscription-access-policy.ts`
- Create: `apps/api/src/subscriptions/subscription-access.guard.ts`
- Modify: `apps/api/src/modules/label-templates/label-templates.controller.ts`
- Modify: `apps/api/src/modules/api-keys/api-keys.controller.ts`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts`
- Modify: `apps/api/src/modules/kiosk/kiosk.controller.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/src/modules/operators/dto.ts` or the station bootstrap DTO source that carries
  tenant subscription status
- Create: `apps/api/test/subscription-features.e2e.test.ts`
- Create: `apps/api/test/subscription-expiry.e2e.test.ts`

**Interfaces:**

- Produces explicit policies `RequireSubscriptionWrite`, `RequireFeature(key)`, and
  `AllowSubscriptionRecovery(kind)`.
- Extends station/kiosk bootstrap with status/end timestamps for honest offline UI.

- [ ] **Step 1: Write route-classification and recovery tests**

Test expired managed tenants:

```ts
expect(await cabinet.post("/shifts").send(shift)).toHaveStatus(403);
expect(await station.post(`/shifts/${preExpiryShiftId}/open`)).toHaveStatus(403);
expect(await station.post("/station/scans").send(preExpiryOpenShiftBatch)).toHaveStatus(201);
expect(await station.post("/station/scans").send(postExpiryNewShiftBatch)).toHaveStatus(403);
expect(await kiosk.post("/kiosk/orders").send(preExpiryQueuedOrder)).toHavePerRecordStatus(
  "accepted",
);
expect(await kiosk.post("/kiosk/orders").send(postExpiryOrder)).toHavePerRecordStatus(
  "subscription_read_only",
);
```

Also prove label create/update blocked but list/get/preview use remains; public API key issue/write
blocked but read/export remains; identity/profile security maintenance remains available.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/subscription-features.e2e.test.ts \
  test/subscription-expiry.e2e.test.ts
```

- [ ] **Step 3: Implement explicit policies**

Do not add a broad global mutation blocker that can accidentally strand device recovery. Every
business mutation declares write, feature, or recovery policy. The guard obtains authoritative
entitlements from the server and emits `{ code: "subscription_read_only" }` or
`{ code: "subscription_feature_disabled", entitlement }`.

For station recovery, load the referenced tenant-scoped shift and allow delivery only when it opened
before entitlement expiry. For kiosk queued records, compare validated device occurrence time to
the authoritative end time and preserve per-record responses so one denial does not wedge the
queue.

- [ ] **Step 4: Run device/cabinet regression suites and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/subscription-features.e2e.test.ts \
  test/subscription-expiry.e2e.test.ts test/label-templates.e2e.test.ts test/api-keys.e2e.test.ts \
  test/shifts.e2e.test.ts test/station-scans.e2e.test.ts test/kiosk-orders.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
git commit -m "feat(api): enforce subscription features and expiry"
```

---

### Task 9: Expose customer subscription state and banners

**Files:**

- Modify: `apps/api/src/authorization/access.controller.ts`
- Modify: `apps/api/src/authorization/authorization.service.ts`
- Modify: `apps/admin/src/access/api.ts`
- Modify: `apps/admin/src/access/context.tsx`
- Create: `apps/admin/src/subscription/SubscriptionBanner.tsx`
- Create: `apps/admin/src/pages/settings/SubscriptionPage.tsx`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/layout/AppShell.tsx`
- Modify: `apps/admin/src/pages/Shell.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/subscription-banner.test.tsx`
- Create: `apps/admin/test/subscription-page.test.tsx`

**Interfaces:**

- Extends `AccessDocument` with subscription status, exact plan/version label, timestamps, usage,
  quotas, features, and scheduled successor; no prices/payment/platform identities.

- [ ] **Step 1: Write customer UI tests**

Cover pending activation, trial days remaining, over-limit, scheduled paid plan, read-only expiry,
unmanaged legacy tenant, RU/EN, and error-code rendering:

```tsx
renderShell({ subscription: trialFixture({ daysRemaining: 3 }) });
expect(screen.getByRole("status").textContent).toContain("Демо закончится через 3 дня");
expect(screen.getByRole("link", { name: "Посмотреть лимиты" }).getAttribute("href")).toBe(
  "/settings/subscription",
);
```

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @markiro/admin exec vitest run test/subscription-banner.test.tsx \
  test/subscription-page.test.tsx
```

- [ ] **Step 3: Extend access bootstrap and render UI**

Resolve access/capabilities and entitlements from the same request-time state. The subscription page
uses text-plus-progress for each quota and lists add-on contributors. Expired state keeps read/export
navigation while disabling write controls through server capabilities and visible explanations.

- [ ] **Step 4: Run API/admin gates and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/authorization.e2e.test.ts
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
git commit -m "feat(admin): surface subscription limits and status"
```

---

### Task 10: Implement offers, full payment, and idempotent fulfilment

**Files:**

- Create: `apps/api/src/modules/platform-offers/dto.ts`
- Create: `apps/api/src/modules/platform-offers/offer-totals.ts`
- Create: `apps/api/src/modules/platform-offers/platform-offers.service.ts`
- Create: `apps/api/src/modules/platform-offers/payment-fulfilment.service.ts`
- Create: `apps/api/src/modules/platform-offers/platform-offers.controller.ts`
- Create: `apps/api/src/modules/platform-offers/platform-offers.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/offer-totals.test.ts`
- Create: `apps/api/test/platform-offers.e2e.test.ts`
- Create: `apps/api/test/payment-fulfilment.e2e.test.ts`

**Interfaces:**

- Produces offer draft/publish/revision/cancel/list/detail routes under `/platform/offers`.
- Produces `POST /platform/offers/:id/payment` with `Idempotency-Key` plus exact body.
- Produces `PaymentFulfilmentResult { paymentId, fulfilments[], subscriptionId? }`.

- [ ] **Step 1: Write exact decimal total tests**

No JavaScript floating-point arithmetic:

```ts
expect(
  calculateOfferTotals([
    { quantity: 2, unitPrice: "15000.00", vatRateBps: 2000, vatIncluded: true },
    { quantity: 1, unitPrice: "5000.50", vatRateBps: null, vatIncluded: false },
  ]),
).toEqual({ total: "35000.50", currency: "RUB" });
```

Use integer minor-unit or exact decimal helpers with bounds checked before conversion.

- [ ] **Step 2: Write offer/payment e2e tests**

Cover catalog snapshot, ad-hoc service restriction, one plan line, override reason, immutable
publication, exact amount, bank reference, role access, cross-tenant IDs, immediate/after-current,
add-on term, service order, duplicate idempotency, different-key replay, and rollback injection.

Core assertion:

```ts
const [first, retry] = await Promise.all([
  markPaid(offerId, "payment-key-1", paymentBody),
  markPaid(offerId, "payment-key-1", paymentBody),
]);
expect(retry).toEqual(first);
expect(await countPayments(offerId)).toBe(1);
expect(await countFulfilments(offerId)).toBe(publishedOffer.lines.length);
expect(await countCurrentSubscriptions(tenantId)).toBe(1);
```

- [ ] **Step 3: Verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/offer-totals.test.ts \
  test/platform-offers.e2e.test.ts test/payment-fulfilment.e2e.test.ts
```

- [ ] **Step 4: Implement immutable offer revisions**

Draft lines may reference published catalog versions or be ad-hoc service lines. Publish validates
all lines, copies display/commercial/effect snapshots, calculates totals, and freezes the revision.
Changing a published offer creates a new revision/family link; never mutate the old row.

- [ ] **Step 5: Implement atomic payment fulfilment**

In one transaction:

1. Lock offer and tenant subscription timeline.
2. Return existing payment for the same idempotency key.
3. Reject wrong total/state or a different-key replay.
4. Insert payment.
5. Fulfil each line once using a unique offer-line constraint.
6. For immediate plan, supersede current and create active; for `after_current`, create scheduled or
   active when already expired.
7. Attach add-ons to the plan from the same offer or compatible selected subscription.
8. Create `ordered_services` for catalog/ad-hoc services.
9. Append subscription events and exact platform audit.

Do not call SMTP or external services in the transaction.

- [ ] **Step 6: Run focused/full API gates and commit**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/offer-totals.test.ts \
  test/platform-offers.e2e.test.ts test/payment-fulfilment.e2e.test.ts
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
git commit -m "feat(api): fulfil paid commercial offers"
```

---

### Task 11: Add offer, payment, service, team, and audit UI to SaaS-admin

**Files:**

- Create: `apps/saas-admin/src/pages/offers/api.ts`
- Create: `apps/saas-admin/src/pages/offers/OffersPage.tsx`
- Create: `apps/saas-admin/src/pages/offers/OfferEditor.tsx`
- Create: `apps/saas-admin/src/pages/offers/PaymentPanel.tsx`
- Create: `apps/saas-admin/src/pages/services/OrderedServicesPanel.tsx`
- Create: `apps/saas-admin/src/pages/team/api.ts`
- Create: `apps/saas-admin/src/pages/team/PlatformTeamPage.tsx`
- Create: `apps/saas-admin/src/pages/audit/api.ts`
- Create: `apps/saas-admin/src/pages/audit/PlatformAuditPage.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/TenantPage.tsx`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/layout/AppShell.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/offers.test.tsx`
- Create: `apps/saas-admin/test/payment.test.tsx`
- Create: `apps/saas-admin/test/platform-team.test.tsx`
- Create: `apps/saas-admin/test/platform-audit.test.tsx`

**Interfaces:**

- Consumes Task 10 DTOs and Task 2 platform team/audit APIs.
- Completes first-release platform screens from design section 11.

- [ ] **Step 1: Write offer/payment UI tests**

Cover catalog picker, ad-hoc service, price override reason, exact totals, one-plan rule, publish
immutability, revision, activation policy, payment exact amount/reference, confirmation preview,
idempotent retry, fulfilment results, ordered-service status, team invitation/role/suspension/
recovery, role-filtered audit, role redaction, and transaction error retention.

```tsx
await user.click(screen.getByRole("button", { name: "Зафиксировать оплату" }));
expect(screen.getByText("Будет назначен тариф Базовый, версия 3")).toBeDefined();
await user.type(screen.getByLabelText("Банковский референс"), "PAY-2026-00042");
await user.click(screen.getByRole("button", { name: "Подтвердить полную оплату" }));
expect(await screen.findByText("Подписка назначена")).toBeDefined();
```

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/offers.test.tsx test/payment.test.tsx \
  test/platform-team.test.tsx test/platform-audit.test.tsx
```

- [ ] **Step 3: Implement UI with protected financial data**

Accountant/admin screens render prices and payment facts; support routes are absent and direct URL
access yields forbidden. Payment confirmation repeats exact total, bank reference, plan activation
policy, add-ons, and services. Disable repeat submission while pending but retain form data after
failure. Generate one UUID idempotency key per payment attempt and reuse it for network retry.

Platform audit filters by tenant, actor, action, outcome, and period. Metadata rendering uses an
allowlisted formatter, not arbitrary JSON containing secrets.

Tenant detail renders immutable ordered services separately from entitlement-bearing add-ons.
Platform-team invitations explain the one-time activation and mandatory 2FA flow; destructive role,
suspension, and recovery actions require confirmation and surface the last-admin invariant.

- [ ] **Step 4: Run app gates and commit**

```bash
pnpm --filter @markiro/saas-admin test
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
pnpm --filter @markiro/saas-admin build
git commit -m "feat(saas-admin): manage offers payments and audit"
```

---

### Task 12: Package the platform app, update contracts/docs, and run final acceptance

**Files:**

- Modify: `deploy/production/edge.Dockerfile`
- Modify: `deploy/production/Caddyfile`
- Modify: `deploy/production/Caddyfile.alb`
- Modify: `compose.production.yml`
- Modify: `deploy/production/preflight.mjs`
- Modify: `deploy/production/production-domain.mjs`
- Modify: `deploy/production/smoke.mjs`
- Modify: `deploy/production/test/edge-contract.test.mjs`
- Modify: `deploy/production/test/compose-contract.test.mjs`
- Modify: `deploy/production/test/preflight.test.mjs`
- Modify: `deploy/production/test/smoke-route-table.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `.env.production.example`
- Modify: `docs/runbooks/saas-production-deploy.md`
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`
- Create: `tools/saas-browser/package.json`
- Create: `tools/saas-browser/pnpm-lock.yaml`
- Create: `tools/saas-browser/tsconfig.json`
- Create: `tools/saas-browser/playwright.config.ts`
- Create: `tools/saas-browser/tests/first-release.spec.ts`
- Create: `tools/saas-browser/support/fixtures.ts`

**Interfaces:**

- Produces `MARKIRO_SAAS_ADMIN_DOMAIN`/`SAAS_ADMIN_ORIGIN` production configuration.
- Produces exact-host routing: platform host serves only platform SPA plus platform API/auth routes.

- [ ] **Step 1: Write production contract tests first**

Assert edge build contains `/srv/saas-admin`; platform host forwards only `/api/platform-auth/*` and
`/api/platform/*`; customer/kiosk hosts cannot serve the platform SPA; reserved namespaces return
404; preflight requires canonical distinct domains and secrets; smoke checks release header and
platform login document without authenticating.

```js
assert.match(caddyfile, /https:\/\/\{\$MARKIRO_SAAS_ADMIN_DOMAIN\}:8443/);
assert.match(caddyfile, /path \/api\/platform-auth\/\*/);
assert.match(caddyfile, /handle_path \/api\/platform\/\*/);
assert.doesNotMatch(kioskRoutes, /platform-auth|saas-admin/);
```

- [ ] **Step 2: Verify RED**

```bash
pnpm test:production-bundle:contract
```

Expected: focused platform-host assertions fail before packaging/routing changes.

- [ ] **Step 3: Package and route the new app**

Build `@markiro/saas-admin` in the edge image and copy only its `dist` output to
`/srv/saas-admin`. Add exact host blocks to both direct-Caddy and ALB Caddyfiles. Keep customer,
kiosk, platform, station, CommerceML, health, and docs route namespaces isolated. Add CSP/connect
sources only when tests demonstrate a required self-origin path; no CDN assets.

Update Compose/preflight/smoke/env inventory without real domains or secrets. Add CI package gates
and production contracts.

- [ ] **Step 4: Run automated final gates**

Add a local-only Playwright harness that boots against the configured test database and Mailpit,
uses API/DB fixtures without exposing activation tokens in reporter output, and covers the first
release happy path: platform activation and TOTP, catalog publication, tenant/demo activation,
quota boundary, expiry banner/read-only state, offer publication, payment retry, fulfilment, and
support financial redaction. Keep production-doc browser checks separate because they do not prove
authenticated SaaS behavior.

With the repository test environment loaded:

```bash
pnpm --filter @markiro/db db:migrate
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
pnpm test:production-bundle:contract
pnpm test:saas-browser
pnpm test:production-docs:browser
git diff --check
```

Expected: all executed tests pass. Record exact database/browser skips; do not infer live SMTP,
DNS/TLS, or cloud success.

- [ ] **Step 5: Run manual non-production acceptance**

Against local Postgres, Mailpit, MinIO, API, customer admin, and SaaS-admin:

1. Provision first platform admin; confirm no password/token appears in command output.
2. Activate, enroll TOTP, sign out/in, and complete a TOTP challenge.
3. Publish default demo, a standard plan, quota add-on, feature add-on, and service.
4. Create tenant; verify demo has no timestamps before owner activation.
5. Activate owner; verify exact demo dates and customer banner.
6. Reach every quota and verify the final concurrent slot cannot be exceeded.
7. Expire demo in controlled test data; verify reads/exports and eligible offline recovery remain.
8. Publish an individual offer with price override reason; record exact payment twice with one key;
   verify one payment and one fulfilment per line.
9. Confirm support sees no financial facts and customer sessions cannot access platform routes.

Real production SMTP, bank reconciliation, DNS/TLS, Yandex deployment, and physical station/kiosk
acceptance remain external and must be reported `NOT RUN` unless actually exercised.

- [ ] **Step 6: Update roadmap and commit**

Mark only this approved first SaaS-admin slice delivered. Leave invoice PDF/email, partial payments,
bank integration, monitoring, and broader billing lifecycle pending.

```bash
git add deploy/production compose.production.yml .github/workflows/ci.yml package.json \
  .env.production.example tools/saas-browser \
  docs/runbooks/saas-production-deploy.md README.md README.ru.md \
  docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md
git diff --cached --check
git commit -m "feat(deploy): package the SaaS administration app"
```

## Plan self-review record

- **Spec coverage:** Tasks 1-12 implement the in-scope commitments and success criteria, with
  explicit steps for architecture, catalog/subscriptions, demo activation, fulfilment, enforcement,
  APIs/UI, audit, migration compatibility, failures, and verification from sections 4-16 of the
  approved spec. Deferred billing/monitoring items remain outside Task 12 completion claims.
- **Dependency order:** schema -> platform auth -> catalog -> catalog UI -> provisioning/demo ->
  tenant UI -> quota resolver -> access enforcement -> customer UI -> payment fulfilment ->
  financial UI -> production packaging.
- **Type consistency:** `SaasEntitlementKey`, `PlatformPrincipal`, `EffectiveEntitlements`, exact
  catalog version IDs, decimal-string prices, and payment idempotency keys have one producer and are
  consumed by later tasks under the same names.
- **Safety:** Every cross-tenant, concurrency, offline recovery, immutable-history, and secret
  boundary from the spec has a focused automated assertion before implementation.
