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

describe.skipIf(!ready)("disaggregation-reasons e2e", () => {
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

  it("creates, lists, updates, archives", async () => {
    const created = await agent
      .post("/disaggregation-reasons")
      .send({ name: "Пересорт", sortOrder: 1 })
      .expect(201);
    const id = (created.body as { id: string }).id;

    const list = await agent.get("/disaggregation-reasons").expect(200);
    expect((list.body as { items: { id: string }[] }).items.map((r) => r.id)).toContain(id);

    const updated = await agent
      .patch(`/disaggregation-reasons/${id}`)
      .send({ name: "Пересорт продукции" })
      .expect(200);
    expect((updated.body as { name: string }).name).toBe("Пересорт продукции");

    await agent.delete(`/disaggregation-reasons/${id}`).expect(204);
    const after = await agent.get("/disaggregation-reasons").expect(200);
    expect((after.body as { items: { id: string }[] }).items.map((r) => r.id)).not.toContain(id);
  });

  it("rejects an empty name", async () => {
    await agent.post("/disaggregation-reasons").send({ name: "  " }).expect(400);
  });
});
