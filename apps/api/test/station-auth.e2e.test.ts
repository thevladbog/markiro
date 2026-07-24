import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

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
    // The sign-up user is the org owner (always permitted to create org keys).
    // Better Auth's sign-up/email returns the created user; if the body shape
    // differs, read it from GET /api/auth/get-session instead.
    return { orgId: org.body.id as string, userId: signUp.body.user.id as string };
  }

  it("an org-owned station api-key (referenceId = tenantId) resolves the tenant with no session", async () => {
    const { orgId, userId } = await signUpAndActivate(request.agent(app!.getHttpServer()));
    // Mint an ORG-owned key (referenceId = orgId) exactly as Task 6 enrollment does.
    const created = await setup.auth.api.createApiKey({
      body: { configId: "station", organizationId: orgId, userId, name: "station" },
    });

    // A fresh (session-less) client authenticates purely by x-api-key.
    await request(app!.getHttpServer()).get("/shifts").set("x-api-key", created.key).expect(200);
  });

  it("a bad api-key and no session -> 401", async () => {
    await request(app!.getHttpServer()).get("/shifts").set("x-api-key", "mk_not_real").expect(401);
  });

  it("no auth at all -> 401", async () => {
    await request(app!.getHttpServer()).get("/shifts").expect(401);
  });
});
