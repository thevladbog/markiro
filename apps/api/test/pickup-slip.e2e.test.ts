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

/** GS (ASCII 0x1D) — the KM segment separator. Renders invisibly in prose; use the real byte in fixtures. */
const GS = String.fromCharCode(0x1d);

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("pickup order printed slip e2e", () => {
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
    await db.insert(schema.employees).values({
      id: employeeId,
      tenantId,
      fullName: "Смирнов Алексей Петрович",
      role: "оператор линии",
    });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: BADGE });

    productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Жигулёвское светлое 0,5 л",
      unitPrice: "52.00",
    });

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

  it("GET /pickup-orders/:id/slip returns a print-ready A4 HTML page containing the order number", async () => {
    const created = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 1,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN}21SLIP1${GS}93Abcd` }],
      })
      .expect(201);
    const orderId = await orderIdByNo(created.body.orderNo);

    const res = await agent.get(`/pickup-orders/${orderId}/slip`).expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain(created.body.orderNo);
    expect(res.text).toContain("Жигулёвское светлое 0,5 л");
    expect(res.text).toContain("@page");
    const svgCount = (res.text.match(/<svg/g) ?? []).length;
    expect(svgCount).toBeGreaterThanOrEqual(3);
  });

  it("404s for an order that doesn't exist", async () => {
    await agent.get(`/pickup-orders/${randomUUID()}/slip`).expect(404);
  });

  it("cancelled order's slip has no item rows and no stale total (Итого stays consistent with the empty table)", async () => {
    const created = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 2,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN}21CANCELSLIP${GS}93Abcd` }],
      })
      .expect(201);
    const orderId = await orderIdByNo(created.body.orderNo);

    // Sanity: before cancelling, the slip shows the item and its (non-null) price.
    const preCancel = await agent.get(`/pickup-orders/${orderId}/slip`).expect(200);
    expect(preCancel.text).toContain("CANCELSLIP");
    expect(preCancel.text).toContain("52.00");

    await agent.post(`/pickup-orders/${orderId}/cancel`).expect(200);

    const postCancel = await agent.get(`/pickup-orders/${orderId}/slip`).expect(200);
    // No rendered row for the (now-voided) KM...
    expect(postCancel.text).not.toContain("CANCELSLIP");
    // ...and no stale "Итого" carried over from the pre-cancel total — the
    // pre-cancel price string must not appear anywhere in the cancelled slip.
    expect(postCancel.text).not.toContain("52.00");
  });
});
