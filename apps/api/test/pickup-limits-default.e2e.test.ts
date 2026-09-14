import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { listenOnLoopback } from "./support/listen-loopback";

const GTIN = "04600682000013";
const GS = String.fromCharCode(0x1d);

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * The daily pickup allowance is opt-in. A tenant that never asked for one must
 * not be charged, and a tenant that asks must still get exactly the old
 * behaviour — the second half is what distinguishes "off by default" from
 * "removed".
 */
describe.skipIf(!ready)("pickup day limits default", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let tenantId: string;

  const TOKEN = `kiosk-token-${randomUUID()}`;
  const BADGE = `badge-${randomUUID()}`;

  const km = (prefix: string): string => {
    const serial = `${prefix}${randomUUID().replace(/-/g, "")}`.slice(0, 18).toUpperCase();
    return `01${GTIN}21${serial}${GS}93Abcd`;
  };

  const order = (deviceSeq: number, count: number, prefix: string) =>
    request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq,
        badgeCode: BADGE,
        reason: "buy",
        items: Array.from({ length: count }, (_, i) => ({ rawKm: km(`${prefix}${i}`) })),
      });

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

    const agent = request.agent(app.getHttpServer());
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);
    tenantId = org.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: tenantId })
      .expect(200);

    // Deliberately NOT setting limitMode or dayLimit: this suite is about what
    // a tenant gets when it never expressed a preference.
    const employeeId = randomUUID();
    await db.insert(schema.employees).values({ id: employeeId, tenantId, fullName: "Иван Иванов" });
    await db.insert(schema.employeePickupPolicies).values({ tenantId, employeeId });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: BADGE });

    const productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: GTIN, name: "Товар", unitPrice: "99.90" });

    const kioskId = randomUUID();
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Киоск А",
      deviceTokenHash: hashDeviceToken(TOKEN),
    });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("does not charge a daily allowance to a tenant that never asked for one", async () => {
    const res = await order(1, 7, "D").expect(201);
    expect(res.body.conflicts).toEqual([]);
    expect(res.body.itemCount).toBe(7);
  });

  it("still charges one once the tenant turns limits on", async () => {
    await db
      .update(schema.pickupTenantPolicies)
      .set({ limitsEnabled: true })
      .where(eq(schema.pickupTenantPolicies.tenantId, tenantId));

    const res = await order(2, 7, "E").expect(201);
    expect(res.body.conflicts).toContainEqual(expect.objectContaining({ reason: "over_limit" }));
  });
});
