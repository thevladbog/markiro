import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { DB } from "../src/auth/auth.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station api-key auth e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
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

  async function signUpAndActivate(
    agent: ReturnType<typeof request.agent>,
  ): Promise<{ orgId: string; userId: string }> {
    const email = `t-${randomUUID()}@example.com`;
    const signUp = await agent
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
    // The sign-up user is the org owner (always permitted to create org keys).
    // Better Auth's sign-up/email returns the created user; if the body shape
    // differs, read it from GET /api/auth/get-session instead.
    return { orgId: org.body.id as string, userId: signUp.body.user.id as string };
  }

  it("a paired station key resolves its tenant and updates only its durable device heartbeat", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { orgId } = await signUpAndActivate(agent);
    const station = await createTestStationDevice(app!, agent, "Heartbeat terminal");
    const otherStation = await createTestStationDevice(app!, agent, "Other terminal");
    const db = app!.get<Db>(DB);

    await request(app!.getHttpServer()).get("/shifts").set("x-api-key", station.apiKey).expect(200);

    const rows = await db
      .select({ id: schema.stationDevices.id, lastSeenAt: schema.stationDevices.lastSeenAt })
      .from(schema.stationDevices)
      .where(
        and(
          eq(schema.stationDevices.tenantId, orgId),
          eq(schema.stationDevices.id, station.deviceId),
        ),
      );
    expect(rows).toEqual([{ id: station.deviceId, lastSeenAt: expect.any(Date) }]);

    const [other] = await db
      .select({ id: schema.stationDevices.id, lastSeenAt: schema.stationDevices.lastSeenAt })
      .from(schema.stationDevices)
      .where(
        and(
          eq(schema.stationDevices.tenantId, orgId),
          eq(schema.stationDevices.id, otherStation.deviceId),
        ),
      );
    expect(other).toEqual({ id: otherStation.deviceId, lastSeenAt: null });
  });

  it("keeps the station roster machine-only while preserving enrolled-device access", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    await agent.get("/station/operators").expect(403);

    const enrolled = await createTestStationDevice(app!, agent, "Roster terminal");
    const roster = await request(app!.getHttpServer())
      .get("/station/operators")
      .set("x-api-key", enrolled.apiKey)
      .expect(200);

    expect(roster.body).toEqual({ items: [] });
  });

  it("a bad api-key and no session -> 401", async () => {
    await request(app!.getHttpServer()).get("/shifts").set("x-api-key", "mk_not_real").expect(401);
  });

  it("no auth at all -> 401", async () => {
    await request(app!.getHttpServer()).get("/shifts").expect(401);
  });
});
