import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

/**
 * Requires a reachable Postgres with the Better Auth + platform schema
 * already migrated: `pnpm --filter @markiro/db db:migrate`. Skipped when
 * DATABASE_URL isn't set, mirroring packages/db/test/partitions.test.ts.
 * CI applies migrations in the workflow (see .github/workflows/ci.yml)
 * before running this suite against the postgres service container.
 */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("auth e2e", () => {
  let app: INestApplication;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot(setup)],
    }).compile();

    // Mirrors main.ts bootstrap: Better Auth needs the raw body, so the Nest
    // body parser is disabled and express.json() installed after mounting it.
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await setup.pool.end();
  });

  it("sign-up -> session cookie -> organization create", async () => {
    const email = `t${Date.now()}@example.com`;
    const agent = request.agent(app.getHttpServer());

    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "Passw0rd!123", name: "T" })
      .expect(200);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Test Plant", slug: `plant-${Date.now()}` })
      .expect(200);

    expect(org.body.id).toBeTruthy();
  });

  it("organization create without a session is unauthorized", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/organization/create")
      .send({ name: "No Session", slug: `no-session-${Date.now()}` })
      .expect(401);
  });
});
