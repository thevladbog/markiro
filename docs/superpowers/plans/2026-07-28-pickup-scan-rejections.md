# Pickup Scan Rejections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every scanned code the pickup kiosk's server refuses a durable, tenant-scoped home (`pickup_scan_rejections`) and an admin-visible surface in «Для себя», so a fully-refused scan stops vanishing into `logger.warn`.

**Architecture:** One new table in `packages/db` using the file's composite `(tenant_id, id)` FK pattern, written from three call sites inside the existing `PickupOrdersService` (where the transactions already are), read by a new 4-file NestJS module `pickup-rejections` behind `TenantGuard + SessionOnlyGuard`, and surfaced in `apps/admin` as a warn banner on the свод plus a `/pickup/rejections` page.

**Tech Stack:** drizzle-orm 0.45.2 + drizzle-kit 0.31.10 (PostgreSQL), NestJS 11 + Zod 4 (`ZodValidationPipe`), React 19 + TanStack Query 5 + `@markiro/ui`, i18next, Vitest 4 + supertest.

**Spec:** `docs/superpowers/specs/2026-07-28-pickup-scan-rejections-design.md`

## Global Constraints

- Tenant scoping is mandatory: every query filters on `tenantId`, every new table uses the composite `(tenant_id, id)` FK pattern from `packages/db/src/schema/pickup.ts`.
- Every new cabinet route carries `@UseGuards(TenantGuard, SessionOnlyGuard)` — a device key (kiosk or station) must be refused. See `docs/device-key-surface.md`.
- `POST /kiosk/orders`' request and response contract does not change. `OrderConflict["reason"]` in `apps/api/src/modules/pickup-orders/dto.ts` keeps its six members.
- `pickup_orders.sync_conflicts` is neither removed nor stopped being written. The new table is a superset, not a replacement.
- Admin i18n is key-parallel RU/EN: every key added to `apps/admin/src/i18n/ru.json` gets the same key in `en.json`. `apps/admin/test/i18n.test.tsx`'s `i18n lockstep` test enforces this.
- E2E tests must RUN, not skip. Load env first: `set -a; . ./.env; set +a`. A suite that prints `skipped` is a failure, not a pass.
- Format only the files you touched: `npx prettier --write <paths>`. Never `prettier --write .`.
- TDD: write the failing test, run it and see it fail for the right reason, then implement.

---

## File Structure

**Created:**

- `packages/db/migrations/0015_*.sql` — drizzle-generated (name is random; keep whatever it produces)
- `apps/api/src/modules/pickup-rejections/dto.ts` — Zod query schema + row/response types
- `apps/api/src/modules/pickup-rejections/pickup-rejections.service.ts` — list + acknowledge (read side only)
- `apps/api/src/modules/pickup-rejections/pickup-rejections.controller.ts` — two cabinet routes
- `apps/api/src/modules/pickup-rejections/pickup-rejections.module.ts`
- `apps/admin/src/pages/pickup/rejections-api.ts` — typed fetchers + TanStack hooks
- `apps/admin/src/pages/pickup/Rejections.tsx` — the `/pickup/rejections` page
- `packages/db/test/pickup-rejections-schema.test.ts`
- `apps/api/test/pickup-rejections.e2e.test.ts`
- `apps/admin/test/pickup-rejections.test.tsx`

**Modified:**

- `packages/db/src/schema/pickup.ts` — append `pickupScanRejections`
- `apps/api/src/modules/pickup-orders/pickup-orders.service.ts` — three write call sites + one private helper
- `apps/api/src/modules/kiosk/pairing.service.ts` — `nextDeviceSeq` spans both tables
- `apps/api/src/app.module.ts` — register `PickupRejectionsModule`
- `apps/admin/src/app.tsx` — add the `/pickup/rejections` route
- `apps/admin/src/pages/pickup/index.tsx` — the banner
- `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`

---

### Task 1: Table `pickup_scan_rejections` + migration

**Files:**

- Modify: `packages/db/src/schema/pickup.ts` (append at end of file)
- Create: `packages/db/migrations/0015_*.sql` (generated)
- Test: `packages/db/test/pickup-rejections-schema.test.ts`

**Interfaces:**

- Produces: `schema.pickupScanRejections` with columns `id, tenantId, kioskId, employeeId, badgeCode, orderId, deviceSeq, codes, scannedAt, syncedAt, acknowledgedAt, acknowledgedByUserId`; constraints named `pickup_scan_rejections_kiosk_device_seq_uq` and `pickup_scan_rejections_badge_xor_employee`.

- [ ] **Step 1: Write the failing schema test**

Create `packages/db/test/pickup-rejections-schema.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { createDb, schema } from "../src/index.js";

const url = process.env.DATABASE_URL;
const { organization } = schema;

describe.skipIf(!url)("pickup_scan_rejections schema", () => {
  const { db, pool } = createDb(url!);
  const org = {
    id: `org-${randomUUID()}`,
    name: "T",
    slug: `t-${randomUUID()}`,
    createdAt: new Date(),
  };
  const foreignOrg = {
    id: `org-${randomUUID()}`,
    name: "T2",
    slug: `t2-${randomUUID()}`,
    createdAt: new Date(),
  };
  const empId = randomUUID();
  const foreignEmpId = randomUUID();
  const kioskId = randomUUID();
  const foreignKioskId = randomUUID();

  const CODES = [{ rawKm: "0104600682000013215X", reason: "not_allowed" }];

  beforeAll(async () => {
    await db.insert(organization).values([org, foreignOrg]);
    await db
      .insert(schema.employees)
      .values({ id: empId, tenantId: org.id, fullName: "Смирнов А." });
    await db
      .insert(schema.employees)
      .values({ id: foreignEmpId, tenantId: foreignOrg.id, fullName: "Чужой" });
    await db.insert(schema.kiosks).values({ id: kioskId, tenantId: org.id, name: "Киоск-1" });
    await db
      .insert(schema.kiosks)
      .values({ id: foreignKioskId, tenantId: foreignOrg.id, name: "Киоск-2" });
  });

  afterAll(async () => {
    await db
      .delete(schema.pickupScanRejections)
      .where(inArray(schema.pickupScanRejections.tenantId, [org.id, foreignOrg.id]));
    await db.delete(schema.kiosks).where(inArray(schema.kiosks.id, [kioskId, foreignKioskId]));
    await db.delete(schema.employees).where(inArray(schema.employees.id, [empId, foreignEmpId]));
    await db.delete(organization).where(inArray(organization.id, [org.id, foreignOrg.id]));
    await pool.end();
  });

  it("stores a fully-refused scan with no order", async () => {
    const [row] = await db
      .insert(schema.pickupScanRejections)
      .values({
        tenantId: org.id,
        kioskId,
        employeeId: empId,
        deviceSeq: 1,
        codes: CODES,
        scannedAt: new Date(),
      })
      .returning();

    expect(row!.orderId).toBeNull();
    expect(row!.badgeCode).toBeNull();
    expect(row!.acknowledgedAt).toBeNull();
    expect(row!.codes).toEqual(CODES);
  });

  it("rejects a kiosk belonging to another tenant", async () => {
    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId: foreignKioskId,
        employeeId: empId,
        deviceSeq: 900,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects an employee belonging to another tenant", async () => {
    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        employeeId: foreignEmpId,
        deviceSeq: 901,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects an order belonging to another tenant", async () => {
    const foreignOrderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: foreignOrderId,
      tenantId: foreignOrg.id,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId: foreignKioskId,
      employeeId: foreignEmpId,
      reason: "buy",
      itemCount: 0,
    });

    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        employeeId: empId,
        orderId: foreignOrderId,
        deviceSeq: 904,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    await db.delete(schema.pickupOrders).where(inArray(schema.pickupOrders.id, [foreignOrderId]));
  });

  // The idempotency key. A retried sync -- lost response, or a kiosk that
  // keeps retrying a 401 forever -- must not double-count in the cabinet.
  it("allows only one rejection per (tenant, kiosk, device_seq)", async () => {
    await db.insert(schema.pickupScanRejections).values({
      tenantId: org.id,
      kioskId,
      employeeId: empId,
      deviceSeq: 42,
      codes: CODES,
      scannedAt: new Date(),
    });

    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        employeeId: empId,
        deviceSeq: 42,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "pickup_scan_rejections_kiosk_device_seq_uq" },
    });
  });

  // `kind` is derived in the DTO from `employee_id IS NULL`, so the two
  // columns must never disagree -- an unrecognised badge has no employee,
  // and a recognised one stores no badge code.
  it("refuses a row with both an employee and a badge code", async () => {
    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        employeeId: empId,
        badgeCode: "badge-1",
        deviceSeq: 902,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "pickup_scan_rejections_badge_xor_employee" },
    });
  });

  it("refuses a row with neither an employee nor a badge code", async () => {
    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        deviceSeq: 903,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "pickup_scan_rejections_badge_xor_employee" },
    });
  });

  it("stores an unrecognised badge with no employee", async () => {
    const [row] = await db
      .insert(schema.pickupScanRejections)
      .values({
        tenantId: org.id,
        kioskId,
        badgeCode: "badge-gone",
        deviceSeq: 43,
        codes: [{ rawKm: "0104600682000013215X", reason: "unknown_badge" }],
        scannedAt: new Date(),
      })
      .returning();

    expect(row!.employeeId).toBeNull();
    expect(row!.badgeCode).toBe("badge-gone");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/db exec vitest run test/pickup-rejections-schema.test.ts
```

Expected: FAIL — `schema.pickupScanRejections` is undefined (`Cannot read properties of undefined`). If you see `skipped` instead, `DATABASE_URL` did not load; fix that before continuing.

- [ ] **Step 3: Confirm `check()` is available in this drizzle version**

```bash
pnpm --filter @markiro/db exec node -e "import('drizzle-orm/pg-core').then(m => console.log('check:', typeof m.check))"
```

Expected: `check: function`.

If it prints `undefined`, drop the `check(...)` line from Step 4 and instead append this to the generated migration in Step 6:

```sql
ALTER TABLE "pickup_scan_rejections" ADD CONSTRAINT "pickup_scan_rejections_badge_xor_employee"
  CHECK ((employee_id IS NULL) = (badge_code IS NOT NULL));
```

- [ ] **Step 4: Add the table to the schema**

In `packages/db/src/schema/pickup.ts`, add `check` to the existing `drizzle-orm/pg-core` import list (alphabetical: after `boolean`, before `foreignKey`), then append at the end of the file:

```ts
/**
 * Every scanned code the server refused, in one place.
 *
 * `pickup_orders.sync_conflicts` covers only the partial case: it hangs off
 * an order, and a scan whose codes are ALL refused deliberately creates no
 * order (a 0-item pending row would clutter the свод and could never be
 * resolved). That worst case -- a worker walks off with product and the
 * cabinet learns nothing -- is exactly what this table exists to record.
 * It matters most for offline kiosks, where the sync lands hours later and
 * the worker is long gone.
 *
 * `order_id` is what distinguishes the two: NULL means no order was created
 * (whole session refused, or the badge was no longer recognised), set means
 * a partial refusal on that order. `sync_conflicts` keeps being written for
 * the partial case -- this table is a superset, not a replacement.
 *
 * `scanned_at` and `synced_at` are both stored on purpose: the gap between
 * them IS the offline problem, and an admin should see it rather than
 * compute it.
 */
export const pickupScanRejections = pgTable(
  "pickup_scan_rejections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kioskId: uuid("kiosk_id").notNull(),
    // NULL <=> the badge was not recognised at sync time. Mutually exclusive
    // with `badgeCode` -- see the check constraint below.
    employeeId: uuid("employee_id"),
    // Only set when the badge was NOT recognised, so the admin can still tell
    // whose badge was used once the employee is gone from the roster. Stored
    // plaintext, exactly as `employee_badges.badge_code` already is; the
    // paired `badge_hash` exists only because bootstrap ships to an untrusted
    // tablet (see docs/device-key-surface.md).
    badgeCode: text("badge_code"),
    orderId: uuid("order_id"),
    deviceSeq: integer("device_seq").notNull(),
    codes: jsonb("codes").$type<{ rawKm: string; reason: string }[]>().notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedByUserId: text("acknowledged_by_user_id"),
  },
  (t) => [
    unique("pickup_scan_rejections_tenant_id_uq").on(t.tenantId, t.id),
    // The SAME idempotency key `pickup_orders` uses. A replayed sync (lost
    // response, or a kiosk retrying a 401 forever) must record once, not
    // once per attempt -- the writers pair this with onConflictDoNothing().
    unique("pickup_scan_rejections_kiosk_device_seq_uq").on(t.tenantId, t.kioskId, t.deviceSeq),
    foreignKey({
      name: "pickup_scan_rejections_tenant_kiosk_fk",
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
    // Nullable columns are exempt under MATCH SIMPLE, so an unrecognised-badge
    // row (employeeId NULL) and a no-order row (orderId NULL) both pass --
    // the same arrangement `pickup_orders.writeoff_reason_id` relies on.
    foreignKey({
      name: "pickup_scan_rejections_tenant_employee_fk",
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "pickup_scan_rejections_tenant_order_fk",
      columns: [t.tenantId, t.orderId],
      foreignColumns: [pickupOrders.tenantId, pickupOrders.id],
    }),
    // `kind` (items_refused / unknown_badge) is derived in the DTO from
    // `employee_id IS NULL` rather than stored, so the database has to
    // guarantee the two columns can never disagree.
    check(
      "pickup_scan_rejections_badge_xor_employee",
      sql`(employee_id is null) = (badge_code is not null)`,
    ),
    // Drives the свод banner's count.
    index("pickup_scan_rejections_open_idx")
      .on(t.tenantId, t.syncedAt)
      .where(sql`acknowledged_at is null`),
  ],
);
```

- [ ] **Step 5: Generate the migration**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/db db:generate
```

Expected: a new `packages/db/migrations/0015_<random-name>.sql` plus an updated `meta/_journal.json`.

- [ ] **Step 6: Verify the generated SQL, then apply it**

```bash
cat packages/db/migrations/0015_*.sql
```

Confirm it contains `CREATE TABLE "pickup_scan_rejections"`, the three `FOREIGN KEY` clauses, `pickup_scan_rejections_kiosk_device_seq_uq`, the `CHECK` constraint, and the partial index. If the `CHECK` is missing (Step 3 printed `undefined`), append the `ALTER TABLE` from Step 3 to the file now.

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/db db:migrate
```

- [ ] **Step 7: Run the test and watch it pass**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/db exec vitest run test/pickup-rejections-schema.test.ts
```

Expected: PASS, 7 tests, 0 skipped.

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write packages/db/src/schema/pickup.ts packages/db/test/pickup-rejections-schema.test.ts
git add packages/db/src/schema/pickup.ts packages/db/test/pickup-rejections-schema.test.ts packages/db/migrations
git commit -m "feat(db): pickup_scan_rejections table for refused kiosk scans"
```

---

### Task 2: Record fully-refused scans and unrecognised badges

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Test: `apps/api/test/pickup-rejections.e2e.test.ts` (create)

**Interfaces:**

- Consumes: `schema.pickupScanRejections` (Task 1).
- Produces: `PickupOrdersService.recordScanRejection(tx, row)` — a private helper used again by Task 3.

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/test/pickup-rejections.e2e.test.ts`. The fixture setup mirrors `apps/api/test/pickup-conflicts.e2e.test.ts` exactly; the GTIN vectors are check-digit valid and must not be swapped for arbitrary digits (an invalid check digit is rejected as `not_km`, which tests the wrong branch).

```ts
import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { schema, type Db } from "@markiro/db";

/** Check-digit VALID GTINs. GTIN is allowlisted on the kiosk; GTIN_NOT_ALLOWED is not. */
const GTIN = "04600682000013";
const GTIN_NOT_ALLOWED = "04600682000020";
/** GS (ASCII 0x1D) — the KM segment separator. */
const GS = String.fromCharCode(0x1d);

const REFUSED_KM = `01${GTIN_NOT_ALLOWED}21REJ1${GS}93Abcd`;
const REFUSED_KM_2 = `01${GTIN_NOT_ALLOWED}21REJ2${GS}93Abcd`;
const GOOD_KM = `01${GTIN}21REJ3${GS}93Abcd`;

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("pickup scan rejections e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let tenantId: string;
  let employeeId: string;
  let productId: string;
  let kioskId: string;
  let agent: ReturnType<typeof request.agent>;
  const TOKEN = `kiosk-token-${randomUUID()}`;
  const BADGE = `badge-${randomUUID()}`;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();

    agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    employeeId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: employeeId, tenantId, fullName: "Иван Иванов", role: "оператор" });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: BADGE });

    productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: GTIN, name: "Товар", unitPrice: "99.90" });
    await db
      .insert(schema.products)
      .values({ id: randomUUID(), tenantId, gtin14: GTIN_NOT_ALLOWED, name: "Другой товар" });

    kioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId, name: "Киоск-1", dayLimitPerEmployee: 20 });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(TOKEN) })
      .where(eq(schema.kiosks.id, kioskId));
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpAndActivate(a: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await a
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);
    const org = await a
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);
    const orgId = org.body.id as string;
    await a.post("/api/auth/organization/set-active").send({ organizationId: orgId }).expect(200);
    return orgId;
  }

  function postScan(body: Record<string, unknown>) {
    return request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send(body);
  }

  function rejectionsFor(deviceSeq: number) {
    return db
      .select()
      .from(schema.pickupScanRejections)
      .where(
        and(
          eq(schema.pickupScanRejections.tenantId, tenantId),
          eq(schema.pickupScanRejections.kioskId, kioskId),
          eq(schema.pickupScanRejections.deviceSeq, deviceSeq),
        ),
      );
  }

  it("records a scan whose codes were all refused, with no order", async () => {
    const res = await postScan({
      deviceSeq: 10,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: REFUSED_KM }, { rawKm: REFUSED_KM_2 }],
    }).expect(201);

    expect(res.body.orderNo).toBe("");
    expect(res.body.conflicts).toHaveLength(2);

    const rows = await rejectionsFor(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBeNull();
    expect(rows[0]!.employeeId).toBe(employeeId);
    expect(rows[0]!.badgeCode).toBeNull();
    expect(rows[0]!.codes.map((c) => c.rawKm).sort()).toEqual([REFUSED_KM, REFUSED_KM_2].sort());
  });

  it("records a replayed all-refused sync exactly once", async () => {
    await postScan({
      deviceSeq: 11,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: REFUSED_KM }],
    }).expect(201);
    await postScan({
      deviceSeq: 11,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: REFUSED_KM }],
    }).expect(201);

    expect(await rejectionsFor(11)).toHaveLength(1);
  });

  it("records a sync whose badge is no longer recognised, and still 401s", async () => {
    await postScan({
      deviceSeq: 12,
      badgeCode: "badge-that-never-existed",
      reason: "buy",
      items: [{ rawKm: GOOD_KM }],
    }).expect(401);

    const rows = await rejectionsFor(12);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employeeId).toBeNull();
    expect(rows[0]!.badgeCode).toBe("badge-that-never-existed");
    expect(rows[0]!.orderId).toBeNull();
    expect(rows[0]!.codes).toEqual([{ rawKm: GOOD_KM, reason: "unknown_badge" }]);
  });

  // A badge heartbeat carries no codes, so nothing was lost -- a row here
  // would be noise in a surface whose whole point is that it stays worth
  // reading.
  it("records nothing when an unrecognised-badge sync carried no codes", async () => {
    await postScan({
      deviceSeq: 13,
      badgeCode: "badge-that-never-existed",
      reason: "buy",
      items: [],
    }).expect(401);

    expect(await rejectionsFor(13)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts
```

Expected: FAIL — the first three tests find 0 rows (`expected [] to have a length of 1`). Confirm 0 skipped.

- [ ] **Step 3: Add the `recordScanRejection` helper**

In `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`, add this private method next to the other private helpers (e.g. just above `resolveActiveEmployeeId`):

```ts
/**
 * Persist refused codes so the cabinet can see them. Idempotent on
 * `(tenant, kiosk, deviceSeq)` -- the same key `pickup_orders` uses -- so a
 * replayed sync (a lost response, or a kiosk that keeps retrying a 401)
 * records once rather than once per attempt.
 *
 * `db` is loosely typed so both `this.db` and a transaction handle satisfy
 * it: the partial-refusal call site MUST enlist in the order's own
 * transaction, or a kmKey-race rollback would leave an orphan row.
 */
private async recordScanRejection(
  db: Pick<Db, "insert">,
  row: {
    tenantId: string;
    kioskId: string;
    employeeId: string | null;
    badgeCode: string | null;
    orderId: string | null;
    deviceSeq: number;
    codes: { rawKm: string; reason: string }[];
    scannedAt: Date;
  },
): Promise<void> {
  await db.insert(schema.pickupScanRejections).values(row).onConflictDoNothing();
}
```

- [ ] **Step 4: Record the unrecognised badge**

Replace step 2 of `createFromKiosk` (currently `const employeeId = …; if (!employeeId) throw new UnauthorizedException("Unknown badge");`) with:

```ts
// 2. Badge -> active employee (badge's revoked_at is null). Unknown -> 401 ("bad badge" on the kiosk).
const employeeId = await this.resolveActiveEmployeeId(tenantId, dto.badgeCode);
if (!employeeId) {
  // An offline sync lands hours after the scan, so the badge may have
  // been revoked in between -- and this 401 fires before a single item
  // is examined, so without this the codes the worker walked off with
  // leave no trace at all. Codes only: an item-less badge heartbeat
  // lost nothing and must not add noise here.
  if (dto.items.length > 0) {
    await this.recordScanRejection(this.db, {
      tenantId,
      kioskId,
      employeeId: null,
      badgeCode: dto.badgeCode,
      orderId: null,
      deviceSeq: dto.deviceSeq,
      codes: dto.items.map((item) => ({ rawKm: item.rawKm, reason: "unknown_badge" })),
      scannedAt: dto.createdAt ? new Date(dto.createdAt) : new Date(),
    });
  }
  throw new UnauthorizedException("Unknown badge");
}
```

- [ ] **Step 5: Record the fully-refused scan**

In the `if (accepted.length === 0 && dto.items.length > 0)` branch, replace the comment block and `logger.warn` call (the lines from `// No order row is created here…` through the `this.logger.warn(…)` statement) with:

```ts
// No order row is created here, so `syncConflicts` has nowhere to live.
// `pickup_scan_rejections` is that home: the cabinet would otherwise
// never learn that a worker's ENTIRE scan session was refused -- the
// same blind spot `syncConflicts` exists to close, in its worst case.
await this.recordScanRejection(this.db, {
  tenantId,
  kioskId,
  employeeId,
  badgeCode: null,
  orderId: null,
  deviceSeq: dto.deviceSeq,
  codes: conflicts,
  scannedAt: when,
});
// Kept alongside the durable row: cheap, and ops alerting may key on it.
this.logger.warn(
  `kiosk ${kioskId}: all ${dto.items.length} scanned code(s) refused for employee ${employeeId} — ${conflicts.map((c) => c.reason).join(", ")}`,
);
```

- [ ] **Step 6: Run the test and watch it pass**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts
```

Expected: PASS, 4 tests, 0 skipped.

- [ ] **Step 7: Confirm nothing regressed in the existing kiosk suites**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run test/kiosk-orders.e2e.test.ts test/pickup-conflicts.e2e.test.ts
```

Expected: PASS, 0 skipped.

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/test/pickup-rejections.e2e.test.ts
git add apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/test/pickup-rejections.e2e.test.ts
git commit -m "feat(api): persist fully-refused kiosk scans and unrecognised badges"
```

---

### Task 3: Record partial refusals alongside the order

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts` (`insertOrderWithRetry`)
- Test: `apps/api/test/pickup-rejections.e2e.test.ts` (append)

**Interfaces:**

- Consumes: `recordScanRejection` (Task 2).

- [ ] **Step 1: Write the failing test**

Append inside the `describe` block in `apps/api/test/pickup-rejections.e2e.test.ts`:

```ts
// The unified log has to be a superset: an admin asking "what got refused
// today?" must not have to check two places. `sync_conflicts` keeps being
// written so the order card and `conflictCount` are untouched.
it("records a partial refusal linked to its order, without disturbing sync_conflicts", async () => {
  const res = await postScan({
    deviceSeq: 14,
    badgeCode: BADGE,
    reason: "buy",
    items: [{ rawKm: GOOD_KM }, { rawKm: REFUSED_KM }],
  }).expect(201);

  expect(res.body.itemCount).toBe(1);

  const rows = await rejectionsFor(14);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.orderId).not.toBeNull();
  expect(rows[0]!.employeeId).toBe(employeeId);
  expect(rows[0]!.codes).toEqual([
    { rawKm: REFUSED_KM, reason: expect.stringMatching(/unknown_product|not_allowed/) },
  ]);

  const [order] = await db
    .select({ syncConflicts: schema.pickupOrders.syncConflicts })
    .from(schema.pickupOrders)
    .where(
      and(
        eq(schema.pickupOrders.tenantId, tenantId),
        eq(schema.pickupOrders.id, rows[0]!.orderId!),
      ),
    );
  expect(order!.syncConflicts).toHaveLength(1);
});

it("records nothing for a clean order", async () => {
  const good = `01${GTIN}21REJ9${GS}93Abcd`;
  await postScan({
    deviceSeq: 15,
    badgeCode: BADGE,
    reason: "buy",
    items: [{ rawKm: good }],
  }).expect(201);

  expect(await rejectionsFor(15)).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts
```

Expected: FAIL on "records a partial refusal…" — `expected [] to have a length of 1`.

- [ ] **Step 3: Write the rejection inside the order transaction**

In `insertOrderWithRetry`, immediately after the `if (remaining.length > 0) { await tx.insert(schema.pickupOrderItems)…}` block and before `return { orderNo: order.orderNo, itemCount: order.itemCount };`, insert:

```ts
// Same transaction as the order on purpose: the kmKey-race retry
// below rolls this back with it, so a rejection row can never
// outlive the order attempt that produced it. `conflicts` is
// mutated by that retry before it loops, so on the attempt that
// finally commits it holds the complete set.
if (conflicts.length > 0) {
  await this.recordScanRejection(tx, {
    tenantId,
    kioskId,
    employeeId,
    badgeCode: null,
    orderId: order.id,
    deviceSeq,
    codes: conflicts,
    scannedAt: when,
  });
}
```

Note on an accepted edge: if an earlier all-refused sync already wrote a row for this `(kiosk, deviceSeq)` and a later replay of the same seq now succeeds (say the allowlist was fixed in between), `onConflictDoNothing` keeps the older row. That row remains truthful about what was refused at the time, and the new order's `sync_conflicts` carries the current picture — no correction is needed.

- [ ] **Step 4: Run the test and watch it pass**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts
```

Expected: PASS, 6 tests, 0 skipped.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/test/pickup-rejections.e2e.test.ts
git add apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/test/pickup-rejections.e2e.test.ts
git commit -m "feat(api): log partial refusals to pickup_scan_rejections too"
```

---

### Task 4: `nextDeviceSeq` spans both tables

**Files:**

- Modify: `apps/api/src/modules/kiosk/pairing.service.ts`
- Test: `apps/api/test/pickup-rejections.e2e.test.ts` (append)

**Why:** `attemptRedeem` computes `nextDeviceSeq` as `MAX(device_seq) + 1` over `pickup_orders` alone. A rejection consumes a seq without creating an order, so after a re-pair the counter could hand back an already-spent number — and the next rejection at that seq would be silently swallowed by `onConflictDoNothing`.

- [ ] **Step 1: Write the failing test**

Append inside the `describe` block in `apps/api/test/pickup-rejections.e2e.test.ts`:

```ts
// A rejection consumes a device_seq without creating an order. If the
// re-pair counter only looked at orders it would hand that number back,
// and the replacement device's first rejection would collide with the old
// one and vanish.
it("continues device_seq past a number consumed only by a rejection", async () => {
  const pairKioskId = randomUUID();
  await db
    .insert(schema.kiosks)
    .values({ id: pairKioskId, tenantId, name: "Киоск-2", dayLimitPerEmployee: 20 });
  await db.insert(schema.pickupScanRejections).values({
    tenantId,
    kioskId: pairKioskId,
    employeeId,
    deviceSeq: 77,
    codes: [{ rawKm: REFUSED_KM, reason: "not_allowed" }],
    scannedAt: new Date(),
  });

  // Route, `.send({})` and status match apps/api/test/kiosk-pairing.e2e.test.ts,
  // which is the reference for this flow.
  const issued = await agent.post(`/kiosks/${pairKioskId}/pairing-code`).send({}).expect(201);
  const paired = await request(app!.getHttpServer())
    .post("/kiosk/pair")
    .send({ code: issued.body.code })
    .expect(201);

  expect(paired.body.nextDeviceSeq).toBe(78);
});
```

Note: `POST /kiosk/pair` is rate-limited per source and globally (`kiosk_pair_attempts`). This test spends one attempt. If it starts failing with `401` for no clear reason after repeated local runs, check how `kiosk-pairing.e2e.test.ts` resets that budget between runs and do the same.

- [ ] **Step 2: Run the test and watch it fail**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts
```

Expected: FAIL — `expected 0 to be 78`.

- [ ] **Step 3: Widen the MAX**

In `apps/api/src/modules/kiosk/pairing.service.ts`, replace the `const [seq] = await tx.select({ max: max(schema.pickupOrders.deviceSeq) })…` block and the `return` that follows it with:

```ts
const [orderSeq] = await tx
  .select({ max: max(schema.pickupOrders.deviceSeq) })
  .from(schema.pickupOrders)
  .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.kioskId, kioskId)));

// Rejections share the order idempotency key space but create no
// order, so a MAX over orders alone would hand this device a seq a
// rejection already spent -- and its next rejection would be dropped
// as a replay. This read rides the kiosk row lock taken above; the
// rejection INSERT deliberately does not take that lock, so an
// in-flight one can still land after this read. That residual race
// costs at most one missing journal row, whereas for orders the same
// race would lose an order -- which is what the lock is there for.
const [rejectionSeq] = await tx
  .select({ max: max(schema.pickupScanRejections.deviceSeq) })
  .from(schema.pickupScanRejections)
  .where(
    and(
      eq(schema.pickupScanRejections.tenantId, tenantId),
      eq(schema.pickupScanRejections.kioskId, kioskId),
    ),
  );

const highest = Math.max(orderSeq?.max ?? -1, rejectionSeq?.max ?? -1);
return { kiosk, nextDeviceSeq: highest + 1 };
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts test/kiosk-pairing.e2e.test.ts
```

Expected: PASS in both suites, 0 skipped.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/api/src/modules/kiosk/pairing.service.ts apps/api/test/pickup-rejections.e2e.test.ts
git add apps/api/src/modules/kiosk/pairing.service.ts apps/api/test/pickup-rejections.e2e.test.ts
git commit -m "fix(api): nextDeviceSeq must clear seqs spent by rejections"
```

---

### Task 5: Cabinet API — list and acknowledge

**Files:**

- Create: `apps/api/src/modules/pickup-rejections/dto.ts`
- Create: `apps/api/src/modules/pickup-rejections/pickup-rejections.service.ts`
- Create: `apps/api/src/modules/pickup-rejections/pickup-rejections.controller.ts`
- Create: `apps/api/src/modules/pickup-rejections/pickup-rejections.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/pickup-rejections.e2e.test.ts` (append)

**Interfaces:**

- Produces: `GET /pickup-rejections` → `{ items: PickupScanRejectionRowDto[]; openCount: number }`; `POST /pickup-rejections/:id/acknowledge` → `PickupScanRejectionRowDto`. Task 6's admin types mirror these names exactly.

- [ ] **Step 1: Write the failing e2e tests**

Append inside the `describe` block in `apps/api/test/pickup-rejections.e2e.test.ts`:

```ts
it("lists rejections for the tenant with an open count", async () => {
  const res = await agent.get("/pickup-rejections").expect(200);

  expect(res.body.openCount).toBeGreaterThan(0);
  const row = res.body.items.find(
    (r: { deviceSeq: number; kioskId: string }) => r.deviceSeq === 10 && r.kioskId === kioskId,
  );
  expect(row.kind).toBe("items_refused");
  expect(row.kioskName).toBe("Киоск-1");
  expect(row.employeeName).toBe("Иван Иванов");
  expect(row.orderNo).toBeNull();
  expect(row.codes).toHaveLength(2);
  expect(row.acknowledgedAt).toBeNull();
});

it("reports an unrecognised badge as its own kind", async () => {
  const res = await agent.get("/pickup-rejections").expect(200);
  const row = res.body.items.find((r: { deviceSeq: number }) => r.deviceSeq === 12);

  expect(row.kind).toBe("unknown_badge");
  expect(row.employeeName).toBeNull();
  expect(row.badgeCode).toBe("badge-that-never-existed");
});

it("links a partial refusal to its order number", async () => {
  const res = await agent.get("/pickup-rejections").expect(200);
  const row = res.body.items.find((r: { deviceSeq: number }) => r.deviceSeq === 14);

  expect(row.orderId).not.toBeNull();
  expect(row.orderNo).toMatch(/^ORD-/);
});

it("acknowledges a rejection and drops it from the open count", async () => {
  const before = await agent.get("/pickup-rejections?state=open").expect(200);
  const target = before.body.items.find((r: { deviceSeq: number }) => r.deviceSeq === 10);
  expect(target).toBeDefined();

  const acked = await agent.post(`/pickup-rejections/${target.id}/acknowledge`).expect(200);
  expect(acked.body.acknowledgedAt).not.toBeNull();

  const after = await agent.get("/pickup-rejections?state=open").expect(200);
  expect(after.body.openCount).toBe(before.body.openCount - 1);
  expect(after.body.items.some((r: { id: string }) => r.id === target.id)).toBe(false);

  const ackedOnly = await agent.get("/pickup-rejections?state=acknowledged").expect(200);
  expect(ackedOnly.body.items.some((r: { id: string }) => r.id === target.id)).toBe(true);
});

it("filters by kiosk", async () => {
  const res = await agent.get(`/pickup-rejections?kioskId=${kioskId}`).expect(200);
  expect(res.body.items.every((r: { kioskId: string }) => r.kioskId === kioskId)).toBe(true);
});

it("404s acknowledging a rejection of another tenant", async () => {
  const other = request.agent(app!.getHttpServer());
  await signUpAndActivate(other);
  const mine = await agent.get("/pickup-rejections").expect(200);

  await other.post(`/pickup-rejections/${mine.body.items[0].id}/acknowledge`).expect(404);
  const theirs = await other.get("/pickup-rejections").expect(200);
  expect(theirs.body.items).toHaveLength(0);
});

// Cabinet-only surface: a device key must never reach it (docs/device-key-surface.md).
it("refuses a kiosk device token on both routes", async () => {
  await request(app!.getHttpServer())
    .get("/pickup-rejections")
    .set("x-kiosk-token", TOKEN)
    .expect(401);
  await request(app!.getHttpServer())
    .post(`/pickup-rejections/${randomUUID()}/acknowledge`)
    .set("x-kiosk-token", TOKEN)
    .expect(401);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts
```

Expected: FAIL — the new tests get 404 from an unregistered route.

- [ ] **Step 3: Write the DTOs**

Create `apps/api/src/modules/pickup-rejections/dto.ts`:

```ts
import { z } from "zod";
import type { OrderConflict } from "../pickup-orders/dto";

/**
 * The kiosk's own six refusal reasons plus `unknown_badge`, which only this
 * table can carry: it happens before any item is examined, so it can never
 * appear in `POST /kiosk/orders`' response and must not widen
 * `OrderConflict`.
 */
export type ScanRejectionReason = OrderConflict["reason"] | "unknown_badge";

export interface ScanRejectionCode {
  rawKm: string;
  reason: ScanRejectionReason;
}

/** `YYYY-MM-DD`. */
const dateOnlySchema = z.string().date();

/**
 * `GET /pickup-rejections` query. `from`/`to` filter on `syncedAt` -- when
 * the server learned -- inclusive whole days, matching the list's own sort.
 */
export const listPickupRejectionsQuerySchema = z.object({
  kioskId: z.string().uuid().optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  state: z.enum(["open", "acknowledged", "all"]).default("all"),
});
export type ListPickupRejectionsQueryDto = z.infer<typeof listPickupRejectionsQuerySchema>;

export interface PickupScanRejectionRowDto {
  id: string;
  /** Derived from `employeeId === null`; the DB check constraint keeps it honest. */
  kind: "items_refused" | "unknown_badge";
  kioskId: string;
  kioskName: string;
  employeeName: string | null;
  badgeCode: string | null;
  orderId: string | null;
  orderNo: string | null;
  deviceSeq: number;
  codes: ScanRejectionCode[];
  scannedAt: Date;
  syncedAt: Date;
  acknowledgedAt: Date | null;
}

/**
 * `openCount` counts EVERY unacknowledged rejection in the tenant and
 * ignores the query's filters: it feeds the свод banner, which needs a
 * stable global number rather than the size of whatever the admin last
 * filtered to.
 */
export interface ListPickupRejectionsResponseDto {
  items: PickupScanRejectionRowDto[];
  openCount: number;
}
```

- [ ] **Step 4: Write the service**

Create `apps/api/src/modules/pickup-rejections/pickup-rejections.service.ts`:

```ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  ListPickupRejectionsQueryDto,
  ListPickupRejectionsResponseDto,
  PickupScanRejectionRowDto,
  ScanRejectionCode,
} from "./dto";

/**
 * Read side of `pickup_scan_rejections`. The WRITES live in
 * `PickupOrdersService`, where the order transaction they must join already
 * is; this service only lists and acknowledges, which is why it can stay a
 * separate module instead of growing that ~1000-line one further.
 */
@Injectable()
export class PickupRejectionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(
    tenantId: string,
    query: ListPickupRejectionsQueryDto,
  ): Promise<ListPickupRejectionsResponseDto> {
    const conditions: SQL[] = [eq(schema.pickupScanRejections.tenantId, tenantId)];
    if (query.kioskId) conditions.push(eq(schema.pickupScanRejections.kioskId, query.kioskId));
    if (query.from)
      conditions.push(
        gte(schema.pickupScanRejections.syncedAt, new Date(`${query.from}T00:00:00.000Z`)),
      );
    if (query.to)
      conditions.push(
        lte(schema.pickupScanRejections.syncedAt, new Date(`${query.to}T23:59:59.999Z`)),
      );
    if (query.state === "open") conditions.push(isNull(schema.pickupScanRejections.acknowledgedAt));
    if (query.state === "acknowledged")
      conditions.push(isNotNull(schema.pickupScanRejections.acknowledgedAt));

    const items = await this.queryRows(conditions);

    // Deliberately NOT filtered by `conditions` -- see the DTO's doc comment.
    const [open] = await this.db
      .select({ value: count() })
      .from(schema.pickupScanRejections)
      .where(
        and(
          eq(schema.pickupScanRejections.tenantId, tenantId),
          isNull(schema.pickupScanRejections.acknowledgedAt),
        ),
      );

    return { items, openCount: open?.value ?? 0 };
  }

  async acknowledge(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<PickupScanRejectionRowDto> {
    const [updated] = await this.db
      .update(schema.pickupScanRejections)
      .set({ acknowledgedAt: new Date(), acknowledgedByUserId: userId })
      .where(
        and(
          eq(schema.pickupScanRejections.tenantId, tenantId),
          eq(schema.pickupScanRejections.id, id),
        ),
      )
      .returning({ id: schema.pickupScanRejections.id });

    if (!updated) throw new NotFoundException();

    const [row] = await this.queryRows([
      eq(schema.pickupScanRejections.tenantId, tenantId),
      eq(schema.pickupScanRejections.id, id),
    ]);
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Newest sync first -- what an admin opening the page wants at the top. */
  private async queryRows(conditions: SQL[]): Promise<PickupScanRejectionRowDto[]> {
    const rows = await this.db
      .select({
        id: schema.pickupScanRejections.id,
        kioskId: schema.pickupScanRejections.kioskId,
        kioskName: schema.kiosks.name,
        employeeId: schema.pickupScanRejections.employeeId,
        employeeName: schema.employees.fullName,
        badgeCode: schema.pickupScanRejections.badgeCode,
        orderId: schema.pickupScanRejections.orderId,
        orderNo: schema.pickupOrders.orderNo,
        deviceSeq: schema.pickupScanRejections.deviceSeq,
        codes: schema.pickupScanRejections.codes,
        scannedAt: schema.pickupScanRejections.scannedAt,
        syncedAt: schema.pickupScanRejections.syncedAt,
        acknowledgedAt: schema.pickupScanRejections.acknowledgedAt,
      })
      .from(schema.pickupScanRejections)
      .leftJoin(schema.kiosks, eq(schema.kiosks.id, schema.pickupScanRejections.kioskId))
      .leftJoin(schema.employees, eq(schema.employees.id, schema.pickupScanRejections.employeeId))
      .leftJoin(
        schema.pickupOrders,
        eq(schema.pickupOrders.id, schema.pickupScanRejections.orderId),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.pickupScanRejections.syncedAt));

    return rows.map((row) => ({
      id: row.id,
      kind: row.employeeId === null ? ("unknown_badge" as const) : ("items_refused" as const),
      kioskId: row.kioskId,
      kioskName: row.kioskName ?? "",
      employeeName: row.employeeName,
      badgeCode: row.badgeCode,
      orderId: row.orderId,
      orderNo: row.orderNo,
      deviceSeq: row.deviceSeq,
      codes: row.codes as ScanRejectionCode[],
      scannedAt: row.scannedAt,
      syncedAt: row.syncedAt,
      acknowledgedAt: row.acknowledgedAt,
    }));
  }
}
```

- [ ] **Step 5: Write the controller and module**

Create `apps/api/src/modules/pickup-rejections/pickup-rejections.controller.ts`:

```ts
import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  listPickupRejectionsQuerySchema,
  type ListPickupRejectionsQueryDto,
  type ListPickupRejectionsResponseDto,
  type PickupScanRejectionRowDto,
} from "./dto";
import { PickupRejectionsService } from "./pickup-rejections.service";

// Cabinet-only: the kiosk device talks to /kiosk/* behind KioskDeviceGuard and
// never needs this module, so no device key — station or kiosk — should reach
// it (see docs/device-key-surface.md).
@ApiTags("pickup-rejections")
@Controller("pickup-rejections")
@UseGuards(TenantGuard, SessionOnlyGuard)
export class PickupRejectionsController {
  constructor(private readonly pickupRejectionsService: PickupRejectionsService) {}

  @Get()
  async list(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listPickupRejectionsQuerySchema))
    query: ListPickupRejectionsQueryDto,
  ): Promise<ListPickupRejectionsResponseDto> {
    return this.pickupRejectionsService.list(req.tenantId!, query);
  }

  @Post(":id/acknowledge")
  @HttpCode(200)
  async acknowledge(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<PickupScanRejectionRowDto> {
    return this.pickupRejectionsService.acknowledge(req.tenantId!, id, req.userId!);
  }
}
```

Create `apps/api/src/modules/pickup-rejections/pickup-rejections.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { PickupRejectionsController } from "./pickup-rejections.controller";
import { PickupRejectionsService } from "./pickup-rejections.service";

@Module({
  controllers: [PickupRejectionsController],
  providers: [PickupRejectionsService],
})
export class PickupRejectionsModule {}
```

- [ ] **Step 6: Register the module**

In `apps/api/src/app.module.ts`, add the import next to the other pickup ones:

```ts
import { PickupRejectionsModule } from "./modules/pickup-rejections/pickup-rejections.module";
```

and add `PickupRejectionsModule,` to the `imports` array immediately after `PickupOrdersModule,`.

- [ ] **Step 7: Run the tests and watch them pass**

```bash
set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts
```

Expected: PASS, 14 tests, 0 skipped.

- [ ] **Step 8: Typecheck, format, commit**

```bash
pnpm --filter @markiro/api typecheck
npx prettier --write apps/api/src/modules/pickup-rejections apps/api/src/app.module.ts apps/api/test/pickup-rejections.e2e.test.ts
git add apps/api/src/modules/pickup-rejections apps/api/src/app.module.ts apps/api/test/pickup-rejections.e2e.test.ts
git commit -m "feat(api): cabinet routes to list and acknowledge scan rejections"
```

---

### Task 6: Admin — banner, page, i18n

**Files:**

- Create: `apps/admin/src/pages/pickup/rejections-api.ts`
- Create: `apps/admin/src/pages/pickup/Rejections.tsx`
- Modify: `apps/admin/src/pages/pickup/index.tsx`, `apps/admin/src/app.tsx`, `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/pickup-rejections.test.tsx` (create)

**Interfaces:**

- Consumes: `GET /pickup-rejections`, `POST /pickup-rejections/:id/acknowledge` (Task 5).

- [ ] **Step 1: Add the i18n keys**

In `apps/admin/src/i18n/ru.json`, add `"unknown_badge": "бейдж не опознан"` to the existing `pages.pickup.conflicts.reason` object (after `over_limit`), and add this `rejections` object inside `pages.pickup` (after `conflicts`):

```json
"rejections": {
  "title": "Отклонённые сканы",
  "bannerTitle": "Отклонённые сканы: {{count}}",
  "bannerKiosks": "Киоски: {{kiosks}}",
  "bannerMore": "и ещё {{count}}",
  "bannerAction": "Разобрать",
  "backAction": "← Заявки",
  "emptyTitle": "Отклонённых сканов нет",
  "emptyHint": "Здесь появятся сканы, коды которых сервер не принял: например, товара нет в каталоге или бейдж уже отозван.",
  "filters": {
    "kioskLabel": "Киоск",
    "kioskAll": "Все киоски",
    "stateLabel": "Состояние",
    "fromLabel": "С даты",
    "toLabel": "По дату",
    "state": {
      "all": "Все",
      "open": "Не отработаны",
      "acknowledged": "Отработаны"
    }
  },
  "table": {
    "syncedAt": "Синхронизировано",
    "scannedAt": "Сканировано",
    "kioskName": "Киоск",
    "employeeName": "Сотрудник",
    "codeCount": "Кодов",
    "order": "Заявка",
    "state": "Состояние",
    "actions": "Действия"
  },
  "unknownBadge": "Бейдж не опознан",
  "badgeCodeLabel": "Бейдж: {{code}}",
  "noOrder": "без заявки",
  "state": {
    "open": "Не отработан",
    "acknowledged": "Отработан"
  },
  "acknowledgeAction": "Отработано",
  "showCodes": "Показать коды",
  "hideCodes": "Скрыть коды",
  "toasts": {
    "acknowledged": "Отмечено как отработанное",
    "acknowledgeError": "Не удалось отметить. Обновите страницу."
  }
}
```

In `apps/admin/src/i18n/en.json`, add `"unknown_badge": "badge not recognised"` to `pages.pickup.conflicts.reason`, and the parallel object:

```json
"rejections": {
  "title": "Rejected scans",
  "bannerTitle": "Rejected scans: {{count}}",
  "bannerKiosks": "Kiosks: {{kiosks}}",
  "bannerMore": "and {{count}} more",
  "bannerAction": "Review",
  "backAction": "← Orders",
  "emptyTitle": "No rejected scans",
  "emptyHint": "Scans whose codes the server refused will appear here — for example, a product missing from the catalogue or a badge already revoked.",
  "filters": {
    "kioskLabel": "Kiosk",
    "kioskAll": "All kiosks",
    "stateLabel": "State",
    "fromLabel": "From",
    "toLabel": "To",
    "state": {
      "all": "All",
      "open": "Open",
      "acknowledged": "Handled"
    }
  },
  "table": {
    "syncedAt": "Synced",
    "scannedAt": "Scanned",
    "kioskName": "Kiosk",
    "employeeName": "Employee",
    "codeCount": "Codes",
    "order": "Order",
    "state": "State",
    "actions": "Actions"
  },
  "unknownBadge": "Badge not recognised",
  "badgeCodeLabel": "Badge: {{code}}",
  "noOrder": "no order",
  "state": {
    "open": "Open",
    "acknowledged": "Handled"
  },
  "acknowledgeAction": "Handled",
  "showCodes": "Show codes",
  "hideCodes": "Hide codes",
  "toasts": {
    "acknowledged": "Marked as handled",
    "acknowledgeError": "Could not mark it. Refresh the page."
  }
}
```

- [ ] **Step 2: Run the i18n lockstep test**

```bash
pnpm --filter @markiro/admin exec vitest run test/i18n.test.tsx
```

Expected: PASS. A failure here means the RU and EN key sets diverged — fix the mismatch before continuing.

- [ ] **Step 3: Write the failing admin test**

Create `apps/admin/test/pickup-rejections.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PickupPage } from "../src/pages/pickup/index.js";
import { RejectionsPage } from "../src/pages/pickup/Rejections.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const REJECTION = {
  id: "r-1",
  kind: "items_refused",
  kioskId: "k-1",
  kioskName: "Киоск-1",
  employeeName: "Иван Иванов",
  badgeCode: null,
  orderId: null,
  orderNo: null,
  deviceSeq: 10,
  codes: [{ rawKm: "0104600682000020215X", reason: "not_allowed" }],
  scannedAt: "2026-07-28T06:00:00.000Z",
  syncedAt: "2026-07-28T09:00:00.000Z",
  acknowledgedAt: null,
};

const UNKNOWN_BADGE_REJECTION = {
  ...REJECTION,
  id: "r-2",
  kind: "unknown_badge",
  employeeName: null,
  badgeCode: "badge-gone",
  deviceSeq: 12,
  codes: [{ rawKm: "0104600682000013215Y", reason: "unknown_badge" }],
};

function renderWith(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("rejections banner on the свод", () => {
  it("stays hidden when nothing is open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("/pickup-rejections")
          ? jsonResponse(200, { items: [], openCount: 0 })
          : jsonResponse(200, { items: [] }),
      ),
    );

    renderWith(<PickupPage />);

    await waitFor(() => expect(screen.getByText("Заявок пока нет")).toBeDefined());
    expect(screen.queryByText(/Отклонённые сканы:/)).toBeNull();
  });

  it("shows the count and kiosks when something is open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("/pickup-rejections")
          ? jsonResponse(200, { items: [REJECTION], openCount: 3 })
          : jsonResponse(200, { items: [] }),
      ),
    );

    renderWith(<PickupPage />);

    await waitFor(() => expect(screen.getByText("Отклонённые сканы: 3")).toBeDefined());
    expect(screen.getByText(/Киоск-1/)).toBeDefined();
  });
});

describe("rejections page", () => {
  it("lists a refused scan and reveals its codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [REJECTION], openCount: 1 })),
    );

    renderWith(<RejectionsPage />);

    await waitFor(() => expect(screen.getByText("Иван Иванов")).toBeDefined());
    expect(screen.getByText("без заявки")).toBeDefined();
    expect(screen.queryByText(/0104600682000020215X/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Показать коды" }));

    expect(screen.getByText(/0104600682000020215X/)).toBeDefined();
    expect(screen.getByText(/товар недоступен на киоске/)).toBeDefined();
  });

  it("labels a scan whose badge was not recognised", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [UNKNOWN_BADGE_REJECTION], openCount: 1 })),
    );

    renderWith(<RejectionsPage />);

    await waitFor(() => expect(screen.getByText("Бейдж не опознан")).toBeDefined());
    expect(screen.getByText("Бейдж: badge-gone")).toBeDefined();
  });

  it("acknowledges a rejection", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(200, { ...REJECTION, acknowledgedAt: "2026-07-28T10:00:00.000Z" });
      }
      return jsonResponse(200, { items: [REJECTION], openCount: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWith(<RejectionsPage />);

    await waitFor(() => expect(screen.getByText("Иван Иванов")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Отработано" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/pickup-rejections/r-1/acknowledge") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("shows the empty state when there is nothing to review", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [], openCount: 0 })),
    );

    renderWith(<RejectionsPage />);

    await waitFor(() => expect(screen.getByText("Отклонённых сканов нет")).toBeDefined());
  });
});
```

- [ ] **Step 4: Run the test and watch it fail**

```bash
pnpm --filter @markiro/admin exec vitest run test/pickup-rejections.test.tsx
```

Expected: FAIL — `Failed to resolve import "../src/pages/pickup/Rejections.js"`.

- [ ] **Step 5: Write the API hooks**

Create `apps/admin/src/pages/pickup/rejections-api.ts`:

```ts
/**
 * Typed fetchers + TanStack Query hooks for `GET /pickup-rejections` and
 * `POST /pickup-rejections/:id/acknowledge`. Kept out of `./api.ts` (already
 * ~250 lines covering the orders endpoints) so each file stays readable.
 * Same `apiFetch` wrapper and filtered-list query-key pattern as `./api.ts`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/pickup-rejections/dto.ts`'s `ScanRejectionReason`. */
export type ScanRejectionReason =
  | "not_km"
  | "incomplete"
  | "unknown_product"
  | "not_allowed"
  | "duplicate"
  | "over_limit"
  | "unknown_badge";

export interface ScanRejectionCode {
  rawKm: string;
  reason: ScanRejectionReason;
}

/** Mirrors `apps/api/src/modules/pickup-rejections/dto.ts`'s `PickupScanRejectionRowDto`. */
export interface PickupScanRejectionRowDto {
  id: string;
  kind: "items_refused" | "unknown_badge";
  kioskId: string;
  kioskName: string;
  employeeName: string | null;
  badgeCode: string | null;
  orderId: string | null;
  orderNo: string | null;
  deviceSeq: number;
  codes: ScanRejectionCode[];
  scannedAt: string;
  syncedAt: string;
  acknowledgedAt: string | null;
}

export type RejectionState = "open" | "acknowledged" | "all";

export interface ListRejectionsParams {
  kioskId?: string;
  from?: string;
  to?: string;
  state?: RejectionState;
}

export interface ListRejectionsResponse {
  items: PickupScanRejectionRowDto[];
  openCount: number;
}

/** Shared cache key prefix for every rejections list variant. */
export const PICKUP_REJECTIONS_QUERY_KEY = ["pickup-rejections"] as const;

function rejectionsQueryKey(params: ListRejectionsParams) {
  return [...PICKUP_REJECTIONS_QUERY_KEY, params] as const;
}

function buildListPath(params: ListRejectionsParams): string {
  const query = new URLSearchParams();
  if (params.kioskId) query.set("kioskId", params.kioskId);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.state) query.set("state", params.state);
  const qs = query.toString();
  return qs ? `/pickup-rejections?${qs}` : "/pickup-rejections";
}

function fetchRejections(params: ListRejectionsParams): Promise<ListRejectionsResponse> {
  return apiFetch<ListRejectionsResponse>(buildListPath(params));
}

function postAcknowledge(id: string): Promise<PickupScanRejectionRowDto> {
  return apiFetch<PickupScanRejectionRowDto>(`/pickup-rejections/${id}/acknowledge`, {
    method: "POST",
  });
}

/** `GET /pickup-rejections` -- the tenant's refused scans, optionally filtered. */
export function usePickupRejections(
  params: ListRejectionsParams = {},
): UseQueryResult<ListRejectionsResponse> {
  return useQuery({
    queryKey: rejectionsQueryKey(params),
    queryFn: () => fetchRejections(params),
  });
}

/**
 * Feeds the свод banner: the count of unacknowledged rejections plus the
 * kiosks they came from. `openCount` is the server's global figure, so the
 * banner never disagrees with itself as filters change on the page.
 */
export function useOpenRejectionSummary(): { openCount: number; kioskNames: string[] } {
  const { data } = usePickupRejections({ state: "open" });
  const kioskNames = [...new Set((data?.items ?? []).map((row) => row.kioskName))].filter(Boolean);
  return { openCount: data?.openCount ?? 0, kioskNames };
}

/** `POST /pickup-rejections/:id/acknowledge`. Invalidates every rejections query variant. */
export function useAcknowledgeRejection(): UseMutationResult<
  PickupScanRejectionRowDto,
  Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postAcknowledge,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PICKUP_REJECTIONS_QUERY_KEY });
    },
  });
}
```

- [ ] **Step 6: Write the page**

Create `apps/admin/src/pages/pickup/Rejections.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  Alert,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { formatCreatedAt } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import {
  useAcknowledgeRejection,
  usePickupRejections,
  type PickupScanRejectionRowDto,
  type RejectionState,
} from "./rejections-api.js";

/**
 * «Для себя» → отклонённые сканы. The durable home for codes the server
 * refused: partial refusals (which also live on the order) and, crucially,
 * whole sessions that produced no order at all — those have nowhere else to
 * be seen. Reached from the warn banner on the свод.
 */
export function RejectionsPage() {
  const { t, i18n } = useTranslation();

  const [stateFilter, setStateFilter] = useState<RejectionState>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isPending, isError } = usePickupRejections({
    state: stateFilter,
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  });
  const acknowledge = useAcknowledgeRejection();

  const items = data?.items ?? [];

  const stateOptions: SelectOption[] = [
    { value: "all", label: t("pages.pickup.rejections.filters.state.all") },
    { value: "open", label: t("pages.pickup.rejections.filters.state.open") },
    { value: "acknowledged", label: t("pages.pickup.rejections.filters.state.acknowledged") },
  ];

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAcknowledge = async (id: string) => {
    try {
      await acknowledge.mutateAsync(id);
      toast("ok", t("pages.pickup.rejections.toasts.acknowledged"));
    } catch {
      toast("error", t("pages.pickup.rejections.toasts.acknowledgeError"));
    }
  };

  const columns: TableColumn<PickupScanRejectionRowDto>[] = [
    {
      key: "syncedAt",
      title: t("pages.pickup.rejections.table.syncedAt"),
      mono: true,
      render: (row) => formatCreatedAt(row.syncedAt, i18n.language),
    },
    {
      key: "scannedAt",
      title: t("pages.pickup.rejections.table.scannedAt"),
      mono: true,
      render: (row) => formatCreatedAt(row.scannedAt, i18n.language),
    },
    { key: "kioskName", title: t("pages.pickup.rejections.table.kioskName") },
    {
      key: "employeeName",
      title: t("pages.pickup.rejections.table.employeeName"),
      render: (row) =>
        row.kind === "unknown_badge" ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span>{t("pages.pickup.rejections.unknownBadge")}</span>
            <span style={{ font: "var(--text-code)", color: "var(--fg-2)" }}>
              {t("pages.pickup.rejections.badgeCodeLabel", { code: row.badgeCode ?? "" })}
            </span>
          </div>
        ) : (
          (row.employeeName ?? "—")
        ),
    },
    {
      key: "codeCount",
      title: t("pages.pickup.rejections.table.codeCount"),
      align: "right",
      mono: true,
      render: (row) => (
        <Button
          type="button"
          variant="secondary"
          size="compact"
          onClick={() => toggleExpanded(row.id)}
        >
          {expanded.has(row.id)
            ? t("pages.pickup.rejections.hideCodes")
            : t("pages.pickup.rejections.showCodes")}
        </Button>
      ),
    },
    {
      key: "order",
      title: t("pages.pickup.rejections.table.order"),
      mono: true,
      render: (row) =>
        row.orderId ? (
          <Link to={`/pickup/${row.orderId}`} style={{ color: "inherit" }}>
            {row.orderNo}
          </Link>
        ) : (
          <span style={{ color: "var(--fg-2)" }}>{t("pages.pickup.rejections.noOrder")}</span>
        ),
    },
    {
      key: "state",
      title: t("pages.pickup.rejections.table.state"),
      render: (row) => (
        <StatusChip
          status={row.acknowledgedAt ? "ok" : "warn"}
          label={
            row.acknowledgedAt
              ? t("pages.pickup.rejections.state.acknowledged")
              : t("pages.pickup.rejections.state.open")
          }
        />
      ),
    },
    {
      key: "actions",
      title: t("pages.pickup.rejections.table.actions"),
      render: (row) =>
        row.acknowledgedAt ? null : (
          <Button
            type="button"
            size="compact"
            loading={acknowledge.isPending}
            onClick={() => void handleAcknowledge(row.id)}
          >
            {t("pages.pickup.rejections.acknowledgeAction")}
          </Button>
        ),
    },
  ];

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.pickup.rejections.title")}
        actions={
          <Link to="/pickup" style={{ color: "inherit" }}>
            {t("pages.pickup.rejections.backAction")}
          </Link>
        }
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.pickup.rejections.filters.stateLabel")}
            options={stateOptions}
            value={stateFilter}
            onChange={(value) => setStateFilter(value as RejectionState)}
          />
        </div>
        <div style={{ width: 180 }}>
          <Input
            label={t("pages.pickup.rejections.filters.fromLabel")}
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
        </div>
        <div style={{ width: 180 }}>
          <Input
            label={t("pages.pickup.rejections.filters.toLabel")}
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
          />
        </div>
      </div>

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.pickup.rejections.emptyTitle")}
          hint={t("pages.pickup.rejections.emptyHint")}
        />
      ) : (
        <>
          <Table columns={columns} rows={items} />
          {items
            .filter((row) => expanded.has(row.id))
            .map((row) => (
              <Alert
                key={row.id}
                tone="warn"
                title={t("pages.pickup.conflicts.title", { count: row.codes.length })}
              >
                <ul style={{ margin: 0, paddingInlineStart: "var(--sp-5)" }}>
                  {row.codes.map((code, index) => (
                    <li key={`${code.rawKm}:${index}`} style={{ font: "var(--text-code)" }}>
                      {code.rawKm} — {t(`pages.pickup.conflicts.reason.${code.reason}`)}
                    </li>
                  ))}
                </ul>
              </Alert>
            ))}
        </>
      )}
    </div>
  );
}
```

(`ButtonVariant` is `"primary" | "secondary" | "destructive"` — there is no flatter variant to reach for.)

- [ ] **Step 7: Add the banner to the свод**

In `apps/admin/src/pages/pickup/index.tsx`:

Add `Link` usage (already imported) and these imports after the existing `./api.js` import block:

```ts
import { useOpenRejectionSummary } from "./rejections-api.js";
```

Inside `PickupPage`, after `const exportMutation = useExportCodes();`, add:

```ts
const rejections = useOpenRejectionSummary();
const shownKiosks = rejections.kioskNames.slice(0, 3);
const hiddenKioskCount = rejections.kioskNames.length - shownKiosks.length;
```

Then, in the returned JSX, immediately after the closing `/>` of `<PageHeader … />`, insert:

```tsx
{
  rejections.openCount > 0 && (
    <Alert
      tone="warn"
      title={t("pages.pickup.rejections.bannerTitle", { count: rejections.openCount })}
      action={
        <Link to="/pickup/rejections" style={{ color: "inherit" }}>
          {t("pages.pickup.rejections.bannerAction")}
        </Link>
      }
    >
      {shownKiosks.length > 0 &&
        t("pages.pickup.rejections.bannerKiosks", { kiosks: shownKiosks.join(", ") })}
      {hiddenKioskCount > 0 &&
        ` ${t("pages.pickup.rejections.bannerMore", { count: hiddenKioskCount })}`}
    </Alert>
  );
}
```

- [ ] **Step 8: Register the route**

In `apps/admin/src/app.tsx`, add the import next to the other pickup pages:

```ts
import { RejectionsPage } from "./pages/pickup/Rejections.js";
```

and add the route **before** `<Route path="pickup/:id" …>` so the intent is obvious at a glance (react-router ranks the static segment higher regardless, and Step 9 asserts it):

```tsx
<Route path="pickup/rejections" element={<RejectionsPage />} />
```

- [ ] **Step 9: Add the route-ranking test**

Append to `apps/admin/test/pickup-rejections.test.tsx`:

```tsx
// `/pickup/rejections` must not be swallowed by `/pickup/:id`. React Router
// ranks the static segment above the dynamic one, but that ranking is a
// framework behaviour this page's URL now depends on, so assert it.
describe("routing", () => {
  it("resolves /pickup/rejections to the rejections page, not the order detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [], openCount: 0 })),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/pickup/rejections"]}>
          <Routes>
            <Route path="/pickup/rejections" element={<RejectionsPage />} />
            <Route path="/pickup/:id" element={<div>order detail</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("Отклонённые сканы")).toBeDefined());
    expect(screen.queryByText("order detail")).toBeNull();
  });
});
```

Add `Route, Routes` to the `react-router` import at the top of that file.

- [ ] **Step 10: Run the admin tests and watch them pass**

```bash
pnpm --filter @markiro/admin exec vitest run test/pickup-rejections.test.tsx test/pickup.test.tsx test/i18n.test.tsx
```

Expected: PASS in all three suites.

`test/pickup.test.tsx` should need no changes: its mocks answer every URL with the orders shape, so the banner's query reads `openCount` as `undefined → 0` and the banner stays hidden, and its four `fetch` assertions all use `toHaveBeenCalledWith` rather than a call count, so the extra request is harmless. If something there does break anyway, make its `fetch` mock branch on `input.includes("/pickup-rejections")` the way the new test does.

- [ ] **Step 11: Typecheck, format, commit**

```bash
pnpm --filter @markiro/admin typecheck
npx prettier --write apps/admin/src/pages/pickup/Rejections.tsx apps/admin/src/pages/pickup/rejections-api.ts apps/admin/src/pages/pickup/index.tsx apps/admin/src/app.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/pickup-rejections.test.tsx
git add apps/admin/src apps/admin/test/pickup-rejections.test.tsx
git commit -m "feat(admin): rejected-scans page and свод banner in «Для себя»"
```

---

### Task 7: Full verification

**Files:** none — this task only runs things.

- [ ] **Step 1: Run the whole test suite**

```bash
set -a; . ./.env; set +a; pnpm test
```

Expected: PASS across `@markiro/db`, `@markiro/api`, `@markiro/admin`, `@markiro/domain`, `@markiro/ui`. Confirm the pickup suites report 0 skipped — a skip means `DATABASE_URL` did not reach vitest.

- [ ] **Step 2: Typecheck and lint the workspace**

```bash
pnpm typecheck && pnpm lint
```

Expected: no errors.

- [ ] **Step 3: Check formatting matches CI**

```bash
pnpm format:check
```

Expected: PASS. If it flags a file you did not touch, leave it alone and report it — CI's scope is the whole repo but this change's scope is not.

- [ ] **Step 4: Update the spec's status**

Append to `docs/superpowers/specs/2026-07-28-pickup-scan-rejections-design.md`:

```markdown
## Статус

Реализовано планом `docs/superpowers/plans/2026-07-28-pickup-scan-rejections.md`.
```

```bash
npx prettier --write docs/superpowers/specs/2026-07-28-pickup-scan-rejections-design.md
git add docs/superpowers/specs/2026-07-28-pickup-scan-rejections-design.md
git commit -m "docs(spec): mark scan-rejections design as implemented"
```
