import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.js";
import { organization } from "../src/schema/auth.js";
import { counterparties, products, shifts } from "../src/schema/platform.js";

// Postgres error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("tenant isolation (composite FKs + tenant-scoped uniqueness)", () => {
  const { db, pool } = createDb(url!);

  const orgA = {
    id: `org-a-${randomUUID()}`,
    name: "Tenant A",
    slug: `tenant-a-${randomUUID()}`,
    createdAt: new Date(),
  };
  const orgB = {
    id: `org-b-${randomUUID()}`,
    name: "Tenant B",
    slug: `tenant-b-${randomUUID()}`,
    createdAt: new Date(),
  };

  const productIds: string[] = [];
  const shiftIds: string[] = [];
  const counterpartyIds: string[] = [];

  beforeAll(async () => {
    await db.insert(organization).values([orgA, orgB]);
  });

  afterAll(async () => {
    // Clean up in FK order: shifts -> products/counterparties -> organization.
    if (shiftIds.length) await db.delete(shifts).where(inArray(shifts.id, shiftIds));
    if (productIds.length) await db.delete(products).where(inArray(products.id, productIds));
    if (counterpartyIds.length) {
      await db.delete(counterparties).where(inArray(counterparties.id, counterpartyIds));
    }
    await db.delete(organization).where(inArray(organization.id, [orgA.id, orgB.id]));
    await pool.end();
  });

  it("rejects a shift for tenant B that references tenant A's product", async () => {
    const [productA] = await db
      .insert(products)
      .values({ tenantId: orgA.id, gtin14: "04012345678901", name: "Widget A" })
      .returning();
    productIds.push(productA!.id);

    await expect(
      db.insert(shifts).values({
        tenantId: orgB.id,
        productId: productA!.id,
        mode: "validation",
      }),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } });
  });

  it("allows a shift that references a same-tenant product", async () => {
    const [productA2] = await db
      .insert(products)
      .values({ tenantId: orgA.id, gtin14: "04012345678902", name: "Widget A2" })
      .returning();
    productIds.push(productA2!.id);

    const [shift] = await db
      .insert(shifts)
      .values({ tenantId: orgA.id, productId: productA2!.id, mode: "validation" })
      .returning();
    shiftIds.push(shift!.id);

    expect(shift!.tenantId).toBe(orgA.id);
    expect(shift!.productId).toBe(productA2!.id);
  });

  it("rejects a product whose default_counterparty_id belongs to another tenant", async () => {
    const [counterpartyA] = await db
      .insert(counterparties)
      .values({ tenantId: orgA.id, name: "Distributor A", gln: "4600000000001" })
      .returning();
    counterpartyIds.push(counterpartyA!.id);

    await expect(
      db.insert(products).values({
        tenantId: orgB.id,
        gtin14: "04012345678903",
        name: "Widget B",
        defaultCounterpartyId: counterpartyA!.id,
      }),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } });
  });

  it("rejects a duplicate GTIN for the same tenant (products_tenant_gtin_uq)", async () => {
    const gtin = "04012345678904";
    const [first] = await db
      .insert(products)
      .values({ tenantId: orgA.id, gtin14: gtin, name: "Widget dup 1" })
      .returning();
    productIds.push(first!.id);

    await expect(
      db.insert(products).values({ tenantId: orgA.id, gtin14: gtin, name: "Widget dup 2" }),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } });
  });

  it("allows the same GTIN across different tenants", async () => {
    const gtin = "04012345678905";
    const [productA] = await db
      .insert(products)
      .values({ tenantId: orgA.id, gtin14: gtin, name: "Widget shared A" })
      .returning();
    productIds.push(productA!.id);

    const [productB] = await db
      .insert(products)
      .values({ tenantId: orgB.id, gtin14: gtin, name: "Widget shared B" })
      .returning();
    productIds.push(productB!.id);

    expect(productA!.gtin14).toBe(productB!.gtin14);
    expect(productA!.tenantId).not.toBe(productB!.tenantId);
  });
});
