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

/**
 * GTIN test vectors (check-digit VALID — computed with node + gs1CheckDigit,
 * see packages/domain/src/gs1/check-digit.ts). The plan/prototype's
 * "04650075195923" has an INVALID check digit and would make every scan
 * fail classification as `not_km` before it even reaches product
 * resolution — do not reuse it here.
 *   - GTIN            "04600682000013" — the allowlisted product on the main kiosk.
 *   - GTIN_NOT_ALLOWED "04600682000020" — a real product for this tenant, but never
 *                      added to the main kiosk's allowlist -> "not_allowed".
 *   - GTIN_UNKNOWN     "04600682000037" — no product row for this tenant at all -> "unknown_product".
 */
const GTIN = "04600682000013";
const GTIN_NOT_ALLOWED = "04600682000020";
const GTIN_UNKNOWN = "04600682000037";

/** GS (ASCII 0x1D) — the KM segment separator. Renders invisibly in prose/plans; use the real byte in fixtures. */
const GS = String.fromCharCode(0x1d);

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("kiosk orders e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let tenantId: string;
  let employeeId: string;
  let productId: string;
  let kioskId: string;
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

    const agent = request.agent(app!.getHttpServer());
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
    // A real product for this tenant that is deliberately NOT allowlisted on the main kiosk (-> not_allowed).
    await db.insert(schema.products).values({
      id: randomUUID(),
      tenantId,
      gtin14: GTIN_NOT_ALLOWED,
      name: "Другой товар",
    });

    kioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId, name: "Киоск А", dayLimitPerEmployee: 5 });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(TOKEN) })
      .where(eq(schema.kiosks.id, kioskId));
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpWithInactiveOrg(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "Passw0rd!123", name: "T" })
      .expect(200);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);

    return org.body.id as string;
  }

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  it("creates a pending order from valid KM scans and echoes the order number", async () => {
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 1,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN}21KYC9X7MQ${GS}93Abcd` }],
      })
      .expect(201);
    expect(res.body.orderNo).toMatch(/^ORD-\d{2}-\d{4,}$/);
    expect(res.body.status).toBe("pending");
    expect(res.body.itemCount).toBe(1);
    expect(res.body.conflicts).toHaveLength(0);
  });

  it("is idempotent on (kiosk, deviceSeq)", async () => {
    const body = {
      deviceSeq: 7,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: `01${GTIN}21ZZZ1${GS}93Abcd` }],
    };
    const a = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send(body)
      .expect(201);
    const b = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send(body)
      .expect(201);
    expect(b.body.orderNo).toBe(a.body.orderNo);
    expect(b.body.itemCount).toBe(a.body.itemCount);
  });

  it("flags a code whose GTIN has no product at all for this tenant as unknown_product", async () => {
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 2,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN_UNKNOWN}21S1${GS}93Abcd` }],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(0);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].reason).toMatch(/unknown_product|not_allowed/);
    expect(res.body.conflicts[0].reason).toBe("unknown_product");
  });

  it("flags a code for a real product that isn't on this kiosk's allowlist as not_allowed", async () => {
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 9,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN_NOT_ALLOWED}21S2${GS}93Abcd` }],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(0);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].reason).toBe("not_allowed");
  });

  it("rejects an unknown badge", async () => {
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 3, badgeCode: "NOPE", reason: "buy", items: [] })
      .expect(401);
  });

  it("rejects a non-revoked badge belonging to an archived employee", async () => {
    const archivedEmployeeId = randomUUID();
    const archivedBadge = `badge-archived-${randomUUID()}`;
    await db
      .insert(schema.employees)
      .values({ id: archivedEmployeeId, tenantId, fullName: "Архивов А." });
    await db
      .insert(schema.employeeBadges)
      .values({ tenantId, employeeId: archivedEmployeeId, badgeCode: archivedBadge });

    // Sanity: the badge works while the employee is still active.
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 11, badgeCode: archivedBadge, reason: "buy", items: [] })
      .expect(201);

    await db
      .update(schema.employees)
      .set({ status: "archived" })
      .where(eq(schema.employees.id, archivedEmployeeId));

    // The badge itself is still not revoked, but the employee behind it is archived -> unknown badge (401).
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 12, badgeCode: archivedBadge, reason: "buy", items: [] })
      .expect(401);
  });

  it("flags a not-a-KM scan and a KM missing its crypto tail (dropped GS) distinctly", async () => {
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 8,
        badgeCode: BADGE,
        reason: "buy",
        items: [
          { rawKm: "not-a-valid-code-at-all" },
          { rawKm: `01${GTIN}21INCOMP1` }, // no GS, no trailing AI 91/92/93 -> incomplete
        ],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(0);
    expect(res.body.conflicts).toEqual([
      { rawKm: "not-a-valid-code-at-all", reason: "not_km" },
      { rawKm: `01${GTIN}21INCOMP1`, reason: "incomplete" },
    ]);
  });

  it("requires a non-archived writeoffReasonId of this tenant for reason=writeoff", async () => {
    const missing = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 4, badgeCode: BADGE, reason: "writeoff", items: [] })
      .expect(400);
    expect(missing.body.message).toBeDefined();

    const archivedReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values({
      id: archivedReasonId,
      tenantId,
      name: "Просрочка",
      sortOrder: 0,
      archived: true,
    });
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 4,
        badgeCode: BADGE,
        reason: "writeoff",
        writeoffReasonId: archivedReasonId,
        items: [],
      })
      .expect(400);

    const activeReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values({
      id: activeReasonId,
      tenantId,
      name: "Брак",
      sortOrder: 0,
      archived: false,
    });
    const ok = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 4,
        badgeCode: BADGE,
        reason: "writeoff",
        writeoffReasonId: activeReasonId,
        items: [{ rawKm: `01${GTIN}21WRITEOFF1${GS}93Abcd` }],
      })
      .expect(201);
    expect(ok.body.itemCount).toBe(1);
    expect(ok.body.conflicts).toHaveLength(0);
  });

  it("converts a race against an already-open code (23505) into a duplicate conflict", async () => {
    // Seed a second, unrelated order that already holds this kmKey as an open item —
    // simulates a concurrent request winning the race on the DB's partial unique index.
    const seedOrderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: seedOrderId,
      tenantId,
      orderNo: `SEED-DUP-${randomUUID().slice(0, 8)}`,
      kioskId,
      employeeId,
      reason: "buy",
      status: "pending",
      itemCount: 1,
      deviceSeq: null,
    });
    await db.insert(schema.pickupOrderItems).values({
      id: randomUUID(),
      tenantId,
      orderId: seedOrderId,
      productId,
      gtin14: GTIN,
      serial: "DUPKEY1",
      rawKm: "seed-duplicate",
      kmKey: `01${GTIN}21DUPKEY1`,
      voided: false,
      scannedAt: new Date(),
    });

    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 10,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN}21DUPKEY1${GS}93Abcd` }],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(0);
    expect(res.body.conflicts).toEqual([
      { rawKm: `01${GTIN}21DUPKEY1${GS}93Abcd`, reason: "duplicate" },
    ]);
  });

  it("resolves two truly-concurrent POSTs with the same deviceSeq into a single order (no 500)", async () => {
    const body = {
      deviceSeq: 20,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: `01${GTIN}21CONC1${GS}93Abcd` }],
    };
    const [a, b] = await Promise.all([
      request(app!.getHttpServer()).post("/kiosk/orders").set("x-kiosk-token", TOKEN).send(body),
      request(app!.getHttpServer()).post("/kiosk/orders").set("x-kiosk-token", TOKEN).send(body),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.orderNo).toBe(b.body.orderNo);

    const orders = await db
      .select()
      .from(schema.pickupOrders)
      .where(
        and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.kioskId, kioskId),
          eq(schema.pickupOrders.deviceSeq, 20),
        ),
      );
    expect(orders).toHaveLength(1);
  });

  it("day-limit accepts up to dayLimitPerEmployee and marks the overflow over_limit", async () => {
    const limitKioskId = randomUUID();
    const limitBadge = `badge-limit-${randomUUID()}`;
    const limitEmployeeId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: limitEmployeeId, tenantId, fullName: "Лимитов Л." });
    await db
      .insert(schema.employeeBadges)
      .values({ tenantId, employeeId: limitEmployeeId, badgeCode: limitBadge });
    await db
      .insert(schema.kiosks)
      .values({ id: limitKioskId, tenantId, name: "Киоск-лимит", dayLimitPerEmployee: 2 });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId: limitKioskId, productId });
    const limitToken = `kiosk-token-limit-${randomUUID()}`;
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(limitToken) })
      .where(eq(schema.kiosks.id, limitKioskId));

    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", limitToken)
      .send({
        deviceSeq: 1,
        badgeCode: limitBadge,
        reason: "buy",
        items: [
          { rawKm: `01${GTIN}21LIM1${GS}93Abcd` },
          { rawKm: `01${GTIN}21LIM2${GS}93Abcd` },
          { rawKm: `01${GTIN}21LIM3${GS}93Abcd` },
        ],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(2);
    expect(res.body.conflicts).toEqual([
      { rawKm: `01${GTIN}21LIM3${GS}93Abcd`, reason: "over_limit" },
    ]);
  });

  it("bootstrap returns config, reasons, allowlist products and employees with badge codes", async () => {
    const res = await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", TOKEN)
      .expect(200);
    expect(res.body.config.dayLimitPerEmployee).toBeGreaterThan(0);
    expect(res.body.config.showPrices).toBe(true);
    expect(res.body.products.some((p: { gtin14: string }) => p.gtin14 === GTIN)).toBe(true);
    expect(res.body.products.every((p: { gtin14: string }) => p.gtin14 !== GTIN_NOT_ALLOWED)).toBe(
      true,
    );
    const employee = res.body.employees.find((e: { id: string }) => e.id === employeeId);
    expect(employee.badgeCodes).toContain(BADGE);
  });

  it("401s a kiosk token that is missing entirely", async () => {
    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", "not-a-real-token")
      .expect(401);
  });

  it("archived kiosk -> 401, even with a previously-valid token (locks the guard's active-status filter)", async () => {
    const archivedKioskId = randomUUID();
    const archivedToken = `kiosk-token-archived-${randomUUID()}`;
    await db.insert(schema.kiosks).values({ id: archivedKioskId, tenantId, name: "Киоск-архив" });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(archivedToken) })
      .where(eq(schema.kiosks.id, archivedKioskId));

    // Sanity: the token works while the kiosk is active.
    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", archivedToken)
      .expect(200);

    await db
      .update(schema.kiosks)
      .set({ status: "archived" })
      .where(eq(schema.kiosks.id, archivedKioskId));

    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", archivedToken)
      .expect(401);
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", archivedToken)
      .send({ deviceSeq: 1, badgeCode: BADGE, reason: "buy", items: [] })
      .expect(401);
  });
});
