import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
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
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";

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

/** 1x1 PNG. Если normalizeBoundedImage отвергнет 1x1 (invalid_dimensions) — заменить на 8x8. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function catalogWithBarcodeXml(
  guid: string,
  name: string,
  barcode: string,
  image?: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05">
 <Каталог><Товары>
  <Товар>
   <Ид>${guid}</Ид>
   <Наименование>${name}</Наименование>
   <Штрихкод>${barcode}</Штрихкод>
   ${image === undefined ? "" : `<Картинка>${image}</Картинка>`}
  </Товар>
 </Товары></Каталог>
</КоммерческаяИнформация>`;
}

/**
 * Same one `<Товар>` as `catalogWithBarcodeXml`, plus a `<ПакетПредложений>`
 * offer for the SAME `<Ид>` in the SAME file -- needed to exercise "link now,
 * price this same round" (`apply.ts`'s `priceTargetByRef` folds this round's
 * own new GTIN links in before offers are matched against it; that only
 * happens when items and offers arrive in the same `parseCommerceMl` call,
 * i.e. the same physical file).
 */
function catalogWithBarcodeAndOfferXml(
  guid: string,
  name: string,
  barcode: string,
  price: string,
  image?: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05">
 <Каталог><Товары>
  <Товар>
   <Ид>${guid}</Ид>
   <Наименование>${name}</Наименование>
   <Штрихкод>${barcode}</Штрихкод>
   ${image === undefined ? "" : `<Картинка>${image}</Картинка>`}
  </Товар>
 </Товары></Каталог>
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
  const storedObjects = new Map<string, Buffer>();
  // Task 6's photo scenarios only assert DB state (product_images/
  // media_assets rows), never storage.put's own call args -- so a bare
  // in-memory fake, the same pattern products.e2e.test.ts already uses to
  // override this Global()-scoped provider, is enough to keep this file
  // independent of a real S3/MinIO endpoint.
  const storage = {
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    put: vi.fn(async (key: string, body: Buffer) => {
      storedObjects.set(key, body);
    }),
    delete: vi.fn(async (key: string) => {
      storedObjects.delete(key);
    }),
    get: vi.fn(async (key: string) => ({
      body: storedObjects.get(key) ?? Buffer.alloc(0),
      contentType: "image/webp",
    })),
    presignRead: vi.fn(async (key: string) => `https://signed.invalid/${encodeURIComponent(key)}`),
  };

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, SUBSCRIPTION_ENFORCEMENT_MODE: "managed_only" });
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .compile();
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

  /** Repeats the checkauth exchange for arbitrary credentials and turns its two body lines into a `Cookie` header value. */
  async function checkauthAs(
    loginValue: string,
    secretValue: string,
  ): Promise<{ cookie: string; value: string }> {
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(loginValue, secretValue)
      .expect(200);
    const [, name, value] = res.text.split("\n");
    return { cookie: `${name}=${value}`, value: value! };
  }

  /** Repeats the checkauth exchange for THIS suite's shared tenant (see `beforeAll`). */
  async function checkauth(): Promise<{ cookie: string; value: string }> {
    return checkauthAs(login, secret);
  }

  /**
   * Spins up a brand-new tenant with its own CommerceML credentials, exactly
   * like `beforeAll` does for the suite's shared one -- Task 6's scenarios
   * each need their own isolated GTIN/candidate space, per the brief ("свой
   * тенант через существующий сетап").
   */
  async function setupTenant(): Promise<{
    agent: ReturnType<typeof request.agent>;
    tenantId: string;
    login: string;
    secret: string;
  }> {
    const freshAgent = request.agent(app!.getHttpServer());
    const freshTenantId = await signUpAndActivate(freshAgent);
    const issued = await freshAgent
      .post("/integrations/commerceml/credentials")
      .send({})
      .expect(201);
    return {
      agent: freshAgent,
      tenantId: freshTenantId,
      login: issued.body.login,
      secret: issued.body.secret,
    };
  }

  async function uploadFile(
    auth: { cookie: string },
    filename: string,
    body: string | Buffer,
  ): Promise<void> {
    await request(app!.getHttpServer())
      .post(`/1c_exchange?type=catalog&mode=file&filename=${encodeURIComponent(filename)}`)
      .set("Cookie", auth.cookie)
      .send(typeof body === "string" ? Buffer.from(body, "utf8") : body)
      .expect(200);
  }

  it("применяет цены сопоставленным товарам и отвечает success", async () => {
    // This suite deliberately pins the legacy-tenant rollout mode: an
    // unmanaged tenant remains writable only under `managed_only`.
    expect(
      loadEnv({ ...process.env, SUBSCRIPTION_ENFORCEMENT_MODE: "managed_only" }),
    ).toHaveProperty("SUBSCRIPTION_ENFORCEMENT_MODE", "managed_only");
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
  }, 15_000);

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

  it("refuses an expired tenant before applying any CommerceML work and journals a stable non-leaking failure", async () => {
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
    });
    const managed = await createManagedSubscription(db, {
      tenantId,
      planVersionId,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const activeAuth = await checkauth();
    await uploadFile(activeAuth, "active-offers.xml", offersXmlFor("guid-1", "888.00"));
    expect(
      (
        await request(app!.getHttpServer())
          .get("/1c_exchange?type=catalog&mode=import&filename=active-offers.xml")
          .set("Cookie", activeAuth.cookie)
          .expect(200)
      ).text,
    ).toBe("success");
    await db
      .update(schema.tenantSubscriptions)
      .set({ endsAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.tenantSubscriptions.id, managed.subscriptionId));
    const [before] = await db
      .select({ unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    const auth = await checkauth();
    await uploadFile(auth, "expired-offers.xml", offersXmlFor("guid-1", "999.00"));

    const response = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=expired-offers.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(response.text).toBe("failure\nsubscription write unavailable");
    expect(response.text).not.toMatch(/plan|price|tenant|expired|database/i);

    const query = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(query.headers["content-type"]).toContain("application/xml");
    const success = await request(app!.getHttpServer())
      .post("/1c_exchange?mode=success")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(success.text).toBe("success");
    const [after] = await db
      .select({ unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(after).toEqual(before);

    const journal = await agent.get("/integrations/commerceml/journal").expect(200);
    const denied = journal.body.sessions
      .flatMap((session: { events: unknown[] }) => session.events)
      .find((event: { message?: string }) => event.message === "import: subscription write denied");
    expect(denied).toMatchObject({
      outcome: "error",
      details: { filename: "expired-offers.xml", raw: "failure\nsubscription write unavailable" },
    });

    const brokenItemId = randomUUID();
    const brokenPlanVersionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: brokenItemId,
      code: `broken-commerce-${brokenItemId}`,
      nameRu: "Broken CommerceML plan",
      nameEn: "Broken CommerceML plan",
      kind: "plan",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: brokenPlanVersionId,
      catalogItemId: brokenItemId,
      kind: "plan",
      version: 1,
      status: "published",
      publishedAt: new Date(),
      nameRu: "Broken CommerceML plan",
      nameEn: "Broken CommerceML plan",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "1000.00",
      vatRate: "20.00",
      vatIncluded: true,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "superseded" })
      .where(eq(schema.tenantSubscriptions.id, managed.subscriptionId));
    await db.insert(schema.tenantSubscriptions).values({
      tenantId,
      planVersionId: brokenPlanVersionId,
      status: "active",
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
      source: "manual",
    });
    const brokenAuth = await checkauth();
    await uploadFile(brokenAuth, "broken-managed.xml", offersXmlFor("guid-1", "1000.00"));
    const broken = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=broken-managed.xml")
      .set("Cookie", brokenAuth.cookie)
      .expect(200);
    expect(broken.text).toBe("failure\nsubscription write unavailable");
    const [afterBroken] = await db
      .select({ unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(afterBroken).toEqual(after);
  });

  // Task 6: worklist link/price/image/candidate wiring and the journal
  // events `decideApplication`'s GTIN plan (Task 2) drives. Each scenario
  // gets its own tenant (`setupTenant`) -- GTIN matching and candidate rows
  // are per-tenant, and these five deliberately share no state with the
  // suite's own tenant/product above or with each other.
  describe("автосвязь по GTIN, фото и журнал (Task 6)", () => {
    it("автосвязь по GTIN и цена одним раундом", async () => {
      const tenant = await setupTenant();
      const linkedProductId = randomUUID();
      await db.insert(schema.products).values({
        id: linkedProductId,
        tenantId: tenant.tenantId,
        gtin14: "04680089900253",
        name: "Товар для автосвязи",
        unitPrice: "100.00",
        externalRef: null,
      });

      const auth = await checkauthAs(tenant.login, tenant.secret);
      await uploadFile(
        auth,
        "auto-link.xml",
        catalogWithBarcodeAndOfferXml("guid-auto-1", "Новый товар", "4680089900253", "9200.00"),
      );
      const res = await request(app!.getHttpServer())
        .get("/1c_exchange?type=catalog&mode=import&filename=auto-link.xml")
        .set("Cookie", auth.cookie)
        .expect(200);
      expect(res.text.trim()).toBe("success");

      const [product] = await db
        .select({ externalRef: schema.products.externalRef, unitPrice: schema.products.unitPrice })
        .from(schema.products)
        .where(eq(schema.products.id, linkedProductId));
      expect(product!.externalRef).toBe("guid-auto-1");
      expect(product!.unitPrice).toBe("9200.00");

      const candidates = await db
        .select()
        .from(schema.integrationCandidates)
        .where(eq(schema.integrationCandidates.tenantId, tenant.tenantId));
      expect(candidates).toHaveLength(0);

      const events = await db
        .select()
        .from(schema.integrationEvents)
        .where(eq(schema.integrationEvents.tenantId, tenant.tenantId));
      const linkEvent = events.find((e) => e.message.includes("связан автоматически по GTIN"));
      expect(linkEvent).toMatchObject({ outcome: "ok", grain: "item" });
    });

    it("конфликт GTIN: карточка уже связана с другим Ид", async () => {
      const tenant = await setupTenant();
      const conflictedProductId = randomUUID();
      await db.insert(schema.products).values({
        id: conflictedProductId,
        tenantId: tenant.tenantId,
        gtin14: "04680089900253",
        name: "Товар с конфликтом",
        unitPrice: "100.00",
        externalRef: "другой-guid",
      });

      const auth = await checkauthAs(tenant.login, tenant.secret);
      await uploadFile(
        auth,
        "conflict.xml",
        catalogWithBarcodeXml("guid-conflict-1", "Претендент", "4680089900253"),
      );
      await request(app!.getHttpServer())
        .get("/1c_exchange?type=catalog&mode=import&filename=conflict.xml")
        .set("Cookie", auth.cookie)
        .expect(200);

      const [product] = await db
        .select({ externalRef: schema.products.externalRef })
        .from(schema.products)
        .where(eq(schema.products.id, conflictedProductId));
      expect(product!.externalRef).toBe("другой-guid");

      const [candidate] = await db
        .select()
        .from(schema.integrationCandidates)
        .where(
          and(
            eq(schema.integrationCandidates.tenantId, tenant.tenantId),
            eq(schema.integrationCandidates.externalRef, "guid-conflict-1"),
          ),
        );
      expect(candidate?.gtin).toBe("04680089900253");

      const events = await db
        .select()
        .from(schema.integrationEvents)
        .where(eq(schema.integrationEvents.tenantId, tenant.tenantId));
      const conflictEvent = events.find((e) => e.message.includes("конфликт GTIN"));
      expect(conflictEvent).toMatchObject({ outcome: "warn", grain: "item" });
    });

    it("нет карточки с таким GTIN — позиция уходит в кандидаты со своим gtin", async () => {
      const tenant = await setupTenant();
      const auth = await checkauthAs(tenant.login, tenant.secret);
      await uploadFile(
        auth,
        "candidate-gtin.xml",
        catalogWithBarcodeXml("guid-cand-gtin-1", "Новинка со штрихкодом", "4680089900253"),
      );
      await request(app!.getHttpServer())
        .get("/1c_exchange?type=catalog&mode=import&filename=candidate-gtin.xml")
        .set("Cookie", auth.cookie)
        .expect(200);

      const [candidate] = await db
        .select()
        .from(schema.integrationCandidates)
        .where(
          and(
            eq(schema.integrationCandidates.tenantId, tenant.tenantId),
            eq(schema.integrationCandidates.externalRef, "guid-cand-gtin-1"),
          ),
        );
      expect(candidate).toBeDefined();
      expect(candidate!.gtin).toBe("04680089900253");
    });

    it("фото из файла сеанса применяется и дедуплицируется на повторном import", async () => {
      const tenant = await setupTenant();
      const photoProductId = randomUUID();
      await db.insert(schema.products).values({
        id: photoProductId,
        tenantId: tenant.tenantId,
        gtin14: "04680089900260",
        name: "Товар с фото",
        unitPrice: "10.00",
        externalRef: "guid-photo-1",
      });

      const auth = await checkauthAs(tenant.login, tenant.secret);
      // Файл сеанса -- отдельный mode=file, до каталога, который на него сошлётся.
      await uploadFile(auth, "import_files/1.png", TINY_PNG);
      await uploadFile(
        auth,
        "photo.xml",
        catalogWithBarcodeXml(
          "guid-photo-1",
          "Товар с фото",
          "0000000000000", // товар уже связан по Ид -- штрихкод тут ни на что не влияет
          "import_files/1.png",
        ),
      );

      const first = await request(app!.getHttpServer())
        .get("/1c_exchange?type=catalog&mode=import&filename=photo.xml")
        .set("Cookie", auth.cookie)
        .expect(200);
      expect(first.text.trim()).toBe("success");

      const [imageRowFirst] = await db
        .select({ assetId: schema.productImages.assetId, status: schema.mediaAssets.status })
        .from(schema.productImages)
        .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.id, schema.productImages.assetId))
        .where(
          and(
            eq(schema.productImages.tenantId, tenant.tenantId),
            eq(schema.productImages.productId, photoProductId),
          ),
        );
      expect(imageRowFirst).toMatchObject({ status: "active" });

      const assetsAfterFirst = await db
        .select({ id: schema.mediaAssets.id })
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.ownerTenantId, tenant.tenantId));

      // Тот же файл, тот же import -- 1С резонно может повторить его.
      // Обработанные байты не изменились -- ждём "unchanged" (Task 5), а не
      // второй asset.
      const second = await request(app!.getHttpServer())
        .get("/1c_exchange?type=catalog&mode=import&filename=photo.xml")
        .set("Cookie", auth.cookie)
        .expect(200);
      expect(second.text.trim()).toBe("success");

      const assetsAfterSecond = await db
        .select({ id: schema.mediaAssets.id })
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.ownerTenantId, tenant.tenantId));
      expect(assetsAfterSecond).toHaveLength(assetsAfterFirst.length);

      // Review Minor 5: row count matching is not enough on its own -- also
      // pin that the SAME asset still backs the product (not a swap with the
      // count merely unchanged by coincidence), and that "unchanged" really
      // did take the quiet path: no "фото не применено" warn for this tenant.
      const [imageRowSecond] = await db
        .select({ assetId: schema.productImages.assetId, status: schema.mediaAssets.status })
        .from(schema.productImages)
        .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.id, schema.productImages.assetId))
        .where(
          and(
            eq(schema.productImages.tenantId, tenant.tenantId),
            eq(schema.productImages.productId, photoProductId),
          ),
        );
      expect(imageRowSecond).toMatchObject({
        assetId: imageRowFirst!.assetId,
        status: "active",
      });

      const events = await db
        .select()
        .from(schema.integrationEvents)
        .where(eq(schema.integrationEvents.tenantId, tenant.tenantId));
      expect(events.some((e) => e.message.includes("фото не применено"))).toBe(false);
    });

    it("битое фото не валит раунд — предупреждение в журнале, цена и связь применяются", async () => {
      const tenant = await setupTenant();
      const brokenPhotoProductId = randomUUID();
      await db.insert(schema.products).values({
        id: brokenPhotoProductId,
        tenantId: tenant.tenantId,
        gtin14: "04680089900253",
        name: "Товар с битым фото",
        unitPrice: "100.00",
        externalRef: null,
      });

      const auth = await checkauthAs(tenant.login, tenant.secret);
      // `import_files/missing.png` НИКОГДА не загружался этим сеансом.
      await uploadFile(
        auth,
        "broken-photo.xml",
        catalogWithBarcodeAndOfferXml(
          "guid-broken-photo-1",
          "Товар",
          "4680089900253",
          "777.00",
          "import_files/missing.png",
        ),
      );

      const res = await request(app!.getHttpServer())
        .get("/1c_exchange?type=catalog&mode=import&filename=broken-photo.xml")
        .set("Cookie", auth.cookie)
        .expect(200);
      expect(res.text.trim()).toBe("success");

      const [product] = await db
        .select({ externalRef: schema.products.externalRef, unitPrice: schema.products.unitPrice })
        .from(schema.products)
        .where(eq(schema.products.id, brokenPhotoProductId));
      expect(product!.externalRef).toBe("guid-broken-photo-1");
      expect(product!.unitPrice).toBe("777.00");

      const events = await db
        .select()
        .from(schema.integrationEvents)
        .where(eq(schema.integrationEvents.tenantId, tenant.tenantId));
      const warnEvent = events.find((e) => e.message.includes("фото не применено"));
      expect(warnEvent).toMatchObject({ outcome: "warn", grain: "item" });
      expect(warnEvent!.message).toMatch(/не найден в сеансе/);
      // Review Minor 4: a machine-readable reason alongside the free-text message.
      expect((warnEvent!.details as { reason?: string } | null)?.reason).toBe("file_not_found");
    });

    // Review Important 1 + 2 regression: a link used to be its own worklist
    // row, fingerprinted alongside price/image/candidate rows. Applying it
    // made the NEXT round's `plan.links` empty, shrinking that round's
    // worklist -- which the fingerprint check read as "the list changed
    // between rounds", restarting the whole file and re-journaling/re-doing
    // already-applied work. This only ever showed up on a file that took
    // MORE than one round -- reproduced here cheaply via the image sub-cap
    // (`IMPORT_IMAGE_BATCH_SIZE = 25`, review Important 2) rather than 501
    // cheap rows: one catalog file carrying a fresh GTIN link (no image of
    // its own) plus 26 already-linked products each with a `<Картинка>`
    // forces exactly two `mode=import` rounds (25 images, then 1).
    it("связь в многораундовом файле (лимит фото) применяется один раз — без «список изменился между кругами»", async () => {
      const tenant = await setupTenant();
      const linkTargetId = randomUUID();
      await db.insert(schema.products).values({
        id: linkTargetId,
        tenantId: tenant.tenantId,
        gtin14: "04680089900253",
        name: "Связываемый товар",
        unitPrice: "100.00",
        externalRef: null,
      });

      const photoProductIds = Array.from({ length: 26 }, () => randomUUID());
      for (const [i, id] of photoProductIds.entries()) {
        await db.insert(schema.products).values({
          id,
          tenantId: tenant.tenantId,
          gtin14: `9${String(i).padStart(13, "0")}`,
          name: `Товар с фото ${i}`,
          unitPrice: "5.00",
          externalRef: `guid-multiround-photo-${i}`,
        });
      }

      const auth = await checkauthAs(tenant.login, tenant.secret);
      await uploadFile(auth, "import_files/1.png", TINY_PNG);

      const items = [
        `<Товар><Ид>guid-multiround-link</Ид><Наименование>Связываемый</Наименование><Штрихкод>4680089900253</Штрихкод></Товар>`,
        ...photoProductIds.map(
          (_, i) =>
            `<Товар><Ид>guid-multiround-photo-${i}</Ид><Наименование>Фото ${i}</Наименование><Картинка>import_files/1.png</Картинка></Товар>`,
        ),
      ].join("\n");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05">
 <Каталог><Товары>
${items}
 </Товары></Каталог>
</КоммерческаяИнформация>`;
      await uploadFile(auth, "multiround.xml", xml);

      const first = await request(app!.getHttpServer())
        .get("/1c_exchange?type=catalog&mode=import&filename=multiround.xml")
        .set("Cookie", auth.cookie)
        .expect(200);
      expect(first.text.trim()).toBe("progress");

      // Applied at offset 0, inside round 1, BEFORE the batched image loop --
      // already true after round 1, not only after the file finishes.
      const [afterFirst] = await db
        .select({ externalRef: schema.products.externalRef })
        .from(schema.products)
        .where(eq(schema.products.id, linkTargetId));
      expect(afterFirst!.externalRef).toBe("guid-multiround-link");

      const second = await request(app!.getHttpServer())
        .get("/1c_exchange?type=catalog&mode=import&filename=multiround.xml")
        .set("Cookie", auth.cookie)
        .expect(200);
      expect(second.text.trim()).toBe("success");

      const events = await db
        .select()
        .from(schema.integrationEvents)
        .where(eq(schema.integrationEvents.tenantId, tenant.tenantId));
      const linkEvents = events.filter((e) => e.message.includes("связан автоматически по GTIN"));
      expect(linkEvents).toHaveLength(1);
      expect(linkEvents[0]).toMatchObject({ outcome: "ok", grain: "item" });
      expect(events.some((e) => e.message.includes("изменился между кругами"))).toBe(false);

      const imageRows = await db
        .select({ productId: schema.productImages.productId })
        .from(schema.productImages)
        .where(eq(schema.productImages.tenantId, tenant.tenantId));
      expect(imageRows).toHaveLength(26);
    });
  });
});
