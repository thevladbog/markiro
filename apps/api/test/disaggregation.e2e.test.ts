import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("disaggregation e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let agent: ReturnType<typeof request.agent>;

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
    agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("creates a draft with a DSG number, patches, lists, gets, cancels", async () => {
    const reason = await agent
      .post("/disaggregation-reasons")
      .send({ name: "Брак упаковки" })
      .expect(201);
    const reasonId = (reason.body as { id: string }).id;

    const created = await agent.post("/disaggregation").send({}).expect(201);
    const doc = created.body as { id: string; docNo: string; status: string };
    expect(doc.status).toBe("draft");
    expect(doc.docNo).toMatch(/^DSG-\d{2}-\d{4,}$/);

    const patched = await agent
      .patch(`/disaggregation/${doc.id}`)
      .send({ reasonId, comment: "тест" })
      .expect(200);
    expect((patched.body as { reasonId: string }).reasonId).toBe(reasonId);
    expect((patched.body as { reasonName: string }).reasonName).toBe("Брак упаковки");

    const list = await agent.get("/disaggregation").expect(200);
    expect((list.body as { items: { id: string }[] }).items.map((d) => d.id)).toContain(doc.id);

    const detail = await agent.get(`/disaggregation/${doc.id}`).expect(200);
    expect((detail.body as { lines: unknown[] }).lines).toEqual([]);

    const cancelled = await agent.post(`/disaggregation/${doc.id}/cancel`).expect(200);
    expect((cancelled.body as { status: string }).status).toBe("cancelled");

    // A cancelled document refuses further mutation.
    await agent.patch(`/disaggregation/${doc.id}`).send({ comment: "x" }).expect(409);
    await agent.post(`/disaggregation/${doc.id}/cancel`).expect(409);
  });

  it("404s on a foreign/unknown id", async () => {
    await agent.get(`/disaggregation/00000000-0000-0000-0000-000000000000`).expect(404);
  });
});
