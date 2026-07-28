import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Task 9: kiosks, pickup-orders and pickup-reasons were `TenantGuard`-only
 * (device-key reachable) until this pass made them cabinet-only. See
 * docs/device-key-surface.md.
 */
describe.skipIf(!ready)("device key surface triage e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;
  let agent: ReturnType<typeof request.agent>;
  let stationKey: string;
  const TOKEN = `kiosk-token-${randomUUID()}`;

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
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
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Plant", slug: `plant-${randomUUID()}`, keepCurrentActiveOrganization: true })
      .expect(200);
    const tenantId = org.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: tenantId })
      .expect(200);

    const enroll = await agent.post("/station-devices").send({ name: "Terminal" }).expect(201);
    stationKey = enroll.body.apiKey as string;

    const kioskId = randomUUID();
    await db.insert(schema.kiosks).values({ id: kioskId, tenantId, name: "Киоск" });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(TOKEN) })
      .where(eq(schema.kiosks.id, kioskId));
  });

  afterAll(async () => {
    await app?.close();
  });

  it("refuses a station api-key on kiosk management", async () => {
    await request(app!.getHttpServer()).get("/kiosks").set("x-api-key", stationKey).expect(403);
  });

  it("refuses a station api-key on the pickup order flow", async () => {
    await request(app!.getHttpServer())
      .get("/pickup-orders")
      .set("x-api-key", stationKey)
      .expect(403);
  });

  it("refuses a station api-key on pickup reasons", async () => {
    await request(app!.getHttpServer())
      .get("/pickup-reasons")
      .set("x-api-key", stationKey)
      .expect(403);
  });

  it("refuses a station api-key on pickup rejections", async () => {
    await request(app!.getHttpServer())
      .get("/pickup-rejections")
      .set("x-api-key", stationKey)
      .expect(403);
  });

  it("still serves a cabinet session", async () => {
    await agent.get("/kiosks").expect(200);
    await agent.get("/pickup-orders").expect(200);
    await agent.get("/pickup-reasons").expect(200);
  });

  it("leaves the kiosk's own device routes reachable", async () => {
    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", TOKEN)
      .expect(200);
  });
});
