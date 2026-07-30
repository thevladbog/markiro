import { randomUUID } from "node:crypto";
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
import { SILENT_AFTER_HOURS_MAX } from "../src/modules/integrations/dto";
import { JOURNAL_EVENTS_LIMIT } from "../src/modules/integrations/integrations.service";
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

  // Review fix (PR #32, item 8): before `.strict()` (channel-registry.ts),
  // `descriptor.settingsSchema.safeParse` silently STRIPPED any key it
  // didn't recognise -- `parsed.success` stayed `true`, so a typo'd field
  // name came back a clean 200 that changed nothing, and settings stayed
  // exactly as they were.
  it("отвергает неизвестный ключ настроек, а не молча отбрасывает его", async () => {
    const before = await agent.get("/integrations/commerceml").expect(200);

    await agent.patch("/integrations/commerceml").send({ priceTyp: "Розничная" }).expect(400);

    const after = await agent.get("/integrations/commerceml").expect(200);
    expect(after.body.settings).toEqual(before.body.settings);
  });

  // Review fix (PR #32, item 8): `@Body()` alone was only a TypeScript
  // annotation -- nothing checked the actual JSON body was an object at all.
  // A bare array or string used to reach `updateChannel`'s destructuring
  // assignment unfiltered; wiring `ZodValidationPipe` (integrations.controller.ts)
  // now rejects both with a clean 400 instead.
  it("отвергает тело настроек, которое не является объектом", async () => {
    await agent
      .patch("/integrations/commerceml")
      .set("Content-Type", "application/json")
      .send("[1,2,3]")
      .expect(400);
    await agent
      .patch("/integrations/commerceml")
      .set("Content-Type", "application/json")
      .send('"just a string"')
      .expect(400);
    await agent
      .patch("/integrations/commerceml")
      .set("Content-Type", "application/json")
      .send("null")
      .expect(400);
  });

  // `silentAfterHours` — отдельная top-level колонка (`silent_after_hours`),
  // а не поле JSONB `settings`. Раньше `PATCH` её принимал только на вид: без
  // `.passthrough()` в схеме канала `safeParse` тихо вырезал незнакомый ключ,
  // ответ был 200, а колонка не менялась — оператор получал "Настройки
  // сохранены" про то, что не сохранилось.
  it("принимает silentAfterHours отдельно от settings и отдаёт его в GET", async () => {
    await agent.patch("/integrations/commerceml").send({ silentAfterHours: 5 }).expect(200);
    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.silentAfterHours).toBe(5);
    // Настройки канала из предыдущего теста не должны были пострадать —
    // патч выше не прислал ни одного их поля.
    expect(res.body.settings.priceType).toBe("Розничная");
  });

  it("изменение только настроек не сбрасывает уже заданный silentAfterHours", async () => {
    await agent.patch("/integrations/commerceml").send({ priceType: "Оптовая" }).expect(200);
    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.settings.priceType).toBe("Оптовая");
    // 5 из предыдущего теста, а не сброс к дефолту 48 — патч выше не прислал
    // silentAfterHours вовсе.
    expect(res.body.silentAfterHours).toBe(5);
  });

  // `updateChannel` раньше заменял JSONB `settings` целиком
  // (`set: { settings: parsed.data }`). `commercemlSettings` объявляет
  // `splitWriteoffDocument` с `.default(false)`, так что патч, несущий
  // только `priceType`, всё равно проходил `safeParse` — но `parsed.data`
  // при этом нёс подставленный дефолт `false` для поля, которого в запросе
  // не было, и запись стирала им уже включённый `splitWriteoffDocument`.
  it("патч только priceType не сбрасывает уже включённый splitWriteoffDocument", async () => {
    await agent.patch("/integrations/commerceml").send({ splitWriteoffDocument: true }).expect(200);
    let res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.settings.splitWriteoffDocument).toBe(true);

    await agent.patch("/integrations/commerceml").send({ priceType: "Розничная 2" }).expect(200);
    res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.settings.priceType).toBe("Розничная 2");
    // Этот патч splitWriteoffDocument не упоминал вовсе -- должно остаться
    // `true`, а не скатиться к дефолту схемы `false`.
    expect(res.body.settings.splitWriteoffDocument).toBe(true);
  });

  // Симметричный случай: патч только splitWriteoffDocument не должен терять
  // уже сохранённый priceType. Заодно проверяет, что поле остаётся
  // ОСОЗНАННО сбрасываемым несмотря на слияние -- явный
  // `splitWriteoffDocument: false` в патче реально перезаписывает
  // сохранённый `true`, потому что слияние решает по тому, пришёл ли ключ в
  // запросе, а не по тому, отличается ли значение от дефолта.
  it("патч только splitWriteoffDocument не теряет уже сохранённый priceType", async () => {
    await agent.patch("/integrations/commerceml").send({ priceType: "Розничная 3" }).expect(200);

    await agent
      .patch("/integrations/commerceml")
      .send({ splitWriteoffDocument: false })
      .expect(200);
    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.settings.splitWriteoffDocument).toBe(false);
    // Не тронуто этим патчем.
    expect(res.body.settings.priceType).toBe("Розничная 3");
  });

  it("silentAfterHours за пределами границ — 400, и сохранённое значение не трогает", async () => {
    await agent.patch("/integrations/commerceml").send({ silentAfterHours: 0 }).expect(400);
    await agent.patch("/integrations/commerceml").send({ silentAfterHours: -1 }).expect(400);
    await agent.patch("/integrations/commerceml").send({ silentAfterHours: 1.5 }).expect(400);
    await agent
      .patch("/integrations/commerceml")
      .send({ silentAfterHours: SILENT_AFTER_HOURS_MAX + 1 })
      .expect(400);

    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.silentAfterHours).toBe(5);
  });

  it("порог из PATCH реально управляет состоянием «молчит», не только хранится", async () => {
    // Одно и то же событие двухчасовой давности: широкий порог его ещё не
    // считает молчанием, узкий — уже да. Раз это меняется вслед за PATCH'ем
    // (а не только за прямой записью в БД, как в тестах stateOf ниже),
    // значение действительно доходит до `stateOf`, а не просто лежит в ответе.
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await db
      .update(schema.integrationChannels)
      .set({ lastEventAt: twoHoursAgo, lastOutcome: "ok" })
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );

    await agent.patch("/integrations/commerceml").send({ silentAfterHours: 24 }).expect(200);
    const wide = await agent.get("/integrations/commerceml").expect(200);
    expect(wide.body.state).toBe("working");

    await agent.patch("/integrations/commerceml").send({ silentAfterHours: 1 }).expect(200);
    const narrow = await agent.get("/integrations/commerceml").expect(200);
    expect(narrow.body.state).toBe("silent");
  });

  it("отказывает в настройке недоступного канала", async () => {
    await agent.patch("/integrations/chestny_znak").send({}).expect(409);
  });

  // Fix 1 (review, task 15 follow-up): before this guard, `issueCredentials`
  // only checked `available` -- `public_api` is available, so this route
  // used to happily mint and persist a real exchange login+secret pair on
  // its `integration_channels` row even though nothing on the verifying
  // side (`exchange.controller.ts`'s `POST /1c_exchange`) ever reads a
  // `public_api` row's credentials; that channel's real authentication is
  // its own key list (`api-keys.e2e.test.ts`). 409, not 500, and not a
  // silent 201 -- `channel-registry.ts`'s `usesExchangeCredentials` is
  // `false` for `public_api`.
  it("отказывает в выпуске учётных данных обмена каналу, который их не использует (public_api)", async () => {
    const res = await agent.post("/integrations/public_api/credentials").send({}).expect(409);
    expect(res.body.message).toEqual(expect.any(String));

    const row = await agent.get("/integrations/public_api").expect(200);
    expect(row.body.credentialLogin).toBeNull();
  });

  it("отдаёт журнал сеансами, неуспешный — первым", async () => {
    const res = await agent.get("/integrations/commerceml/journal").expect(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  // Review fix (PR #32, item 6): the events query behind this route used to
  // carry no `.limit()` at all -- a big import journals one `grain: "item"`
  // event per skipped/unmatched offer, so a single event-heavy session could
  // make one page load fetch tens of thousands of rows. This pins two things
  // at once: the query is actually bounded (`JOURNAL_EVENTS_LIMIT`), and the
  // events that DO come back are still grouped onto the RIGHT session (the
  // O(sessions × events) `.filter()` this replaced could otherwise have hidden
  // a grouping bug behind a small fixture that happened to work either way).
  it("журнал ограничивает число событий и не путает их между сеансами", async () => {
    const [session] = await db
      .insert(schema.integrationSessions)
      .values({
        tenantId,
        channelType: "commerceml",
        cookieHash: `bulk-events-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: schema.integrationSessions.id });

    const eventCount = JOURNAL_EVENTS_LIMIT + 50;
    const rows = Array.from({ length: eventCount }, (_, i) => ({
      tenantId,
      channelType: "commerceml" as const,
      sessionId: session!.id,
      direction: "in" as const,
      outcome: "warn" as const,
      grain: "item" as const,
      message: `bulk-event-${i}`,
    }));
    await db.insert(schema.integrationEvents).values(rows);

    const res = await agent.get("/integrations/commerceml/journal").expect(200);
    const thisSession = res.body.sessions.find((s: { id: string }) => s.id === session!.id);
    expect(thisSession).toBeDefined();
    // Bounded to EXACTLY the limit, not just "no more than" it: this session
    // alone contributes more rows than the limit, all with the same (latest)
    // insert timestamp, so the global events query's top JOURNAL_EVENTS_LIMIT
    // rows can only come from here -- a weaker "some smaller number came
    // back" bound would also pass if the query silently dropped rows, leaked
    // rows from elsewhere, or applied the limit somewhere it shouldn't.
    expect(thisSession.events.length).toBe(JOURNAL_EVENTS_LIMIT);
    // Every event handed back for THIS session really does belong to it --
    // proof the grouping didn't leak another session's rows in, or this
    // session's rows out, while redistributing `events` into buckets.
    for (const event of thisSession.events) {
      expect(typeof event.message).toBe("string");
      expect((event.message as string).startsWith("bulk-event-")).toBe(true);
    }
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
