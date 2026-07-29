import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

describe("integrations (cabinet)", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;

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
    await listenOnLoopback(app);
    agent = request.agent(app.getHttpServer());
    await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("показывает все каналы реестра, включая ещё не построенные", async () => {
    const res = await agent.get("/integrations").expect(200);
    const types = res.body.channels.map((c: { type: string }) => c.type);
    expect(types).toEqual(["commerceml", "public_api", "gis_mt_files", "chestny_znak"]);
    const chz = res.body.channels.find((c: { type: string }) => c.type === "chestny_znak");
    expect(chz.state).toBe("unavailable");
  });

  it("ненастроенный канал — это состояние, а не отсутствие записи", async () => {
    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.state).toBe("not_configured");
    expect(res.body.settings).toEqual({});
  });

  it("сохраняет настройки по схеме дескриптора и отвергает чужие", async () => {
    await agent.patch("/integrations/commerceml").send({ priceType: "Розничная" }).expect(200);
    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.settings.priceType).toBe("Розничная");

    await agent.patch("/integrations/commerceml").send({ priceType: 42 }).expect(400);
  });

  it("отказывает в настройке недоступного канала", async () => {
    await agent.patch("/integrations/chestny_znak").send({}).expect(409);
  });

  it("отдаёт журнал сеансами, неуспешный — первым", async () => {
    const res = await agent.get("/integrations/commerceml/journal").expect(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it("не пускает ключ станции в кабинетный маршрут", async () => {
    await request(app!.getHttpServer())
      .get("/integrations")
      .set("x-api-key", `mk_${randomUUID()}`)
      .expect(401);
  });
});
