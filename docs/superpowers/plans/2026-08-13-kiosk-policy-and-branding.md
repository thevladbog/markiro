# Kiosk Employee Policy and Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move kiosk limits and writeoff permission to tenant/employee policy, expose company branding to paired kiosks, and add the corresponding admin controls without breaking legacy kiosk queues.

**Architecture:** Add tenant- and employee-scoped policy tables plus tenant-owned logo metadata in Postgres. Cabinet APIs embed employee policy into the existing employee DTO and tenant settings into the organisation profile; kiosk bootstrap resolves the effective policy and a same-origin logo route. Admin reuses the current settings and employee side-panel patterns, while legacy `kiosks.dayLimitPerEmployee` remains readable for one transition release but no longer drives enforcement.

**Tech Stack:** PostgreSQL 17, Drizzle ORM, NestJS, Zod, Better Auth organisation records, S3-compatible object storage, Sharp, React 19, TanStack Query, React Hook Form, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-kiosk-self-service-redesign-design.md`

## Global Constraints

- Preserve tenant composite foreign keys and add cross-tenant denial tests.
- Keep `badgeDigest` plus legacy `badgeCode` compatibility unchanged.
- `canWriteoff` is independent from the employee limit mode and defaults to `false`.
- Tenant-off and employee-unlimited both bypass the numeric limit without deleting `dayLimit`.
- The UTC day boundary and the existing cross-kiosk split remain unchanged.
- Do not infer writeoff permission from the free-text employee role.
- A kiosk login must use a bundled Markiro logo when the company logo is absent, stale, broken, or offline.
- Logo processing accepts bounded single-frame JPEG/PNG/WebP input only; no SVG or external runtime URL.
- Use `@markiro/ui` tokens/components and the existing RU/EN i18n structure.
- Preserve unrelated `.pnpm-store/` worktree content.

---

### Task 1: Add tenant and employee pickup policy schema and migration

**Files:**

- Modify: `packages/db/src/schema/pickup.ts`
- Create: `packages/db/migrations/0036_kiosk_pickup_policy.sql`
- Create: `packages/db/migrations/meta/0036_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/test/pickup-schema.test.ts`
- Modify: `packages/db/test/runtime-migrate.test.ts`

**Interfaces:**

- Produces: `schema.pickupTenantPolicies`, `schema.employeePickupPolicies`, and enum `pickupLimitMode`.
- Produces row shape `{ limitMode: "limited" | "unlimited"; dayLimit: number; canWriteoff: boolean }` keyed by `(tenantId, employeeId)`.
- Migration seeds each tenant from the maximum active-kiosk legacy limit and seeds `can_writeoff=false`.

- [ ] **Step 1: Write failing schema and migration tests**

```ts
it("keeps one tenant-scoped pickup policy per employee", () => {
  const fks = getTableConfig(schema.employeePickupPolicies).foreignKeys;
  expect(fks).toHaveLength(1);
  expect(fks[0]!.reference().columns.map((column) => column.name)).toEqual([
    "tenant_id",
    "employee_id",
  ]);
  expect(fks[0]!.reference().foreignColumns.map((column) => column.name)).toEqual([
    "tenant_id",
    "id",
  ]);
});

it("rejects a non-positive employee day limit", async () => {
  await expect(
    db.insert(schema.employeePickupPolicies).values({
      tenantId,
      employeeId,
      limitMode: "limited",
      dayLimit: 0,
      canWriteoff: false,
    }),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/pickup-schema.test.ts test/runtime-migrate.test.ts
```

Expected: FAIL because `employeePickupPolicies` and migration `0036` do not exist.

- [ ] **Step 3: Add the Drizzle schema**

```ts
export const pickupLimitMode = pgEnum("pickup_limit_mode", ["limited", "unlimited"]);

export const pickupTenantPolicies = pgTable("pickup_tenant_policies", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id),
  limitsEnabled: boolean("limits_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const employeePickupPolicies = pgTable(
  "employee_pickup_policies",
  {
    tenantId: tenantId(),
    employeeId: uuid("employee_id").notNull(),
    limitMode: pickupLimitMode("limit_mode").notNull().default("limited"),
    dayLimit: integer("day_limit").notNull().default(5),
    canWriteoff: boolean("can_writeoff").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.employeeId] }),
    check("employee_pickup_policies_day_limit_check", sql`${t.dayLimit} > 0`),
    foreignKey({
      name: "employee_pickup_policies_tenant_employee_fk",
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }).onDelete("cascade"),
  ],
);
```

- [ ] **Step 4: Generate the migration, append the deterministic backfill, and confirm GREEN**

Run the generator once after the schema edit:

```bash
pnpm --filter @markiro/db db:generate --name kiosk_pickup_policy
```

Then append this seed rule to the generated `0036_kiosk_pickup_policy.sql`, not
to an already-applied earlier migration and not through a JavaScript loop:

```sql
INSERT INTO pickup_tenant_policies (tenant_id, limits_enabled)
SELECT o.id, EXISTS (
  SELECT 1 FROM kiosks k WHERE k.tenant_id = o.id AND k.status = 'active'
)
FROM organization o;

INSERT INTO employee_pickup_policies
  (tenant_id, employee_id, limit_mode, day_limit, can_writeoff)
SELECT e.tenant_id, e.id, 'limited',
       COALESCE((SELECT MAX(k.day_limit_per_employee)
                 FROM kiosks k
                 WHERE k.tenant_id = e.tenant_id AND k.status = 'active'), 5),
       false
FROM employees e;
```

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db exec vitest run test/pickup-schema.test.ts test/runtime-migrate.test.ts
```

Expected: PASS. Review generated SQL for both PKs, the positive check, cascade behavior, seed value, and journal entry; keep the numbered filename aligned with the branch's next migration number.

- [ ] **Step 5: Commit the schema slice**

```bash
git add packages/db/src/schema/pickup.ts packages/db/migrations/0036_kiosk_pickup_policy.sql packages/db/migrations/meta/0036_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/pickup-schema.test.ts packages/db/test/runtime-migrate.test.ts
git commit -m "feat(db): add employee pickup policies"
```

---

### Task 2: Expose policy through employee and organisation APIs with audit

**Files:**

- Modify: `apps/api/src/modules/employees/dto.ts`
- Modify: `apps/api/src/modules/employees/employees.controller.ts`
- Modify: `apps/api/src/modules/employees/employees.service.ts`
- Modify: `apps/api/src/modules/org-profile/dto.ts`
- Modify: `apps/api/src/modules/org-profile/org-profile.service.ts`
- Modify: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts`
- Modify: `apps/api/test/employees.e2e.test.ts`
- Modify: `apps/api/test/org-profile.e2e.test.ts`
- Modify: `apps/api/test/platform-tenants.e2e.test.ts`

**Interfaces:**

- Produces `EmployeePickupPolicyDto` embedded as `EmployeeDto.pickupPolicy`.
- Produces `PATCH /employees/:id/pickup-policy`.
- Produces `OrgProfileDto.pickupLimitsEnabled` and accepts it in `PUT /org/profile`.
- New tenant provisioning inserts `{limitsEnabled:true}` in the same transaction.
- Writes exact `tenantAuditEvents` for tenant policy and employee policy mutations.

- [ ] **Step 1: Add failing tenant isolation, provisioning-default, and audit e2e cases**

```ts
it("updates only this tenant employee pickup policy and audits before/after", async () => {
  const response = await request(app.getHttpServer())
    .patch(`/employees/${employeeId}/pickup-policy`)
    .set("cookie", ownerCookie)
    .send({ limitMode: "unlimited", dayLimit: 12, canWriteoff: true })
    .expect(200);

  expect(response.body.pickupPolicy).toEqual({
    limitMode: "unlimited",
    dayLimit: 12,
    canWriteoff: true,
  });
  expect(await readAudit("employee.pickup_policy.updated", employeeId)).toMatchObject({
    organizationId: tenantId,
    actorUserId: ownerUserId,
    targetType: "employee",
    targetId: employeeId,
    before: { limitMode: "limited", dayLimit: 5, canWriteoff: false },
    after: { limitMode: "unlimited", dayLimit: 12, canWriteoff: true },
  });
});

it("does not let one tenant patch another tenant employee policy", async () => {
  await request(app.getHttpServer())
    .patch(`/employees/${foreignEmployeeId}/pickup-policy`)
    .set("cookie", ownerCookie)
    .send({ limitMode: "unlimited", dayLimit: 5, canWriteoff: false })
    .expect(404);
});

it("provisions the tenant pickup policy atomically", async () => {
  const tenant = await provisionTenantOwner();
  expect(await readTenantPickupPolicy(tenant.id)).toEqual({ limitsEnabled: true });
});
```

- [ ] **Step 2: Run focused API tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/employees.e2e.test.ts test/org-profile.e2e.test.ts test/platform-tenants.e2e.test.ts
```

Expected: FAIL with missing DTO fields/routes.

- [ ] **Step 3: Implement DTOs, transactional upserts, tenant provisioning, and audit**

```ts
export const employeePickupPolicySchema = z.object({
  limitMode: z.enum(["limited", "unlimited"]),
  dayLimit: z.number().int().min(1),
  canWriteoff: z.boolean(),
});

export interface EmployeePickupPolicyDto {
  limitMode: "limited" | "unlimited";
  dayLimit: number;
  canWriteoff: boolean;
}
```

`createEmployee` must insert `employees` and `employeePickupPolicies` in one DB transaction. New tenant provisioning must insert `pickupTenantPolicies` before commit. `listEmployees` must left-join policies and treat a missing active policy as a configuration error rather than silently returning unlimited. Every mutation locks/reads the existing policy, writes the new row, and inserts one `tenantAuditEvents` record in the same transaction.

- [ ] **Step 4: Re-run focused tests and API typecheck**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/employees.e2e.test.ts test/org-profile.e2e.test.ts test/platform-tenants.e2e.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS; DB-backed tests must not be reported green if they skip for missing `DATABASE_URL`.

- [ ] **Step 5: Commit the cabinet policy API**

```bash
git add apps/api/src/modules/employees apps/api/src/modules/org-profile apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts apps/api/test/employees.e2e.test.ts apps/api/test/org-profile.e2e.test.ts apps/api/test/platform-tenants.e2e.test.ts
git commit -m "feat(api): manage kiosk employee policies"
```

---

### Task 3: Enforce employee policy in kiosk bootstrap and order creation

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/dto.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/test/kiosk-bootstrap-day-count.e2e.test.ts`
- Modify: `apps/api/test/kiosk-orders.e2e.test.ts`
- Modify: `apps/kiosk/src/api/types.ts`
- Modify: `apps/kiosk/src/session/day-count.ts`
- Modify: `apps/kiosk/test/day-count.test.ts`

**Interfaces:**

- `KioskBootstrapDto.pickupPolicy.limitsEnabled`.
- Each bootstrap employee produces `limitMode`, `dayLimit`, `canWriteoff`, and existing `takenTodayElsewhere`.
- `POST /kiosk/orders` rejects `reason="writeoff"` with 422 code `writeoff_forbidden` when the employee lacks permission.
- `applyDayLimit` accepts an effective employee policy, not a kiosk row.

- [ ] **Step 1: Write failing effective-policy and writeoff-denial tests**

```ts
it("does not apply a numeric limit when the tenant policy is disabled", async () => {
  await setTenantPolicy({ limitsEnabled: false });
  await setEmployeePolicy({ limitMode: "limited", dayLimit: 1, canWriteoff: false });
  const result = await postKioskOrder(twoDistinctKms);
  expect(result.body.conflicts).toEqual([]);
  expect(result.body.itemCount).toBe(2);
});

it("denies writeoff without employee permission", async () => {
  await setEmployeePolicy({ limitMode: "unlimited", dayLimit: 5, canWriteoff: false });
  await postKioskOrder(oneKm, { reason: "writeoff", writeoffReasonId }).expect(422, {
    code: "writeoff_forbidden",
    message: "Employee is not allowed to create writeoffs",
  });
});
```

- [ ] **Step 2: Run focused server and kiosk day-count tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/kiosk-bootstrap-day-count.e2e.test.ts test/kiosk-orders.e2e.test.ts
pnpm --filter @markiro/kiosk exec vitest run test/day-count.test.ts
```

Expected: FAIL because bootstrap still exposes kiosk-level `dayLimitPerEmployee` only.

- [ ] **Step 3: Implement effective-policy resolution and client helpers**

```ts
export interface EffectivePickupPolicy {
  limited: boolean;
  dayLimit: number;
  canWriteoff: boolean;
}

export function effectivePickupPolicy(
  bootstrap: KioskBootstrapDto,
  employeeId: string,
): EffectivePickupPolicy | null {
  const employee = bootstrap.employees.find((one) => one.id === employeeId);
  if (!employee) return null;
  return {
    limited: bootstrap.pickupPolicy.limitsEnabled && employee.limitMode === "limited",
    dayLimit: employee.dayLimit,
    canWriteoff: employee.canWriteoff,
  };
}
```

Server order flow must resolve the active employee policy before reason validation and before the limit query. `unlimited` or tenant-off passes all valid items without an `over_limit` branch; `limited` uses the existing UTC/cross-kiosk query with the employee's `dayLimit`.

- [ ] **Step 4: Re-run focused tests and compatibility tests**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/kiosk-bootstrap-day-count.e2e.test.ts test/kiosk-orders.e2e.test.ts test/kiosk-pairing.e2e.test.ts
pnpm --filter @markiro/kiosk exec vitest run test/day-count.test.ts test/api-client.test.ts
```

Expected: PASS, including the legacy item-only request shape.

- [ ] **Step 5: Commit policy enforcement**

```bash
git add apps/api/src/modules/pickup-orders apps/api/test/kiosk-bootstrap-day-count.e2e.test.ts apps/api/test/kiosk-orders.e2e.test.ts apps/kiosk/src/api/types.ts apps/kiosk/src/session/day-count.ts apps/kiosk/test/day-count.test.ts
git commit -m "feat(kiosk): enforce employee pickup policy"
```

---

### Task 4: Add tenant-owned company logo upload and kiosk delivery

**Files:**

- Modify: `packages/db/src/schema/org-profile.ts`
- Modify: `packages/db/src/schema/media.ts`
- Create: `packages/db/migrations/0037_organization_branding.sql`
- Create: `packages/db/migrations/meta/0037_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `apps/api/src/modules/org-profile/logo-processor.ts`
- Create: `apps/api/src/modules/profile/raster-image-processor.ts`
- Modify: `apps/api/src/modules/profile/avatar-processor.ts`
- Modify: `apps/api/src/modules/org-profile/dto.ts`
- Modify: `apps/api/src/modules/org-profile/org-profile.controller.ts`
- Modify: `apps/api/src/modules/org-profile/org-profile.service.ts`
- Modify: `apps/api/src/modules/kiosk/kiosk.controller.ts`
- Modify: `apps/api/src/modules/pickup-orders/dto.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/src/modules/storage/object-storage.service.ts`
- Modify: `packages/db/test/mail-media-schema.test.ts`
- Modify: `packages/db/test/runtime-migrate.test.ts`
- Modify: `apps/api/test/org-profile.e2e.test.ts`
- Modify: `apps/api/test/kiosk-bootstrap-hashes.e2e.test.ts`

**Interfaces:**

- Produces `organizationLogoAssets` tenant-owned metadata and `orgProfiles.logoAssetId`.
- Produces cabinet `POST /org/profile/logo`, `DELETE /org/profile/logo`.
- Produces device-auth `GET /kiosk/branding/logo/:revision` as same-origin `image/webp`.
- Bootstrap branding shape: `{ organizationName, logoUrl, logoRevision }`.

- [ ] **Step 1: Write failing image-boundary, tenant-isolation, fallback, and streaming tests**

```ts
it("returns null branding logo when the tenant has none", async () => {
  const bootstrap = await kioskBootstrap();
  expect(bootstrap.body.branding).toEqual({
    organizationName: tenantName,
    logoUrl: null,
    logoRevision: null,
  });
});

it("streams only the paired kiosk tenant logo", async () => {
  const revision = await uploadTenantLogo(ownerCookie, pngFixture);
  await request(app.getHttpServer())
    .get(`/kiosk/branding/logo/${revision}`)
    .set("x-kiosk-token", kioskToken)
    .expect("content-type", /image\/webp/)
    .expect(200);
  await request(app.getHttpServer())
    .get(`/kiosk/branding/logo/${foreignRevision}`)
    .set("x-kiosk-token", kioskToken)
    .expect(404);
});
```

- [ ] **Step 2: Run focused API tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/org-profile.e2e.test.ts test/kiosk-bootstrap-hashes.e2e.test.ts
```

Expected: FAIL because no organisation logo metadata or routes exist.

- [ ] **Step 3: Implement bounded logo normalization, durable metadata, upload swap, and same-origin read**

```ts
export interface ProcessedLogo {
  buffer: Buffer;
  contentType: "image/webp";
  byteSize: number;
  checksum: string;
  width: number;
  height: number;
}

export async function processLogo(input: Buffer): Promise<ProcessedLogo> {
  const image = await processRasterImage(input, {
    maxSourceBytes: 5 * 1024 * 1024,
    maxDimension: 8192,
    maxPixels: 25_000_000,
    maxFrames: 1,
    width: 1024,
    height: 512,
    fit: "inside",
    withoutEnlargement: true,
    quality: 85,
  });
  return {
    buffer: image.buffer,
    contentType: "image/webp",
    byteSize: image.buffer.byteLength,
    checksum: createHash("sha256").update(image.buffer).digest("hex"),
    width: image.width,
    height: image.height,
  };
}
```

Extract the avatar worker's bounded decode/resize implementation into
`processRasterImage`; keep avatar output fixed at 512×512 `cover`, while logo
uses the options above. Define `organizationLogoAssets` with `id`, `tenantId`,
`objectKey`, `contentType`, `byteSize`, `checksum`, `width`, `height`, `status`,
`createdAt`, `updatedAt`, plus unique `(tenantId,id)` and `objectKey`. Add nullable
`orgProfiles.logoAssetId` with composite `(tenantId,logoAssetId)` FK.

Generate `0037_organization_branding.sql` only after these schema edits. Use
object keys `tenants/${tenantId}/branding/${assetId}.webp`. Insert a staging
metadata row, upload, lock the tenant profile, activate the new asset, mark the
old one deleting, and write `organization.logo.updated` audit before deleting
the old object. Extend `ObjectStorageService` with a bounded `get(key)` method
returning body/content type so the API, not a presigned external URL, serves the
image.

Run the generator once after both schema modules are complete:

```bash
pnpm --filter @markiro/db db:generate --name organization_branding
```

- [ ] **Step 4: Re-run API tests, storage tests, and typecheck**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/org-profile.e2e.test.ts test/kiosk-bootstrap-hashes.e2e.test.ts test/profile-assets.reconciler.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS; malformed, animated, oversized, cross-tenant, missing-object and storage-failure cases remain explicit.

- [ ] **Step 5: Commit branding API**

```bash
git add packages/db/src/schema packages/db/migrations/0037_organization_branding.sql packages/db/migrations/meta/0037_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/mail-media-schema.test.ts packages/db/test/runtime-migrate.test.ts apps/api/src/modules/org-profile apps/api/src/modules/profile/raster-image-processor.ts apps/api/src/modules/profile/avatar-processor.ts apps/api/src/modules/kiosk/kiosk.controller.ts apps/api/src/modules/pickup-orders apps/api/src/modules/storage/object-storage.service.ts apps/api/test/org-profile.e2e.test.ts apps/api/test/kiosk-bootstrap-hashes.e2e.test.ts apps/api/test/profile-assets.reconciler.test.ts
git commit -m "feat(kiosk): deliver tenant branding offline"
```

---

### Task 5: Build admin policy and branding controls

**Files:**

- Modify: `apps/admin/src/pages/settings/api.ts`
- Modify: `apps/admin/src/pages/settings/OrgProfilePage.tsx`
- Modify: `apps/admin/src/pages/employees/api.ts`
- Create: `apps/admin/src/pages/employees/EmployeePickupPolicySection.tsx`
- Modify: `apps/admin/src/pages/employees/EmployeePanelRoute.tsx`
- Modify: `apps/admin/src/pages/employees/EmployeeSectionNav.tsx`
- Modify: `apps/admin/src/pages/employees/index.tsx`
- Modify: `apps/admin/src/pages/employees/employees.css`
- Modify: `apps/admin/src/pages/kiosks/KioskProfileForm.tsx`
- Modify: `apps/admin/src/pages/kiosks/api.ts`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/org-profile.test.tsx`
- Modify: `apps/admin/test/employees.test.tsx`
- Modify: `apps/admin/test/employees-routing.test.tsx`
- Modify: `apps/admin/test/kiosks.test.tsx`

**Interfaces:**

- Settings form controls `pickupLimitsEnabled` and company logo upload/remove.
- Employee panel adds section id `pickup-policy` and saves via the dedicated mutation.
- New kiosk forms no longer expose or submit `dayLimitPerEmployee`.

- [ ] **Step 1: Write failing component/API behavior tests**

```tsx
it("keeps employee numeric limit when switching to unlimited", async () => {
  renderEmployeePanel({
    pickupPolicy: { limitMode: "limited", dayLimit: 12, canWriteoff: false },
  });
  await user.click(screen.getByRole("radio", { name: "Без лимита" }));
  await user.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(lastPatchBody()).toEqual({
    limitMode: "unlimited",
    dayLimit: 12,
    canWriteoff: false,
  });
});

it("does not submit the deprecated kiosk limit", async () => {
  renderCreateKiosk();
  await fillRequiredKioskFields();
  await submit();
  expect(lastPostBody()).not.toHaveProperty("dayLimitPerEmployee");
});
```

- [ ] **Step 2: Run focused admin tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/org-profile.test.tsx test/employees.test.tsx test/employees-routing.test.tsx test/kiosks.test.tsx
```

Expected: FAIL with missing controls, route section, and request shapes.

- [ ] **Step 3: Implement typed hooks, forms, logo preview, and i18n**

```ts
export interface EmployeePickupPolicyInput {
  limitMode: "limited" | "unlimited";
  dayLimit: number;
  canWriteoff: boolean;
}

export type EmployeeSectionId = "profile" | "badges" | "station-access" | "pickup-policy";
```

The tenant toggle must include copy that disabling enforcement preserves employee values. Logo UI accepts one file, previews the normalized result returned by the API, offers explicit remove, and labels the Markiro fallback. Limit mode, numeric limit, and writeoff permission are edited for one employee at a time so changing limits cannot silently change `canWriteoff`.

- [ ] **Step 4: Run focused tests, full admin package tests, and typecheck**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/org-profile.test.tsx test/employees.test.tsx test/employees-routing.test.tsx test/kiosks.test.tsx
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
```

Expected: PASS with RU and EN resources present.

- [ ] **Step 5: Commit admin controls**

```bash
git add apps/admin/src/pages/settings apps/admin/src/pages/employees apps/admin/src/pages/kiosks apps/admin/src/i18n apps/admin/test/org-profile.test.tsx apps/admin/test/employees.test.tsx apps/admin/test/employees-routing.test.tsx apps/admin/test/kiosks.test.tsx
git commit -m "feat(admin): manage kiosk pickup policy"
```

---

### Task 6: Run the policy and branding slice gates

**Files:**

- Verify only; do not add generated build output.

**Interfaces:**

- Consumes every interface produced by Tasks 1–5.
- Produces a reviewable, independently deployable policy/branding foundation for the SSCC and UI plans.

- [ ] **Step 1: Build shared DB output before consumers**

```bash
pnpm --filter @markiro/db build
```

Expected: PASS.

- [ ] **Step 2: Run package gates**

```bash
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/kiosk exec vitest run test/day-count.test.ts test/api-client.test.ts
```

Expected: PASS; report database skips separately.

- [ ] **Step 3: Run builds and formatting**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api build
pnpm --filter @markiro/admin build
pnpm --filter @markiro/kiosk build
pnpm format:check
git diff --check
```

Expected: PASS with no tracked `dist`, coverage, or `.turbo` output.

- [ ] **Step 4: Inspect migration and final diff**

```bash
git status --short
git diff --stat
git diff -- packages/db/migrations/0036_kiosk_pickup_policy.sql
git diff -- packages/db/migrations/0037_organization_branding.sql
```

Expected: only policy/branding source, tests, migration metadata, and translations are changed; `.pnpm-store/` remains untracked and unstaged.

- [ ] **Step 5: Commit any verification-only corrections**

```bash
git add packages/db apps/api apps/admin apps/kiosk docs/superpowers/plans/2026-08-13-kiosk-policy-and-branding.md
git commit -m "test(kiosk): verify pickup policy foundation"
```

Skip this commit when verification required no correction; do not create an empty commit.
