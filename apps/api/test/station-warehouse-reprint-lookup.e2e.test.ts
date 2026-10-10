import { randomUUID } from "node:crypto";
import { seedReportInventory } from "./support/platform-report-inventory-fixture";
import { createManagedSubscription } from "./support/subscription-fixtures";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { warehouseLookupResultSchema, warehouseTemplateCatalogSchema } from "@markiro/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// setupWarehouseApi binds the server once through listenOnLoopback.
import {
  setupWarehouseApi,
  WAREHOUSE_TEST_KM,
  WAREHOUSE_TEST_SSCC,
} from "./support/warehouse-reprint";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
describe.skipIf(!ready)("station warehouse reprint lookup", () => {
  let h: Awaited<ReturnType<typeof setupWarehouseApi>>;
  beforeAll(async () => {
    h = await setupWarehouseApi();
  });
  afterAll(async () => {
    await h?.close();
  });
  it.each([
    `!100${WAREHOUSE_TEST_SSCC}`,
    `]C0!100${WAREHOUSE_TEST_SSCC}`,
    `00${WAREHOUSE_TEST_SSCC}`,
  ])("resolves %s in a closed shift on another station", async (raw) => {
    const response = await h.lookup(h.a.apiKey, h.a.operatorId, raw).expect(200);
    const result = warehouseLookupResultSchema.parse(response.body);
    expect(result).toMatchObject({
      status: "found",
      source: {
        kind: "box",
        identity: WAREHOUSE_TEST_SSCC,
        sourceId: h.boxId,
        fields: { qty: "1", date: "08.10.2026" },
      },
    });
  });
  it("returns the original full code with its GS and crypto tail", async () => {
    const response = await h.lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM).expect(200);
    expect(warehouseLookupResultSchema.parse(response.body)).toMatchObject({
      status: "found",
      source: {
        kind: "unit",
        identity: h.codeHash,
        fields: { "km.code": WAREHOUSE_TEST_KM },
        unavailableFields: expect.arrayContaining(["expiry"]),
      },
    });
  });
  it("does not expose another organisation's source", async () => {
    await h
      .lookup(h.b.apiKey, h.b.operatorId, `!100${WAREHOUSE_TEST_SSCC}`)
      .expect(200, { status: "not_found" });
    await h.lookup(h.a.apiKey, h.b.operatorId, `00${WAREHOUSE_TEST_SSCC}`).expect(403);
  });
  it("rejects cabinet authentication, handheld kind and injected scope", async () => {
    await h.a.cabinet
      .post("/station/warehouse-reprint/lookup")
      .send({
        protocol: "warehouse-label-reprint-v1",
        operatorId: h.a.operatorId,
        raw: WAREHOUSE_TEST_KM,
      })
      .expect(403);
    const device = (
      await h.db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.id, h.a.deviceId))
    )[0];
    if (!device) throw new Error("fixture device missing");
    await h.db
      .update(schema.stationDevices)
      .set({ kind: "handheld" })
      .where(eq(schema.stationDevices.id, h.a.deviceId));
    try {
      await h.lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM).expect(403);
    } finally {
      await h.db
        .update(schema.stationDevices)
        .set({ kind: "station" })
        .where(eq(schema.stationDevices.id, h.a.deviceId));
    }
    await request(h.app.getHttpServer())
      .post("/station/warehouse-reprint/lookup")
      .set("x-api-key", h.a.apiKey)
      .send({
        protocol: "warehouse-label-reprint-v1",
        operatorId: h.a.operatorId,
        raw: WAREHOUSE_TEST_KM,
        tenantId: h.b.tenantId,
      })
      .expect(400);
  });
  it("does not grant printing to a disassembled box", async () => {
    await h.db
      .update(schema.boxes)
      .set({ disassembledAt: new Date() })
      .where(and(eq(schema.boxes.tenantId, h.a.tenantId), eq(schema.boxes.id, h.boxId)));
    try {
      await h
        .lookup(h.a.apiKey, h.a.operatorId, `!100${WAREHOUSE_TEST_SSCC}`)
        .expect(200, { status: "unavailable", code: "source_not_printable" });
    } finally {
      await h.db
        .update(schema.boxes)
        .set({ disassembledAt: null })
        .where(eq(schema.boxes.id, h.boxId));
    }
  });
  it("blocks revoked credentials and an operator removed from the roster", async () => {
    await h.db
      .update(schema.operatorCredentials)
      .set({ active: false })
      .where(
        and(
          eq(schema.operatorCredentials.tenantId, h.a.tenantId),
          eq(schema.operatorCredentials.employeeId, h.a.operatorId),
        ),
      );
    try {
      await h.lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM).expect(403);
    } finally {
      await h.db
        .update(schema.operatorCredentials)
        .set({ active: true })
        .where(
          and(
            eq(schema.operatorCredentials.tenantId, h.a.tenantId),
            eq(schema.operatorCredentials.employeeId, h.a.operatorId),
          ),
        );
    }
    await h.db
      .update(schema.stationDevices)
      .set({ revokedAt: new Date() })
      .where(eq(schema.stationDevices.id, h.a.deviceId));
    try {
      await h.lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM).expect(401);
    } finally {
      await h.db
        .update(schema.stationDevices)
        .set({ revokedAt: null })
        .where(eq(schema.stationDevices.id, h.a.deviceId));
    }
  });
  it("does not reconstruct a missing crypto tail", async () => {
    await h.db
      .update(schema.codes)
      .set({ canonicalRaw: "010460068200001321abcDEF1234567" })
      .where(and(eq(schema.codes.tenantId, h.a.tenantId), eq(schema.codes.codeHash, h.codeHash)));
    try {
      await h
        .lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM)
        .expect(200, { status: "unavailable", code: "incomplete_km" });
    } finally {
      await h.db
        .update(schema.codes)
        .set({ canonicalRaw: WAREHOUSE_TEST_KM })
        .where(and(eq(schema.codes.tenantId, h.a.tenantId), eq(schema.codes.codeHash, h.codeHash)));
    }
  });
  it("offers only enabled templates of the current organisation", async () => {
    const response = await request(h.app.getHttpServer())
      .get("/station/warehouse-reprint/templates")
      .set("x-api-key", h.a.apiKey)
      .expect(200);
    const catalog = warehouseTemplateCatalogSchema.parse(response.body);
    expect(catalog.templates.map((t) => t.id)).toEqual(
      expect.arrayContaining([h.boxTemplateId, h.unitTemplateId]),
    );
    expect(catalog.templates.map((t) => t.id)).not.toContain(h.disabledTemplateId);
    await request(h.app.getHttpServer())
      .get("/station/warehouse-reprint/templates")
      .set("x-api-key", h.b.apiKey)
      .expect(200);
    const other = await request(h.app.getHttpServer())
      .get("/station/warehouse-reprint/templates")
      .set("x-api-key", h.b.apiKey)
      .expect(200);
    expect(
      warehouseTemplateCatalogSchema.parse(other.body).templates.map((t) => t.id),
    ).not.toContain(h.boxTemplateId);
  });
  it("finds closed warehouse repack boxes and rejects invalidated packaging", async () => {
    const [shift] = await h.db.select().from(schema.shifts).where(eq(schema.shifts.id, h.shiftId));
    const [member] = await h.db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, h.a.tenantId));
    if (!shift || !member) throw new Error("fixture parent");
    const line = randomUUID();
    await h.db.insert(schema.lines).values({ id: line, tenantId: h.a.tenantId, name: "Warehouse" });
    const inventoryId = await seedReportInventory(h.db, {
      tenant: h.a.tenantId,
      product: shift.productId,
      line,
      operator: h.a.operatorId,
      user: member.userId,
    });
    const [box] = await h.db
      .select()
      .from(schema.inventoryRepackBoxes)
      .where(eq(schema.inventoryRepackBoxes.inventoryId, inventoryId));
    const [result] = await h.db
      .select()
      .from(schema.inventoryCodeResults)
      .where(
        and(
          eq(schema.inventoryCodeResults.inventoryId, inventoryId),
          eq(schema.inventoryCodeResults.classification, "expected"),
        ),
      );
    if (!box || !result) throw new Error("fixture repack");
    await h.db
      .update(schema.inventoryCodeResults)
      .set({ observedProductionDate: "2026-09-01" })
      .where(eq(schema.inventoryCodeResults.id, result.id));
    await h.db.insert(schema.inventoryRepackItems).values({
      tenantId: h.a.tenantId,
      inventoryId,
      boxId: box.id,
      resultId: result.id,
      productionDate: "2026-09-01",
      activeObservedProductionDate: "2026-09-01",
    });
    const sscc = "046006820000621515";
    await h.db
      .update(schema.inventoryRepackBoxes)
      .set({ newSscc: sscc })
      .where(eq(schema.inventoryRepackBoxes.id, box.id));
    expect(
      (await h.lookup(h.a.apiKey, h.a.operatorId, `00${sscc}`).expect(200)).body,
    ).toMatchObject({
      status: "found",
      source: {
        kind: "box",
        sourceId: box.id,
        sourceShiftId: null,
        fields: { sscc, date: "01.09.2026", qty: "1", "product.name": "Snapshot product" },
      },
    });
    await h.lookup(h.b.apiKey, h.b.operatorId, `00${sscc}`).expect(200, { status: "not_found" });
    await h.db
      .update(schema.inventoryRepackBoxes)
      .set({
        state: "invalidated",
        invalidationSource: "admin",
        invalidatedAt: new Date(),
        printState: "not_ready",
        printAttemptCount: 0,
        printedAt: null,
      })
      .where(eq(schema.inventoryRepackBoxes.id, box.id));
    await h
      .lookup(h.a.apiKey, h.a.operatorId, `00${sscc}`)
      .expect(200, { status: "unavailable", code: "source_not_printable" });
  });

  it("allows recovery under an expired subscription and rejects malformed scans", async () => {
    await createManagedSubscription(h.db, {
      tenantId: h.a.tenantId,
      startsAt: new Date(Date.now() - 86400000),
      endsAt: new Date(Date.now() - 3600000),
    });
    await h.lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM).expect(200);
    await h.lookup(h.a.apiKey, h.a.operatorId, `!100${WAREHOUSE_TEST_SSCC}extra`).expect(400);
  });
});
