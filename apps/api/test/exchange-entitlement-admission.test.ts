import { createHash, randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, schema } from "@markiro/db";
import { DB } from "../src/auth/auth.module";
import { ExchangeController } from "../src/modules/exchange/exchange.controller";
import { ExchangeSessionService } from "../src/modules/exchange/exchange-session.service";
import { JournalService } from "../src/modules/integrations/journal.service";
import { PickupOrdersService } from "../src/modules/pickup-orders/pickup-orders.service";
import { ProductsService } from "../src/modules/products/products.service";
import { OperatorsService } from "../src/modules/operators/operators.service";
import { OrgProfileService } from "../src/modules/org-profile/org-profile.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import {
  EntitlementAdmissionService,
  admissionScopeDigest,
} from "../src/subscriptions/entitlement-admission.service";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";
import { listenOnLoopback } from "./support/listen-loopback";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const apps: INestApplication[] = [];
afterAll(async () => {
  for (const app of apps) await app.close();
  await connection.pool.end();
});

describe.skipIf(!process.env.DATABASE_URL)("CommerceML entitlement effect owners", () => {
  async function fixture(grant = true) {
    const db = connection.db;
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 10,
      maxStations: 10,
      maxKiosks: 10,
      maxCabinetUsers: 10,
      publicApiEnabled: false,
    });
    const managed = await createManagedSubscription(db, { planVersionId });
    if (grant) {
      const userId = randomUUID();
      const sourceId = randomUUID();
      await db.insert(schema.platformUsers).values({
        id: userId,
        email: `${userId}@example.invalid`,
        name: "Exchange fixture",
        role: "platform_admin",
        status: "active",
      });
      await db.insert(schema.entitlementSources).values({
        id: sourceId,
        versionId: sourceId,
        tenantId: managed.tenantId,
        subscriptionId: managed.subscriptionId,
        kind: "compatibility",
        effects: [{ key: "commerceMl", featureEnabled: true }],
        operationIds: ["commerceMl.exchange.v1"],
        startsAt: new Date(Date.now() - 60000),
        endsAt: new Date(Date.now() + 600000),
        reason: "Exchange fixture",
        decisionReference: "P1B3-TEST",
        requestId: randomUUID(),
        createdByPlatformUserId: userId,
      });
    }
    const entitlements = new EntitlementsService(db, "managed_only");
    const module = await Test.createTestingModule({
      controllers: [ExchangeController],
      providers: [
        { provide: DB, useValue: db },
        { provide: EntitlementsService, useValue: entitlements },
        { provide: ProductsService, useValue: {} },
        { provide: OperatorsService, useValue: {} },
        { provide: OrgProfileService, useValue: {} },
        ExchangeSessionService,
        JournalService,
        PickupOrdersService,
        EntitlementAdmissionService,
      ],
    }).compile();
    const app = module.createNestApplication();
    apps.push(app);
    await app.init();
    await listenOnLoopback(app);
    const sessions = module.get(ExchangeSessionService);
    const opened = await sessions.open(managed.tenantId, "commerceml");
    const session = await sessions.resolve(opened.cookie);
    if (!session) throw new Error("fixture session missing");
    return {
      ...managed,
      app,
      sessions,
      session,
      cookie: `mk_1c_session=${opened.cookie}`,
      db,
      admission: module.get(EntitlementAdmissionService),
    };
  }
  async function observations(tenantId: string) {
    return connection.db
      .select()
      .from(schema.entitlementShadowObservations)
      .where(eq(schema.entitlementShadowObservations.tenantId, tenantId));
  }

  it("observes only the concurrent export winner, retaining exact XML and digest", async () => {
    const f = await fixture();
    const first = { orderIds: [randomUUID()], xml: "<first/>" };
    const second = { orderIds: [], xml: "<second/>" };
    const [left, right] = await Promise.all([
      f.sessions.ensureOutstandingOrderQuery(f.session, first),
      f.sessions.ensureOutstandingOrderQuery(f.session, second),
    ]);
    expect(left).toEqual(right);
    expect(await f.sessions.readOutstandingOrderQuery(f.session.id)).toEqual(left);
    const rows = await observations(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: f.tenantId,
      actorType: "exchange_session",
      actorId: f.session.id,
      operationId: "commerceMl.exchange.v1",
      outcome: "allow",
      reasonCodes: [],
      resourceScope: {
        digest: admissionScopeDigest({ sessionId: f.session.id, action: "query", batch: left }),
      },
    });
    const replay = await request(f.app.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", f.cookie)
      .expect(200);
    expect(replay.text).toBe(left.xml);
    expect(await observations(f.tenantId)).toEqual(rows);
  });

  const catalog = (refs: string[], name = "Товар") =>
    Buffer.from(
      `<КоммерческаяИнформация><Каталог><Товары>${refs.map((ref) => `<Товар><Ид>${ref}</Ид><Наименование>${name}</Наименование></Товар>`).join("")}</Товары></Каталог></КоммерческаяИнформация>`,
    );
  const runImport = (
    f: Awaited<ReturnType<typeof fixture>>,
    filename = "import.xml",
    type = "catalog",
  ) =>
    request(f.app.getHttpServer())
      .get(`/1c_exchange?mode=import&type=${type}&filename=${filename}`)
      .set("Cookie", f.cookie)
      .expect(200);
  it("observes a fresh catalog file once, retaining small-file replay and changed-source semantics", async () => {
    const f = await fixture();
    const ref = randomUUID();
    const bytes = catalog([ref]);
    await f.sessions.appendChunk(f.tenantId, f.session.id, "import.xml", bytes);
    expect(await observations(f.tenantId)).toEqual([]);
    expect((await runImport(f)).text).toBe("success");
    const rows = await observations(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: f.tenantId,
      actorId: f.session.id,
      actorType: "exchange_session",
      operationId: "commerceMl.exchange.v1",
      outcome: "allow",
      reasonCodes: [],
      resourceScope: {
        digest: admissionScopeDigest({
          sessionId: f.session.id,
          action: "catalog_import",
          effectiveConfig: { priceType: null },
          effectiveLinkTargets: [],
          filename: "import.xml",
          sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
          fingerprint: `1:${createHash("sha256").update(`c:${ref}`).digest("hex")}`,
          cursor: 0,
        }),
      },
    });
    expect(await f.sessions.readImportCursor(f.session.id, "import.xml")).toBeNull();
    expect((await runImport(f)).text).toBe("success");
    expect(await observations(f.tenantId)).toEqual(rows);
    const [candidate] = await f.db
      .select()
      .from(schema.integrationCandidates)
      .where(eq(schema.integrationCandidates.tenantId, f.tenantId));
    expect(candidate).toMatchObject({
      tenantId: f.tenantId,
      externalRef: ref,
      name: "Товар",
      channelType: "commerceml",
    });
    // Model a replacement upload without altering the retained import cursor.
    await f.db
      .delete(schema.exchangeUploads)
      .where(eq(schema.exchangeUploads.sessionId, f.session.id));
    await f.sessions.appendChunk(
      f.tenantId,
      f.session.id,
      "import.xml",
      catalog([ref], "Новое имя"),
    );
    expect((await runImport(f)).text).toBe("success");
    expect(await observations(f.tenantId)).toHaveLength(2);
    const events = await f.db
      .select()
      .from(schema.integrationEvents)
      .where(eq(schema.integrationEvents.sessionId, f.session.id));
    expect(
      events.filter((event) => event.message === "import: файл «import.xml» применён"),
    ).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      tenantId: f.tenantId,
      sessionId: f.session.id,
      channelType: "commerceml",
      direction: "in",
      outcome: "ok",
      grain: "session",
      details: { filename: "import.xml", candidates: 1, updated: 0, linked: 0, images: 0 },
    });
  });

  const catalogWithLink = (externalRef: string, candidates: string[]) =>
    Buffer.from(
      `<КоммерческаяИнформация><Каталог><Товары><Товар><Ид>${externalRef}</Ид><Наименование>Связанный товар</Наименование><Штрихкод>4680089900253</Штрихкод></Товар>${candidates.map((ref) => `<Товар><Ид>${ref}</Ид><Наименование>Кандидат</Наименование></Товар>`).join("")}</Товары></Каталог></КоммерческаяИнформация>`,
    );

  it.each([0, 1])(
    "binds auto-link targets across replay and reassignment with %i candidate rows",
    async (candidateCount) => {
      const f = await fixture();
      const externalRef = randomUUID();
      const firstProductId = randomUUID();
      const secondProductId = randomUUID();
      const refs = Array.from({ length: candidateCount }, () => randomUUID());
      const bytes = catalogWithLink(externalRef, refs);
      await f.db.insert(schema.products).values({
        id: firstProductId,
        tenantId: f.tenantId,
        gtin14: "04680089900253",
        name: "Первый товар",
      });
      await f.sessions.appendChunk(f.tenantId, f.session.id, "import.xml", bytes);
      const readProduct = async (id: string) =>
        (await f.db.select().from(schema.products).where(eq(schema.products.id, id)))[0];
      expect((await runImport(f)).text).toBe("success");
      expect(await readProduct(firstProductId)).toMatchObject({ externalRef });
      const first = await observations(f.tenantId);
      expect(first).toHaveLength(1);
      expect((await runImport(f)).text).toBe("success");
      expect(await observations(f.tenantId)).toEqual(first);
      expect(await f.sessions.readImportCursor(f.session.id, "import.xml")).toBeNull();

      // The same source now resolves to a different active card; no upload,
      // session or business cursor change distinguishes this fresh link.
      await f.db
        .update(schema.products)
        .set({ archived: true, externalRef: null })
        .where(eq(schema.products.id, firstProductId));
      await f.db.insert(schema.products).values({
        id: secondProductId,
        tenantId: f.tenantId,
        gtin14: "04680089900253",
        name: "Второй товар",
      });
      expect((await runImport(f)).text).toBe("success");
      expect(await readProduct(firstProductId)).toMatchObject({
        archived: true,
        externalRef: null,
      });
      expect(await readProduct(secondProductId)).toMatchObject({ externalRef });
      const changed = await observations(f.tenantId);
      expect.soft(changed).toHaveLength(2);
      const fingerprint = `${refs.length}:${createHash("sha256")
        .update(refs.map((ref) => `c:${ref}`).join(" "))
        .digest("hex")}`;
      for (const productId of [firstProductId, secondProductId]) {
        expect.soft(changed).toContainEqual(
          expect.objectContaining({
            tenantId: f.tenantId,
            actorType: "exchange_session",
            actorId: f.session.id,
            operationId: "commerceMl.exchange.v1",
            outcome: "allow",
            reasonCodes: [],
            resourceScope: expect.objectContaining({
              digest: admissionScopeDigest({
                sessionId: f.session.id,
                action: "catalog_import",
                effectiveConfig: { priceType: null },
                effectiveLinkTargets: [{ externalRef, productId }],
                filename: "import.xml",
                sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
                fingerprint,
                cursor: 0,
              }),
            }),
          }),
        );
      }
      expect((await runImport(f)).text).toBe("success");
      expect(await observations(f.tenantId)).toEqual(changed);
      expect(await f.sessions.readImportCursor(f.session.id, "import.xml")).toBeNull();
      expect(await f.sessions.assemble(f.session.id, "import.xml")).toEqual(bytes);
      const candidates = await f.db
        .select()
        .from(schema.integrationCandidates)
        .where(eq(schema.integrationCandidates.tenantId, f.tenantId));
      expect(candidates.map((row) => row.externalRef)).toEqual(refs);
    },
  );

  it("keeps linked targets and the key-only cursor stable through a multi-batch import", async () => {
    const f = await fixture();
    const externalRef = randomUUID();
    const productId = randomUUID();
    const refs = Array.from({ length: 501 }, () => randomUUID());
    const bytes = catalogWithLink(externalRef, refs);
    await f.db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04680089900253",
      name: "Товар",
    });
    await f.sessions.appendChunk(f.tenantId, f.session.id, "import.xml", bytes);
    expect((await runImport(f)).text).toBe("progress");
    const fingerprint = `501:${createHash("sha256")
      .update(refs.map((ref) => `c:${ref}`).join(" "))
      .digest("hex")}`;
    const cursor = { offset: 500, fingerprint };
    expect(await f.sessions.readImportCursor(f.session.id, "import.xml")).toEqual(cursor);
    expect(
      (await f.db.select().from(schema.products).where(eq(schema.products.id, productId)))[0],
    ).toMatchObject({ externalRef });
    const first = await observations(f.tenantId);
    expect(first).toHaveLength(1);
    expect.soft(first[0]?.resourceScope.digest).toBe(
      admissionScopeDigest({
        sessionId: f.session.id,
        action: "catalog_import",
        effectiveConfig: { priceType: null },
        effectiveLinkTargets: [{ externalRef, productId }],
        filename: "import.xml",
        sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
        fingerprint,
        cursor: 0,
      }),
    );
    expect((await runImport(f)).text).toBe("success");
    expect((await runImport(f)).text).toBe("success");
    expect(await f.sessions.readImportCursor(f.session.id, "import.xml")).toEqual(cursor);
    expect(await observations(f.tenantId)).toEqual(first);
    expect(
      await f.db
        .select()
        .from(schema.integrationCandidates)
        .where(eq(schema.integrationCandidates.tenantId, f.tenantId)),
    ).toHaveLength(501);
  });

  it("keeps the actual catalog cursor on progress, completion and retry without new admission", async () => {
    const f = await fixture();
    const refs = Array.from({ length: 501 }, () => randomUUID());
    await f.sessions.appendChunk(f.tenantId, f.session.id, "import.xml", catalog(refs));
    expect((await runImport(f)).text).toBe("progress");
    const cursor = await f.sessions.readImportCursor(f.session.id, "import.xml");
    expect(cursor).toEqual({
      offset: 500,
      fingerprint: `501:${createHash("sha256")
        .update(refs.map((ref) => `c:${ref}`).join(" "))
        .digest("hex")}`,
    });
    const rows = await observations(f.tenantId);
    expect(rows).toHaveLength(1);
    expect((await runImport(f)).text).toBe("success");
    expect((await runImport(f)).text).toBe("success");
    expect(await f.sessions.readImportCursor(f.session.id, "import.xml")).toEqual(cursor);
    expect(await observations(f.tenantId)).toEqual(rows);
    expect(
      await f.db
        .select()
        .from(schema.integrationCandidates)
        .where(eq(schema.integrationCandidates.tenantId, f.tenantId)),
    ).toHaveLength(501);
  });

  it("keeps subscription denial before any import observation and preserves read-only export", async () => {
    const f = await fixture();
    await f.db
      .update(schema.tenantSubscriptions)
      .set({
        startsAt: new Date(Date.now() - 86400000 * 60),
        endsAt: new Date(Date.now() - 86400000 * 30),
      })
      .where(eq(schema.tenantSubscriptions.id, f.subscriptionId));
    await f.sessions.appendChunk(f.tenantId, f.session.id, "import.xml", catalog([randomUUID()]));
    expect((await runImport(f)).text).toBe("failure\nsubscription write unavailable");
    expect(await observations(f.tenantId)).toEqual([]);
    const exported = await request(f.app.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", f.cookie)
      .expect(200);
    const batch = await f.sessions.readOutstandingOrderQuery(f.session.id);
    expect(batch).toEqual({ orderIds: [], xml: exported.text });
    expect((await observations(f.tenantId))[0]).toMatchObject({
      outcome: "deny",
      reasonCodes: ["subscription_read_only"],
      actorId: f.session.id,
      actorType: "exchange_session",
      tenantId: f.tenantId,
      operationId: "commerceMl.exchange.v1",
    });
    for (const method of ["get", "post"] as const)
      expect(
        (
          await request(f.app.getHttpServer())
            [method]("/1c_exchange?mode=success")
            .set("Cookie", f.cookie)
            .expect(200)
        ).text,
      ).toBe("success");
    expect(await observations(f.tenantId)).toHaveLength(1);
  });

  it("observes sale apply once and keeps the completed source/mapping cursor and exact audit on replay", async () => {
    const f = await fixture();
    const orderId = randomUUID();
    const kioskId = randomUUID();
    const employeeId = randomUUID();
    await f.db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId: f.tenantId, name: "Киоск", dayLimitPerEmployee: 20 });
    await f.db
      .insert(schema.employees)
      .values({ id: employeeId, tenantId: f.tenantId, fullName: "Иван" });
    await f.db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId: f.tenantId,
      orderNo: `EX-${randomUUID().slice(0, 8)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 0,
      totalPrice: "0.00",
    });
    await f.db.insert(schema.integrationChannels).values({
      tenantId: f.tenantId,
      type: "commerceml",
      settings: { orderStatusField: "СтатусЗаказа", statusMapping: { Оплачен: "punched" } },
    });
    const bytes = Buffer.from(
      `<КоммерческаяИнформация><ПакетДокументов><Документ><Ид>${orderId}</Ид><ЗначенияРеквизитов><ЗначениеРеквизита><Наименование>СтатусЗаказа</Наименование><Значение>Оплачен</Значение></ЗначениеРеквизита></ЗначенияРеквизитов></Документ></ПакетДокументов></КоммерческаяИнформация>`,
    );
    await f.sessions.appendChunk(f.tenantId, f.session.id, "sale.xml", bytes);
    expect((await runImport(f, "sale.xml", "sale")).text).toBe("success");
    const cursor = await f.sessions.readSaleImportCursor(f.session.id, "sale.xml");
    expect(cursor).toMatchObject({
      completed: true,
      offset: 1,
      applied: 1,
      discrepancies: 0,
      total: 1,
      orderStatusField: "СтатусЗаказа",
      statusMapping: { Оплачен: "punched" },
      sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
    });
    const rows = await observations(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: f.tenantId,
      actorId: f.session.id,
      actorType: "exchange_session",
      operationId: "commerceMl.exchange.v1",
      outcome: "allow",
      reasonCodes: [],
      resourceScope: {
        digest: admissionScopeDigest({
          sessionId: f.session.id,
          action: "sale_import",
          filename: "sale.xml",
          sourceFingerprint: cursor?.sourceFingerprint,
          fingerprint: cursor?.fingerprint,
          cursor: 0,
        }),
      },
    });
    const [order] = await f.db
      .select()
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(order).toMatchObject({
      tenantId: f.tenantId,
      status: "punched",
      resolvedByUserId: null,
    });
    expect(order?.resolvedAt).toBeInstanceOf(Date);
    const events = await f.db
      .select()
      .from(schema.integrationEvents)
      .where(eq(schema.integrationEvents.sessionId, f.session.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: f.tenantId,
      sessionId: f.session.id,
      channelType: "commerceml",
      direction: "in",
      outcome: "ok",
      grain: "session",
      message: "import (sale): файл «sale.xml» применён",
      details: { filename: "sale.xml", applied: 1, discrepancies: 0, total: 1 },
    });
    await f.db
      .update(schema.integrationChannels)
      .set({ settings: { statusMapping: { Оплачен: "cancelled" } } })
      .where(eq(schema.integrationChannels.tenantId, f.tenantId));
    expect((await runImport(f, "sale.xml", "sale")).text).toBe("success");
    expect(await f.sessions.readSaleImportCursor(f.session.id, "sale.xml")).toEqual(cursor);
    expect(await observations(f.tenantId)).toEqual(rows);
    expect(
      await f.db.select().from(schema.pickupOrders).where(eq(schema.pickupOrders.id, orderId)),
    ).toEqual([order]);
    expect(
      await f.db
        .select()
        .from(schema.integrationEvents)
        .where(eq(schema.integrationEvents.sessionId, f.session.id)),
    ).toEqual(events);

    // A fresh file may reconcile an already terminal prefix and report a missing
    // order. Admission records processing the file, never mutation success.
    await f.db
      .update(schema.integrationChannels)
      .set({
        settings: { orderStatusField: "СтатусЗаказа", statusMapping: { Оплачен: "punched" } },
      })
      .where(eq(schema.integrationChannels.tenantId, f.tenantId));
    const missingId = randomUUID();
    const mixed = Buffer.from(
      bytes
        .toString()
        .replace(
          "</ПакетДокументов>",
          `<Документ><Ид>${missingId}</Ид><ЗначенияРеквизитов><ЗначениеРеквизита><Наименование>СтатусЗаказа</Наименование><Значение>Оплачен</Значение></ЗначениеРеквизита></ЗначенияРеквизитов></Документ></ПакетДокументов>`,
        ),
    );
    await f.sessions.appendChunk(f.tenantId, f.session.id, "reconcile.xml", mixed);
    expect((await runImport(f, "reconcile.xml", "sale")).text).toBe("success");
    const reconciled = await f.sessions.readSaleImportCursor(f.session.id, "reconcile.xml");
    expect(reconciled).toMatchObject({
      completed: true,
      offset: 2,
      applied: 1,
      discrepancies: 1,
      total: 2,
    });
    expect(
      await f.db.select().from(schema.pickupOrders).where(eq(schema.pickupOrders.id, orderId)),
    ).toEqual([order]);
    expect(
      await f.db.select().from(schema.pickupOrders).where(eq(schema.pickupOrders.id, missingId)),
    ).toEqual([]);
    const admitted = await observations(f.tenantId);
    expect(admitted).toHaveLength(2);
    expect(admitted.find((row) => row.id !== rows[0]?.id)).toMatchObject({
      tenantId: f.tenantId,
      actorId: f.session.id,
      actorType: "exchange_session",
      operationId: "commerceMl.exchange.v1",
      outcome: "allow",
      reasonCodes: [],
      resourceScope: {
        digest: admissionScopeDigest({
          sessionId: f.session.id,
          action: "sale_import",
          filename: "reconcile.xml",
          sourceFingerprint: reconciled?.sourceFingerprint,
          fingerprint: reconciled?.fingerprint,
          cursor: 0,
        }),
      },
    });
    const afterEvents = await f.db
      .select()
      .from(schema.integrationEvents)
      .where(eq(schema.integrationEvents.sessionId, f.session.id));
    expect(afterEvents).toContainEqual(
      expect.objectContaining({
        tenantId: f.tenantId,
        sessionId: f.session.id,
        channelType: "commerceml",
        direction: "in",
        outcome: "warn",
        grain: "session",
        message: "import (sale): файл «reconcile.xml» применён",
        details: { filename: "reconcile.xml", applied: 1, discrepancies: 1, total: 2 },
      }),
    );
    expect((await runImport(f, "reconcile.xml", "sale")).text).toBe("success");
    expect(await observations(f.tenantId)).toEqual(admitted);
    expect(await f.sessions.readSaleImportCursor(f.session.id, "reconcile.xml")).toEqual(
      reconciled,
    );
  });

  it.each(["observation", "marker"] as const)(
    "keeps catalog apply and cursor after %s persistence failure",
    async (failure) => {
      const f = await fixture();
      const refs = Array.from({ length: 501 }, () => randomUUID());
      const name = `exchange_import_${randomUUID().replaceAll("-", "")}`;
      const table =
        failure === "observation" ? "entitlement_shadow_observations" : "integration_sessions";
      const predicate =
        failure === "observation"
          ? `NEW.tenant_id = '${f.tenantId}'`
          : `NEW.id = '${f.session.id}' AND NEW.summary->'entitlementImports' IS DISTINCT FROM OLD.summary->'entitlementImports'`;
      await f.db.execute(
        sql.raw(
          `create function ${name}() returns trigger language plpgsql as $$ begin if ${predicate} then raise exception 'synthetic shadow failure'; end if; return NEW; end $$`,
        ),
      );
      await f.db.execute(
        sql.raw(
          `create trigger ${name} before ${failure === "observation" ? "insert" : "update"} on ${table} for each row execute function ${name}()`,
        ),
      );
      const observed = vi.spyOn(f.sessions, "observeImport");
      try {
        await f.sessions.appendChunk(f.tenantId, f.session.id, "import.xml", catalog(refs));
        expect((await runImport(f)).text).toBe("progress");
        expect(await observed.mock.results[0]?.value).toMatchObject({
          decision: "unknown",
          reasons: ["shadow_persistence_failed"],
          observationId: null,
        });
        const cursor = await f.sessions.readImportCursor(f.session.id, "import.xml");
        expect(cursor?.offset).toBe(500);
        expect((await runImport(f)).text).toBe("success");
        expect(await f.sessions.readImportCursor(f.session.id, "import.xml")).toEqual(cursor);
        expect(await observations(f.tenantId)).toEqual([]);
        expect(
          await f.db
            .select()
            .from(schema.integrationCandidates)
            .where(eq(schema.integrationCandidates.tenantId, f.tenantId)),
        ).toHaveLength(501);
        const events = await f.db
          .select()
          .from(schema.integrationEvents)
          .where(eq(schema.integrationEvents.sessionId, f.session.id));
        expect(events.at(-1)).toMatchObject({
          tenantId: f.tenantId,
          sessionId: f.session.id,
          channelType: "commerceml",
          direction: "in",
          outcome: "ok",
          grain: "session",
          details: { filename: "import.xml", candidates: 501 },
        });
      } finally {
        observed.mockRestore();
        await f.db.execute(sql.raw(`drop trigger ${name} on ${table}`));
        await f.db.execute(sql.raw(`drop function ${name}()`));
      }
    },
  );

  it("observes offers before price apply and preserves all unrelated product fields on replay", async () => {
    const f = await fixture();
    const productId = randomUUID();
    const externalRef = randomUUID();
    await f.db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04600682000112",
      name: "Сохранённое имя",
      externalRef,
      unitPrice: "10.00",
    });
    const bytes = Buffer.from(
      `<КоммерческаяИнформация><ПакетПредложений><Предложения><Предложение><Ид>${externalRef}</Ид><Цены><Цена><Представление>Розничная</Представление><ЦенаЗаЕдиницу>25.00</ЦенаЗаЕдиницу><Валюта>руб</Валюта></Цена></Цены></Предложение></Предложения></ПакетПредложений></КоммерческаяИнформация>`,
    );
    await f.sessions.appendChunk(f.tenantId, f.session.id, "offers.xml", bytes);
    expect((await runImport(f, "offers.xml")).text).toBe("success");
    const rows = await observations(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: f.tenantId,
      actorId: f.session.id,
      actorType: "exchange_session",
      operationId: "commerceMl.exchange.v1",
      outcome: "allow",
      reasonCodes: [],
      resourceScope: {
        digest: admissionScopeDigest({
          sessionId: f.session.id,
          action: "catalog_import",
          effectiveConfig: { priceType: null },
          effectiveLinkTargets: [],
          filename: "offers.xml",
          sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
          fingerprint: `1:${createHash("sha256").update(`p:${productId}`).digest("hex")}`,
          cursor: 0,
        }),
      },
    });
    const [product] = await f.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product).toMatchObject({
      tenantId: f.tenantId,
      name: "Сохранённое имя",
      gtin14: "04600682000112",
      externalRef,
      unitPrice: "25.00",
    });
    expect((await runImport(f, "offers.xml")).text).toBe("success");
    expect(await observations(f.tenantId)).toEqual(rows);
    expect(
      await f.db.select().from(schema.products).where(eq(schema.products.id, productId)),
    ).toEqual([product]);
  });

  it("admits a changed effective price type for identical offers while preserving unchanged retries", async () => {
    const f = await fixture();
    const productId = randomUUID();
    const externalRef = randomUUID();
    await f.db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04600682000112",
      name: "Товар",
      externalRef,
      unitPrice: "10.00",
    });
    await f.db
      .insert(schema.integrationChannels)
      .values({ tenantId: f.tenantId, type: "commerceml", settings: { priceType: "Розничная" } });
    const bytes = Buffer.from(
      `<КоммерческаяИнформация><ПакетПредложений><Предложения><Предложение><Ид>${externalRef}</Ид><Цены><Цена><Представление>Розничная</Представление><ЦенаЗаЕдиницу>25.00</ЦенаЗаЕдиницу><Валюта>руб</Валюта></Цена><Цена><Представление>Оптовая</Представление><ЦенаЗаЕдиницу>15.00</ЦенаЗаЕдиницу><Валюта>руб</Валюта></Цена></Цены></Предложение></Предложения></ПакетПредложений></КоммерческаяИнформация>`,
    );
    await f.sessions.appendChunk(f.tenantId, f.session.id, "offers.xml", bytes);
    const price = async () =>
      (await f.db.select().from(schema.products).where(eq(schema.products.id, productId)))[0]
        ?.unitPrice;
    expect((await runImport(f, "offers.xml")).text).toBe("success");
    expect(await price()).toBe("25.00");
    const first = await observations(f.tenantId);
    expect(first).toHaveLength(1);
    expect((await runImport(f, "offers.xml")).text).toBe("success");
    expect(await observations(f.tenantId)).toEqual(first);
    await f.db
      .update(schema.integrationChannels)
      .set({ settings: { priceType: "Оптовая" } })
      .where(eq(schema.integrationChannels.tenantId, f.tenantId));
    expect((await runImport(f, "offers.xml")).text).toBe("success");
    expect(await price()).toBe("15.00");
    const changed = await observations(f.tenantId);
    expect(changed).toHaveLength(2);
    for (const priceType of ["Розничная", "Оптовая"])
      expect(changed).toContainEqual(
        expect.objectContaining({
          tenantId: f.tenantId,
          actorType: "exchange_session",
          actorId: f.session.id,
          operationId: "commerceMl.exchange.v1",
          outcome: "allow",
          reasonCodes: [],
          resourceScope: expect.objectContaining({
            digest: admissionScopeDigest({
              sessionId: f.session.id,
              action: "catalog_import",
              filename: "offers.xml",
              sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
              fingerprint: `1:${createHash("sha256").update(`p:${productId}`).digest("hex")}`,
              cursor: 0,
              effectiveConfig: { priceType },
              effectiveLinkTargets: [],
            }),
          }),
        }),
      );
    expect((await runImport(f, "offers.xml")).text).toBe("success");
    expect(await price()).toBe("15.00");
    expect(await observations(f.tenantId)).toEqual(changed);
    expect(await f.sessions.readImportCursor(f.session.id, "offers.xml")).toBeNull();
    expect(await f.sessions.assemble(f.session.id, "offers.xml")).toEqual(bytes);
  });

  it("preserves independent session keys across concurrent query, marker and cursor writes", async () => {
    const f = await fixture();
    const batch = { orderIds: [], xml: "<batch/>" };
    const cursor = { offset: 500, fingerprint: "501:stored" };
    const input = {
      action: "catalog_import" as const,
      effectiveConfig: { priceType: null },
      effectiveLinkTargets: [],
      filename: "import.xml",
      sourceFingerprint: "source",
      fingerprint: "501:stored",
      cursor: 0,
    };
    await Promise.all([
      f.sessions.ensureOutstandingOrderQuery(f.session, batch),
      f.sessions.observeImport(f.session, input),
      f.sessions.writeImportCursor(f.session.id, "import.xml", cursor),
    ]);
    expect(await f.sessions.readOutstandingOrderQuery(f.session.id)).toEqual(batch);
    expect(await f.sessions.readImportCursor(f.session.id, "import.xml")).toEqual(cursor);
    expect(await f.sessions.observeImport(f.session, input)).toBeNull();
    const rows = await observations(f.tenantId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.resourceScope.digest).sort()).toEqual(
      [
        admissionScopeDigest({ sessionId: f.session.id, action: "query", batch }),
        admissionScopeDigest({ sessionId: f.session.id, ...input }),
      ].sort(),
    );
  });

  it("acknowledges only the retained offered order and never observes ACK as fresh work", async () => {
    const f = await fixture();
    const kioskId = randomUUID();
    const employeeId = randomUUID();
    const offeredId = randomUUID();
    const otherId = randomUUID();
    await f.db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId: f.tenantId, name: "Киоск", dayLimitPerEmployee: 20 });
    await f.db
      .insert(schema.employees)
      .values({ id: employeeId, tenantId: f.tenantId, fullName: "Иван" });
    for (const id of [offeredId, otherId])
      await f.db.insert(schema.pickupOrders).values({
        id,
        tenantId: f.tenantId,
        orderNo: `EX-${randomUUID().slice(0, 8)}`,
        kioskId,
        employeeId,
        reason: "buy",
        itemCount: 0,
        totalPrice: "0.00",
      });
    const batch = { orderIds: [offeredId], xml: `<retained>${offeredId}</retained>` };
    await f.sessions.ensureOutstandingOrderQuery(f.session, batch);
    const rows = await observations(f.tenantId);
    expect(rows).toHaveLength(1);
    expect(
      (
        await request(f.app.getHttpServer())
          .get("/1c_exchange?mode=query")
          .set("Cookie", f.cookie)
          .expect(200)
      ).text,
    ).toBe(batch.xml);
    expect(await f.sessions.readOutstandingOrderQuery(f.session.id)).toEqual(batch);
    expect(
      (
        await request(f.app.getHttpServer())
          .get("/1c_exchange?mode=success")
          .set("Cookie", f.cookie)
          .expect(200)
      ).text,
    ).toBe("success");
    const [offered] = await f.db
      .select()
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, offeredId));
    expect(offered).toMatchObject({ tenantId: f.tenantId, status: "pending" });
    expect(offered?.exportedAt).toBeInstanceOf(Date);
    expect(
      (await f.db.select().from(schema.pickupOrders).where(eq(schema.pickupOrders.id, otherId)))[0]
        ?.exportedAt,
    ).toBeNull();
    expect(await f.sessions.readOutstandingOrderQuery(f.session.id)).toBeNull();
    expect(
      (
        await request(f.app.getHttpServer())
          .post("/1c_exchange?mode=success")
          .set("Cookie", f.cookie)
          .expect(200)
      ).text,
    ).toBe("success");
    expect(await observations(f.tenantId)).toEqual(rows);
    expect(
      await f.db.select().from(schema.pickupOrders).where(eq(schema.pickupOrders.id, offeredId)),
    ).toEqual([offered]);
    const events = await f.db
      .select()
      .from(schema.integrationEvents)
      .where(eq(schema.integrationEvents.sessionId, f.session.id));
    expect(events).toContainEqual(
      expect.objectContaining({
        tenantId: f.tenantId,
        sessionId: f.session.id,
        channelType: "commerceml",
        direction: "out",
        outcome: "ok",
        grain: "session",
        message: "success: подтверждено заявок: 1",
        details: { confirmed: 1, offered: 1 },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        tenantId: f.tenantId,
        sessionId: f.session.id,
        channelType: "commerceml",
        direction: "out",
        outcome: "ok",
        grain: "session",
        message: "success: подтверждено заявок: 0",
        details: { confirmed: 0, offered: 0 },
      }),
    );
  });

  it("rejects invalid and expired sessions without commercial observations", async () => {
    const f = await fixture();
    for (const cookie of ["mk_1c_session=invalid", f.cookie]) {
      if (cookie === f.cookie)
        await f.db
          .update(schema.integrationSessions)
          .set({ expiresAt: new Date(0) })
          .where(eq(schema.integrationSessions.id, f.session.id));
      const res = await request(f.app.getHttpServer())
        .get("/1c_exchange?mode=query")
        .set("Cookie", cookie)
        .expect(200);
      expect(res.text).toBe("failure\nno session");
    }
    const unauth = await request(f.app.getHttpServer())
      .get("/1c_exchange?mode=checkauth")
      .expect(200);
    expect(unauth.text).toBe("failure\nmissing credentials");
    expect(await observations(f.tenantId)).toEqual([]);
  });

  it("commits exactly one export winner when the shadow INSERT fails in PostgreSQL", async () => {
    const f = await fixture();
    const observed = vi.spyOn(f.admission, "observe");
    const name = `exchange_shadow_${randomUUID().replaceAll("-", "")}`;
    await f.db.execute(
      sql.raw(
        `create function ${name}() returns trigger language plpgsql as $$ begin if NEW.tenant_id = '${f.tenantId}' then raise exception 'synthetic shadow failure'; end if; return NEW; end $$`,
      ),
    );
    await f.db.execute(
      sql.raw(
        `create trigger ${name} before insert on entitlement_shadow_observations for each row execute function ${name}()`,
      ),
    );
    try {
      const first = { orderIds: [], xml: "<winning/>" };
      const [left, right] = await Promise.all([
        f.sessions.ensureOutstandingOrderQuery(f.session, first),
        f.sessions.ensureOutstandingOrderQuery(f.session, { orderIds: [], xml: "<other/>" }),
      ]);
      expect(left).toEqual(right);
      expect(await f.sessions.readOutstandingOrderQuery(f.session.id)).toEqual(left);
      expect(await observations(f.tenantId)).toEqual([]);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(await observed.mock.results[0]?.value).toEqual({
        mode: "shadow",
        decision: "unknown",
        reasons: ["shadow_persistence_failed"],
        observationId: null,
      });
      expect(observed.mock.calls[0]?.[0]).toMatchObject({
        tenantId: f.tenantId,
        actor: { domain: "exchange_session", id: f.session.id },
        operationId: "commerceMl.exchange.v1",
        scopeDigest: admissionScopeDigest({
          sessionId: f.session.id,
          action: "query",
          batch: left,
        }),
      });
    } finally {
      observed.mockRestore();
      await f.db.execute(sql.raw(`drop trigger ${name} on entitlement_shadow_observations`));
      await f.db.execute(sql.raw(`drop function ${name}()`));
    }
  });
});
