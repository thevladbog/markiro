import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { createDb, schema } from "../src/index.js";

const url = process.env.DATABASE_URL;
const { organization } = schema;

describe("pickup policy schema", () => {
  it("keeps one tenant-scoped pickup policy per employee", () => {
    const foreignKey = getTableConfig(schema.employeePickupPolicies).foreignKeys.find(
      (key) => key.getName() === "employee_pickup_policies_tenant_employee_fk",
    );

    expect(foreignKey, "missing employee tenant foreign key").toBeDefined();
    const reference = foreignKey!.reference();
    expect(reference.columns.map((column) => column.name)).toEqual(["tenant_id", "employee_id"]);
    expect(reference.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
  });

  it("links pickup box snapshots to tenant-scoped orders, boxes, and products", () => {
    expect(schema.pickupOrderBoxes, "missing pickup_order_boxes table").toBeDefined();
    if (!schema.pickupOrderBoxes) return;
    const config = getTableConfig(schema.pickupOrderBoxes);
    const foreignKeys = config.foreignKeys;
    const references = new Map(
      foreignKeys.map((foreignKey) => [foreignKey.getName(), foreignKey.reference()]),
    );
    const uniqueConstraints = new Map(
      config.uniqueConstraints.map((constraint) => [constraint.getName(), constraint]),
    );

    expect(
      references.get("pickup_order_boxes_tenant_order_fk")?.columns.map((c) => c.name),
    ).toEqual(["tenant_id", "order_id"]);
    expect(
      references.get("pickup_order_boxes_tenant_order_fk")?.foreignColumns.map((c) => c.name),
    ).toEqual(["tenant_id", "id"]);
    expect(references.get("pickup_order_boxes_tenant_box_fk")?.columns.map((c) => c.name)).toEqual([
      "tenant_id",
      "box_id",
    ]);
    expect(
      references.get("pickup_order_boxes_tenant_box_fk")?.foreignColumns.map((c) => c.name),
    ).toEqual(["tenant_id", "id"]);
    expect(
      references.get("pickup_order_boxes_tenant_product_fk")?.columns.map((c) => c.name),
    ).toEqual(["tenant_id", "product_id"]);
    expect(
      references.get("pickup_order_boxes_tenant_product_fk")?.foreignColumns.map((c) => c.name),
    ).toEqual(["tenant_id", "id"]);
    expect(
      uniqueConstraints
        .get("pickup_order_boxes_tenant_order_id_uq")
        ?.columns.map((column) => column.name),
    ).toEqual(["tenant_id", "order_id", "id"]);
    expect(
      uniqueConstraints
        .get("pickup_order_boxes_order_box_uq")
        ?.columns.map((column) => column.name),
    ).toEqual(["tenant_id", "order_id", "box_id"]);
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "pickup_order_boxes_bottle_count_check",
    );
  });

  it("links expanded pickup items to a box snapshot from the same tenant and order", () => {
    const foreignKey = getTableConfig(schema.pickupOrderItems).foreignKeys.find(
      (key) => key.getName() === "pickup_order_items_tenant_order_box_fk",
    );

    expect(foreignKey, "missing pickup item order-box foreign key").toBeDefined();
    const reference = foreignKey!.reference();
    expect(reference.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "order_id",
      "order_box_id",
    ]);
    expect(reference.foreignColumns.map((column) => column.name)).toEqual([
      "tenant_id",
      "order_id",
      "id",
    ]);
  });
});

describe.skipIf(!url)("pickup schema constraints", () => {
  const { db, pool } = createDb(url!);
  const org = {
    id: `org-${randomUUID()}`,
    name: "T",
    slug: `t-${randomUUID()}`,
    createdAt: new Date(),
  };
  const foreignOrg = {
    id: `org-${randomUUID()}`,
    name: "Foreign",
    slug: `foreign-${randomUUID()}`,
    createdAt: new Date(),
  };
  const empId = randomUUID();
  const foreignEmpId = randomUUID();
  const kioskId = randomUUID();
  const foreignKioskId = randomUUID();
  const productId = randomUUID();
  const foreignProductId = randomUUID();
  const shiftId = randomUUID();
  const foreignShiftId = randomUUID();
  const boxId = randomUUID();
  const foreignBoxId = randomUUID();
  const order1 = randomUUID();
  const order2 = randomUUID();
  const foreignOrder = randomUUID();
  const orderBoxId = randomUUID();
  const foreignOrderBoxId = randomUUID();

  beforeAll(async () => {
    await db.insert(organization).values([org, foreignOrg]);
    await db.insert(schema.employees).values([
      { id: empId, tenantId: org.id, fullName: "Смирнов А." },
      { id: foreignEmpId, tenantId: foreignOrg.id, fullName: "Чужой С." },
    ]);
    await db.insert(schema.kiosks).values([
      { id: kioskId, tenantId: org.id, name: "Киоск-1" },
      { id: foreignKioskId, tenantId: foreignOrg.id, name: "Чужой киоск" },
    ]);
    await db.insert(schema.products).values([
      {
        id: productId,
        tenantId: org.id,
        gtin14: "04650075195923",
        name: "Пиво",
      },
      {
        id: foreignProductId,
        tenantId: foreignOrg.id,
        gtin14: "04650075195930",
        name: "Чужое пиво",
      },
    ]);
    await db.insert(schema.shifts).values([
      { id: shiftId, tenantId: org.id, productId, mode: "validation" },
      {
        id: foreignShiftId,
        tenantId: foreignOrg.id,
        productId: foreignProductId,
        mode: "validation",
      },
    ]);
    await db.insert(schema.boxes).values([
      { id: boxId, tenantId: org.id, shiftId, deviceBoxId: "pickup-box" },
      {
        id: foreignBoxId,
        tenantId: foreignOrg.id,
        shiftId: foreignShiftId,
        deviceBoxId: "foreign-pickup-box",
      },
    ]);
    await db.insert(schema.pickupOrders).values([
      {
        id: order1,
        tenantId: org.id,
        orderNo: "ORD-26-0001",
        kioskId,
        employeeId: empId,
        reason: "buy",
        itemCount: 1,
      },
      {
        id: order2,
        tenantId: org.id,
        orderNo: "ORD-26-0002",
        kioskId,
        employeeId: empId,
        reason: "buy",
        itemCount: 1,
      },
      {
        id: foreignOrder,
        tenantId: foreignOrg.id,
        orderNo: "FOREIGN-ORD-26-0001",
        kioskId: foreignKioskId,
        employeeId: foreignEmpId,
        reason: "buy",
        itemCount: 1,
      },
    ]);
    await db.insert(schema.pickupOrderBoxes).values([
      {
        id: orderBoxId,
        tenantId: org.id,
        orderId: order1,
        boxId,
        sscc: "046500751959230001",
        productId,
        bottleCount: 12,
      },
      {
        id: foreignOrderBoxId,
        tenantId: foreignOrg.id,
        orderId: foreignOrder,
        boxId: foreignBoxId,
        sscc: "046500751959230018",
        productId: foreignProductId,
        bottleCount: 12,
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(schema.employeePickupPolicies)
      .where(inArray(schema.employeePickupPolicies.employeeId, [empId, foreignEmpId]));
    await db
      .delete(schema.pickupOrderItems)
      .where(inArray(schema.pickupOrderItems.orderId, [order1, order2, foreignOrder]));
    await db
      .delete(schema.pickupOrderBoxes)
      .where(inArray(schema.pickupOrderBoxes.id, [orderBoxId, foreignOrderBoxId]));
    await db
      .delete(schema.pickupOrders)
      .where(inArray(schema.pickupOrders.id, [order1, order2, foreignOrder]));
    await db.delete(schema.boxes).where(inArray(schema.boxes.id, [boxId, foreignBoxId]));
    await db.delete(schema.shifts).where(inArray(schema.shifts.id, [shiftId, foreignShiftId]));
    await db.delete(schema.kiosks).where(inArray(schema.kiosks.id, [kioskId, foreignKioskId]));
    await db
      .delete(schema.products)
      .where(inArray(schema.products.id, [productId, foreignProductId]));
    await db.delete(schema.employees).where(inArray(schema.employees.id, [empId, foreignEmpId]));
    await db.delete(organization).where(inArray(organization.id, [org.id, foreignOrg.id]));
    await pool.end();
  });

  const item = (orderId: string) => ({
    tenantId: org.id,
    orderId,
    productId,
    gtin14: "04650075195923",
    serial: "KYC9X7MQ",
    rawKm: "raw",
    kmKey: "01046500751959232-1KYC9X7MQ",
    scannedAt: new Date(),
  });

  const boxSnapshot = (overrides: Partial<typeof schema.pickupOrderBoxes.$inferInsert> = {}) => ({
    tenantId: org.id,
    orderId: order2,
    boxId,
    sscc: "046500751959230025",
    productId,
    bottleCount: 12,
    ...overrides,
  });

  it("rejects non-positive box bottle counts", async () => {
    await expect(
      db.insert(schema.pickupOrderBoxes).values(boxSnapshot({ bottleCount: 0 })),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects a pickup box snapshot that crosses the tenant order boundary", async () => {
    await expect(
      db.insert(schema.pickupOrderBoxes).values(boxSnapshot({ orderId: foreignOrder })),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects a pickup box snapshot that crosses the tenant production-box boundary", async () => {
    await expect(
      db.insert(schema.pickupOrderBoxes).values(boxSnapshot({ boxId: foreignBoxId })),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects a pickup box snapshot that crosses the tenant product boundary", async () => {
    await expect(
      db.insert(schema.pickupOrderBoxes).values(boxSnapshot({ productId: foreignProductId })),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects an expanded item that references a box snapshot from another order", async () => {
    await expect(
      db.insert(schema.pickupOrderItems).values({
        ...item(order2),
        orderBoxId,
        rawKm: "same-order-raw",
        kmKey: "01046500751959232-1SAMEORDER",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects an expanded item that references a box snapshot from another tenant", async () => {
    await expect(
      db.insert(schema.pickupOrderItems).values({
        ...item(order1),
        orderBoxId: foreignOrderBoxId,
        rawKm: "foreign-box-raw",
        kmKey: "01046500751959232-1FOREIGNBOX",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("keeps the pickup snapshot when its production box cannot be deleted", async () => {
    await expect(db.delete(schema.boxes).where(eq(schema.boxes.id, boxId))).rejects.toMatchObject({
      cause: { code: "23503" },
    });
    const [snapshot] = await db
      .select({ id: schema.pickupOrderBoxes.id })
      .from(schema.pickupOrderBoxes)
      .where(eq(schema.pickupOrderBoxes.id, orderBoxId));
    expect(snapshot?.id).toBe(orderBoxId);
  });

  it("blocks the same km_key in a second non-cancelled order", async () => {
    await db.insert(schema.pickupOrderItems).values(item(order1));
    await expect(db.insert(schema.pickupOrderItems).values(item(order2))).rejects.toMatchObject({
      cause: { code: "23505" },
    });
  });

  it("defaults employee QR printing off for a new kiosk", async () => {
    const [savedKiosk] = await db
      .select({ printEmployeeQrOnSlip: schema.kiosks.printEmployeeQrOnSlip })
      .from(schema.kiosks)
      .where(eq(schema.kiosks.id, kioskId));

    expect(savedKiosk?.printEmployeeQrOnSlip).toBe(false);
  });

  it("allows the km_key again once the first item is voided", async () => {
    // Self-contained: don't rely on the previous test's insert having run
    // first -- make sure order1's item exists regardless of execution order
    // (`onConflictDoNothing` no-ops if the prior test already inserted it).
    await db
      .insert(schema.pickupOrderItems)
      .values(item(order1))
      .onConflictDoNothing({
        target: [
          schema.pickupOrderItems.tenantId,
          schema.pickupOrderItems.orderId,
          schema.pickupOrderItems.kmKey,
        ],
      });
    // Scoped to THIS test's data (tenant + order1) -- an unscoped update
    // here would void every pickup_order_item row in the shared Postgres,
    // including ones from concurrently-running api e2e tests.
    await db
      .update(schema.pickupOrderItems)
      .set({ voided: true })
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, org.id),
          eq(schema.pickupOrderItems.orderId, order1),
        ),
      );
    await expect(db.insert(schema.pickupOrderItems).values(item(order2))).resolves.toBeDefined();
  });

  it("exported_at defaults to null and can be set", async () => {
    const [before] = await db
      .select({ exportedAt: schema.pickupOrders.exportedAt })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, order1));
    expect(before?.exportedAt).toBeNull();

    const now = new Date();
    await db
      .update(schema.pickupOrders)
      .set({ exportedAt: now })
      .where(eq(schema.pickupOrders.id, order1));

    const [after] = await db
      .select({ exportedAt: schema.pickupOrders.exportedAt })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, order1));
    expect(after?.exportedAt?.getTime()).toBe(now.getTime());

    // Reset for any test after this one in the same file.
    await db
      .update(schema.pickupOrders)
      .set({ exportedAt: null })
      .where(eq(schema.pickupOrders.id, order1));
  });

  it("rejects a non-positive employee day limit", async () => {
    await expect(
      db.insert(schema.employeePickupPolicies).values({
        tenantId: org.id,
        employeeId: empId,
        limitMode: "limited",
        dayLimit: 0,
        canWriteoff: false,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects a tenant policy for an employee from another tenant", async () => {
    await expect(
      db.insert(schema.employeePickupPolicies).values({
        tenantId: org.id,
        employeeId: foreignEmpId,
        limitMode: "limited",
        dayLimit: 5,
        canWriteoff: false,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});
