import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { createDb, schema } from "../src/index.js";

const url = process.env.DATABASE_URL;
const { organization } = schema;

describe.skipIf(!url)("pickup_scan_rejections schema", () => {
  const { db, pool } = createDb(url!);
  const org = {
    id: `org-${randomUUID()}`,
    name: "T",
    slug: `t-${randomUUID()}`,
    createdAt: new Date(),
  };
  const foreignOrg = {
    id: `org-${randomUUID()}`,
    name: "T2",
    slug: `t2-${randomUUID()}`,
    createdAt: new Date(),
  };
  const empId = randomUUID();
  const foreignEmpId = randomUUID();
  const kioskId = randomUUID();
  const foreignKioskId = randomUUID();

  const CODES = [{ rawKm: "0104600682000013215X", reason: "not_allowed" }];

  beforeAll(async () => {
    await db.insert(organization).values([org, foreignOrg]);
    await db
      .insert(schema.employees)
      .values({ id: empId, tenantId: org.id, fullName: "Смирнов А." });
    await db
      .insert(schema.employees)
      .values({ id: foreignEmpId, tenantId: foreignOrg.id, fullName: "Чужой" });
    await db.insert(schema.kiosks).values({ id: kioskId, tenantId: org.id, name: "Киоск-1" });
    await db
      .insert(schema.kiosks)
      .values({ id: foreignKioskId, tenantId: foreignOrg.id, name: "Киоск-2" });
  });

  afterAll(async () => {
    await db
      .delete(schema.pickupScanRejections)
      .where(inArray(schema.pickupScanRejections.tenantId, [org.id, foreignOrg.id]));
    await db.delete(schema.kiosks).where(inArray(schema.kiosks.id, [kioskId, foreignKioskId]));
    await db.delete(schema.employees).where(inArray(schema.employees.id, [empId, foreignEmpId]));
    await db.delete(organization).where(inArray(organization.id, [org.id, foreignOrg.id]));
    await pool.end();
  });

  it("stores a fully-refused scan with no order", async () => {
    const [row] = await db
      .insert(schema.pickupScanRejections)
      .values({
        tenantId: org.id,
        kioskId,
        employeeId: empId,
        deviceSeq: 1,
        codes: CODES,
        scannedAt: new Date(),
      })
      .returning();

    expect(row!.orderId).toBeNull();
    expect(row!.badgeCode).toBeNull();
    expect(row!.acknowledgedAt).toBeNull();
    expect(row!.codes).toEqual(CODES);
  });

  it("rejects a kiosk belonging to another tenant", async () => {
    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId: foreignKioskId,
        employeeId: empId,
        deviceSeq: 900,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects an employee belonging to another tenant", async () => {
    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        employeeId: foreignEmpId,
        deviceSeq: 901,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects an order belonging to another tenant", async () => {
    const foreignOrderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: foreignOrderId,
      tenantId: foreignOrg.id,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId: foreignKioskId,
      employeeId: foreignEmpId,
      reason: "buy",
      itemCount: 0,
    });

    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        employeeId: empId,
        orderId: foreignOrderId,
        deviceSeq: 904,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    await db.delete(schema.pickupOrders).where(inArray(schema.pickupOrders.id, [foreignOrderId]));
  });

  // The idempotency key. A retried sync -- lost response, or a kiosk that
  // keeps retrying a 401 forever -- must not double-count in the cabinet.
  it("allows only one rejection per (tenant, kiosk, device_seq)", async () => {
    await db.insert(schema.pickupScanRejections).values({
      tenantId: org.id,
      kioskId,
      employeeId: empId,
      deviceSeq: 42,
      codes: CODES,
      scannedAt: new Date(),
    });

    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        employeeId: empId,
        deviceSeq: 42,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "pickup_scan_rejections_kiosk_device_seq_uq" },
    });
  });

  // `kind` is derived in the DTO from `employee_id IS NULL`, so the two
  // columns must never disagree -- an unrecognised badge has no employee,
  // and a recognised one stores no badge code.
  it("refuses a row with both an employee and a badge code", async () => {
    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        employeeId: empId,
        badgeCode: "badge-1",
        deviceSeq: 902,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "pickup_scan_rejections_badge_xor_employee" },
    });
  });

  it("refuses a row with neither an employee nor a badge code", async () => {
    await expect(
      db.insert(schema.pickupScanRejections).values({
        tenantId: org.id,
        kioskId,
        deviceSeq: 903,
        codes: CODES,
        scannedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "pickup_scan_rejections_badge_xor_employee" },
    });
  });

  it("stores an unrecognised badge with no employee", async () => {
    const [row] = await db
      .insert(schema.pickupScanRejections)
      .values({
        tenantId: org.id,
        kioskId,
        badgeCode: "badge-gone",
        deviceSeq: 43,
        codes: [{ rawKm: "0104600682000013215X", reason: "unknown_badge" }],
        scannedAt: new Date(),
      })
      .returning();

    expect(row!.employeeId).toBeNull();
    expect(row!.badgeCode).toBe("badge-gone");
  });
});
