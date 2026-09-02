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
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

describe("integrations (cabinet)", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let tenantId: string;
  let journalFrom: Date;
  let journalTo: Date;
  let journalTieAt: Date;
  const journalIdSuffix = randomUUID().slice(8);
  const journalIds = {
    orphan: `ffffffff${journalIdSuffix}`,
    newestOk: `eeeeeeee${journalIdSuffix}`,
    tieHigh: `dddddddd${journalIdSuffix}`,
    tieLow: `cccccccc${journalIdSuffix}`,
    running: `bbbbbbbb${journalIdSuffix}`,
    outside: `aaaaaaaa${journalIdSuffix}`,
  };

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

    const anchor = new Date();
    journalFrom = new Date(anchor.getTime() - 86_400_000);
    journalTo = new Date(anchor.getTime() + 86_400_000);
    journalTieAt = new Date(anchor.getTime() + 120_000);
    const otherAgent = request.agent(app.getHttpServer());
    const otherTenantId = await signUpAndActivate(otherAgent);

    await db
      .insert(schema.orgProfiles)
      .values({ tenantId, timeZone: "Asia/Irkutsk" })
      .onConflictDoUpdate({
        target: schema.orgProfiles.tenantId,
        set: { timeZone: "Asia/Irkutsk" },
      });

    await db.insert(schema.integrationSessions).values([
      {
        id: journalIds.newestOk,
        tenantId,
        channelType: "public_api",
        startedAt: new Date(anchor.getTime() + 180_000),
        finishedAt: new Date(anchor.getTime() + 181_000),
        outcome: "ok",
        cookieHash: `journal-ok-${randomUUID()}`,
        expiresAt: journalTo,
        summary: { message: "newest successful" },
      },
      {
        id: journalIds.tieHigh,
        tenantId,
        channelType: "public_api",
        startedAt: journalTieAt,
        finishedAt: new Date(journalTieAt.getTime() + 1_000),
        outcome: "error",
        cookieHash: `journal-error-${randomUUID()}`,
        expiresAt: journalTo,
      },
      {
        id: journalIds.tieLow,
        tenantId,
        channelType: "public_api",
        startedAt: journalTieAt,
        finishedAt: new Date(journalTieAt.getTime() + 1_000),
        outcome: "warn",
        cookieHash: `journal-warn-${randomUUID()}`,
        expiresAt: journalTo,
      },
      {
        id: journalIds.running,
        tenantId,
        channelType: "public_api",
        startedAt: new Date(anchor.getTime() + 60_000),
        outcome: null,
        cookieHash: `journal-running-${randomUUID()}`,
        expiresAt: journalTo,
      },
      {
        id: journalIds.outside,
        tenantId,
        channelType: "public_api",
        startedAt: new Date(anchor.getTime() - 2 * 86_400_000),
        outcome: "ok",
        cookieHash: `journal-outside-${randomUUID()}`,
        expiresAt: journalTo,
      },
      {
        tenantId: otherTenantId,
        channelType: "public_api",
        startedAt: new Date(anchor.getTime() + 300_000),
        outcome: "error",
        cookieHash: `journal-other-tenant-${randomUUID()}`,
        expiresAt: journalTo,
      },
    ]);

    await db.insert(schema.integrationEvents).values([
      {
        id: journalIds.orphan,
        tenantId,
        channelType: "public_api",
        sessionId: null,
        at: new Date(anchor.getTime() + 240_000),
        direction: "in",
        outcome: "error",
        grain: "session",
        message: "orphan failure",
      },
      {
        tenantId,
        channelType: "public_api",
        sessionId: journalIds.newestOk,
        at: new Date(anchor.getTime() + 180_500),
        direction: "local",
        outcome: "ok",
        grain: "session",
        message: "session summary",
        details: { raw: "exact protocol payload" },
      },
      ...Array.from({ length: 25 }, (_, index) => ({
        tenantId,
        channelType: "public_api" as const,
        sessionId: journalIds.newestOk,
        at: new Date(anchor.getTime() + 181_000 + index),
        direction: "out" as const,
        outcome: "ok" as const,
        grain: "item" as const,
        message: `item-${index}`,
      })),
      {
        tenantId,
        channelType: "public_api",
        sessionId: journalIds.tieHigh,
        at: journalTieAt,
        direction: "out",
        outcome: "error",
        grain: "session",
        message: "failed session",
      },
      {
        tenantId,
        channelType: "public_api",
        sessionId: journalIds.tieLow,
        at: journalTieAt,
        direction: "in",
        outcome: "warn",
        grain: "session",
        message: "warning session",
      },
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("показывает все каналы реестра, включая ещё не построенные", async () => {
    const res = await agent.get("/integrations").expect(200);
    const types = res.body.channels.map((c: { type: string }) => c.type);
    expect(types).toEqual(["commerceml", "public_api", "gis_mt_files", "chestny_znak"]);
    const chz = res.body.channels.find((c: { type: string }) => c.type === "chestny_znak");
    expect(chz.state).toBe("not_configured");
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

  it("явно очищает строковые настройки и пустое сопоставление с сохранением после GET", async () => {
    await agent
      .patch("/integrations/commerceml")
      .send({
        writeoffDocumentType: "Списание товара",
        orderStatusField: "СтатусЗаказа",
        statusMapping: { Оплачен: "punched" },
      })
      .expect(200);

    await agent
      .patch("/integrations/commerceml")
      .send({ writeoffDocumentType: null, orderStatusField: null, statusMapping: {} })
      .expect(200);

    const reloaded = await agent.get("/integrations/commerceml").expect(200);
    expect(reloaded.body.settings).toEqual(
      expect.objectContaining({
        writeoffDocumentType: null,
        orderStatusField: null,
        statusMapping: {},
      }),
    );
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
    await agent.patch("/integrations/gis_mt_files").send({}).expect(409);
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

  it("пагинирует общую хронологию сеансов и одиночных событий без error-first", async () => {
    const first = await agent
      .get("/integrations/public_api/journal")
      .query({
        page: 1,
        pageSize: 2,
        from: journalFrom.toISOString(),
        to: journalTo.toISOString(),
      })
      .expect(200);

    expect(first.body.timeZone).toBe("Asia/Irkutsk");
    expect(first.body.pageInfo).toEqual({
      page: 1,
      pageSize: 2,
      totalItems: 5,
      totalPages: 3,
    });
    expect(first.body.sessions.map((session: { id: string }) => session.id)).toEqual([
      journalIds.orphan,
      journalIds.newestOk,
    ]);
    expect(first.body.sessions[0]).toMatchObject({ eventCount: 1, eventsTruncated: false });

    const second = await agent
      .get("/integrations/public_api/journal")
      .query({
        page: 2,
        pageSize: 2,
        from: journalFrom.toISOString(),
        to: journalTo.toISOString(),
      })
      .expect(200);
    expect(second.body.sessions.map((session: { id: string }) => session.id)).toEqual([
      journalIds.tieHigh,
      journalIds.tieLow,
    ]);

    const beyond = await agent
      .get("/integrations/public_api/journal")
      .query({
        page: 4,
        pageSize: 2,
        from: journalFrom.toISOString(),
        to: journalTo.toISOString(),
      })
      .expect(200);
    expect(beyond.body.sessions).toEqual([]);
    expect(beyond.body.pageInfo.totalItems).toBe(5);
  });

  it("фильтрует выбранные сеансы и сохраняет диагностический контекст", async () => {
    const baseQuery = {
      page: 1,
      pageSize: 20,
      from: journalFrom.toISOString(),
      to: journalTo.toISOString(),
    };

    const errors = await agent
      .get("/integrations/public_api/journal")
      .query({ ...baseQuery, outcome: "error" })
      .expect(200);
    expect(errors.body.sessions.map((session: { id: string }) => session.id)).toEqual([
      journalIds.orphan,
      journalIds.tieHigh,
    ]);

    const running = await agent
      .get("/integrations/public_api/journal")
      .query({ ...baseQuery, outcome: "running" })
      .expect(200);
    expect(running.body.sessions.map((session: { id: string }) => session.id)).toEqual([
      journalIds.running,
    ]);

    const local = await agent
      .get("/integrations/public_api/journal")
      .query({ ...baseQuery, direction: "local" })
      .expect(200);
    expect(local.body.sessions).toHaveLength(1);
    expect(local.body.sessions[0]).toMatchObject({
      id: journalIds.newestOk,
      eventCount: 26,
      eventsTruncated: true,
    });
    expect(local.body.sessions[0].events).toHaveLength(21);
    expect(local.body.sessions[0].events[0]).toMatchObject({
      message: "session summary",
      details: { raw: "exact protocol payload" },
    });
    expect(
      local.body.sessions[0].events
        .filter((event: { message: string }) => event.message.startsWith("item-"))
        .map((event: { message: string }) => event.message),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `item-${index + 5}`));
  });

  it("включает границы временного окна", async () => {
    const result = await agent
      .get("/integrations/public_api/journal")
      .query({
        from: journalTieAt.toISOString(),
        to: journalTieAt.toISOString(),
      })
      .expect(200);

    expect(result.body.sessions.map((session: { id: string }) => session.id)).toEqual([
      journalIds.tieHigh,
      journalIds.tieLow,
    ]);
  });

  it.each([
    { page: 0 },
    { pageSize: 51 },
    { outcome: "failed" },
    { direction: "sideways" },
    { from: "not-a-date" },
    { from: "2026-09-02T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
    { from: "2026-05-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" },
  ])(
    "отвергает неверные параметры журнала: $page$pageSize$outcome$direction$from",
    async (query) => {
      await agent.get("/integrations/public_api/journal").query(query).expect(400);
    },
  );

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
    const stationKey = (await createTestStationDevice(app!, agent, "Terminal")).apiKey;

    await request(app!.getHttpServer())
      .get("/integrations")
      .set("x-api-key", stationKey)
      .expect(403);
  });
});
