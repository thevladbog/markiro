import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { schema, type Db } from "@markiro/db";
import { createTestEmployee } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

/**
 * GTIN test vectors (check-digit VALID). See kiosk-orders.e2e.test.ts for the
 * full rationale — do not swap in a check-digit-invalid GTIN here, it would
 * be rejected as `not_km` and test the wrong branch.
 *   - GTIN            "04600682000013" — the allowlisted product on this kiosk.
 *   - GTIN_NOT_ALLOWED "04600682000020" — a real product for this tenant, but
 *                      never added to this kiosk's allowlist -> "not_allowed".
 */
const GTIN = "04600682000013";
const GTIN_NOT_ALLOWED = "04600682000020";

/** GS (ASCII 0x1D) — the KM segment separator. Use the real byte in fixtures. */
const GS = String.fromCharCode(0x1d);

const GOOD_KM = `01${GTIN}21TASK7A${GS}93Abcd`;
const GOOD_KM_2 = `01${GTIN}21TASK7C${GS}93Abcd`;
const NOT_ALLOWED_KM = `01${GTIN_NOT_ALLOWED}21TASK7B${GS}93Abcd`;

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("pickup order sync conflicts e2e", () => {
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
    await listenOnLoopback(app);

    agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    employeeId = randomUUID();
    await createTestEmployee(db, {
      id: employeeId,
      tenantId,
      fullName: "Иван Иванов",
      role: "оператор",
    });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: BADGE });

    productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: GTIN, name: "Товар", unitPrice: "99.90" });
    // A real product for this tenant that is deliberately NOT allowlisted on this kiosk (-> not_allowed).
    await db.insert(schema.products).values({
      id: randomUUID(),
      tenantId,
      gtin14: GTIN_NOT_ALLOWED,
      name: "Другой товар",
    });

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

    return org.body.id as string;
  }

  async function signUpAndActivate(a: ReturnType<typeof request.agent>): Promise<string> {
    const orgId = await signUpWithInactiveOrg(a);
    await a.post("/api/auth/organization/set-active").send({ organizationId: orgId }).expect(200);
    return orgId;
  }

  it("records the codes it refused, so an admin can see what the kiosk lost", async () => {
    // Two items: one valid, one whose GTIN is not on this kiosk's allowlist.
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 1,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: GOOD_KM }, { rawKm: NOT_ALLOWED_KM }],
      })
      .expect(201);

    expect(res.body.itemCount).toBe(1);
    expect(res.body.conflicts).toHaveLength(1);

    const list = await agent.get("/pickup-orders").expect(200);
    const row = list.body.items.find((r: { orderNo: string }) => r.orderNo === res.body.orderNo);
    expect(row.conflictCount).toBe(1);

    const detail = await agent.get(`/pickup-orders/${row.id}`).expect(200);
    expect(detail.body.syncConflicts).toEqual([
      { rawKm: NOT_ALLOWED_KM, reason: expect.stringMatching(/unknown_product|not_allowed/) },
    ]);
  });

  it("reports no conflicts for a clean order", async () => {
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 2, badgeCode: BADGE, reason: "buy", items: [{ rawKm: GOOD_KM_2 }] })
      .expect(201);

    const list = await agent.get("/pickup-orders").expect(200);
    const row = list.body.items.find((r: { orderNo: string }) => r.orderNo === res.body.orderNo);
    expect(row.conflictCount).toBe(0);

    const detail = await agent.get(`/pickup-orders/${row.id}`).expect(200);
    expect(detail.body.syncConflicts).toEqual([]);
  });
});
