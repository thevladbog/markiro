import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { schema, type Db } from "@markiro/db";
import { and, eq, like } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";
import { excludeExchangeRoute } from "../src/modules/exchange/exchange.module";
import { IMPORT_BATCH_SIZE } from "../src/modules/exchange/exchange.controller";
import { ExchangeSessionService } from "../src/modules/exchange/exchange-session.service";
import { hashDeviceToken } from "../src/pickup/device-token";

/** A minimal `<Каталог><Товары><Товар>` document -- one item, one name. */
function catalogXmlFor(guid: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05">
 <Каталог><Товары>
  <Товар>
   <Ид>${guid}</Ид>
   <Наименование>${name}</Наименование>
  </Товар>
 </Товары></Каталог>
</КоммерческаяИнформация>`;
}

/**
 * A minimal `<ПакетПредложений><Предложения><Предложение>` document -- one
 * offer, one price, the inline `<Представление>` label so the price type
 * resolves without needing a `<ТипыЦен>` catalog (see parse.ts).
 */
function offersXmlFor(guid: string, price: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05">
 <ПакетПредложений>
  <Предложения>
   <Предложение>
    <Ид>${guid}</Ид>
    <Цены>
     <Цена>
      <Представление>Розничная</Представление>
      <ЦенаЗаЕдиницу>${price}</ЦенаЗаЕдиницу>
      <Валюта>руб</Валюта>
     </Цена>
    </Цены>
   </Предложение>
  </Предложения>
 </ПакетПредложений>
</КоммерческаяИнформация>`;
}

describe("mode=import", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let login: string;
  let secret: string;
  let productId: string;
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
    server.use(excludeExchangeRoute(express.json()));
    await app.init();
    await listenOnLoopback(app);
    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    const issued = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
    login = issued.body.login;
    secret = issued.body.secret;

    productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04600682000013",
      name: "Исходное имя",
      unitPrice: "50.00",
      externalRef: "guid-1",
    });
  });

  afterAll(async () => {
    // The "не размножает кандидатов" tests below look up rows by the bare
    // literal `externalRef` ("guid-new"), with no tenant filter -- that is
    // the brief's own assertion, verbatim. Harmless within a single run (one
    // tenant, one row), but this suite shares one real, persistent Postgres
    // across runs (see exchange-protocol.e2e.test.ts's own afterAll for the
    // same concern about `exchange_attempts`): a second run would create a
    // SECOND tenant, insert a SECOND "guid-new" row, and the unscoped query
    // would then see two rows and fail a test that changed nothing. Deleting
    // this run's own candidate rows here keeps the suite repeatable without
    // touching the brief's assertions themselves.
    await db
      .delete(schema.integrationCandidates)
      .where(eq(schema.integrationCandidates.tenantId, tenantId));
    await app?.close();
  });

  /** Repeats the checkauth exchange and turns its two body lines into a `Cookie` header value. */
  async function checkauth(): Promise<{ cookie: string; value: string }> {
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(login, secret)
      .expect(200);
    const [, name, value] = res.text.split("\n");
    return { cookie: `${name}=${value}`, value: value! };
  }

  async function uploadFile(
    auth: { cookie: string },
    filename: string,
    xml: string,
  ): Promise<void> {
    await request(app!.getHttpServer())
      .post(`/1c_exchange?type=catalog&mode=file&filename=${filename}`)
      .set("Cookie", auth.cookie)
      .send(Buffer.from(xml, "utf8"))
      .expect(200);
  }

  it("применяет цены сопоставленным товарам и отвечает success", async () => {
    // товар с external_ref = guid-1 создан в beforeAll
    const auth = await checkauth();
    await uploadFile(auth, "offers.xml", offersXmlFor("guid-1", "77.50"));
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=offers.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(res.text.trim()).toBe("success");

    const [product] = await db
      .select({ unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product!.unitPrice).toBe("77.50");
  });

  it("незнакомую номенклатуру кладёт в кандидаты, а каталог не трогает", async () => {
    const auth = await checkauth();
    await uploadFile(auth, "import.xml", catalogXmlFor("guid-new", "Новинка"));
    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=import.xml")
      .set("Cookie", auth.cookie)
      .expect(200);

    const rows = await db
      .select()
      .from(schema.integrationCandidates)
      .where(eq(schema.integrationCandidates.externalRef, "guid-new"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Новинка");
  });

  it("повторный import не размножает кандидатов", async () => {
    const auth = await checkauth();
    await uploadFile(auth, "import.xml", catalogXmlFor("guid-new", "Новинка"));
    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=import.xml")
      .set("Cookie", auth.cookie)
      .expect(200);

    const rows = await db
      .select()
      .from(schema.integrationCandidates)
      .where(eq(schema.integrationCandidates.externalRef, "guid-new"));
    expect(rows).toHaveLength(1);
  });

  it("обмен не меняет ни имя, ни GTIN сопоставленного товара", async () => {
    const before = await db
      .select({ name: schema.products.name, gtin14: schema.products.gtin14 })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    const auth = await checkauth();
    await uploadFile(auth, "import.xml", catalogXmlFor("guid-1", "ДРУГОЕ ИМЯ"));
    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=import.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    const after = await db
      .select({ name: schema.products.name, gtin14: schema.products.gtin14 })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(after).toEqual(before);
  });

  // Review fix (Fix 1): a finished file used to close the whole session
  // (`finishSession`) -- this test used to look for a session with
  // `outcome === "ok"` and its summary there. Now a file's outcome is a
  // journal event of its own, and the session it belongs to stays open (only
  // `ExchangeSessionService.sweepExpired`, on TTL expiry, ever finishes a
  // session) -- see that method's own comment for why.
  it("пишет итог файла в журнал событием, а сеанс не завершает", async () => {
    const auth = await checkauth();
    await uploadFile(auth, "summary.xml", offersXmlFor("guid-1", "88.00"));
    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=summary.xml")
      .set("Cookie", auth.cookie)
      .expect(200);

    const journal = await agent.get("/integrations/commerceml/journal").expect(200);
    const session = journal.body.sessions.find((s: { events: { message: string }[] }) =>
      s.events.some((e) => e.message.includes("summary.xml")),
    );
    expect(session).toBeDefined();
    // Файл завершился успешно, но сеанс -- нет: обмен по протоколу без «до
    // свидания» мог ещё не закончиться, следующий файл может прийти с той
    // же cookie.
    expect(session.finishedAt).toBeNull();
    expect(session.outcome).toBeNull();

    const fileEvent = session.events.find(
      (e: { message: string; outcome: string }) =>
        e.message.includes("summary.xml") && e.outcome === "ok",
    );
    expect(fileEvent).toBeDefined();
    expect((fileEvent as { details: Record<string, unknown> }).details).toMatchObject({
      updated: expect.any(Number),
    });
  });

  it("sweepExpired закрывает сеанс по истечении TTL и проставляет исход, не удаляя строку", async () => {
    const sessions = app!.get(ExchangeSessionService);
    const auth = await checkauth();
    const cookieHash = hashDeviceToken(auth.value);
    const [session] = await db
      .select()
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.cookieHash, cookieHash));
    expect(session).toBeDefined();

    // Состариваем именно этот сеанс, как будто его TTL истёк, не трогая
    // ничего другого -- та же техника, что `exchange-protocol.e2e.test.ts`
    // использует для резолва сеанса по cookie-хэшу.
    await db
      .update(schema.integrationSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.integrationSessions.id, session!.id));

    await sessions.sweepExpired(new Date());

    const [after] = await db
      .select()
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.id, session!.id));
    expect(after).toBeDefined();
    expect(after!.finishedAt).not.toBeNull();
    // Единственное событие этого сеанса на момент истечения -- "checkauth:
    // сеанс открыт" (outcome "ok"), поэтому закрывающий исход обязан быть
    // "ok", а не молчаливым "error" по умолчанию.
    expect(after!.outcome).toBe("ok");
  });

  // Beyond the brief's five: the prose requirements ("не теряйте молча",
  // "большой каталог ... отвечает progress") aren't exercised by the five
  // tests above, so pin them directly -- same convention as
  // exchange-protocol.e2e.test.ts's own "Beyond the brief's five" section.

  it("неоднозначный тип цены не применяется и уходит в журнал с перечнем пришедших типов", async () => {
    const before = await db
      .select({ unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));

    const auth = await checkauth();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05">
 <ПакетПредложений>
  <Предложения>
   <Предложение>
    <Ид>guid-1</Ид>
    <Цены>
     <Цена>
      <Представление>Розничная</Представление>
      <ЦенаЗаЕдиницу>111.00</ЦенаЗаЕдиницу>
      <Валюта>руб</Валюта>
     </Цена>
     <Цена>
      <Представление>Закупочная</Представление>
      <ЦенаЗаЕдиницу>222.00</ЦенаЗаЕдиницу>
      <Валюта>руб</Валюта>
     </Цена>
    </Цены>
   </Предложение>
  </Предложения>
 </ПакетПредложений>
</КоммерческаяИнформация>`;
    await uploadFile(auth, "offers-ambiguous.xml", xml);
    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=offers-ambiguous.xml")
      .set("Cookie", auth.cookie)
      .expect(200);

    const after = await db
      .select({ unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(after).toEqual(before);

    const journal = await agent.get("/integrations/commerceml/journal").expect(200);
    const events = journal.body.sessions.flatMap(
      (s: { events: { message: string; details: Record<string, unknown> | null }[] }) => s.events,
    );
    const skipEvent = events.find((e: { message: string }) =>
      e.message.includes("ambiguous_price_type"),
    );
    expect(skipEvent).toBeDefined();
    expect((skipEvent!.details as { priceTypes?: string[] } | null)?.priceTypes).toEqual(
      expect.arrayContaining(["Розничная", "Закупочная"]),
    );
  });

  it("предложение на товар без связи в каталоге не исчезает — фиксируется в журнале", async () => {
    const auth = await checkauth();
    await uploadFile(auth, "offers-unlinked.xml", offersXmlFor("guid-unlinked-zzz", "10.00"));
    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=offers-unlinked.xml")
      .set("Cookie", auth.cookie)
      .expect(200);

    const journal = await agent.get("/integrations/commerceml/journal").expect(200);
    const messages = journal.body.sessions.flatMap((s: { events: { message: string }[] }) =>
      s.events.map((e) => e.message),
    );
    expect(messages.join(" ")).toMatch(/без связанного товара/);
  });

  it("большой каталог отвечает progress и дожимается повторным import с тем же filename", async () => {
    const auth = await checkauth();
    const guids = Array.from({ length: IMPORT_BATCH_SIZE + 1 }, (_, i) => `cand-batch-${i}`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05">
 <Каталог><Товары>
${guids.map((guid) => `  <Товар><Ид>${guid}</Ид><Наименование>Товар ${guid}</Наименование></Товар>`).join("\n")}
 </Товары></Каталог>
</КоммерческаяИнформация>`;
    await uploadFile(auth, "big-catalog.xml", xml);

    const first = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=big-catalog.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(first.text.trim()).toBe("progress");

    const second = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=big-catalog.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(second.text.trim()).toBe("success");

    const rows = await db
      .select()
      .from(schema.integrationCandidates)
      .where(
        and(
          eq(schema.integrationCandidates.tenantId, tenantId),
          like(schema.integrationCandidates.externalRef, "cand-batch-%"),
        ),
      );
    expect(rows).toHaveLength(guids.length);
  });

  // Review fix (Fix 1): the actual regression a real CommerceML "Обмен с
  // сайтом" hits every time -- one `checkauth`, then номенклатура
  // (import.xml, no prices) followed by предложения (offers.xml, the
  // prices) in the SAME session. Before this fix, `mode=import` finished
  // the session the instant the FIRST file completed, so this second
  // `mode=import` call would have come back `failure\nno session` and the
  // prices -- the entire point of the exchange -- would never have landed.
  it("каталог, затем предложения в ОДНОМ сеансе (один checkauth) -- цены из второго файла применяются", async () => {
    const auth = await checkauth();

    // Файл 1: номенклатура. Ссылается на уже известный товар (guid-1), как
    // 1С обычно и присылает -- каталог тут ничего не создаёт и не меняет.
    await uploadFile(auth, "two-files-catalog.xml", catalogXmlFor("guid-1", "Имя из каталога"));
    const catalogImport = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=two-files-catalog.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(catalogImport.text.trim()).toBe("success");

    // Файл 2, ТА ЖЕ cookie: до фикса сеанс уже был бы мёртв здесь.
    await uploadFile(auth, "two-files-offers.xml", offersXmlFor("guid-1", "321.00"));
    const offersImport = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=two-files-offers.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(offersImport.text.trim()).toBe("success");

    const [product] = await db
      .select({ unitPrice: schema.products.unitPrice, name: schema.products.name })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product!.unitPrice).toBe("321.00");
    // Каталог по-прежнему не переименовывает сопоставленный товар -- пин
    // повторён здесь, чтобы этот тест не мог случайно пройти, переименовав
    // товар вместо (или вместе с) применения цены.
    expect(product!.name).not.toBe("Имя из каталога");
  });

  // Review fix (Fix 2): a bare numeric cursor trusts that THIS round's
  // freshly rebuilt worklist still lines up with the one an EARLIER round's
  // offset was measured against -- untrue the moment a product gets linked
  // or unlinked between two rounds of the SAME filename (1С resubmits
  // `mode=import` verbatim after a `progress` reply). Rather than racing a
  // real link/unlink against `IMPORT_BATCH_SIZE`-sized batches, this seeds a
  // stale cursor directly through the same `writeImportCursor` the
  // controller itself calls -- exactly the state an earlier round against a
  // DIFFERENT worklist would have left behind -- and checks that `mode=
  // import` refuses to resume blindly from it.
  it("устаревший курсор (список изменился между кругами) не используется вслепую — файл начинается заново с предупреждением в журнале", async () => {
    const auth = await checkauth();
    await uploadFile(auth, "cursor-shift.xml", offersXmlFor("guid-1", "501.00"));

    const sessions = app!.get(ExchangeSessionService);
    const cookieHash = hashDeviceToken(auth.value);
    const [session] = await db
      .select()
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.cookieHash, cookieHash));

    // `offset: 1` on a worklist that will actually turn out to hold exactly
    // ONE row: if the stale offset were honoured as-is, the loop below would
    // run zero iterations and the price would never be written at all --
    // the silent-skip this fix exists to prevent.
    await sessions.writeImportCursor(session!.id, "cursor-shift.xml", {
      offset: 1,
      fingerprint: "stale-fingerprint-from-a-different-worklist",
    });

    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=cursor-shift.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(res.text.trim()).toBe("success");

    const journal = await agent.get("/integrations/commerceml/journal").expect(200);
    const messages = journal.body.sessions.flatMap((s: { events: { message: string }[] }) =>
      s.events.map((e) => e.message),
    );
    expect(messages.join(" ")).toMatch(/изменился между кругами/);

    const [product] = await db
      .select({ unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product!.unitPrice).toBe("501.00");
  });

  // CodeQL js/stack-trace-exposure: `parseCommerceMl` (commerceml/parse.ts)
  // deliberately throws a DETAILED message -- "the message this throws ends
  // up in the integration journal, read by a 1С specialist on the client's
  // side" (parseXml's own comment) -- but that detail must never reach the
  // wire response itself: this is the one route with no guard in front of it
  // at all (class-level comment on ExchangeController), so whoever is
  // calling it is, by definition, unauthenticated as far as this check goes.
  it("невалидный XML отвечает стабильным отказом на проводе, а подробность разбора остаётся только в журнале", async () => {
    const auth = await checkauth();
    // Same malformed fragment `commerceml-parse.test.ts` uses to pin that
    // `parseCommerceMl` itself throws rather than silently returning
    // nothing -- guaranteed to reach the `catch` block in `import()`.
    await uploadFile(auth, "broken.xml", "<не xml");

    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=broken.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    // Stable, generic wire text -- not the real fast-xml-parser exception.
    expect(res.text).toBe("failure\ninvalid file");
    expect(res.text).not.toMatch(/CommerceML|xml|parser|char|line|tag/i);

    const journal = await agent.get("/integrations/commerceml/journal").expect(200);
    const events = journal.body.sessions.flatMap(
      (s: { events: { message: string; details: Record<string, unknown> | null }[] }) => s.events,
    );
    // The detailed parse failure DOES still reach the journal -- the 1С
    // specialist reading it needs to know what actually broke.
    const event = events.find((e: { message: string }) =>
      e.message.includes("не удалось разобрать XML"),
    );
    expect(event).toBeDefined();
    // `details.raw` records exactly what was sent over the wire, verbatim
    // (brief 08) -- which is now the STABLE message, not the real detail
    // that landed in `message` above. Same split
    // `ExchangeExceptionFilter.INTERNAL_ERROR_RAW` already holds for its own
    // unhandled-exception catch-all.
    expect(event?.details).toMatchObject({ raw: "failure\ninvalid file" });
  });
});
