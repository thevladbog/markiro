import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station devices e2e", () => {
  let app: INestApplication | undefined;

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
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

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<void> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "Passw0rd!123", name: "T" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Plant", slug: `plant-${randomUUID()}`, keepCurrentActiveOrganization: true })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
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
    await request(app!.getHttpServer()).get("/shifts").set("x-api-key", enroll.body.apiKey).expect(200);

    const list = await agent.get("/station-devices").expect(200);
    expect(list.body.items.map((d: { id: string }) => d.id)).toContain(deviceId);
    expect(list.body.items[0]).not.toHaveProperty("apiKey");

    // Another tenant cannot delete this device.
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    await other.delete(`/station-devices/${deviceId}`).expect(404);

    // Owner deletes it; the key stops working afterward.
    await agent.delete(`/station-devices/${deviceId}`).expect(204);
    await request(app!.getHttpServer()).get("/shifts").set("x-api-key", enroll.body.apiKey).expect(401);
  });
});
