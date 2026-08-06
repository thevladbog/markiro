import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { SsccService } from "../src/modules/sscc/sscc.service";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station device lifecycle e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;

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
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Plant", slug: `plant-${randomUUID()}`, keepCurrentActiveOrganization: true })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return org.body.id as string;
  }

  it("pre-creates, reassigns, and durably revokes a station without deleting its SSCC history", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [line] = await db.insert(schema.lines).values({ tenantId, name: "Packing" }).returning();

    const create = await agent
      .post("/station-devices")
      .send({ name: "Terminal 1", lineId: line!.id })
      .expect(201);
    expect(create.body).toMatchObject({
      name: "Terminal 1",
      lineId: line!.id,
      lineName: "Packing",
      lifecycle: "awaiting_pairing",
      pairedAt: null,
      revokedAt: null,
      lastSeenAt: null,
    });
    expect(create.body).toHaveProperty("id");
    expect(create.body).toHaveProperty("createdAt");
    expect(create.body).not.toHaveProperty("apiKey");
    expect(create.body).not.toHaveProperty("serverUrl");
    const deviceId = create.body.id as string;

    const list = await agent.get("/station-devices").expect(200);
    expect(list.body.items).toContainEqual(
      expect.objectContaining({
        id: deviceId,
        lineId: line!.id,
        lineName: "Packing",
        lifecycle: "awaiting_pairing",
      }),
    );

    const [stored] = await db
      .select()
      .from(schema.stationDevices)
      .where(
        and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
      );
    expect(stored).toMatchObject({ apiKeyId: null, lineId: line!.id });

    const update = await agent
      .patch(`/station-devices/${deviceId}`)
      .send({ name: "Terminal 1A", lineId: null })
      .expect(200);
    expect(update.body).toMatchObject({
      id: deviceId,
      name: "Terminal 1A",
      lineId: null,
      lineName: null,
      lifecycle: "awaiting_pairing",
    });

    await app!.get(SsccService).allocate(tenantId, "460000009", 0, deviceId, 10);
    await db.insert(schema.stationPairingCodes).values({
      tenantId,
      stationDeviceId: deviceId,
      codeHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      issuedByUserId: "cabinet-user",
    });

    await agent.delete(`/station-devices/${deviceId}`).expect(204);
    const [revoked] = await db
      .select()
      .from(schema.stationDevices)
      .where(
        and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
      );
    expect(revoked).toMatchObject({ id: deviceId, apiKeyId: null });
    expect(revoked!.revokedAt).toBeInstanceOf(Date);

    const [retiredCode] = await db
      .select()
      .from(schema.stationPairingCodes)
      .where(eq(schema.stationPairingCodes.stationDeviceId, deviceId));
    expect(retiredCode!.usedAt).toBeInstanceOf(Date);
    const blocks = await db
      .select({ id: schema.ssccBlocks.id })
      .from(schema.ssccBlocks)
      .where(
        and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
      );
    expect(blocks).toHaveLength(1);

    const revokedAt = revoked!.revokedAt;
    await agent.delete(`/station-devices/${deviceId}`).expect(204);
    const [repeated] = await db
      .select({ revokedAt: schema.stationDevices.revokedAt })
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, deviceId));
    expect(repeated!.revokedAt).toEqual(revokedAt);
  });

  it("rejects a foreign line and hides station records from another tenant", async () => {
    const owner = request.agent(app!.getHttpServer());
    const ownerTenantId = await signUpAndActivate(owner);
    const [ownerLine] = await db
      .insert(schema.lines)
      .values({ tenantId: ownerTenantId, name: "Owner line" })
      .returning();
    const created = await owner
      .post("/station-devices")
      .send({ name: "Owner station", lineId: ownerLine!.id })
      .expect(201);

    const other = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(other);
    const [otherLine] = await db
      .insert(schema.lines)
      .values({ tenantId: otherTenantId, name: "Other line" })
      .returning();
    await owner
      .post("/station-devices")
      .send({ name: "Wrong line", lineId: otherLine!.id })
      .expect(400);
    await other
      .patch(`/station-devices/${created.body.id as string}`)
      .send({ name: "Nope" })
      .expect(404);
    await other.delete(`/station-devices/${created.body.id as string}`).expect(404);
    const list = await other.get("/station-devices").expect(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).not.toContain(created.body.id);
  });
});
