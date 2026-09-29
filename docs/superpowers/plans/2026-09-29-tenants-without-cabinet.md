# Tenants Without Cabinet Access Implementation Plan

**Status:** executed via subagent-driven development; deviations recorded in the spec (`docs/superpowers/specs/2026-09-29-tenants-without-cabinet-design.md`, "Implementation notes and changes").

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator create a tenant with no cabinet (no owner, no activation mail, no demo, services only), create it inline from the offer editor, and grant the cabinet later.

**Architecture:** A new `organization.cabinet_access` column (`enabled` | `none`) is the single source of truth. `createTenantSchema` becomes conditional on it; `TenantProvisioningService` branches on it and gains a `grantCabinetAccess` method that reuses an extracted owner-creation method. Licence kinds (`plan`/`addon`) are refused for `none` tenants at the three places that write them (subscription lifecycle, offer draft, invoice create).

**Tech Stack:** NestJS + Drizzle/Postgres, Zod contracts (`@markiro/platform-contracts`), React + react-query + react-hook-form in `apps/saas-admin`, Vitest.

Spec: `docs/superpowers/specs/2026-09-29-tenants-without-cabinet-design.md`.

## Global Constraints

- Add a new migration; never edit applied ones (root `AGENTS.md`).
- `@markiro/db` and `@markiro/platform-contracts` export compiled `dist`: run `pnpm --filter <pkg> build` before consumer tests.
- Platform contract schemas are `.strict()`; every consumer (API, saas-admin fixtures) is updated in the same change.
- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: no casts, no `!`, use `import type`.
- Audit assertions check exact actor, tenant, action, target, result and metadata, not row counts.
- Only catalog kind `service` may be ordered by a `none` tenant. Refusal code: `catalog_kind_not_allowed_for_offline_tenant` (HTTP 409).
- Cabinet grant is one way (`none` → `enabled`); capability `tenants.write`, denied for role `accountant` (role `support` holds `tenants.write` and may grant).
- ~~No demo is created retroactively on grant.~~ Superseded (owner decision 2026-09-29): the grant creates the default demo as provisioning does and fails with `default_demo_not_configured` when none is configured.
- User-visible text goes through the existing i18n files (`ru.json` and `en.json`).
- DB-backed tests need `DATABASE_URL` and the auth env from `.env`; if the shared dev database has a drifted migration journal, use a one-off Postgres container instead of touching shared data. Report skipped suites explicitly.
- Commit steps below are only for when the owner has authorised commits for this task; stage explicit paths, never `git add -A`.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/db/src/schema/auth.ts` | `organization.cabinetAccess` column + check |
| `packages/db/migrations/0176_*.sql` (generated) | migration |
| `packages/db/test/tenant-cabinet-access-migration.test.ts` | migration test |
| `packages/platform-contracts/src/tenants.ts` | `cabinetAccessSchema`, conditional create schema, nullable create response, list/detail field, grant contract |
| `packages/platform-contracts/test/tenants.test.ts` | contract tests |
| `apps/api/src/subscriptions/tenant-cabinet-access.ts` (new) | `OFFLINE_TENANT_KIND_ERROR`, `assertKindAllowedForTenant` |
| `apps/api/src/subscriptions/subscription-lifecycle.service.ts` | call the guard from `assignPlan/AddonInTransaction` |
| `apps/api/src/modules/platform-offers/platform-offer-draft.ts` | guard for offer lines |
| `apps/api/src/modules/billing/billing.service.ts` | guard for invoice lines |
| `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` | `none` branch, extracted `provisionOwner`, `grantCabinetAccess` |
| `apps/api/src/modules/platform-tenants/platform-tenants.service.ts` | expose `cabinetAccess`, grant wrapper, renew guard |
| `apps/api/src/modules/platform-tenants/platform-tenants.controller.ts` | grant route |
| `apps/api/test/*.ts` | e2e + contract + inventory tests |
| `apps/saas-admin/src/pages/tenants/*`, `pages/offers/CreateOfferPage.tsx`, `i18n/*.json` | UI |

---

### Task 1: `organization.cabinet_access` column and migration

**Files:**
- Modify: `packages/db/src/schema/auth.ts` (the `organization` table, ~line 89)
- Create (generated): `packages/db/migrations/0176_tenant_cabinet_access.sql` + `meta` snapshot and journal entry
- Test: `packages/db/test/tenant-cabinet-access-migration.test.ts`

**Interfaces:**
- Produces: `schema.organization.cabinetAccess: "enabled" | "none"` (not null, default `"enabled"`), used by every later task.

- [ ] **Step 1: Write the failing migration test**

Create `packages/db/test/tenant-cabinet-access-migration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("organization.cabinet_access migration", () => {
  const name = `markiro_cabinet_access_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  let temporaryRoot = "";

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-cabinet-access-"));
    const legacy = join(temporaryRoot, "legacy");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacy,
      lastIncludedIndex: 175,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ('legacy-org', 'Legacy', 'legacy-org', now())`,
    );
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("backfills existing tenants as enabled", async () => {
    const { rows } = await pool.query<{ cabinet_access: string }>(
      `SELECT cabinet_access FROM organization WHERE id = 'legacy-org'`,
    );
    expect(rows).toEqual([{ cabinet_access: "enabled" }]);
  });

  it("accepts none and rejects unknown values", async () => {
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at, cabinet_access) VALUES ('offline-org', 'Offline', 'offline-org', now(), 'none')`,
    );
    await expect(
      pool.query(
        `INSERT INTO organization (id, name, slug, created_at, cabinet_access) VALUES ('bad-org', 'Bad', 'bad-org', now(), 'sometimes')`,
      ),
    ).rejects.toThrow(/organization_cabinet_access_ck/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @markiro/db exec vitest run test/tenant-cabinet-access-migration.test.ts`
Expected: FAIL (`column "cabinet_access" does not exist`). If `DATABASE_URL` is unset the suite skips — load `.env` first and report a skip as "not verified".

- [ ] **Step 3: Add the column to the schema**

In `packages/db/src/schema/auth.ts`, change the `organization` table to:

```ts
export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: timestamp("created_at").notNull(),
    metadata: text("metadata"),
    cabinetAccess: text("cabinet_access").$type<"enabled" | "none">().notNull().default("enabled"),
  },
  (table) => [
    uniqueIndex("organization_slug_uidx").on(table.slug),
    check("organization_cabinet_access_ck", sql`${table.cabinetAccess} in ('enabled', 'none')`),
  ],
);
```

Add `check` to the `drizzle-orm/pg-core` import and `sql` to the `drizzle-orm` import of that file if they are not already imported.

- [ ] **Step 4: Generate and review the migration**

Run: `pnpm --filter @markiro/db db:generate --name tenant_cabinet_access`
Expected: a new `0176_tenant_cabinet_access.sql` containing exactly an `ADD COLUMN "cabinet_access" text DEFAULT 'enabled' NOT NULL` and an `ADD CONSTRAINT "organization_cabinet_access_ck" CHECK (...)`. Read `packages/db/drizzle.config.ts` first: some partitioned tables are hand-migrated; `organization` is not. If the generator emits anything else (other tables), stop and investigate drift instead of committing it.

- [ ] **Step 5: Build and run the test**

Run:
```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db exec vitest run test/tenant-cabinet-access-migration.test.ts
pnpm --filter @markiro/db test
```
Expected: PASS. If a schema snapshot/parity test fails, update it for the new column only.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/auth.ts packages/db/migrations packages/db/test/tenant-cabinet-access-migration.test.ts
git commit -m "feat(db): add organization.cabinet_access"
```

---

### Task 2: Contracts

**Files:**
- Modify: `packages/platform-contracts/src/tenants.ts` (`tenantListItemSchema`, `tenantDetailSchema.tenant`, `createTenantSchema`, `createTenantResponseSchema`, `platformTenantContracts`, type exports)
- Test: `packages/platform-contracts/test/tenants.test.ts`

**Interfaces:**
- Produces:
  - `cabinetAccessSchema = z.enum(["enabled","none"])`, type `CabinetAccess`
  - `createTenantSchema` input `{ tenantName; tenantSlug; email?: string; cabinetAccess?: CabinetAccess }`, output `cabinetAccess` always present; issue message `"email"` when `enabled` without email, `"emailNotAllowed"` when `none` with email
  - `createTenantResponseSchema`: `userId`, `memberId`, `deliveryId` nullable
  - `tenantListItemSchema.cabinetAccess`, `tenantDetailSchema.tenant.cabinetAccess`
  - `grantCabinetAccessSchema = { email }`, `grantCabinetAccessResponseSchema = { tenantId, userId, memberId, deliveryId }`, and `platformTenantContracts.grantCabinetAccess = { params: tenantParamsSchema, body, response }`
  - types `GrantCabinetAccessInput`, `GrantCabinetAccessDto`, `GrantCabinetAccessResult`

- [ ] **Step 1: Write failing tests** (append to `packages/platform-contracts/test/tenants.test.ts`; keep the file's existing imports and add the new names to them)

```ts
describe("createTenantSchema cabinet access", () => {
  const base = { tenantName: "Завод", tenantSlug: "zavod" };

  it("defaults to enabled and requires an e-mail", () => {
    expect(createTenantSchema.parse({ ...base, email: " Owner@Example.com " })).toEqual({
      ...base,
      email: "owner@example.com",
      cabinetAccess: "enabled",
    });
    const result = createTenantSchema.safeParse(base);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["email"], message: "email" });
  });

  it("accepts none without an e-mail and rejects one", () => {
    expect(createTenantSchema.parse({ ...base, cabinetAccess: "none" })).toEqual({
      ...base,
      cabinetAccess: "none",
    });
    const result = createTenantSchema.safeParse({
      ...base,
      cabinetAccess: "none",
      email: "owner@example.com",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["email"], message: "emailNotAllowed" });
  });

  it("allows a none tenant to have no owner ids in the response", () => {
    expect(
      createTenantResponseSchema.parse({
        tenantId: "org_1",
        userId: null,
        memberId: null,
        deliveryId: null,
      }),
    ).toEqual({ tenantId: "org_1", userId: null, memberId: null, deliveryId: null });
  });
});

describe("grantCabinetAccessSchema", () => {
  it("normalises the e-mail and rejects unknown keys", () => {
    expect(grantCabinetAccessSchema.parse({ email: " A@B.co " })).toEqual({ email: "a@b.co" });
    expect(grantCabinetAccessSchema.safeParse({ email: "a@b.co", extra: 1 }).success).toBe(false);
  });
});
```

Use a valid `platformTenantIdSchema` value for `tenantId` — copy one from the existing tests in that file if `"org_1"` is rejected.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/platform-contracts exec vitest run test/tenants.test.ts`
Expected: FAIL (missing exports / behavior).

- [ ] **Step 3: Implement**

In `packages/platform-contracts/src/tenants.ts`:

```ts
export const cabinetAccessSchema = z.enum(["enabled", "none"]);
export type CabinetAccess = z.output<typeof cabinetAccessSchema>;
```
(place near `tenantActivationPolicySchema`).

`tenantListItemSchema`: add `cabinetAccess: cabinetAccessSchema,` after `slug`.

`tenantDetailSchema.tenant`: add `cabinetAccess: cabinetAccessSchema,` after `slug`.

Replace `createTenantSchema` and `createTenantResponseSchema`:

```ts
export const createTenantSchema = z
  .object({
    tenantName: z.string().trim().min(1, "required").max(300, "nameTooLong"),
    tenantSlug: z
      .string()
      .trim()
      .max(128, "slugTooLong")
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug"),
    email: normalizedEmailSchema.optional(),
    cabinetAccess: cabinetAccessSchema.default("enabled"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.cabinetAccess === "enabled" && value.email === undefined) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "email" });
    }
    if (value.cabinetAccess === "none" && value.email !== undefined) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "emailNotAllowed" });
    }
  });

export const createTenantResponseSchema = z.object({
  tenantId: platformTenantIdSchema,
  userId: z.string().min(1).max(128).nullable(),
  memberId: z.string().min(1).max(128).nullable(),
  deliveryId: platformUuidSchema.nullable(),
});

export const grantCabinetAccessSchema = z.object({ email: normalizedEmailSchema }).strict();
export const grantCabinetAccessResponseSchema = z.object({
  tenantId: platformTenantIdSchema,
  userId: z.string().min(1).max(128),
  memberId: z.string().min(1).max(128),
  deliveryId: platformUuidSchema,
});
```

In `platformTenantContracts` add:

```ts
  grantCabinetAccess: {
    params: tenantParamsSchema,
    body: grantCabinetAccessSchema,
    response: grantCabinetAccessResponseSchema,
  },
```
and near the other type exports:

```ts
export type GrantCabinetAccessInput = z.input<typeof grantCabinetAccessSchema>;
export type GrantCabinetAccessDto = z.output<typeof grantCabinetAccessSchema>;
export type GrantCabinetAccessResult = z.output<typeof grantCabinetAccessResponseSchema>;
```

The V2 and V3 contract objects spread `platformTenantContracts`, and V3 detail derives `tenant` from the base schema, so they pick the new fields up without further edits. Make sure `index.ts` re-exports the new names (check whether it uses `export *`).

- [ ] **Step 4: Build and run**

Run:
```bash
pnpm --filter @markiro/platform-contracts exec vitest run test/tenants.test.ts
pnpm --filter @markiro/platform-contracts test
pnpm --filter @markiro/platform-contracts typecheck
pnpm --filter @markiro/platform-contracts build
```
Expected: PASS. Existing tests that build a tenant list item or detail fixture will now fail on the missing `cabinetAccess`: add `cabinetAccess: "enabled"` to those fixtures (only that field).

- [ ] **Step 5: Commit**

```bash
git add packages/platform-contracts
git commit -m "feat(contracts): cabinet access on tenants"
```

---

### Task 3: Refuse licences for `none` tenants (server guard)

**Files:**
- Create: `apps/api/src/subscriptions/tenant-cabinet-access.ts`
- Modify: `apps/api/src/subscriptions/subscription-lifecycle.service.ts` (`assignPlanInTransaction` ~line 344, `assignAddonInTransaction` ~line 587)
- Modify: `apps/api/src/modules/platform-offers/platform-offer-draft.ts` (line loop ~46)
- Modify: `apps/api/src/modules/billing/billing.service.ts` (`create`, after the tenant lookup ~line 129 and the line selection)
- Test: `apps/api/test/tenant-cabinet-access-guard.e2e.test.ts`

**Interfaces:**
- Produces (in `tenant-cabinet-access.ts`):

```ts
export const OFFLINE_TENANT_KIND_ERROR = "catalog_kind_not_allowed_for_offline_tenant";
export async function assertKindAllowedForTenant(
  tx: Pick<Db, "select">,
  tenantId: string,
  kind: "plan" | "addon" | "service",
): Promise<void>; // throws ConflictException({ code: OFFLINE_TENANT_KIND_ERROR })
```
- Consumes: `schema.organization.cabinetAccess` (Task 1).

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/test/tenant-cabinet-access-guard.e2e.test.ts` modelled on `platform-tenants.e2e.test.ts` (same `ready` env gate, `createPlatformAgent`, `currentTotp`, `requiredSetCookie`, `listenOnLoopback`, AppModule bootstrap). Do not import them from the other test file; copy the helpers, or move them to `apps/api/test/support/platform-agent.ts` if you prefer, changing both files. Seed a `none` tenant directly with the DB (this task must not depend on Task 4):

```ts
async function createOfflineTenant(): Promise<string> {
  const id = randomUUID();
  await setup.db.insert(schema.organization).values({
    id,
    name: "Offline",
    slug: `offline-${id}`,
    createdAt: new Date(),
    cabinetAccess: "none",
  });
  return id;
}
```

Cases (each `it`):

1. `assign plan to none tenant → 409 catalog_kind_not_allowed_for_offline_tenant` — `admin.post(`/platform/tenants/${id}/subscription/plan`).set("X-Markiro-Commercial-Version","2").send({ catalogVersionId: <published plan>, activationPolicy: "immediate", reason: "x" })`; assert `status 409` and `body.code`. Reuse the `createPublishedPlan` helper from the platform tenants test (copy it).
2. `assign add-on to none tenant → 409` with the same code (`createPublishedAddon` helper, `POST /subscription/addons`, body `{ catalogVersionId, activationPolicy: "immediate", quantity: 1, reason: "x", expectedSubscriptionId: randomUUID() }`; the guard must fire before the subscription lookup, so the code is the offline code, not `subscription_target_missing`).
3. `offer with a plan line for a none tenant → 409` — `POST /platform/offers` with a plan line (copy a minimal valid offer body from `apps/api/test` offer tests: `grep -rn "platform/offers" apps/api/test | head`), code `catalog_kind_not_allowed_for_offline_tenant`.
4. `offer with only a service line (no catalogVersionId) for a none tenant → 201`.
5. `invoice with a plan line for a none tenant → 409` and `invoice with a service line → 201` (copy a valid `POST /platform/invoices` body from the existing invoice e2e tests).
6. `the same plan assignment for an enabled tenant is unaffected` — create an enabled tenant via `POST /platform/tenants` and assert 201.
7. cross-tenant: after a refusal on the `none` tenant, an unrelated enabled tenant's subscription list is unchanged (no rows created for the `none` tenant either: `select count(*) from tenant_subscriptions where tenant_id = <none>` is `0`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/api exec vitest run test/tenant-cabinet-access-guard.e2e.test.ts`
Expected: FAIL (cases 1, 2, 3, 5 return 2xx or other codes). Run `pnpm --filter @markiro/db build && pnpm --filter @markiro/platform-contracts build` first if the API cannot see the new column.

- [ ] **Step 3: Implement the guard**

Create `apps/api/src/subscriptions/tenant-cabinet-access.ts`:

```ts
import { ConflictException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

export const OFFLINE_TENANT_KIND_ERROR = "catalog_kind_not_allowed_for_offline_tenant";

/**
 * A tenant created without a cabinet may only order services. Licences (plan,
 * add-on) grant entitlements to a cabinet that does not exist for it. Callers
 * run this inside the transaction that writes, so a concurrent grant of the
 * cabinet cannot slip a licence in between check and write.
 */
export async function assertKindAllowedForTenant(
  tx: Pick<Db, "select">,
  tenantId: string,
  kind: "plan" | "addon" | "service",
): Promise<void> {
  if (kind === "service") return;
  const [tenant] = await tx
    .select({ cabinetAccess: schema.organization.cabinetAccess })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId))
    .limit(1);
  if (tenant?.cabinetAccess === "none") {
    throw new ConflictException({ code: OFFLINE_TENANT_KIND_ERROR });
  }
}
```

`subscription-lifecycle.service.ts`: import the helper and, immediately **before** `await requireTenant(tx, tenantId);` in `assignPlanInTransaction`, add `await assertKindAllowedForTenant(tx, tenantId, "plan");`; likewise `"addon"` in `assignAddonInTransaction`. `requireTenant` still produces `tenant_not_found` for a missing tenant: the guard returns silently when the row is absent, so that order is safe. `applyPaidLicense` reaches both methods, which protects the payment route as a last resort.

`platform-offer-draft.ts`: in `prepareOfferDraft`, at the top of the `for (const line of input.lines)` body add:

```ts
    await assertKindAllowedForTenant(tx, input.tenantId, line.kind);
```
`tx` there is `Pick<Db, "select">`, which matches the helper.

`billing.service.ts` (`create`): after the tenant is found and before `assertCommercialPlanSequence(invoiceLines)`, add:

```ts
      for (const line of invoiceLines) {
        await assertKindAllowedForTenant(tx, normalizedInput.tenantId, line.kind);
      }
```
Check that `invoiceLines` items expose `kind`; if the source-offer variant uses another property name, use the one `assertCommercialPlanSequence` reads.

- [ ] **Step 4: Run tests**

Run:
```bash
pnpm --filter @markiro/api exec vitest run test/tenant-cabinet-access-guard.e2e.test.ts
pnpm --filter @markiro/api exec vitest run test/platform-tenants.e2e.test.ts
pnpm --filter @markiro/api typecheck
```
Expected: PASS; the second command proves enabled tenants are unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/subscriptions apps/api/src/modules/platform-offers/platform-offer-draft.ts apps/api/src/modules/billing/billing.service.ts apps/api/test/tenant-cabinet-access-guard.e2e.test.ts
git commit -m "feat(api): refuse licences for tenants without a cabinet"
```

---

### Task 4: Provision a tenant without a cabinet

**Files:**
- Modify: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts`
- Modify: `apps/api/src/modules/platform-tenants/platform-tenants.service.ts` (`renewActivation`)
- Modify: `apps/api/src/cli/provision-tenant-owner.ts` (types only, if `tsc` requires)
- Test: `apps/api/test/provision-tenant-owner.e2e.test.ts` (new `describe` cases in the existing suite, plus cleanup patterns for the new slug prefix `offline-tenant-%`)

**Interfaces:**
- Consumes: `ProvisionTenantDto` with `cabinetAccess` and optional `email` (Task 2).
- Produces:
  - `TenantProvisioningResult { tenantId: string; userId: string | null; memberId: string | null; deliveryId: string | null }`
  - `provision()` behavior for `cabinetAccess: "none"` and the `tenant_cabinet_access_mismatch` conflict.

- [ ] **Step 1: Write failing tests** in `provision-tenant-owner.e2e.test.ts` (inside the existing `describe`; reuse `provisionTenantOwner`, `MailDeliveryService`, `connection`, `defaultDemo`). Add `like(schema.organization.slug, "offline-tenant-%")` to the `afterAll` tenant cleanup.

```ts
  it("creates a tenant without cabinet: no owner, mail, token or subscription, and needs no demo", async () => {
    // No default demo installed on purpose.
    const suffix = crypto.randomUUID();
    const tenantSlug = `offline-tenant-${suffix}`;
    const mail = new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x72)), () =>
      crypto.randomUUID(),
    );
    const actor = {
      userId: crypto.randomUUID(),
      role: "platform_admin",
    } as const;
    const input = { tenantName: "Офлайн завод", tenantSlug, cabinetAccess: "none" } as const;
    const result = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input,
      actor: { ...actor, capabilities: platformCapabilitiesForRole("platform_admin") },
    });
    expect(result).toEqual({
      tenantId: expect.any(String),
      userId: null,
      memberId: null,
      deliveryId: null,
    });

    const [org] = await connection.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, result.tenantId));
    expect(org).toMatchObject({ slug: tenantSlug, cabinetAccess: "none" });
    expect(
      await connection.db
        .select()
        .from(schema.member)
        .where(eq(schema.member.organizationId, result.tenantId)),
    ).toEqual([]);
    expect(
      await connection.db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId)),
    ).toEqual([]);
    expect(
      await connection.db
        .select()
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.sourceId, `tenant-owner:${result.tenantId}`)),
    ).toEqual([]);
    // Stock rows are still seeded.
    expect(
      (
        await connection.db
          .select()
          .from(schema.orgProfiles)
          .where(eq(schema.orgProfiles.tenantId, result.tenantId))
      ).length,
    ).toBe(1);

    const audit = await connection.db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.tenantId, result.tenantId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorPlatformUserId: actor.userId,
      actorRole: "platform_admin",
      action: "platform.tenant.created",
      outcome: "success",
      targetType: "tenant",
      targetId: result.tenantId,
      reason: null,
      before: null,
      after: { cabinetAccess: "none", subscriptionStatus: "none", planVersionId: null },
    });
    const tenantAudit = await connection.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, result.tenantId));
    expect(tenantAudit).toEqual([]);

    // Idempotent retry returns the same tenant.
    await expect(
      provisionTenantOwner({
        db: connection.db,
        mail,
        adminOrigin: "https://cabinet.example.test",
        input,
      }),
    ).resolves.toEqual(result);
  });

  it("refuses to reuse a slug with a different cabinet access", async () => {
    const suffix = crypto.randomUUID();
    const tenantSlug = `offline-tenant-${suffix}`;
    const mail = new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x73)), () =>
      crypto.randomUUID(),
    );
    await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input: { tenantName: "Офлайн", tenantSlug, cabinetAccess: "none" },
    });
    await expect(
      provisionTenantOwner({
        db: connection.db,
        mail,
        adminOrigin: "https://cabinet.example.test",
        input: {
          tenantName: "Офлайн",
          tenantSlug,
          cabinetAccess: "enabled",
          email: `mismatch-${suffix}@example.com`,
        },
      }),
    ).rejects.toMatchObject({ response: { code: "tenant_cabinet_access_mismatch" } });
  });
```

Imports to add: `platformCapabilitiesForRole` from `../src/platform-auth/platform-access-policy`. Check the actual field names of `PlatformPrincipal` there and match them in `actor`. Also update existing assertions in this file that compare the result shape only if they fail (the enabled path is unchanged).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/api exec vitest run test/provision-tenant-owner.e2e.test.ts`
Expected: the two new tests FAIL; the old ones PASS.

- [ ] **Step 3: Refactor — extract the owner block into `provisionOwner`**

In `tenant-provisioning.service.ts`:

1. Change the result type:

```ts
export interface TenantProvisioningResult {
  tenantId: string;
  userId: string | null;
  memberId: string | null;
  deliveryId: string | null;
}
```

2. Move, **verbatim and in order**, everything in `provisionInTransaction` from `let [user] = await tx.select(...)` through the end of the `if (!deliveryId) { ... }` block (user lookup/creation, the member checks, `userProfiles`, the `member` insert with its `tenant.owner.provisioned` tenant audit, the delivery lookup, the whole `renewActivation` branch, and the token/mail block) into a new private method:

```ts
  private async provisionOwner(
    tx: ProvisionTransaction,
    ctx: {
      tenantId: string;
      tenantName: string;
      email: string;
      operationAt: Date;
      createId: () => string;
      createToken: () => string;
      options: TenantProvisioningOptions;
    },
  ): Promise<{
    user: { id: string; emailVerified: boolean };
    memberId: string;
    deliveryId: string;
  }> {
    const { tenantId, tenantName, email, operationAt, createId, createToken, options } = ctx;
    // ...moved block, with `tenant.id` → `tenantId`, `input.email` → `email`,
    // `input.tenantName` → `tenantName`. Return at the end:
    return { user, memberId, deliveryId };
  }
```

`deliveryId` is `string | undefined` inside the moved code; after the `if (!deliveryId)` block it is always set, so end with `if (!deliveryId) throw new Error("tenant owner activation delivery missing");` before returning. `existingDelivery` is only used by the moved block plus the demo-independent audit, so nothing outside needs it.

3. In `provisionInTransaction`, after the tenant insert/lookup, branch:

```ts
    let owner: { user: { id: string }; memberId: string; deliveryId: string } | null = null;
    if (input.cabinetAccess === "enabled") {
      if (input.email === undefined) throw new Error("cabinet access enabled requires an e-mail");
      owner = await this.provisionOwner(tx, {
        tenantId: tenant.id,
        tenantName: input.tenantName,
        email: input.email,
        operationAt,
        createId,
        createToken,
        options,
      });
    }
```

4. The two advisory locks: take the `tenant-owner-email` lock only when `input.email !== undefined`; the slug lock always. Keep the order (email first, then slug).

5. Existing-tenant mismatch: change the tenant lookup to also select `cabinetAccess`, and right after it:

```ts
    if (tenant && tenant.cabinetAccess !== input.cabinetAccess) {
      throw new ConflictException({ code: "tenant_cabinet_access_mismatch" });
    }
```
On insert of a new organization set `cabinetAccess: input.cabinetAccess`.

6. Demo: `const demo = tenant || input.cabinetAccess === "none" ? null : await this.lockDefaultDemo(...)`. The later `if (tenantCreated && demo)` block is unchanged. Replace the `unmanaged` computation so a `none` tenant is not reported as unmanaged:

```ts
    if (tenantCreated) {
      const offline = input.cabinetAccess === "none";
      const unmanaged = !offline && demo === null;
      await this.audit.record(tx, {
        actorPlatformUserId: options.actor?.userId ?? null,
        actorRole: options.actor?.role ?? null,
        action: unmanaged ? "platform.tenant.created_unmanaged" : "platform.tenant.created",
        outcome: "success",
        tenantId: tenant.id,
        targetType: "tenant",
        targetId: tenant.id,
        reason: unmanaged ? "operator_allowed_unmanaged_without_default_demo" : null,
        before: null,
        after: {
          cabinetAccess: input.cabinetAccess,
          ownerUserId: owner?.user.id ?? null,
          ownerMemberId: owner?.memberId ?? null,
          subscriptionId,
          subscriptionStatus: offline ? "none" : unmanaged ? "unmanaged" : "pending_activation",
          planVersionId: demo?.versionId ?? null,
        },
        requestId: null,
      });
    }
    return {
      tenantId: tenant.id,
      userId: owner?.user.id ?? null,
      memberId: owner?.memberId ?? null,
      deliveryId: owner?.deliveryId ?? null,
    };
```

Existing audit assertions in this suite check `after` with `toMatchObject`/exact equality; if an exact `toEqual` now fails on the extra `cabinetAccess: "enabled"` key, update that expectation to include it.

- [ ] **Step 4: Fix the callers**

`platform-tenants.service.ts` `renewActivation`: the `provision` input needs `cabinetAccess: "enabled"`, and the result may now carry a null delivery:

```ts
    const result = await this.provisioning.provision(
      {
        email: owner.email,
        tenantName: owner.tenantName,
        tenantSlug: owner.tenantSlug,
        cabinetAccess: "enabled",
      },
      { actor, renewActivation: true },
    );
    if (result.deliveryId === null) throw new NotFoundException({ code: "tenant_owner_not_found" });
    return { deliveryId: result.deliveryId };
```

Run `pnpm --filter @markiro/api typecheck` and fix any other call site it reports (the CLI `parseProvisionTenantOwnerArgs` / `provisionTenantOwner` types: the CLI stays owner-only, so set `cabinetAccess: "enabled"` where it builds the input).

- [ ] **Step 5: Run tests**

Run:
```bash
pnpm --filter @markiro/api exec vitest run test/provision-tenant-owner.e2e.test.ts
pnpm --filter @markiro/api exec vitest run test/platform-tenants.e2e.test.ts test/tenant-owner-activation.e2e.test.ts
pnpm --filter @markiro/api typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test/provision-tenant-owner.e2e.test.ts
git commit -m "feat(api): provision tenants without a cabinet"
```

---

### Task 5: Expose `cabinetAccess` in list and detail

**Files:**
- Modify: `apps/api/src/modules/platform-tenants/platform-tenants.service.ts` (`list`, `get`, `TenantListRow`)
- Test: `apps/api/test/platform-tenants.e2e.test.ts`, `apps/api/test/platform-tenants.contract.test.ts`

**Interfaces:**
- Consumes: contract fields from Task 2.
- Produces: list items and `detail.tenant` include `cabinetAccess`; `ownerActivation` is `null` for `none` tenants.

- [ ] **Step 1: Write failing tests**

In `platform-tenants.contract.test.ts`, add `cabinetAccess: "enabled"` to the fixture item in the existing "parses service results" test and add a second assertion that an item without it fails to parse:

```ts
    expect(() =>
      parsePlatformResponse(platformTenantContracts.list.response, {
        items: [{ id: "legacy_better_auth_org", name: "X", slug: "x", createdAt: "2026-08-11T18:08:42.158Z", subscriptionStatus: "unmanaged" }],
        page: 1,
        limit: 50,
        total: 1,
      }),
    ).toThrow();
```

In `platform-tenants.e2e.test.ts` add:

```ts
  it("creates a none tenant through the API and shows it as cabinet-less", async () => {
    const tenantSlug = `offline-api-${randomUUID()}`;
    const created = await admin
      .post("/platform/tenants")
      .send({ tenantName: "Offline API", tenantSlug, cabinetAccess: "none" })
      .expect(201);
    expect(created.body).toEqual({
      tenantId: expect.any(String),
      userId: null,
      memberId: null,
      deliveryId: null,
    });
    const detail = await admin
      .get(`/platform/tenants/${created.body.tenantId}`)
      .set("X-Markiro-Commercial-Version", "3")
      .expect(200);
    expect(detail.body.tenant).toMatchObject({ slug: tenantSlug, cabinetAccess: "none" });
    expect(detail.body.ownerActivation).toBeNull();
    expect(detail.body.subscriptionStatus).toBe("unmanaged");
    const list = await admin
      .get("/platform/tenants?limit=100")
      .set("X-Markiro-Commercial-Version", "3")
      .expect(200);
    expect(
      list.body.items.find((item: { id: string }) => item.id === created.body.tenantId),
    ).toMatchObject({ cabinetAccess: "none" });
  });

  it("rejects a cabinet-less tenant with an e-mail and an enabled one without", async () => {
    await admin
      .post("/platform/tenants")
      .send({ tenantName: "Bad", tenantSlug: `bad-${randomUUID()}`, cabinetAccess: "none", email: "a@b.co" })
      .expect(400);
    await admin
      .post("/platform/tenants")
      .send({ tenantName: "Bad", tenantSlug: `bad-${randomUUID()}` })
      .expect(400);
  });

  it("returns owner_not_found when renewing activation for a none tenant", async () => {
    const created = await admin
      .post("/platform/tenants")
      .send({ tenantName: "Offline renew", tenantSlug: `offline-renew-${randomUUID()}`, cabinetAccess: "none" })
      .expect(201);
    const renewed = await admin
      .post(`/platform/tenants/${created.body.tenantId}/owner-activation/renew`)
      .expect(404);
    expect(renewed.body.code).toBe("tenant_owner_not_found");
  });
```

Adapt the `X-Markiro-Commercial-Version` header value to what the neighbouring detail tests in this file use for the current version.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/api exec vitest run test/platform-tenants.contract.test.ts test/platform-tenants.e2e.test.ts`
Expected: FAIL (`cabinetAccess` missing / response parse errors).

- [ ] **Step 3: Implement**

`list`: add `organization.cabinet_access as "cabinetAccess",` to the select, `cabinetAccess: "enabled" | "none";` to `TenantListRow`, and `cabinetAccess: row.cabinetAccess,` to each mapped item.

`get`: add `cabinetAccess: tenant.cabinetAccess,` to the `tenant` object of the response. `ownerActivation` already resolves to `null` when there is no owner member.

- [ ] **Step 4: Run tests**

Run:
```bash
pnpm --filter @markiro/api exec vitest run test/platform-tenants.contract.test.ts test/platform-tenants.e2e.test.ts
pnpm --filter @markiro/api typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/platform-tenants/platform-tenants.service.ts apps/api/test/platform-tenants.contract.test.ts apps/api/test/platform-tenants.e2e.test.ts
git commit -m "feat(api): expose cabinet access in tenant list and detail"
```

---

### Task 6: Grant the cabinet later

**Files:**
- Modify: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` (`grantCabinetAccess`)
- Modify: `apps/api/src/modules/platform-tenants/platform-tenants.service.ts` (wrapper)
- Modify: `apps/api/src/modules/platform-tenants/platform-tenants.controller.ts` (route), `dto.ts` (re-exports)
- Modify: `apps/api/test/platform-route-contracts.ts`, `apps/api/test/subscription-route-inventory.test.ts`, `apps/api/test/platform-contract-openapi.test.ts` (whichever lists platform routes: find with `grep -rn "owner-activation/renew" apps/api/test`)
- Test: `apps/api/test/grant-cabinet-access.e2e.test.ts`

**Interfaces:**
- Consumes: `provisionOwner` (Task 4), `grantCabinetAccessSchema` / contract entry (Task 2).
- Produces:
  - `TenantProvisioningService.grantCabinetAccess(tenantId: string, input: GrantCabinetAccessDto, options: { actor: PlatformPrincipal; now?: () => Date; createId?: () => string; createToken?: () => string }): Promise<{ tenantId: string; userId: string; memberId: string; deliveryId: string }>`
  - `POST /platform/tenants/:id/cabinet-access`, capabilities `tenants.write`, status 201.
  - Errors: `tenant_not_found` (404), `cabinet_access_already_enabled` (409), plus `tenant_first_owner_conflict` from `provisionOwner`.

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/test/grant-cabinet-access.e2e.test.ts` with the same bootstrap and helper copies as Task 3 (admin, accountant and support agents). Cases:

1. **Grant succeeds.** Create a `none` tenant through `POST /platform/tenants`, then `POST /platform/tenants/${id}/cabinet-access` with `{ email: `granted-${randomUUID()}@example.com` }` as admin → 201 with `{ tenantId, userId, memberId, deliveryId }` all non-null. Then assert with `setup.db`:
   - `organization.cabinetAccess` is `"enabled"`;
   - one `member` row `{ organizationId: id, userId, role: "owner" }`;
   - one `emailDeliveries` row `{ kind: "tenant-owner-activation", sourceId: `tenant-owner:${id}`, userId }`;
   - no `tenant_subscriptions` row for the tenant (no retroactive demo); **superseded:** exactly one `pending_activation` demo subscription and one `demo.provisioned` event (see the spec);
   - platform audit: exactly one row with `action: "platform.tenant.cabinet_access.granted"`, `actorPlatformUserId: adminId`, `actorRole: "platform_admin"`, `outcome: "success"`, `tenantId: id`, `targetType: "member"`, `targetId: memberId`, `before: { cabinetAccess: "none" }`, `after: { cabinetAccess: "enabled", ownerUserId: userId, deliveryId }`;
   - tenant audit: one `tenant.owner.provisioned` row for the member (`actorUserId: null`, `outcome: "success"`, `targetType: "member"`, `targetId: memberId`).
2. **Detail after grant** shows `tenant.cabinetAccess: "enabled"` and a non-null `ownerActivation` with the e-mail; `POST .../owner-activation/renew` now returns 200.
3. **Already enabled → 409** `cabinet_access_already_enabled`, for both an originally enabled tenant and after a first successful grant (second call).
4. **Unknown tenant → 404** `tenant_not_found`.
5. **Accountant → 403**, support → 403 (support has no `tenants.write`); assert nothing changed in the DB for the tenant. **Corrected:** support holds `tenants.write` and may grant (201); only the accountant is refused.
6. **Invalid body → 400** (`{}` and `{ email: "not-an-email" }` and an extra key).
7. **E-mail already an owner of another tenant is allowed only through the existing rules:** create an enabled tenant with e-mail X, then grant X to a `none` tenant → this must succeed exactly as provisioning a second tenant for the same e-mail does today. Check the existing behaviour in `provision-tenant-owner.e2e.test.ts` (search `tenant_owner_email_conflict`); if the existing rule rejects it, assert that same code instead.
8. **Concurrency:** two simultaneous grants with different e-mails for the same `none` tenant → exactly one 201 and one 409 `cabinet_access_already_enabled`; exactly one owner `member` row exists.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/api exec vitest run test/grant-cabinet-access.e2e.test.ts`
Expected: FAIL (404 route missing).

- [ ] **Step 3: Implement `grantCabinetAccess`**

In `tenant-provisioning.service.ts` add:

```ts
  async grantCabinetAccess(
    tenantId: string,
    input: GrantCabinetAccessDto,
    options: {
      actor: PlatformPrincipal;
      now?: () => Date;
      createId?: () => string;
      createToken?: () => string;
    },
  ): Promise<GrantCabinetAccessResult> {
    return this.db.transaction(async (tx) => {
      const operationAt = (options.now ?? (() => new Date()))();
      const createId = options.createId ?? randomUUID;
      const createToken = options.createToken ?? (() => randomBytes(24).toString("base64url"));

      const [located] = await tx
        .select({ slug: schema.organization.slug })
        .from(schema.organization)
        .where(eq(schema.organization.id, tenantId))
        .limit(1);
      if (!located) throw new NotFoundException({ code: "tenant_not_found" });

      // Same lock order as provisioning: normalized e-mail, then slug.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-email:${input.email}`}, 0))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-slug:${located.slug}`}, 0))`,
      );
      const [tenant] = await tx
        .select({
          id: schema.organization.id,
          name: schema.organization.name,
          cabinetAccess: schema.organization.cabinetAccess,
        })
        .from(schema.organization)
        .where(eq(schema.organization.id, tenantId))
        .for("update") // executed as .for("no key update"), see the spec
        .limit(1);
      if (!tenant) throw new NotFoundException({ code: "tenant_not_found" });
      if (tenant.cabinetAccess !== "none") {
        throw new ConflictException({ code: "cabinet_access_already_enabled" });
      }

      const owner = await this.provisionOwner(tx, {
        tenantId,
        tenantName: tenant.name,
        email: input.email,
        operationAt,
        createId,
        createToken,
        options: { actor: options.actor },
      });
      await tx
        .update(schema.organization)
        .set({ cabinetAccess: "enabled" })
        .where(eq(schema.organization.id, tenantId));
      await this.audit.record(tx, {
        actorPlatformUserId: options.actor.userId,
        actorRole: options.actor.role,
        action: "platform.tenant.cabinet_access.granted",
        outcome: "success",
        tenantId,
        targetType: "member",
        targetId: owner.memberId,
        reason: null,
        before: { cabinetAccess: "none" },
        after: {
          cabinetAccess: "enabled",
          ownerUserId: owner.user.id,
          deliveryId: owner.deliveryId,
        },
        requestId: null,
      });
      return {
        tenantId,
        userId: owner.user.id,
        memberId: owner.memberId,
        deliveryId: owner.deliveryId,
      };
    });
  }
```

Import `NotFoundException` from `@nestjs/common` and the `GrantCabinetAccessDto` / `GrantCabinetAccessResult` types from `@markiro/platform-contracts`. `provisionOwner` writes the `tenant.owner.provisioned` tenant audit itself (moved code), so it is not repeated here.

`platform-tenants.service.ts`:

```ts
  async grantCabinetAccess(
    actor: PlatformPrincipal,
    tenantId: string,
    input: GrantCabinetAccessDto,
  ): Promise<GrantCabinetAccessResult> {
    return platformTenantContracts.grantCabinetAccess.response.parse(
      await this.provisioning.grantCabinetAccess(tenantId, input, { actor }),
    );
  }
```

`dto.ts`: add `grantCabinetAccessSchema` to the value re-exports and `GrantCabinetAccessDto` to the type re-exports.

`platform-tenants.controller.ts`, after `renewActivation`:

```ts
  @Post(":id/cabinet-access")
  @ApiOperation({
    summary: "Grant cabinet access to a tenant created without one",
    description:
      "Creates the owner account, sends the activation link and switches the tenant to cabinet_access=enabled. No demo is created.",
  })
  @PlatformApiProtectedCreated({
    body: platformTenantContracts.grantCabinetAccess.body,
    response: platformTenantContracts.grantCabinetAccess.response,
  })
  @RequirePlatformCapabilities("tenants.write")
  async grantCabinetAccess(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(tenantReferenceSchema)) id: string,
    @Body(new ZodValidationPipe(grantCabinetAccessSchema)) body: GrantCabinetAccessDto,
  ) {
    return parsePlatformResponse(
      platformTenantContracts.grantCabinetAccess.response,
      await this.tenants.grantCabinetAccess(request.platformPrincipal!, id, body),
    );
  }
```
with the new imports from `./dto`. Confirm in `platform-access-policy.ts` that `accountant` lacks `tenants.write` (the create route relies on the same); if the create route has an extra role check elsewhere, mirror it.

- [ ] **Step 4: Update the route inventories**

Run `grep -rn "owner-activation/renew" apps/api/test` and add the new route next to it in every list found (`platform-route-contracts.ts` via its `route("post", "/platform/tenants/{id}/cabinet-access", "201", ...)` helper in the same style as the neighbours; the subscription inventory and OpenAPI tests follow whatever pattern the renew route uses).

- [ ] **Step 5: Run tests**

Run:
```bash
pnpm --filter @markiro/api exec vitest run test/grant-cabinet-access.e2e.test.ts
pnpm --filter @markiro/api exec vitest run test/subscription-route-inventory.test.ts test/platform-contract-openapi.test.ts
pnpm --filter @markiro/api typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): grant cabinet access to a tenant created without one"
```

---

### Task 7: saas-admin — API client, create form, tenant card, badge

**Files:**
- Modify: `apps/saas-admin/src/pages/tenants/api.ts`, `errorMessages.ts`, `CreateTenantPanel.tsx`, `TenantPage.tsx`, `TenantsPage.tsx`
- Create: `apps/saas-admin/src/pages/tenants/GrantCabinetAccessPanel.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`, `en.json`
- Modify: test fixtures that build a tenant list item or detail (`apps/saas-admin/test/*`, e.g. `grep -rln "subscriptionStatus" apps/saas-admin/test`): add `cabinetAccess: "enabled"` (list items: top level; detail: inside `tenant`)
- Test: `apps/saas-admin/test/tenants-cabinet-access.test.tsx`

**Interfaces:**
- Consumes: contracts from Task 2; route from Task 6.
- Produces: `grantCabinetAccess(tenantId: string, input: GrantCabinetAccessInput)` in `api.ts`; `<GrantCabinetAccessPanel tenantId canGrant />`.

- [ ] **Step 1: Look at an existing page test for the harness**

Read `apps/saas-admin/test/entitlements.test.tsx` (or the closest tenant-page test: `grep -ln "TenantPage\|CreateTenantPanel" apps/saas-admin/test`) and copy its render helper (router, query client, principal provider, fetch mock). Write the new test file with that helper.

- [ ] **Step 2: Write failing tests** in `apps/saas-admin/test/tenants-cabinet-access.test.tsx`

Cases, with `getByRole`/`findByText` on RU strings from `ru.json` (use `t` keys via the same i18n setup the other tests use):

1. **Create form, switch on (default):** the e-mail field is visible; submitting without e-mail shows the `email` validation message.
2. **Create form, switch off:** the e-mail field disappears, the demo notice is replaced by the offline notice, and submit posts `{ tenantName, tenantSlug, cabinetAccess: "none" }` (assert the mocked fetch body has no `email` key), then navigates to `/tenants/<id>`.
3. **Tenant card for a `none` tenant:** shows "Кабинет не выдан", does **not** render the owner-activation block or `SubscriptionPanel`, shows the "no platform mail" notice, and shows the grant button only with `tenants.write` and a role other than accountant.
4. **Grant flow:** click the button, enter an e-mail, submit; the mocked `POST /tenants/:id/cabinet-access` receives `{ email }`; the tenant query is invalidated (assert the second `GET /tenants/:id` call).
5. **Grant error mapping:** a 409 `cabinet_access_already_enabled` shows the mapped message.
6. **List badge:** a `none` row renders the text badge "Без кабинета" (text, not colour only).

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/tenants-cabinet-access.test.tsx`
Expected: FAIL. Build first if consumers cannot resolve the new contract exports: `pnpm turbo run build --filter='@markiro/saas-admin^...'`.

- [ ] **Step 4: Implement**

`api.ts`: import `grantCabinetAccessSchema`, type `GrantCabinetAccessInput`, and add

```ts
export async function grantCabinetAccess(tenantId: string, input: GrantCabinetAccessInput) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  const validated = grantCabinetAccessSchema.parse(input);
  return platformApiFetch(`/tenants/${validatedId}/cabinet-access`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformTenantContracts.grantCabinetAccess.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}
```
(import `platformTenantContracts` from `@markiro/platform-contracts`). Export `CreateTenantInput` as today; the create response schema is now nullable, and `createTenant`'s `responseSchema` already comes from `platformTenantV3Contracts.create.response`.

`errorMessages.ts`: change `TenantOperation` to include `"grant"`; add

```ts
const GRANT_ERROR_KEYS: Readonly<Record<string, string>> = {
  cabinet_access_already_enabled: "tenants.errors.cabinet_access_already_enabled",
  tenant_first_owner_conflict: "tenants.errors.tenant_first_owner_conflict",
  tenant_owner_email_conflict: "tenants.errors.tenant_owner_email_conflict",
  tenant_email_conflict: "tenants.errors.tenant_email_conflict",
};
```
add `grant: "tenants.errors.grant_failed"` to `FALLBACK_KEYS`, and route `operation === "grant"` to `GRANT_ERROR_KEYS` in `tenantErrorMessageKey`. Add `tenant_cabinet_access_mismatch: "tenants.errors.tenant_cabinet_access_mismatch"` to `CREATE_ERROR_KEYS`.

`CreateTenantPanel.tsx`: default values `{ tenantName: "", tenantSlug: "", email: "", cabinetAccess: "enabled" }`. Because the schema now rejects `email: ""` for `none` and treats `""` as an invalid address for `enabled`, convert on submit and hide the field:

```tsx
  const cabinetAccess = form.watch("cabinetAccess");
  // ...
  const submit = form.handleSubmit(async (values) => {
    setSubmitErrorKey(null);
    const { email, ...rest } = values;
    const payload: CreateTenantInput =
      rest.cabinetAccess === "none" ? rest : { ...rest, email: email ?? "" };
    // create.mutateAsync(payload) ...
```
Add a labelled switch (use the `Switch`/`Checkbox` component that `@markiro/ui` already exports; find it with `grep -n "export" packages/ui/src/index.ts | grep -i "switch\|checkbox"`) bound with `form.setValue("cabinetAccess", checked ? "enabled" : "none", { shouldDirty: true })`; when switching to `none`, also `form.setValue("email", "")` and `form.clearErrors("email")`. Render the e-mail `Input` only when `cabinetAccess === "enabled"`. The `SectionHeader` description is `t(cabinetAccess === "enabled" ? "tenants.createForm.demoNotice" : "tenants.createForm.offlineNotice")`, the submit label `t(cabinetAccess === "enabled" ? "tenants.createForm.submit" : "tenants.createForm.submitOffline")`. Add `emailNotAllowed` to the `validationMessage` keys (`tenants.createForm.validation.emailNotAllowed`). Because `zodResolver` runs on the form values, register the schema's `email: ""` handling by passing `email: undefined` when `none`: set `defaultValues.email` to `undefined` only after the toggle by calling `form.unregister("email")` when the field is hidden, so the resolver sees no key.

`TenantsPage.tsx`: in the status column render, when `item.cabinetAccess === "none"` add after the chip:

```tsx
<StatusChip phase="none" label={t("tenants.cabinet.none")} />
```
(the `none` phase is grey and its label carries the meaning, so it is not colour-only).

`TenantPage.tsx`:
- Replace the `owner-activation` `<section>` with a conditional: when `detail.tenant.cabinetAccess === "none"` render `<GrantCabinetAccessPanel tenantId={detail.tenant.id} canGrant={canGrant} />` where `const canGrant = principal.role !== "accountant" && principal.capabilities.includes("tenants.write");`; otherwise keep the existing block untouched.
- Render `<SubscriptionPanel ... />` only when `cabinetAccess === "enabled"`; for `none` render `<Alert tone="info">{t("tenants.detail.offline.documentsNotice")}</Alert>` instead (text: platform sends no documents; the operator downloads and sends them).
- Do not show the `pendingActivation` alert for `none` (its status is `unmanaged`, so it already does not).

`GrantCabinetAccessPanel.tsx`: a section with heading `tenants.detail.offline.title` ("Кабинет не выдан"), explanatory text, and, if `canGrant`, a button opening an inline form (single `Input` e-mail, `Button` submit, cancel) built with `react-hook-form` + `zodResolver(grantCabinetAccessSchema)` (export the schema from `api.ts` as `grantCabinetAccessInputSchema`). On success invalidate `["platform","tenants",tenantId]` and `["platform","tenants"]`; on error show `t(tenantErrorMessageKey("grant", error))`. Keep the same `useUnsavedChanges(form.formState.isDirty, mutation.isPending)` guard as `CreateTenantPanel`.

i18n (both files): add under `tenants`:
- `createForm.cabinetAccess` ("Доступ в кабинет" / "Cabinet access"), `createForm.cabinetAccessHint`, `createForm.offlineNotice` ("Тенант без кабинета: владелец, письмо активации и демо не создаются. Лицензии недоступны, только услуги. Счета и акты вы отправляете вручную." / EN equivalent), `createForm.submitOffline` ("Создать тенант без кабинета"), `createForm.validation.emailNotAllowed`.
- `cabinet.none` ("Без кабинета" / "No cabinet").
- `detail.offline.title` ("Кабинет не выдан"), `detail.offline.body`, `detail.offline.grant` ("Выдать доступ в кабинет"), `detail.offline.email` ("Email владельца"), `detail.offline.submit` ("Выдать и отправить активацию"), `detail.offline.granted` ("Доступ выдан, письмо активации поставлено в очередь."), `detail.offline.documentsNotice`.
- `errors.cabinet_access_already_enabled`, `errors.tenant_cabinet_access_mismatch`, `errors.grant_failed`.

Keep key sets identical in both files (the repo has an i18n parity test: run it in Step 5).

- [ ] **Step 5: Run tests**

Run:
```bash
pnpm --filter @markiro/saas-admin exec vitest run test/tenants-cabinet-access.test.tsx
pnpm --filter @markiro/saas-admin test
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
```
Expected: PASS. Fix fixtures that fail only on the missing `cabinetAccess`.

- [ ] **Step 6: Commit**

```bash
git add apps/saas-admin
git commit -m "feat(saas-admin): create tenants without cabinet and grant it later"
```

---

### Task 8: Offer editor — create the tenant inline

**Files:**
- Create: `apps/saas-admin/src/pages/offers/CreateOfflineTenantDialog.tsx`
- Modify: `apps/saas-admin/src/pages/offers/CreateOfferPage.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`, `en.json`
- Test: `apps/saas-admin/test/offer-create-offline-tenant.test.tsx`

**Interfaces:**
- Consumes: `createTenant` (Task 7, sends `cabinetAccess: "none"`).
- Produces: `<CreateOfflineTenantDialog onCreated={(tenantId: string) => void} />`, shown only with `tenants.write` (and never for role `accountant`) and only when the page has no `requestId` (a request-bound offer has a locked tenant).

- [ ] **Step 1: Write the failing test**

Reuse the harness of `apps/saas-admin/test/offer-editor.test.tsx`. Cases:

1. With `tenants.write` and `billing.write`, the offer page shows a "Создать тенанта без кабинета" button; without `tenants.write` it does not; with `requestId` route it does not.
2. Submitting name and slug posts `{ tenantName, tenantSlug, cabinetAccess: "none" }` to `/tenants` (assert body has no `email`), then the page navigates to `/offers/new?tenantId=<newId>` and the tenant list query is invalidated.
3. A 409 error from create shows the mapped message from `tenantErrorMessageKey("create", error)` and keeps the dialog open.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/offer-create-offline-tenant.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`CreateOfflineTenantDialog.tsx` — a small dialog (reuse the dialog primitive `CreateOfferPage`/other pages already use from `@markiro/ui`, e.g. `ConfirmDialog` is confirm-only, so look for `Dialog`/`Modal` in `packages/ui/src/index.ts`; if none fits, render an inline `Card` toggled by the button) with `react-hook-form` and this schema:

```ts
const offlineTenantSchema = createTenantInputSchema; // from ../tenants/api.js, used as-is
// defaultValues: { tenantName: "", tenantSlug: "", cabinetAccess: "none" as const }
```
Fields: name `Input`, slug `Input` (`mono`). Submit calls `createTenant(values)`; success → `await queryClient.invalidateQueries({ queryKey: ["platform", "tenants"] })` then `onCreated(created.tenantId)`. Errors: `t(tenantErrorMessageKey("create", error))`.

`CreateOfferPage.tsx`: render, above `<DocumentComposer />` and only when `requestId === undefined` and the principal has `tenants.write` and role is not `accountant` (use `usePlatformPrincipal` as `CreateTenantPanel` does):

```tsx
<CreateOfflineTenantDialog
  onCreated={(tenantId) => void navigate(`/offers/new?tenantId=${tenantId}`, { replace: true })}
/>
```
The page already derives `selectedTenantId` from `?tenantId=` and prefetches a tenant that is not in the first list page, so the new tenant is preselected without touching `DocumentComposer`.

i18n: `offers.createOfflineTenant.button` ("Создать тенанта без кабинета" / "Create tenant without cabinet"), `.title`, `.hint` ("Владелец, письмо и демо не создаются; реквизиты заполните в карточке тенанта." / EN), `.submit`.

- [ ] **Step 4: Run tests**

Run:
```bash
pnpm --filter @markiro/saas-admin exec vitest run test/offer-create-offline-tenant.test.tsx test/offer-editor.test.tsx
pnpm --filter @markiro/saas-admin test
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/saas-admin
git commit -m "feat(saas-admin): create a tenant without cabinet from the offer editor"
```

---

### Task 9: Notification behaviour, docs and final gates

**Files:**
- Test: `apps/api/test/tenant-billing-notifications.service.test.ts` (one new case)
- Modify: `docs/superpowers/specs/2026-09-29-tenants-without-cabinet-design.md` (status line) and `docs/architecture.md` only if it states that every tenant has an owner (`grep -n "owner" docs/architecture.md`)
- Run: repo gates

- [ ] **Step 1: Pin the "no recipients" behaviour**

Add a case to `tenant-billing-notifications.service.test.ts`, in the style of its neighbours, where a tenant has zero `member` rows: the service enqueues nothing and does not throw. Run it: it should already PASS (it documents existing behaviour). If it fails, the notification path needs a guard before the release; fix it minimally in `tenant-billing-notifications.service.ts` and keep the test.

Run: `pnpm --filter @markiro/api exec vitest run test/tenant-billing-notifications.service.test.ts`

- [ ] **Step 2: Docs**

Set the spec status to "implemented" only after Step 3 passes. If `docs/architecture.md` says a tenant always has an owner, add one sentence describing `cabinet_access = none`.

- [ ] **Step 3: Final gates** (load `.env` for DB-backed suites)

```bash
git diff --check
pnpm turbo lint typecheck test build --filter=@markiro/db --filter=@markiro/platform-contracts --filter=@markiro/api --filter=@markiro/saas-admin --concurrency=1 --force
pnpm format:check
```
Check `tools/ci/affected.mjs`: it already maps `packages/db`, `platform-contracts`, `apps/api` and `apps/saas-admin` changes to their jobs; no new surface was added, so no change is expected.

- [ ] **Step 4: Refresh the local graph**

Run: `graphify update .` (AST-only, skip silently if `graphify-out/graph.json` does not exist).

- [ ] **Step 5: Final report**

List: behaviour changed; areas changed; automated checks with results and any skipped DB-backed suites; not exercised — real mail delivery, a browser run of the saas-admin UI, and production migration on a large `organization` table (the `ADD COLUMN ... DEFAULT` is a metadata-only change on current Postgres versions; confirm the production major version).

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/tenant-billing-notifications.service.test.ts docs
git commit -m "test(api): pin no-recipient billing notifications for tenants without a cabinet"
```

---

## Self-Review

**Spec coverage**
- §1 data/contracts → Tasks 1, 2. Grant schemas in Task 2.
- §2 provisioning branch, no demo, audit `platform.tenant.created` with `cabinetAccess: none`, idempotent retry and mismatch → Task 4.
- §3 services only → Task 3 (lifecycle, offer, invoice). Billing-request lines: requests carry no catalog lines that activate licences; the payment route `applyPaidLicense` is covered because it goes through both lifecycle methods. Verify during Task 3 with `grep -n "catalogVersionId" apps/api/src/modules/platform-billing-requests/*.ts`; if requests hold catalog lines, add the same one-line guard there.
- §4 grant later → Task 6 (audit fields, lock order, no retroactive demo, one-way).
- §5 saas-admin → Tasks 7, 8 (switch, card, badge, catalog is not shown because `SubscriptionPanel` is hidden for `none`; offer/invoice catalog pickers are covered by the server guard, and the composer keeps showing all published items — see note below).
- §5 last bullet (operator sends documents by hand) → `documentsNotice` in Task 7, Task 9 test.
- Tests/verification → each task; external checks listed in Task 9 report.

**Known gap to raise at review, not silently decided:** the spec says catalog pickers show only `service` items for a `none` tenant. This plan enforces it on the server (Task 3) and hides the manual subscription panel (Task 7), but does not filter the `DocumentComposer` catalog list; an operator picking a plan gets a clear 409 instead. Filtering the composer needs the selected tenant's `cabinetAccess` inside `DocumentComposer` and is a small follow-up once Task 8 is in.

**Placeholder scan:** no TBD/TODO; steps that depend on facts I could not read (exact offer/invoice request bodies, `PlatformPrincipal` field names, UI switch component name, dialog primitive) name the exact `grep` that resolves them.

**Type consistency:** `cabinetAccess` (`"enabled" | "none"`) is used identically in schema, contracts, provisioning, list and detail; `TenantProvisioningResult` nullable fields match `createTenantResponseSchema`; `GrantCabinetAccessDto/Result` and `grantCabinetAccess(...)` names match across Tasks 2, 6, 7; error codes `catalog_kind_not_allowed_for_offline_tenant`, `cabinet_access_already_enabled`, `tenant_cabinet_access_mismatch` are spelled the same everywhere.
