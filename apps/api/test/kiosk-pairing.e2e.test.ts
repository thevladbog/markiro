import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { schema, type Db } from "@markiro/db";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("kiosk pairing e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let agent: ReturnType<typeof request.agent>;
  let otherAgent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let kioskId: string;

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
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpWithInactiveOrg(agent: ReturnType<typeof request.agent>): Promise<string> {
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

  // Fresh tenant + kiosk per test, per repo convention -- this Postgres is
  // shared across concurrent test runs, so every test scopes its own rows.
  beforeEach(async () => {
    agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    const kiosk = await agent
      .post("/kiosks")
      .send({ name: `Киоск ${randomUUID()}` })
      .expect(201);
    kioskId = kiosk.body.id as string;

    otherAgent = request.agent(app!.getHttpServer());
    await signUpAndActivate(otherAgent);
  });

  it("issues an 8-digit code that expires in 15 minutes", async () => {
    const res = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    expect(res.body.code).toMatch(/^\d{8}$/);
    const ttlMs = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(13 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it("stores only the hash, never the plaintext code", async () => {
    const res = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const rows = await db
      .select()
      .from(schema.kioskPairingCodes)
      .where(eq(schema.kioskPairingCodes.kioskId, kioskId));
    expect(rows.some((r) => r.codeHash === res.body.code)).toBe(false);
    expect(rows.some((r) => r.codeHash === hashDeviceToken(res.body.code))).toBe(true);
  });

  it("invalidates the previous code when a new one is issued", async () => {
    const first = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const [old] = await db
      .select()
      .from(schema.kioskPairingCodes)
      .where(eq(schema.kioskPairingCodes.codeHash, hashDeviceToken(first.body.code)));
    expect(old!.usedAt).not.toBeNull();
  });

  it("404s for a kiosk of another tenant", async () => {
    await otherAgent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(404);
  });

  // Regression guard: TenantGuard alone would accept a station's own
  // x-api-key for tenant resolution, but a stolen/compromised station device
  // must never be able to mint a kiosk pairing code -- SessionOnlyGuard is
  // what actually blocks it.
  it("rejects a station device api-key even though TenantGuard would accept it", async () => {
    const device = await agent
      .post("/station-devices")
      .send({ name: "Kiosk cabinet terminal" })
      .expect(201);
    const apiKey = (device.body as { apiKey: string }).apiKey;

    await request(app!.getHttpServer())
      .post(`/kiosks/${kioskId}/pairing-code`)
      .set("x-api-key", apiKey)
      .send({})
      .expect(403);
  });

  it("leaves at most one live code when two issue requests race", async () => {
    const [a, b] = await Promise.all([
      agent.post(`/kiosks/${kioskId}/pairing-code`).send({}),
      agent.post(`/kiosks/${kioskId}/pairing-code`).send({}),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);

    const live = await db
      .select()
      .from(schema.kioskPairingCodes)
      .where(
        and(
          eq(schema.kioskPairingCodes.tenantId, tenantId),
          eq(schema.kioskPairingCodes.kioskId, kioskId),
          isNull(schema.kioskPairingCodes.usedAt),
        ),
      );
    expect(live).toHaveLength(1);
  });
});
