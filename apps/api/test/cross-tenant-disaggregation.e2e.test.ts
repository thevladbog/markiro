import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Security regression: tenant B must never be able to reach tenant A's
 * disaggregation documents or reasons through any of the write/read
 * endpoints, even when it has a valid ID from tenant A (e.g. leaked via
 * logs/screenshots). Every endpoint is guarded by `TenantGuard` scoping
 * every query to `req.tenantId`, so a foreign id should 404 exactly like an
 * unknown one -- never 403 (which would leak "this id exists, just not for
 * you").
 */
describe.skipIf(!ready)("cross-tenant disaggregation e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let agentA: ReturnType<typeof request.agent>;
  let agentB: ReturnType<typeof request.agent>;

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

    agentA = request.agent(app!.getHttpServer());
    await signUpAndActivate(agentA);
    agentB = request.agent(app!.getHttpServer());
    await signUpAndActivate(agentB);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("org B gets 404 on org A's disaggregation document and reason across every mutating/reading route", async () => {
    const reasonRes = await agentA
      .post("/disaggregation-reasons")
      .send({ name: "Брак упаковки" })
      .expect(201);
    const reasonId = (reasonRes.body as { id: string }).id;

    const docRes = await agentA.post("/disaggregation").send({}).expect(201);
    const docId = (docRes.body as { id: string }).id;
    await agentA.patch(`/disaggregation/${docId}`).send({ reasonId }).expect(200);

    await agentB.get(`/disaggregation/${docId}`).expect(404);
    await agentB.patch(`/disaggregation/${docId}`).send({ comment: "hijack" }).expect(404);
    await agentB.post(`/disaggregation/${docId}/cancel`).expect(404);
    await agentB.post(`/disaggregation/${docId}/apply`).expect(404);
    await agentB
      .patch(`/disaggregation-reasons/${reasonId}`)
      .send({ name: "Hijacked" })
      .expect(404);
  });
});
