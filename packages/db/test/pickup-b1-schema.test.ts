import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema } from "../src/index.js";

const url = process.env.DATABASE_URL;
const { organization } = schema;

describe.skipIf(!url)("pickup B1 schema (badge salts, pairing codes, sync conflicts)", () => {
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
  const kioskId = randomUUID();
  const foreignKioskId = randomUUID();
  const productId = randomUUID();
  const orderId = randomUUID();

  beforeAll(async () => {
    await db.insert(organization).values([org, foreignOrg]);
    await db
      .insert(schema.employees)
      .values({ id: empId, tenantId: org.id, fullName: "Смирнов А." });
    await db.insert(schema.kiosks).values({ id: kioskId, tenantId: org.id, name: "Киоск-1" });
    await db
      .insert(schema.kiosks)
      .values({ id: foreignKioskId, tenantId: foreignOrg.id, name: "Киоск-2" });
    await db.insert(schema.products).values({
      id: productId,
      tenantId: org.id,
      gtin14: "04650075195923",
      name: "Пиво",
    });
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId: org.id,
      orderNo: "ORD-26-0001",
      kioskId,
      employeeId: empId,
      reason: "buy",
      itemCount: 1,
    });
  });

  afterAll(async () => {
    await db
      .delete(schema.kioskPairingCodes)
      .where(inArray(schema.kioskPairingCodes.tenantId, [org.id, foreignOrg.id]));
    await db
      .delete(schema.employeeBadgeSalts)
      .where(inArray(schema.employeeBadgeSalts.tenantId, [org.id, foreignOrg.id]));
    await db
      .delete(schema.pickupOrderItems)
      .where(inArray(schema.pickupOrderItems.orderId, [orderId]));
    await db.delete(schema.pickupOrders).where(inArray(schema.pickupOrders.id, [orderId]));
    await db.delete(schema.kiosks).where(inArray(schema.kiosks.id, [kioskId, foreignKioskId]));
    await db.delete(schema.products).where(inArray(schema.products.id, [productId]));
    await db.delete(schema.employees).where(inArray(schema.employees.id, [empId]));
    await db.delete(organization).where(inArray(organization.id, [org.id, foreignOrg.id]));
    await pool.end();
  });

  it("keeps one badge salt per tenant", async () => {
    await db.insert(schema.employeeBadgeSalts).values({ tenantId: org.id, salt: "AAAA" });
    await expect(
      db.insert(schema.employeeBadgeSalts).values({ tenantId: org.id, salt: "BBBB" }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("rejects a pairing code for a kiosk of another tenant", async () => {
    await expect(
      db.insert(schema.kioskPairingCodes).values({
        tenantId: org.id,
        kioskId: foreignKioskId,
        codeHash: "deadbeef",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  // F3 regression: `kiosk_pairing_codes_code_hash_live_uq` (migration
  // 0014) is the DB-enforced backstop for `PairingService.issueCode`'s
  // SELECT-then-INSERT clash check, which has its own race window. Partial
  // on `used_at is null`, mirroring `kiosk_pairing_codes_one_live_uq`'s own
  // pattern -- a FULL unique index would permanently block ever reissuing a
  // hash again once its code is spent, which this asserts against directly.
  it("allows only one live row per code hash, but frees it once retired", async () => {
    const hash = `hash-${randomUUID()}`;
    await db.insert(schema.kioskPairingCodes).values({
      tenantId: org.id,
      kioskId,
      codeHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    // A second live row sharing this hash collides -- even across tenants
    // and kiosks, since the exchange looks a device up by hash alone with
    // no tenant context yet.
    await expect(
      db.insert(schema.kioskPairingCodes).values({
        tenantId: foreignOrg.id,
        kioskId: foreignKioskId,
        codeHash: hash,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "kiosk_pairing_codes_code_hash_live_uq" },
    });

    // Retiring the first row (used_at set) frees the hash for reuse.
    await db
      .update(schema.kioskPairingCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.kioskPairingCodes.tenantId, org.id),
          eq(schema.kioskPairingCodes.codeHash, hash),
        ),
      );

    await expect(
      db.insert(schema.kioskPairingCodes).values({
        tenantId: foreignOrg.id,
        kioskId: foreignKioskId,
        codeHash: hash,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.not.toThrow();
  });

  it("round-trips sync conflicts as JSON on the order", async () => {
    await db
      .update(schema.pickupOrders)
      .set({ syncConflicts: [{ rawKm: "01…", reason: "duplicate" }] })
      .where(and(eq(schema.pickupOrders.tenantId, org.id), eq(schema.pickupOrders.id, orderId)));
    const [row] = await db
      .select({ syncConflicts: schema.pickupOrders.syncConflicts })
      .from(schema.pickupOrders)
      .where(and(eq(schema.pickupOrders.tenantId, org.id), eq(schema.pickupOrders.id, orderId)));
    expect(row!.syncConflicts).toEqual([{ rawKm: "01…", reason: "duplicate" }]);
  });
});
