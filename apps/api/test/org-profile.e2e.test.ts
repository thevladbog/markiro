import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

/**
 * Same env-gating as auth.e2e.test.ts -- requires a reachable Postgres with
 * migrations applied (including 0004_org_profiles) plus Better Auth env.
 * See that file's comment for the CI setup this assumes.
 */
const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("org profile e2e", () => {
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

  /**
   * Signs up a fresh user and creates an org for them, WITHOUT activating it
   * (`keepCurrentActiveOrganization: true` -- better-auth's
   * organization/create otherwise auto-activates the new org, which would
   * make the guarded-route-before-set-active assertion below vacuous).
   * Returns the created org id; `agent` accumulates the session cookie.
   */
  async function signUpWithInactiveOrg(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "Passw0rd!123", name: "T" })
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

  it("GET /org/profile is unauthorized without a session", async () => {
    await request(app!.getHttpServer()).get("/org/profile").expect(401);
  });

  it("guarded route 403s until set-active, then 200s with defaults", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);

    // Session exists but has no active organization yet -- this is the
    // Plan-02 handoff assertion: TenantGuard must 403 here, not 200.
    await agent.get("/org/profile").expect(403);

    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const res = await agent.get("/org/profile").expect(200);
    expect(res.body).toEqual({ gln: null, gs1Prefixes: [], inn: null });
  });

  it("PUT /org/profile upserts and roundtrips through GET", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const put = await agent
      .put("/org/profile")
      .send({ gln: "6291041500213", gs1Prefixes: ["4600000", "4600001"], inn: "7701234567" })
      .expect(200);
    expect(put.body).toEqual({
      gln: "6291041500213",
      gs1Prefixes: ["4600000", "4600001"],
      inn: "7701234567",
    });

    const get = await agent.get("/org/profile").expect(200);
    expect(get.body).toEqual(put.body);
  });

  it("PUT /org/profile preserves untouched fields on a partial update", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    await agent.put("/org/profile").send({ gln: "6291041500213", inn: "7701234567" }).expect(200);

    const put2 = await agent.put("/org/profile").send({ inn: "7709876543" }).expect(200);
    expect(put2.body).toEqual({
      gln: "6291041500213",
      gs1Prefixes: [],
      inn: "7709876543",
    });
  });

  it("PUT /org/profile rejects an invalid GLN format with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    await agent.put("/org/profile").send({ gln: "not-a-gln" }).expect(400);
  });

  it("PUT /org/profile rejects GLN with invalid check digit with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    await agent.put("/org/profile").send({ gln: "6291041500214" }).expect(400);
  });

  it("PUT /org/profile merges fields atomically (no lost-update race)", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    // PUT gln first
    await agent.put("/org/profile").send({ gln: "6291041500213" }).expect(200);

    // PUT inn only (should not lose gln)
    const result = await agent.put("/org/profile").send({ inn: "7701234567" }).expect(200);
    expect(result.body).toEqual({
      gln: "6291041500213",
      gs1Prefixes: [],
      inn: "7701234567",
    });

    // Verify GET sees the merged state
    const get = await agent.get("/org/profile").expect(200);
    expect(get.body).toEqual({
      gln: "6291041500213",
      gs1Prefixes: [],
      inn: "7701234567",
    });
  });

  it("tenant isolation: a second organization sees its own empty profile", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpWithInactiveOrg(agent1);
    await agent1
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org1 })
      .expect(200);
    await agent1.put("/org/profile").send({ gln: "6291041500213" }).expect(200);

    const agent2 = request.agent(app!.getHttpServer());
    const org2 = await signUpWithInactiveOrg(agent2);
    await agent2
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org2 })
      .expect(200);

    const res = await agent2.get("/org/profile").expect(200);
    expect(res.body).toEqual({ gln: null, gs1Prefixes: [], inn: null });
  });
});
