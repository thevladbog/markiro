import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { createDb, schema } from "../src/index.js";

const url = process.env.DATABASE_URL;
const { organization } = schema;

describe.skipIf(!url)("pickup schema constraints", () => {
  const { db, pool } = createDb(url!);
  const org = { id: `org-${randomUUID()}`, name: "T", slug: `t-${randomUUID()}`, createdAt: new Date() };
  const empId = randomUUID();
  const kioskId = randomUUID();
  const productId = randomUUID();
  const order1 = randomUUID();
  const order2 = randomUUID();

  beforeAll(async () => {
    await db.insert(organization).values(org);
    await db.insert(schema.employees).values({ id: empId, tenantId: org.id, fullName: "Смирнов А." });
    await db.insert(schema.kiosks).values({ id: kioskId, tenantId: org.id, name: "Киоск-1" });
    await db.insert(schema.products).values({
      id: productId, tenantId: org.id, gtin14: "04650075195923", name: "Пиво",
    });
    await db.insert(schema.pickupOrders).values([
      { id: order1, tenantId: org.id, orderNo: "ORD-26-0001", kioskId, employeeId: empId, reason: "buy", itemCount: 1 },
      { id: order2, tenantId: org.id, orderNo: "ORD-26-0002", kioskId, employeeId: empId, reason: "buy", itemCount: 1 },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.pickupOrderItems).where(inArray(schema.pickupOrderItems.orderId, [order1, order2]));
    await db.delete(schema.pickupOrders).where(inArray(schema.pickupOrders.id, [order1, order2]));
    await db.delete(schema.kiosks).where(inArray(schema.kiosks.id, [kioskId]));
    await db.delete(schema.products).where(inArray(schema.products.id, [productId]));
    await db.delete(schema.employees).where(inArray(schema.employees.id, [empId]));
    await db.delete(organization).where(inArray(organization.id, [org.id]));
    await pool.end();
  });

  const item = (orderId: string) => ({
    tenantId: org.id, orderId, productId, gtin14: "04650075195923",
    serial: "KYC9X7MQ", rawKm: "raw", kmKey: "01046500751959232-1KYC9X7MQ",
    scannedAt: new Date(),
  });

  it("blocks the same km_key in a second non-cancelled order", async () => {
    await db.insert(schema.pickupOrderItems).values(item(order1));
    await expect(db.insert(schema.pickupOrderItems).values(item(order2)))
      .rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows the km_key again once the first item is voided", async () => {
    await db.update(schema.pickupOrderItems).set({ voided: true });
    await expect(db.insert(schema.pickupOrderItems).values(item(order2))).resolves.toBeDefined();
  });
});
