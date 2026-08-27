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
import {
  EXCHANGE_COOKIE_NAME,
  ExchangeSessionService,
} from "../src/modules/exchange/exchange-session.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

/**
 * `DELETE /integrations/:type` -- полное отключение интеграции (тенант
 * переходит на другую систему). Отдельный файл, а не продолжение
 * integrations.e2e.test.ts: тесты того файла последовательно наращивают
 * состояние одного канала (settings/silentAfterHours переживают тесты),
 * а удаление посреди этой цепочки сломало бы её.
 */
describe("integrations delete (cabinet)", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let tenantId: string;
  let sessions: ExchangeSessionService;

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
    sessions = app.get(ExchangeSessionService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("удаляет настройки, учётные данные, сеансы, журнал и очередь одной операцией", async () => {
    // Настроенный канал: настройки, учётные данные, живой сеанс с cookie,
    // кусок файла обмена и позиция в очереди несопоставленных.
    await agent.patch("/integrations/commerceml").send({ priceType: "Розничная" }).expect(200);
    const issued = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
    expect(issued.body.login).toBeTruthy();

    const opened = await sessions.open(tenantId, "commerceml");
    const cookie = `${EXCHANGE_COOKIE_NAME}=${opened.cookie}`;
    await db.insert(schema.exchangeUploads).values({
      tenantId,
      sessionId: opened.id,
      filename: "import.xml",
      chunk: 0,
      body: Buffer.from("<xml/>"),
    });
    await db.insert(schema.integrationCandidates).values({
      tenantId,
      channelType: "commerceml",
      externalRef: "ref-to-be-deleted",
      name: "Тестовая позиция",
    });

    // Cookie жива: init отвечает протокольным успехом.
    const initBefore = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=init")
      .set("Cookie", cookie)
      .expect(200);
    expect(initBefore.text.startsWith("zip=")).toBe(true);

    await agent.delete("/integrations/commerceml").expect(204);

    // Канал вернулся в исходное состояние: ни настроек, ни логина, ни строки.
    const detail = await agent.get("/integrations/commerceml").expect(200);
    expect(detail.body.state).toBe("not_configured");
    expect(detail.body.settings).toEqual({});
    expect(detail.body.credentialLogin).toBeNull();
    expect(detail.body.lastEventAt).toBeNull();

    // Журнал очищен и объясняет почему: ровно одна запись об удалении.
    const journal = await agent.get("/integrations/commerceml/journal").expect(200);
    expect(journal.body.sessions).toHaveLength(1);
    const messages = journal.body.sessions.flatMap((s: { events: { message: string }[] }) =>
      s.events.map((e) => e.message),
    );
    expect(messages).toEqual(["Интеграция удалена: настройки, учётные данные и журнал очищены"]);

    // Очередь несопоставленных пуста.
    const candidates = await agent
      .get("/integrations/commerceml/candidates?hidden=false")
      .expect(200);
    expect(candidates.body.candidates).toEqual([]);

    // Сеансы и куски файлов удалены физически, не только завершены.
    const sessionRows = await db
      .select()
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.tenantId, tenantId));
    expect(sessionRows).toEqual([]);
    const uploadRows = await db
      .select({ id: schema.exchangeUploads.id })
      .from(schema.exchangeUploads)
      .where(eq(schema.exchangeUploads.tenantId, tenantId));
    expect(uploadRows).toEqual([]);
  });

  it("старая cookie мертва и не воскрешает удалённый канал", async () => {
    // Cookie из предыдущего теста больше не встречает строку сеанса --
    // `resolve` отвечает "no session" МОЛЧА (без журнальной записи), потому
    // что журналирование предъявленной cookie идёт через upsert строки
    // канала (`JournalService.append`) и воскресило бы только что удалённый
    // канал. Здесь заводится свежий сеанс и удаляется вместе с каналом,
    // чтобы тест не зависел от порядка с предыдущим.
    await agent.patch("/integrations/commerceml").send({ priceType: "Оптовая" }).expect(200);
    const opened = await sessions.open(tenantId, "commerceml");
    const cookie = `${EXCHANGE_COOKIE_NAME}=${opened.cookie}`;

    await agent.delete("/integrations/commerceml").expect(204);

    const initAfter = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=init")
      .set("Cookie", cookie)
      .expect(200);
    expect(initAfter.text.startsWith("failure")).toBe(true);

    // Предъявление мёртвой cookie не создало строку канала заново.
    const detail = await agent.get("/integrations/commerceml").expect(200);
    expect(detail.body.state).toBe("not_configured");
    const rows = await db
      .select()
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );
    expect(rows).toEqual([]);
  });

  it("повторное удаление — 409: удалять нечего", async () => {
    await agent.delete("/integrations/commerceml").expect(409);
  });

  it("404 на неизвестный тип канала", async () => {
    await agent.delete("/integrations/bogus").expect(404);
  });

  // У `public_api` аутентификация -- собственный список ключей
  // (api-keys.service.ts), удаление строки канала их бы НЕ отозвало, а
  // выглядело бы как "интеграция удалена". Отказ, а не полу-удаление.
  it("409 каналу без учётных данных обмена (public_api)", async () => {
    await agent.delete("/integrations/public_api").expect(409);
  });

  // Кабинетный раздел: ключ станции сюда не должен доходить
  // (docs/device-key-surface.md) -- та же граница, что в
  // integrations.e2e.test.ts.
  it("не пускает ключ станции в маршрут удаления", async () => {
    const stationKey = (await createTestStationDevice(app!, agent, "Terminal")).apiKey;

    await request(app!.getHttpServer())
      .delete("/integrations/commerceml")
      .set("x-api-key", stationKey)
      .expect(403);
  });
});
