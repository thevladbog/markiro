import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { schema, type Db } from "@markiro/db";
import { createTestEmployee } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { PickupOrdersService } from "../src/modules/pickup-orders/pickup-orders.service";

/** GTIN test vector (check-digit VALID). See kiosk-orders.e2e.test.ts for the full rationale. */
const GTIN = "04600682000013";

/** GS (ASCII 0x1D) — the KM segment separator. */
const GS = String.fromCharCode(0x1d);

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("pickup orders admin e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let pickupOrdersService: PickupOrdersService;

  let tenantId: string;
  let employeeId: string;
  let productId: string;
  let kioskId: string;
  let agent: ReturnType<typeof request.agent>;
  const TOKEN = `kiosk-token-${randomUUID()}`;
  const BADGE = `badge-${randomUUID()}`;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    pickupOrdersService = ref.get(PickupOrdersService);

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    employeeId = randomUUID();
    await createTestEmployee(
      db,
      {
        id: employeeId,
        tenantId,
        fullName: "Иван Иванов",
        role: "оператор",
      },
      { dayLimit: 20, canWriteoff: true },
    );
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: BADGE });

    productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: GTIN, name: "Товар", unitPrice: "99.90" });

    kioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId, name: "Киоск А", dayLimitPerEmployee: 20 });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(TOKEN) })
      .where(eq(schema.kiosks.id, kioskId));
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpWithInactiveOrg(a: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await a
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);

    const org = await a
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);

    return org.body.id as string;
  }

  async function signUpAndActivate(a: ReturnType<typeof request.agent>): Promise<string> {
    const orgId = await signUpWithInactiveOrg(a);
    await a.post("/api/auth/organization/set-active").send({ organizationId: orgId }).expect(200);
    return orgId;
  }

  function scan(
    deviceSeq: number,
    rawKm: string,
    extra: Record<string, unknown> = {},
  ): request.Test {
    return request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq, badgeCode: BADGE, reason: "buy", items: [{ rawKm }], ...extra });
  }

  it("creates orders via the kiosk path, lists/filters/details/resolves/cancels them as admin", async () => {
    // --- Seed 4 orders through the kiosk create path ---
    const orderList = await scan(101, `01${GTIN}21LISTP1${GS}93Abcd`).expect(201);
    const orderPunch = await scan(102, `01${GTIN}21PUNCH1${GS}93Abcd`).expect(201);
    const orderCancel = await scan(103, `01${GTIN}21CANCEL1${GS}93Abcd`).expect(201);

    const writeoffReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values({
      id: writeoffReasonId,
      tenantId,
      name: "Брак",
      sortOrder: 0,
      archived: false,
    });
    const orderWriteoff = await scan(104, `01${GTIN}21WOFF1${GS}93Abcd`, {
      reason: "writeoff",
      writeoffReasonId,
    }).expect(201);

    const idList = await orderIdByNo(orderList.body.orderNo);
    const idPunch = await orderIdByNo(orderPunch.body.orderNo);
    const idCancel = await orderIdByNo(orderCancel.body.orderNo);
    const idWriteoff = await orderIdByNo(orderWriteoff.body.orderNo);

    // --- List: filter by status=pending ---
    const pendingRes = await agent.get("/pickup-orders").query({ status: "pending" }).expect(200);
    const pendingIds = pendingRes.body.items.map((i: { id: string }) => i.id);
    expect(pendingIds).toEqual(expect.arrayContaining([idList, idPunch, idCancel, idWriteoff]));
    for (const item of pendingRes.body.items) {
      expect(item.status).toBe("pending");
    }

    // --- List: filter by reason=buy (excludes the writeoff order) ---
    const buyRes = await agent.get("/pickup-orders").query({ reason: "buy" }).expect(200);
    const buyIds = buyRes.body.items.map((i: { id: string }) => i.id);
    expect(buyIds).toEqual(expect.arrayContaining([idList, idPunch, idCancel]));
    expect(buyIds).not.toContain(idWriteoff);

    // --- Detail ---
    const detailRes = await agent.get(`/pickup-orders/${idList}`).expect(200);
    expect(detailRes.body).toMatchObject({
      id: idList,
      orderNo: orderList.body.orderNo,
      employeeName: "Иван Иванов",
      kioskName: "Киоск А",
      reason: "buy",
      writeoffReasonName: null,
      itemCount: 1,
      totalPrice: "99.90",
      status: "pending",
      employeeBadgeCode: BADGE,
      receiptNo: null,
      actNo: null,
    });
    expect(detailRes.body.items).toHaveLength(1);
    expect(detailRes.body.items[0]).toMatchObject({
      gtin14: GTIN,
      serial: "LISTP1",
      productName: "Товар",
      unitPrice: "99.90",
    });

    // --- Resolve: writeoff without an explicit writeoffReasonId inherits the order's own ---
    const resolveWriteoffRes = await agent
      .post(`/pickup-orders/${idWriteoff}/resolve`)
      .send({ action: "writeoff", actNo: "ACT-1" })
      .expect(200);
    expect(resolveWriteoffRes.body.status).toBe("writtenoff");
    const writeoffDetail = await agent.get(`/pickup-orders/${idWriteoff}`).expect(200);
    expect(writeoffDetail.body.actNo).toBe("ACT-1");
    expect(writeoffDetail.body.writeoffReasonName).toBe("Брак");

    // --- Resolve: writeoff with NO reason anywhere (buy order, none supplied) -> 400 ---
    await agent
      .post(`/pickup-orders/${idList}/resolve`)
      .send({ action: "writeoff", actNo: "ACT-X" })
      .expect(400);

    // --- Resolve: writeoff with a bogus writeoffReasonId -> 400 (not a raw FK-violation 500) ---
    await agent
      .post(`/pickup-orders/${idList}/resolve`)
      .send({ action: "writeoff", actNo: "ACT-Y", writeoffReasonId: randomUUID() })
      .expect(400);

    // --- Resolve: writeoff with an ARCHIVED (but tenant-owned) reason -> 400 ---
    // Symmetric with the kiosk create path: an archived reason can't be
    // (re-)attached on resolve any more than it can on ingest.
    const archivedResolveReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values({
      id: archivedResolveReasonId,
      tenantId,
      name: "Архивная причина",
      sortOrder: 0,
      archived: true,
    });
    await agent
      .post(`/pickup-orders/${idList}/resolve`)
      .send({ action: "writeoff", actNo: "ACT-Z", writeoffReasonId: archivedResolveReasonId })
      .expect(400);

    // --- Resolve: punch sets status + receiptNo + resolvedAt (+ resolvedByUserId) ---
    const resolvePunchRes = await agent
      .post(`/pickup-orders/${idPunch}/resolve`)
      .send({ action: "punch", receiptNo: "R-1" })
      .expect(200);
    expect(resolvePunchRes.body.status).toBe("punched");

    const [punchRow] = await db
      .select()
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, idPunch));
    expect(punchRow?.receiptNo).toBe("R-1");
    expect(punchRow?.resolvedAt).toBeTruthy();
    expect(punchRow?.resolvedByUserId).toBeTruthy();

    // --- Resolve on a non-pending order -> 409 ---
    await agent
      .post(`/pickup-orders/${idPunch}/resolve`)
      .send({ action: "punch", receiptNo: "R-2" })
      .expect(409);

    // --- Cancel a fresh pending order: flips to cancelled AND voids its items (frees the code) ---
    const cancelRes = await agent.post(`/pickup-orders/${idCancel}/cancel`).expect(200);
    expect(cancelRes.body.status).toBe("cancelled");

    const voidedItems = await db
      .select()
      .from(schema.pickupOrderItems)
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          eq(schema.pickupOrderItems.orderId, idCancel),
        ),
      );
    expect(voidedItems.every((i) => i.voided)).toBe(true);

    // Re-scan the SAME code via a new order — should now be ACCEPTED, proving the partial-unique freed it.
    const rescanRes = await scan(105, `01${GTIN}21CANCEL1${GS}93Abcd`).expect(201);
    expect(rescanRes.body.itemCount).toBe(1);
    expect(rescanRes.body.conflicts).toHaveLength(0);

    // --- Cancel on a non-pending order -> 409 ---
    await agent.post(`/pickup-orders/${idCancel}/cancel`).expect(409);
  });

  it("findExportCandidates отдаёт только pending и ещё не выгруженные заявки, с товарами", async () => {
    const linkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: linkedProductId,
      tenantId,
      gtin14: "04600682000037",
      name: "Товар со связью",
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
      totalPrice: "10.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId,
      productId: linkedProductId,
      gtin14: "04600682000037",
      serial: "SN0001",
      rawKm: "raw-export-1",
      kmKey: `kmkey-${randomUUID()}`,
      unitPrice: "10.00",
      scannedAt: new Date(),
    });

    const already = await pickupOrdersService.findExportCandidates(tenantId, 100);
    const found = already.candidates.find((o) => o.id === orderId);
    expect(found).toBeDefined();
    expect(found!.items).toEqual([
      { productId: linkedProductId, productExternalRef: expect.any(String), unitPrice: "10.00" },
    ]);

    await db
      .update(schema.pickupOrders)
      .set({ exportedAt: new Date() })
      .where(eq(schema.pickupOrders.id, orderId));
    const afterExport = await pickupOrdersService.findExportCandidates(tenantId, 100);
    expect(afterExport.candidates.some((o) => o.id === orderId)).toBe(false);
  });

  it("findExportCandidates не отдаёт заявку без активных товаров", async () => {
    const orderId = randomUUID();
    const allVoidedOrderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 0,
      totalPrice: "0.00",
    });
    await db.insert(schema.pickupOrders).values({
      id: allVoidedOrderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      totalPrice: "0.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId: allVoidedOrderId,
      productId,
      gtin14: GTIN,
      serial: `SN-${randomUUID()}`,
      rawKm: `raw-${randomUUID()}`,
      kmKey: `kmkey-${randomUUID()}`,
      voided: true,
      scannedAt: new Date(),
    });

    const result = await pickupOrdersService.findExportCandidates(tenantId, 100);
    expect(result.candidates.some((order) => order.id === orderId)).toBe(false);
    expect(result.candidates.some((order) => order.id === allVoidedOrderId)).toBe(false);
  });

  it("findExportCandidates не отдаёт заявки с непривязанным товаром в candidates, но видит их в held", async () => {
    const unlinkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: unlinkedProductId,
      tenantId,
      gtin14: "04600682000044",
      name: "Товар без связи",
    });

    const heldOrderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: heldOrderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      totalPrice: "10.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId: heldOrderId,
      productId: unlinkedProductId,
      gtin14: "04600682000044",
      serial: "SN-HELD",
      rawKm: "raw-held-1",
      kmKey: `kmkey-${randomUUID()}`,
      unitPrice: "10.00",
      scannedAt: new Date(),
    });

    const result = await pickupOrdersService.findExportCandidates(tenantId, 100);
    expect(result.candidates.some((o) => o.id === heldOrderId)).toBe(false);
    const heldEntry = result.held.find((h) => h.orderId === heldOrderId);
    expect(heldEntry).toBeDefined();
    expect(heldEntry!.unlinkedProductIds).toEqual([unlinkedProductId]);
  });

  it("findExportCandidates: заявки с непривязанным товаром не морят голодом заявку, готовую к экспорту, даже когда held-заявок больше limit", async () => {
    // The starvation bug this fix prevents: the OLD implementation selected
    // the oldest `limit` pending+unexported orders FIRST, then split them
    // into eligible/held afterwards -- so once `limit` or more orders were
    // held, the eligible order below (created LAST, i.e. newest) would never
    // even be selected by the first query, let alone offered. Three held
    // orders against `limit=2` reproduces that: a limit of 2 is smaller than
    // the 3 held orders alone, so the old code would return 2 held orders
    // and nothing else, every round, forever.
    const unlinkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: unlinkedProductId,
      tenantId,
      gtin14: "04600682000051",
      name: "Товар без связи (starvation)",
    });

    for (let i = 0; i < 3; i++) {
      const orderId = randomUUID();
      await db.insert(schema.pickupOrders).values({
        id: orderId,
        tenantId,
        orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
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
        gtin14: "04600682000051",
        serial: `SN-STARVE-${i}`,
        rawKm: `raw-starve-${i}`,
        kmKey: `kmkey-${randomUUID()}`,
        unitPrice: "10.00",
        scannedAt: new Date(),
      });
    }

    const linkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: linkedProductId,
      tenantId,
      gtin14: "04600682000068",
      name: "Товар со связью (starvation)",
      externalRef: `ext-${randomUUID()}`,
    });
    const eligibleOrderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: eligibleOrderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      totalPrice: "10.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId: eligibleOrderId,
      productId: linkedProductId,
      gtin14: "04600682000068",
      serial: "SN-STARVE-ELIGIBLE",
      rawKm: "raw-starve-eligible",
      kmKey: `kmkey-${randomUUID()}`,
      unitPrice: "10.00",
      scannedAt: new Date(),
    });

    const result = await pickupOrdersService.findExportCandidates(tenantId, 2);
    expect(result.candidates.some((o) => o.id === eligibleOrderId)).toBe(true);
  });

  it("detail показывает уникальные непустые названия только для активных непривязанных товаров", async () => {
    const namedProductId = randomUUID();
    const emptyProductId = randomUUID();
    const voidedProductId = randomUUID();
    await db.insert(schema.products).values([
      {
        id: namedProductId,
        tenantId,
        gtin14: "04600682000075",
        name: "Непривязанный товар",
      },
      { id: emptyProductId, tenantId, gtin14: "04600682000082", name: "" },
      {
        id: voidedProductId,
        tenantId,
        gtin14: "04600682000099",
        name: "Аннулированный товар",
      },
    ]);
    const orderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 4,
    });
    await db.insert(schema.pickupOrderItems).values(
      [namedProductId, namedProductId, emptyProductId, voidedProductId].map(
        (itemProductId, index) => ({
          tenantId,
          orderId,
          productId: itemProductId,
          gtin14: `04600682000${["075", "075", "082", "099"][index]}`,
          serial: `SN-HELD-NAME-${index}`,
          rawKm: `raw-held-name-${randomUUID()}`,
          kmKey: `kmkey-${randomUUID()}`,
          voided: index === 3,
          scannedAt: new Date(),
        }),
      ),
    );

    const detail = await pickupOrdersService.detail(tenantId, orderId);
    expect(detail.exportHeldProductNames).toEqual(["Непривязанный товар"]);
  });

  it("applyExternalStatus переводит pending заявку в punched", async () => {
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

    const result = await pickupOrdersService.applyExternalStatus(tenantId, orderId, "punched");
    expect(result).toEqual({ outcome: "applied" });

    const [row] = await db
      .select({ status: schema.pickupOrders.status })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(row?.status).toBe("punched");
  });

  it("applyExternalStatus отказывает расхождением, если заявка уже не pending", async () => {
    const orderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      status: "punched",
    });

    const result = await pickupOrdersService.applyExternalStatus(tenantId, orderId, "cancelled");
    expect(result).toEqual({ outcome: "not_pending", currentStatus: "punched" });

    const [row] = await db
      .select({ status: schema.pickupOrders.status })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(row?.status).toBe("punched");
  });

  it("applyExternalStatus отказывает списанием без причины", async () => {
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

    const result = await pickupOrdersService.applyExternalStatus(tenantId, orderId, "writtenoff");
    expect(result).toEqual({ outcome: "missing_writeoff_reason" });
  });

  it("applyExternalStatus отдаёт not_found для чужого/несуществующего id", async () => {
    const result = await pickupOrdersService.applyExternalStatus(tenantId, randomUUID(), "punched");
    expect(result).toEqual({ outcome: "not_found" });
  });

  it("applyExternalStatus отдаёт not_found для реальной заявки другого tenant", async () => {
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
    const otherTenantId = await signUpAndActivate(request.agent(app!.getHttpServer()));

    const result = await pickupOrdersService.applyExternalStatus(otherTenantId, orderId, "punched");
    expect(result).toEqual({ outcome: "not_found" });
  });

  it("applyExternalStatus при cancelled помечает товары voided", async () => {
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
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId,
      productId,
      gtin14: GTIN,
      serial: `SN-${randomUUID()}`,
      rawKm: `raw-${randomUUID()}`,
      kmKey: `kmkey-${randomUUID()}`,
      scannedAt: new Date(),
    });

    const result = await pickupOrdersService.applyExternalStatus(tenantId, orderId, "cancelled");
    expect(result).toEqual({ outcome: "applied" });
    const [order] = await db
      .select({ status: schema.pickupOrders.status })
      .from(schema.pickupOrders)
      .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, orderId)));
    const items = await db
      .select({ voided: schema.pickupOrderItems.voided })
      .from(schema.pickupOrderItems)
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          eq(schema.pickupOrderItems.orderId, orderId),
        ),
      );
    expect(order?.status).toBe("cancelled");
    expect(items).toEqual([{ voided: true }]);
  });

  it("cross-tenant isolation: org B cannot read, resolve, cancel, slip or export org A's order", async () => {
    const orderRes = await scan(999, `01${GTIN}21XTEN1${GS}93Abcd`).expect(201);
    const orderId = await orderIdByNo(orderRes.body.orderNo);

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    // Reads and mutations alike 404 — the order simply doesn't exist for org B.
    await agent2.get(`/pickup-orders/${orderId}`).expect(404);
    await agent2.get(`/pickup-orders/${orderId}/slip`).expect(404);
    await agent2
      .post(`/pickup-orders/${orderId}/resolve`)
      .send({ action: "punch", receiptNo: "R-X" })
      .expect(404);
    await agent2.post(`/pickup-orders/${orderId}/cancel`).expect(404);

    // Export silently scopes to the caller's tenant, so org B's export of org
    // A's id yields an empty file (200), never org A's codes.
    const exportRes = await agent2
      .post(`/pickup-orders/export`)
      .send({ orderIds: [orderId] })
      .expect(200);
    expect(exportRes.text).toBe("");

    // Org A's order is untouched by any of org B's attempts.
    const stillPending = await agent.get(`/pickup-orders/${orderId}`).expect(200);
    expect(stillPending.body.status).toBe("pending");
  });

  async function orderIdByNo(orderNo: string): Promise<string> {
    const [row] = await db
      .select({ id: schema.pickupOrders.id })
      .from(schema.pickupOrders)
      .where(
        and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.orderNo, orderNo)),
      );
    if (!row) throw new Error(`No order found for orderNo ${orderNo}`);
    return row.id;
  }
});
