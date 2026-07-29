import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

describe("integrations (cabinet)", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let tenantId: string;

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
    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
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

  // `getChannel`/`updateChannel` уже гоняли тип через `safeDescribeChannel`;
  // `readJournal` брал строку из пути как есть и фильтровал по ней запрос —
  // неизвестный канал молча отдавал пустой журнал вместо 404. Ни один из трёх
  // маршрутов на 404 раньше не проверялся вовсе.
  it("404 на неизвестный тип канала — на всех трёх маршрутах", async () => {
    await agent.get("/integrations/bogus").expect(404);
    await agent.patch("/integrations/bogus").send({}).expect(404);
    await agent.get("/integrations/bogus/journal").expect(404);
  });

  // `stateOf` проверял исход раньше давности: канал, однажды ошибившийся и с
  // тех пор молчащий, вечно показывал бы «ошибка» и никогда «молчит». Давность
  // теперь проверяется первой — молчание важнее.
  it("свежая ошибка — это `error`, а не `silent`", async () => {
    await db
      .update(schema.integrationChannels)
      .set({ lastEventAt: new Date(), lastOutcome: "error", silentAfterHours: 1 })
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );

    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.state).toBe("error");
  });

  it("ошибка за порогом `silentAfterHours` — это `silent`, а не вечная `error`", async () => {
    await db
      .update(schema.integrationChannels)
      .set({
        lastEventAt: new Date(Date.now() - 2 * 3_600_000),
        lastOutcome: "error",
        silentAfterHours: 1,
      })
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );

    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.state).toBe("silent");
  });

  // Кабинетный раздел: ключ станции сюда не должен доходить (docs/device-key-surface.md).
  // Случайный незарегистрированный ключ отваливается ещё на TenantGuard с 401
  // и до SessionOnlyGuard не доходит — настоящий, выданный станции ключ такой
  // проверкой не покрыт. Заводим реальное устройство и ждём 403, как в
  // apps/api/test/pickup-rejections.e2e.test.ts:507-519.
  it("не пускает ключ станции в кабинетный маршрут", async () => {
    const enroll = await agent.post("/station-devices").send({ name: "Terminal" }).expect(201);
    const stationKey = enroll.body.apiKey as string;

    await request(app!.getHttpServer())
      .get("/integrations")
      .set("x-api-key", stationKey)
      .expect(403);
  });
});
