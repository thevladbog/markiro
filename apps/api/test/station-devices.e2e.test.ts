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
import { SsccService } from "../src/modules/sscc/sscc.service";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station devices e2e", () => {
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

  it("enroll -> list -> delete, cross-tenant isolation", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const enroll = await agent.post("/station-devices").send({ name: "Terminal 1" }).expect(201);
    expect(enroll.body).toMatchObject({ name: "Terminal 1" });
    expect(typeof enroll.body.apiKey).toBe("string");
    expect(enroll.body.serverUrl).toBe("http://localhost:3000");
    const deviceId = enroll.body.deviceId as string;

    // The freshly issued key authenticates a session-less station request.
    await request(app!.getHttpServer())
      .get("/shifts")
      .set("x-api-key", enroll.body.apiKey)
      .expect(200);

    const list = await agent.get("/station-devices").expect(200);
    expect(list.body.items.map((d: { id: string }) => d.id)).toContain(deviceId);
    expect(list.body.items[0]).not.toHaveProperty("apiKey");

    // Another tenant cannot delete this device, nor see it in their list.
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    await other.delete(`/station-devices/${deviceId}`).expect(404);

    const otherList = await other.get("/station-devices").expect(200);
    expect(otherList.body.items.map((d: { id: string }) => d.id)).not.toContain(deviceId);

    // Owner deletes it; the key stops working afterward.
    await agent.delete(`/station-devices/${deviceId}`).expect(204);
    await request(app!.getHttpServer())
      .get("/shifts")
      .set("x-api-key", enroll.body.apiKey)
      .expect(401);
  });

  it("rejects device-management requests authenticated by a station api-key (session required)", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const enroll = await agent.post("/station-devices").send({ name: "Terminal 2" }).expect(201);
    const apiKey = enroll.body.apiKey as string;

    // A valid station key satisfies TenantGuard (tenant resolution), but
    // device management is an admin-only action requiring a user session.
    await request(app!.getHttpServer())
      .get("/station-devices")
      .set("x-api-key", apiKey)
      .expect(403);

    await request(app!.getHttpServer())
      .delete(`/station-devices/${enroll.body.deviceId}`)
      .set("x-api-key", apiKey)
      .expect(403);

    await request(app!.getHttpServer())
      .post("/station-devices")
      .set("x-api-key", apiKey)
      .send({ name: "Terminal 3" })
      .expect(403);
  });

  // CodeRabbit PR33 review, Finding 8: sscc_blocks' composite FK to
  // station_devices has no `onDelete` (defaults to NO ACTION). The OLD
  // revoke() deleted station_devices first, inside one transaction with the
  // apikey delete -- so a device that had ever issued a box serial block hit
  // that FK violation, which rolled back the WHOLE transaction (including
  // the apikey delete), leaving the credential silently still live. The fix
  // deletes apikey FIRST, as its own committed statement, so the credential
  // dies regardless of whatever the (still FK-blocked) device-row delete
  // does afterward.
  it(
    "revoking a device with an sscc_blocks row referencing it still kills the api-key, even " +
      "though the device-row delete itself is blocked by the FK",
    async () => {
      const agent = request.agent(app!.getHttpServer());
      const tenantId = await signUpAndActivate(agent);

      const enroll = await agent.post("/station-devices").send({ name: "Bundle terminal" }).expect(201);
      const deviceId = enroll.body.deviceId as string;
      const apiKey = enroll.body.apiKey as string;

      // The key works before revoking -- baseline.
      await request(app!.getHttpServer())
        .get("/shifts")
        .set("x-api-key", apiKey)
        .expect(200);

      // Cuts a REAL sscc_blocks row referencing this device -- the only way
      // to reach the FK this finding is about (no HTTP route allocates
      // directly; see sscc.e2e.test.ts's own use of the service this way).
      await app!.get(SsccService).allocate(tenantId, "460000009", 0, deviceId, 10);

      // The device-row delete itself is expected to fail deterministically
      // (the FK this finding documents raises before any custom handling
      // catches it, so NestJS's default filter turns it into a 500) -- but
      // the important assertion is what happens to the credential
      // regardless of this response's own status.
      await agent.delete(`/station-devices/${deviceId}`).expect(500);

      // The fix under test: the api-key is dead, unconditionally -- even
      // though the request above did not return success.
      await request(app!.getHttpServer())
        .get("/shifts")
        .set("x-api-key", apiKey)
        .expect(401);

      // The device row itself is left orphaned (its own delete blocked by
      // the FK) -- accepted bookkeeping debt, not a live credential, which
      // is exactly the trade-off this finding's fix makes on purpose.
      const rows = await db
        .select({ id: schema.stationDevices.id })
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.id, deviceId));
      expect(rows).toHaveLength(1);
    },
  );
});
