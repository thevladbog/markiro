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
});
