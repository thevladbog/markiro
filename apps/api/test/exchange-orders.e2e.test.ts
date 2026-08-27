import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";
import { excludeExchangeRoute } from "../src/modules/exchange/exchange.module";
import { checkauthWindowStart } from "../src/modules/exchange/exchange-credentials";
import { IMPORT_BATCH_SIZE } from "../src/modules/exchange/exchange.controller";
import { hashDeviceToken } from "../src/pickup/device-token";
import { ExchangeSessionService } from "../src/modules/exchange/exchange-session.service";

describe("1c_exchange orders (И-2)", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let tenantId: string;
  let kioskId: string;
  let employeeId: string;
  let login: string;
  let secret: string;
  // Same reasoning as exchange-protocol.e2e.test.ts's own `checkauthWindow`:
  // captured once, at suite start, so afterAll's cleanup only ever removes
  // rate-limit rows this run itself could have written.
  const checkauthWindow = checkauthWindowStart(new Date());

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
    server.use(excludeExchangeRoute(express.json()));
    await app.init();
    await listenOnLoopback(app);
    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    employeeId = randomUUID();
    await db.insert(schema.employees).values({ id: employeeId, tenantId, fullName: "Иван Иванов" });

    kioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId, name: "Киоск", dayLimitPerEmployee: 20 });

    const issued = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
    login = issued.body.login;
    secret = issued.body.secret;
  });

  afterAll(async () => {
    await db
      .delete(schema.exchangeAttempts)
      .where(
        and(
          inArray(schema.exchangeAttempts.source, ["127.0.0.1", "::1", "::ffff:127.0.0.1"]),
          eq(schema.exchangeAttempts.windowStartedAt, checkauthWindow),
        ),
      );
    await app?.close();
  });

  async function checkauth(): Promise<{ cookie: string }> {
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(login, secret)
      .expect(200);
    const [, name, value] = res.text.split("\n");
    return { cookie: `${name}=${value}` };
  }

  async function journalEvents(): Promise<
    { message: string; details: Record<string, unknown> | null }[]
  > {
    const res = await agent.get("/integrations/commerceml/journal").expect(200);
    return res.body.sessions.flatMap(
      (s: { events: { message: string; details: Record<string, unknown> | null }[] }) => s.events,
    );
  }

  it("query/success выгружает pending заявку и помечает её выгруженной", async () => {
    const { cookie } = await checkauth();

    const linkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: linkedProductId,
      tenantId,
      gtin14: "04600682000112",
      name: "Экспортный товар",
      externalRef: `ext-${randomUUID()}`,
    });

    const orderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      totalPrice: "50.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId,
      productId: linkedProductId,
      gtin14: "04600682000112",
      serial: "SN9001",
      rawKm: "raw-query-1",
      kmKey: `kmkey-${randomUUID()}`,
      unitPrice: "50.00",
      scannedAt: new Date(),
    });

    const queryRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", cookie)
      .expect(200);
    expect(queryRes.headers["content-type"]).toContain("application/xml");
    expect(queryRes.text).toContain(`<Ид>${orderId}</Ид>`);
    // СБИС отклоняет документ без обязательного ключа «Контрагент» --
    // покупателем едет сотрудник, оформивший заявку (order-export.ts).
    expect(queryRes.text).toContain(
      `<Контрагенты><Контрагент><Ид>${employeeId}</Ид><Наименование>Иван Иванов</Наименование>` +
        "<Роль>Покупатель</Роль><ПолноеНаименование>Иван Иванов</ПолноеНаименование>" +
        "</Контрагент></Контрагенты>",
    );

    const [beforeSuccess] = await db
      .select({ exportedAt: schema.pickupOrders.exportedAt })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(beforeSuccess?.exportedAt).toBeNull();

    const successRes = await request(app!.getHttpServer())
      .post("/1c_exchange?mode=success")
      .set("Cookie", cookie)
      .expect(200);
    expect(successRes.text).toBe("success");

    const [afterSuccess] = await db
      .select({ exportedAt: schema.pickupOrders.exportedAt })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(afterSuccess?.exportedAt).not.toBeNull();

    // A second query round must not offer the same order again.
    const secondQueryRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", cookie)
      .expect(200);
    expect(secondQueryRes.text).not.toContain(`<Ид>${orderId}</Ид>`);
  });

  it("атомарно выбирает одну outstanding query-пачку для конкурентных первых запросов", async () => {
    const { cookie } = await checkauth();
    const cookieValue = cookie.slice(cookie.indexOf("=") + 1);
    const [session] = await db
      .select({ id: schema.integrationSessions.id })
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.cookieHash, hashDeviceToken(cookieValue)));
    const sessions = app!.get(ExchangeSessionService);
    const first = { orderIds: [randomUUID()], xml: "<first/>" };
    const second = { orderIds: [], xml: "<empty/>" };

    const [left, right] = await Promise.all([
      sessions.ensureOutstandingOrderQuery(session!.id, first),
      sessions.ensureOutstandingOrderQuery(session!.id, second),
    ]);

    expect(left).toEqual(right);
    expect([first, second]).toContainEqual(left);
    await sessions.writeOutstandingOrderQuery(session!.id, null);
  });

  it("товар без связи придерживает заявку — она не появляется в query", async () => {
    const { cookie } = await checkauth();

    const unlinkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: unlinkedProductId,
      tenantId,
      gtin14: "04600682000129",
      name: "Без связи",
    });

    const orderId = randomUUID();
    const orderNo = `ORD-26-${randomUUID().slice(0, 4)}`;
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      totalPrice: "10.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId,
      productId: unlinkedProductId,
      gtin14: "04600682000129",
      serial: "SN9002",
      rawKm: "raw-query-2",
      kmKey: `kmkey-${randomUUID()}`,
      unitPrice: "10.00",
      scannedAt: new Date(),
    });

    const queryRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", cookie)
      .expect(200);
    expect(queryRes.text).not.toContain(`<Ид>${orderId}</Ид>`);

    const events = await journalEvents();
    expect(events.some((e) => e.message.includes(orderNo))).toBe(true);

    // Regression: this round's summary event must report the TRUE held
    // count. `findExportCandidates`'s `candidates` are pre-filtered to
    // exclude held orders (final-review Fix 4), so `planExport`'s own
    // `plan.held` is always empty by construction -- if `query()` still read
    // `plan.held.length` here instead of the separately-queried `held` array,
    // this would silently report `held: 0` no matter how many orders were
    // actually held back.
    const summary = events.find((e) => e.message.startsWith("query: предложено заявок"));
    expect(summary?.details).toMatchObject({ offered: 0, held: 1 });
  });

  it("type=sale&mode=import переводит pending заявку по сопоставленному статусу", async () => {
    const { cookie } = await checkauth();

    const orderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
    });

    // Configure this connection's orderStatusField/statusMapping before
    // sending the file -- PATCH /integrations/commerceml with the admin
    // agent (this file's `agent`, distinct from the raw `request(...)` calls
    // used for `/1c_exchange` itself).
    await agent
      .patch("/integrations/commerceml")
      .send({ orderStatusField: "СтатусЗаказа", statusMapping: { Оплачен: "punched" } })
      .expect(200);

    const saleXml = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<КоммерческаяИнформация><ПакетДокументов><Документ>",
        `<Ид>${orderId}</Ид>`,
        "<ЗначенияРеквизитов><ЗначениеРеквизита>",
        "<Наименование>СтатусЗаказа</Наименование><Значение>Оплачен</Значение>",
        "</ЗначениеРеквизита></ЗначенияРеквизитов>",
        "</Документ></ПакетДокументов></КоммерческаяИнформация>",
      ].join(""),
      "utf8",
    );

    // No explicit Content-Type header, matching every other `mode=file` test
    // in this codebase: `ensureContentType` (exchange.module.ts) backfills
    // one when absent, and supertest's `.send(Buffer)` doesn't set one on
    // its own -- see exchange-protocol.e2e.test.ts's own chunk-upload test.
    await request(app!.getHttpServer())
      .post("/1c_exchange?mode=file&filename=sale.xml")
      .set("Cookie", cookie)
      .send(saleXml)
      .expect(200);

    const importRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=import&type=sale&filename=sale.xml")
      .set("Cookie", cookie)
      .expect(200);
    expect(importRes.text).toBe("success");

    const [row] = await db
      .select({ status: schema.pickupOrders.status })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(row?.status).toBe("punched");
  });

  it("type=sale&mode=import обрабатывает ограниченные возобновляемые пакеты и безопасно повторяет финальный success", async () => {
    const auth = await checkauth();
    await agent
      .patch("/integrations/commerceml")
      .send({ orderStatusField: "СтатусЗаказа", statusMapping: { Оплачен: "punched" } })
      .expect(200);

    const orderIds = Array.from({ length: IMPORT_BATCH_SIZE + 1 }, () => randomUUID());
    await db.insert(schema.pickupOrders).values(
      orderIds.map((id, index) => ({
        id,
        tenantId,
        orderNo: `SALE-BATCH-${randomUUID()}-${index}`,
        kioskId,
        employeeId,
        reason: "buy" as const,
        itemCount: 1,
      })),
    );
    const documents = orderIds
      .map(
        (id) =>
          `<Документ><Ид>${id}</Ид><ЗначенияРеквизитов><ЗначениеРеквизита>` +
          "<Наименование>СтатусЗаказа</Наименование><Значение>Оплачен</Значение>" +
          "</ЗначениеРеквизита></ЗначенияРеквизитов></Документ>",
      )
      .join("");
    const saleXml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><КоммерческаяИнформация><ПакетДокументов>${documents}</ПакетДокументов></КоммерческаяИнформация>`,
      "utf8",
    );
    const filename = `sale-batch-${randomUUID()}.xml`;
    await request(app!.getHttpServer())
      .post(`/1c_exchange?mode=file&filename=${filename}`)
      .set("Cookie", auth.cookie)
      .send(saleXml)
      .expect(200);

    const first = await request(app!.getHttpServer())
      .get(`/1c_exchange?mode=import&type=sale&filename=${filename}`)
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(first.text).toBe("progress");

    const rowsAfterFirst = await db
      .select({ id: schema.pickupOrders.id, status: schema.pickupOrders.status })
      .from(schema.pickupOrders)
      .where(inArray(schema.pickupOrders.id, orderIds));
    expect(rowsAfterFirst.filter((row) => row.status === "punched")).toHaveLength(
      IMPORT_BATCH_SIZE,
    );

    // A settings edit between progress rounds must not mix two mappings in
    // one file or strand its remainder. The cursor keeps the first round's
    // effective configuration until this exact upload completes.
    await agent
      .patch("/integrations/commerceml")
      .send({ statusMapping: { Оплачен: "cancelled" } })
      .expect(200);
    const second = await request(app!.getHttpServer())
      .get(`/1c_exchange?mode=import&type=sale&filename=${filename}`)
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(second.text).toBe("success");

    const rowsAfterCompletion = await db
      .select({ status: schema.pickupOrders.status })
      .from(schema.pickupOrders)
      .where(inArray(schema.pickupOrders.id, orderIds));
    expect(rowsAfterCompletion.every((row) => row.status === "punched")).toBe(true);

    // The final response may have reached 1C ambiguously. Changing the
    // mapping after this file completed must not reinterpret and replay it;
    // the same uploaded bytes still receive the cached successful outcome.
    const third = await request(app!.getHttpServer())
      .get(`/1c_exchange?mode=import&type=sale&filename=${filename}`)
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(third.text).toBe("success");

    const cookieValue = auth.cookie.slice(auth.cookie.indexOf("=") + 1);
    const [session] = await db
      .select({ summary: schema.integrationSessions.summary })
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.cookieHash, hashDeviceToken(cookieValue)));
    expect(session?.summary?.["saleImportCursors"]).toMatchObject({
      [filename]: {
        offset: orderIds.length,
        applied: orderIds.length,
        discrepancies: 0,
        total: orderIds.length,
        completed: true,
      },
    });

    const events = await journalEvents();
    expect(
      events.filter((event) => event.message === `import (sale): файл «${filename}» применён`),
    ).toHaveLength(1);
  }, 15_000);

  it("статус, не найденный в таблице сопоставления, журналируется как расхождение и заявку не трогает", async () => {
    const { cookie } = await checkauth();

    const orderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
    });

    const saleXml = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<КоммерческаяИнформация><ПакетДокументов><Документ>",
        `<Ид>${orderId}</Ид>`,
        "<ЗначенияРеквизитов><ЗначениеРеквизита>",
        "<Наименование>СтатусЗаказа</Наименование><Значение>НеизвестноеЗначение</Значение>",
        "</ЗначениеРеквизита></ЗначенияРеквизитов>",
        "</Документ></ПакетДокументов></КоммерческаяИнформация>",
      ].join(""),
      "utf8",
    );

    await request(app!.getHttpServer())
      .post("/1c_exchange?mode=file&filename=sale2.xml")
      .set("Cookie", cookie)
      .send(saleXml)
      .expect(200);

    await request(app!.getHttpServer())
      .get("/1c_exchange?mode=import&type=sale&filename=sale2.xml")
      .set("Cookie", cookie)
      .expect(200);

    const [row] = await db
      .select({ status: schema.pickupOrders.status })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(row?.status).toBe("pending");

    const events = await journalEvents();
    expect(events.some((e) => e.message.startsWith("статус не сопоставлен"))).toBe(true);
  });

  it("type=sale&mode=import: не-UUID Ид у одного документа не прерывает пакет — журналируется как расхождение (Fix A)", async () => {
    const { cookie } = await checkauth();

    await agent
      .patch("/integrations/commerceml")
      .send({ orderStatusField: "СтатусЗаказа", statusMapping: { Оплачен: "punched" } })
      .expect(200);

    // Not shaped like a UUID at all -- the exact case Fix A validates for
    // BEFORE calling `applyExternalStatus`, rather than by catching the
    // Postgres `22P02` that comparing this against a `uuid` column used to
    // throw. Paired with a status value that DOES map to something
    // (`Оплачен` -> `punched`) so this exercises the lookup-failure path, not
    // the separate "статус не сопоставлен" path already covered above.
    const badExternalRef = "not-a-real-guid";
    const saleXml = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<КоммерческаяИнформация><ПакетДокументов><Документ>",
        `<Ид>${badExternalRef}</Ид>`,
        "<ЗначенияРеквизитов><ЗначениеРеквизита>",
        "<Наименование>СтатусЗаказа</Наименование><Значение>Оплачен</Значение>",
        "</ЗначениеРеквизита></ЗначенияРеквизитов>",
        "</Документ></ПакетДокументов></КоммерческаяИнформация>",
      ].join(""),
      "utf8",
    );

    await request(app!.getHttpServer())
      .post("/1c_exchange?mode=file&filename=sale-bad-guid.xml")
      .set("Cookie", cookie)
      .send(saleXml)
      .expect(200);

    const importRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=import&type=sale&filename=sale-bad-guid.xml")
      .set("Cookie", cookie)
      .expect(200);
    // The route must still answer "success" -- a malformed single document
    // must never abort the whole batch (which is exactly what removing the
    // former overly-wide try/catch, in favor of validating up front, fixes).
    expect(importRes.text).toBe("success");

    const events = await journalEvents();
    const discrepancy = events.find((e) =>
      e.message.includes(`расхождение статуса (lookup_failed): ${badExternalRef}`),
    );
    expect(discrepancy).toBeTruthy();
    expect(discrepancy?.details).toMatchObject({
      externalRef: badExternalRef,
      mapped: "punched",
      outcome: "lookup_failed",
      error: "externalRef is not UUID-shaped",
    });
  });

  it("GET /1c_exchange?mode=success ведёт себя так же, как POST-вариант (Fix 2)", async () => {
    const { cookie } = await checkauth();

    const linkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: linkedProductId,
      tenantId,
      gtin14: "04600682000136",
      name: "Экспортный товар (GET success)",
      externalRef: `ext-${randomUUID()}`,
    });

    const orderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      totalPrice: "50.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId,
      productId: linkedProductId,
      gtin14: "04600682000136",
      serial: "SN9003",
      rawKm: "raw-query-get-success",
      kmKey: `kmkey-${randomUUID()}`,
      unitPrice: "50.00",
      scannedAt: new Date(),
    });

    const queryRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", cookie)
      .expect(200);
    expect(queryRes.text).toContain(`<Ид>${orderId}</Ид>`);

    const [beforeSuccess] = await db
      .select({ exportedAt: schema.pickupOrders.exportedAt })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(beforeSuccess?.exportedAt).toBeNull();

    // Fix 2 (final review): the real 1С protocol's own order/sale round-trip
    // (checkauth -> init -> query -> success) runs entirely over GET, so
    // `mode=success` must work identically here to the POST-based test above.
    const successRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=success")
      .set("Cookie", cookie)
      .expect(200);
    expect(successRes.text).toBe("success");

    const [afterSuccess] = await db
      .select({ exportedAt: schema.pickupOrders.exportedAt })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(afterSuccess?.exportedAt).not.toBeNull();
  });

  it("mode=success помечает exportedAt даже если заявку уже разрешили локально до success (Fix 3)", async () => {
    const { cookie } = await checkauth();

    const linkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: linkedProductId,
      tenantId,
      gtin14: "04600682000143",
      name: "Экспортный товар (resolve до success)",
      externalRef: `ext-${randomUUID()}`,
    });

    const orderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      totalPrice: "50.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId,
      productId: linkedProductId,
      gtin14: "04600682000143",
      serial: "SN9004",
      rawKm: "raw-query-resolved-before-success",
      kmKey: `kmkey-${randomUUID()}`,
      unitPrice: "50.00",
      scannedAt: new Date(),
    });

    const queryRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", cookie)
      .expect(200);
    expect(queryRes.text).toContain(`<Ид>${orderId}</Ид>`);

    // Resolved LOCALLY through the admin API, between this session's own
    // `mode=query` and `mode=success` -- the exact race Fix 3's own comment
    // (`PickupOrdersService.success`) describes: 1С genuinely received and is
    // about to confirm this order, but an operator punched it in the cabinet
    // first, so the order is no longer `pending` by the time `mode=success`
    // runs.
    const resolveRes = await agent
      .post(`/pickup-orders/${orderId}/resolve`)
      .send({ action: "punch", receiptNo: "R-1c-success" })
      .expect(200);
    expect(resolveRes.body.status).toBe("punched");

    // The pending batch is a protocol offer, not a fresh selection. Even
    // after the order becomes terminal and export formatting settings move,
    // query must replay the exact bytes 1С has not acknowledged yet.
    await agent
      .patch("/integrations/commerceml")
      .send({ splitWriteoffDocument: true, writeoffDocumentType: "Changed after query" })
      .expect(200);
    const repeatedQueryRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", cookie)
      .expect(200);
    expect(repeatedQueryRes.text).toBe(queryRes.text);

    const successRes = await request(app!.getHttpServer())
      .post("/1c_exchange?mode=success")
      .set("Cookie", cookie)
      .expect(200);
    expect(successRes.text).toBe("success");

    const [afterSuccess] = await db
      .select({ exportedAt: schema.pickupOrders.exportedAt, status: schema.pickupOrders.status })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    // The order is terminal (`punched`, not `pending`) but Fix 3 (dropping
    // `success()`'s `status = "pending"` predicate) means `exportedAt` still
    // gets set -- proving it isn't left permanently unset just because the
    // order was resolved before 1С's own confirmation arrived.
    expect(afterSuccess?.status).toBe("punched");
    expect(afterSuccess?.exportedAt).not.toBeNull();
  });
});
