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

/** GTIN test vector (check-digit VALID). See kiosk-orders.e2e.test.ts for the full rationale. */
const GTIN = "04600682000013";

/** GS (ASCII 0x1D) — the KM segment separator. */
const GS = String.fromCharCode(0x1d);

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("pickup orders admin e2e", () => {
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

    kioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId, name: "Киоск А", dayLimitPerEmployee: 20 });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(TOKEN) })
      .where(eq(schema.kiosks.id, kioskId));
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpWithInactiveOrg(a: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await a
      .post("/api/auth/sign-up/email")
      .send({ email, password: "Passw0rd!123", name: "T" })
      .expect(200);

    const org = await a
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);

    return org.body.id as string;
  }

  async function signUpAndActivate(a: ReturnType<typeof request.agent>): Promise<string> {
    const orgId = await signUpWithInactiveOrg(a);
    await a.post("/api/auth/organization/set-active").send({ organizationId: orgId }).expect(200);
    return orgId;
  }

  function scan(
    deviceSeq: number,
    rawKm: string,
    extra: Record<string, unknown> = {},
  ): request.Test {
    return request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq, badgeCode: BADGE, reason: "buy", items: [{ rawKm }], ...extra });
  }

  it("creates orders via the kiosk path, lists/filters/details/resolves/cancels them as admin", async () => {
    // --- Seed 4 orders through the kiosk create path ---
    const orderList = await scan(101, `01${GTIN}21LISTP1${GS}93Abcd`).expect(201);
    const orderPunch = await scan(102, `01${GTIN}21PUNCH1${GS}93Abcd`).expect(201);
    const orderCancel = await scan(103, `01${GTIN}21CANCEL1${GS}93Abcd`).expect(201);

    const writeoffReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values({
      id: writeoffReasonId,
      tenantId,
      name: "Брак",
      sortOrder: 0,
      archived: false,
    });
    const orderWriteoff = await scan(104, `01${GTIN}21WOFF1${GS}93Abcd`, {
      reason: "writeoff",
      writeoffReasonId,
    }).expect(201);

    const idList = await orderIdByNo(orderList.body.orderNo);
    const idPunch = await orderIdByNo(orderPunch.body.orderNo);
    const idCancel = await orderIdByNo(orderCancel.body.orderNo);
    const idWriteoff = await orderIdByNo(orderWriteoff.body.orderNo);

    // --- List: filter by status=pending ---
    const pendingRes = await agent.get("/pickup-orders").query({ status: "pending" }).expect(200);
    const pendingIds = pendingRes.body.items.map((i: { id: string }) => i.id);
    expect(pendingIds).toEqual(expect.arrayContaining([idList, idPunch, idCancel, idWriteoff]));
    for (const item of pendingRes.body.items) {
      expect(item.status).toBe("pending");
    }

    // --- List: filter by reason=buy (excludes the writeoff order) ---
    const buyRes = await agent.get("/pickup-orders").query({ reason: "buy" }).expect(200);
    const buyIds = buyRes.body.items.map((i: { id: string }) => i.id);
    expect(buyIds).toEqual(expect.arrayContaining([idList, idPunch, idCancel]));
    expect(buyIds).not.toContain(idWriteoff);

    // --- Detail ---
    const detailRes = await agent.get(`/pickup-orders/${idList}`).expect(200);
    expect(detailRes.body).toMatchObject({
      id: idList,
      orderNo: orderList.body.orderNo,
      employeeName: "Иван Иванов",
      kioskName: "Киоск А",
      reason: "buy",
      writeoffReasonName: null,
      itemCount: 1,
      totalPrice: "99.90",
      status: "pending",
      employeeBadgeCode: BADGE,
      receiptNo: null,
      actNo: null,
    });
    expect(detailRes.body.items).toHaveLength(1);
    expect(detailRes.body.items[0]).toMatchObject({
      gtin14: GTIN,
      serial: "LISTP1",
      productName: "Товар",
      unitPrice: "99.90",
    });

    // --- Resolve: writeoff without an explicit writeoffReasonId inherits the order's own ---
    const resolveWriteoffRes = await agent
      .post(`/pickup-orders/${idWriteoff}/resolve`)
      .send({ action: "writeoff", actNo: "ACT-1" })
      .expect(201);
    expect(resolveWriteoffRes.body.status).toBe("writtenoff");
    const writeoffDetail = await agent.get(`/pickup-orders/${idWriteoff}`).expect(200);
    expect(writeoffDetail.body.actNo).toBe("ACT-1");
    expect(writeoffDetail.body.writeoffReasonName).toBe("Брак");

    // --- Resolve: writeoff with NO reason anywhere (buy order, none supplied) -> 400 ---
    await agent
      .post(`/pickup-orders/${idList}/resolve`)
      .send({ action: "writeoff", actNo: "ACT-X" })
      .expect(400);

    // --- Resolve: writeoff with a bogus writeoffReasonId -> 400 (not a raw FK-violation 500) ---
    await agent
      .post(`/pickup-orders/${idList}/resolve`)
      .send({ action: "writeoff", actNo: "ACT-Y", writeoffReasonId: randomUUID() })
      .expect(400);

    // --- Resolve: punch sets status + receiptNo + resolvedAt (+ resolvedByUserId) ---
    const resolvePunchRes = await agent
      .post(`/pickup-orders/${idPunch}/resolve`)
      .send({ action: "punch", receiptNo: "R-1" })
      .expect(201);
    expect(resolvePunchRes.body.status).toBe("punched");

    const [punchRow] = await db
      .select()
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, idPunch));
    expect(punchRow?.receiptNo).toBe("R-1");
    expect(punchRow?.resolvedAt).toBeTruthy();
    expect(punchRow?.resolvedByUserId).toBeTruthy();

    // --- Resolve on a non-pending order -> 409 ---
    await agent
      .post(`/pickup-orders/${idPunch}/resolve`)
      .send({ action: "punch", receiptNo: "R-2" })
      .expect(409);

    // --- Cancel a fresh pending order: flips to cancelled AND voids its items (frees the code) ---
    const cancelRes = await agent.post(`/pickup-orders/${idCancel}/cancel`).expect(201);
    expect(cancelRes.body.status).toBe("cancelled");

    const voidedItems = await db
      .select()
      .from(schema.pickupOrderItems)
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          eq(schema.pickupOrderItems.orderId, idCancel),
        ),
      );
    expect(voidedItems.every((i) => i.voided)).toBe(true);

    // Re-scan the SAME code via a new order — should now be ACCEPTED, proving the partial-unique freed it.
    const rescanRes = await scan(105, `01${GTIN}21CANCEL1${GS}93Abcd`).expect(201);
    expect(rescanRes.body.itemCount).toBe(1);
    expect(rescanRes.body.conflicts).toHaveLength(0);

    // --- Cancel on a non-pending order -> 409 ---
    await agent.post(`/pickup-orders/${idCancel}/cancel`).expect(409);
  });

  it("cross-tenant isolation: org B cannot GET org A's pickup order", async () => {
    const orderRes = await scan(999, `01${GTIN}21XTEN1${GS}93Abcd`).expect(201);
    const orderId = await orderIdByNo(orderRes.body.orderNo);

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    await agent2.get(`/pickup-orders/${orderId}`).expect(404);
  });

  async function orderIdByNo(orderNo: string): Promise<string> {
    const [row] = await db
      .select({ id: schema.pickupOrders.id })
      .from(schema.pickupOrders)
      .where(
        and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.orderNo, orderNo)),
      );
    if (!row) throw new Error(`No order found for orderNo ${orderNo}`);
    return row.id;
  }
});
