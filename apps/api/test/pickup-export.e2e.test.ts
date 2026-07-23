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

/** GTIN test vector (check-digit VALID). */
const GTIN = "04600682000013";

/** GS (ASCII 0x1D) — the KM segment separator. */
const GS = String.fromCharCode(0x1d);

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("pickup orders export e2e", () => {
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
    await db.insert(schema.employees).values({ id: employeeId, tenantId, fullName: "Иван Иванов", role: "оператор" });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: BADGE });

    productId = randomUUID();
    await db.insert(schema.products).values({ id: productId, tenantId, gtin14: GTIN, name: "Товар", unitPrice: "99.90" });

    kioskId = randomUUID();
    await db.insert(schema.kiosks).values({ id: kioskId, tenantId, name: "Киоск А", dayLimitPerEmployee: 20 });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
    await db.update(schema.kiosks).set({ deviceTokenHash: hashDeviceToken(TOKEN) }).where(eq(schema.kiosks.id, kioskId));
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
    await a
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  function scan(deviceSeq: number, rawKm: string, extra: Record<string, unknown> = {}): request.Test {
    return request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq, badgeCode: BADGE, reason: "buy", items: [{ rawKm }], ...extra });
  }

  async function orderIdByNo(orderNo: string): Promise<string> {
    const [row] = await db
      .select({ id: schema.pickupOrders.id })
      .from(schema.pickupOrders)
      .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.orderNo, orderNo)));
    if (!row) throw new Error(`No order found for orderNo ${orderNo}`);
    return row.id;
  }

  it("exports pickup codes as text/plain with one line per item, preserving GS byte", async () => {
    // Create two orders via the kiosk path, each with one item
    const order1Res = await scan(201, `01${GTIN}21EXPORT1${GS}93Abcd`).expect(201);
    const order2Res = await scan(202, `01${GTIN}21EXPORT2${GS}93Abcd`).expect(201);

    const orderId1 = await orderIdByNo(order1Res.body.orderNo);
    const orderId2 = await orderIdByNo(order2Res.body.orderNo);

    // Export both orders
    const res = await agent
      .post("/pickup-orders/export")
      .send({ orderIds: [orderId1, orderId2] })
      .expect(200)
      .expect("Content-Type", /text\/plain/);

    // Assert response text has 2 lines (one per item)
    const lines = res.text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    // Verify each line contains a GS byte (0x1D)
    for (const line of lines) {
      expect(line).toContain(String.fromCharCode(0x1d));
    }
  });

  it("cross-tenant isolation: export only includes items from same tenant", async () => {
    // Create an order for tenant A
    const order1Res = await scan(301, `01${GTIN}21XTEN1${GS}93Abcd`).expect(201);
    const orderId1 = await orderIdByNo(order1Res.body.orderNo);

    // Create a separate agent for tenant B
    const agent2 = request.agent(app!.getHttpServer());
    const tenantId2 = await signUpAndActivate(agent2);

    // Tenant B attempts to export with tenant A's order ID (should get 0 items)
    // Since tenant A's order ID doesn't belong to tenant B, it contributes nothing
    const res = await agent2
      .post("/pickup-orders/export")
      .send({ orderIds: [orderId1] })
      .expect(200)
      .expect("Content-Type", /text\/plain/);

    const lines = res.text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(0);
  });

  it("validates orderIds schema: min 1, uuid format", async () => {
    // Empty array should fail validation
    await agent
      .post("/pickup-orders/export")
      .send({ orderIds: [] })
      .expect(400);

    // Non-uuid string should fail validation
    await agent
      .post("/pickup-orders/export")
      .send({ orderIds: ["not-a-uuid"] })
      .expect(400);
  });
});
