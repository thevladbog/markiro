import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.js";
import { organization } from "../src/schema/auth.js";
import { mediaAssets } from "../src/schema/media.js";
import {
  counterparties,
  lines,
  productImages,
  products,
  shifts,
  stationDevices,
  stationPairingCodes,
} from "../src/schema/platform.js";

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
  const mediaAssetIds: string[] = [];
  const productImageProductIds: string[] = [];
  const shiftIds: string[] = [];
  const counterpartyIds: string[] = [];
  const lineIds: string[] = [];
  const stationDeviceIds: string[] = [];

  beforeAll(async () => {
    await db.insert(organization).values([orgA, orgB]);
  });

  afterAll(async () => {
    // Clean up in FK order: pairing codes -> devices -> product images -> lines/shifts -> products/counterparties -> organization.
    if (stationDeviceIds.length) {
      await db
        .delete(stationPairingCodes)
        .where(inArray(stationPairingCodes.stationDeviceId, stationDeviceIds));
      await db.delete(stationDevices).where(inArray(stationDevices.id, stationDeviceIds));
    }
    if (shiftIds.length) await db.delete(shifts).where(inArray(shifts.id, shiftIds));
    if (productImageProductIds.length) {
      await db
        .delete(productImages)
        .where(inArray(productImages.productId, productImageProductIds));
    }
    if (lineIds.length) await db.delete(lines).where(inArray(lines.id, lineIds));
    if (productIds.length) await db.delete(products).where(inArray(products.id, productIds));
    if (mediaAssetIds.length)
      await db.delete(mediaAssets).where(inArray(mediaAssets.id, mediaAssetIds));
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

  it("rejects a product image that joins a tenant's product to another tenant's asset", async () => {
    const [productA] = await db
      .insert(products)
      .values({ tenantId: orgA.id, gtin14: "04012345678906", name: "Image product A" })
      .returning();
    productIds.push(productA!.id);
    productImageProductIds.push(productA!.id);

    const [assetB] = await db
      .insert(mediaAssets)
      .values({
        ownerTenantId: orgB.id,
        objectKey: `products/${randomUUID()}.png`,
        contentType: "image/png",
        byteSize: 1,
        checksum: "a".repeat(64),
      })
      .returning();
    mediaAssetIds.push(assetB!.id);

    await expect(
      db.insert(productImages).values({
        tenantId: orgA.id,
        productId: productA!.id,
        assetId: assetB!.id,
      }),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } });
  });

  it("allows a product image backed by an asset from the same tenant", async () => {
    const [productA] = await db
      .insert(products)
      .values({ tenantId: orgA.id, gtin14: "04012345678907", name: "Image product A2" })
      .returning();
    productIds.push(productA!.id);
    productImageProductIds.push(productA!.id);

    const [assetA] = await db
      .insert(mediaAssets)
      .values({
        ownerTenantId: orgA.id,
        objectKey: `products/${randomUUID()}.png`,
        contentType: "image/png",
        byteSize: 1,
        checksum: "b".repeat(64),
      })
      .returning();
    mediaAssetIds.push(assetA!.id);

    const [image] = await db
      .insert(productImages)
      .values({ tenantId: orgA.id, productId: productA!.id, assetId: assetA!.id })
      .returning();

    expect(image).toMatchObject({
      tenantId: orgA.id,
      productId: productA!.id,
      assetId: assetA!.id,
    });
  });

  it("rejects a second asset binding for the same tenant product", async () => {
    const [productA] = await db
      .insert(products)
      .values({ tenantId: orgA.id, gtin14: "04012345678908", name: "Cardinality product" })
      .returning();
    productIds.push(productA!.id);
    productImageProductIds.push(productA!.id);

    const [firstAsset, secondAsset] = await db
      .insert(mediaAssets)
      .values([
        {
          ownerTenantId: orgA.id,
          objectKey: `products/${randomUUID()}.png`,
          contentType: "image/png",
          byteSize: 1,
          checksum: "c".repeat(64),
        },
        {
          ownerTenantId: orgA.id,
          objectKey: `products/${randomUUID()}.png`,
          contentType: "image/png",
          byteSize: 1,
          checksum: "d".repeat(64),
        },
      ])
      .returning();
    mediaAssetIds.push(firstAsset!.id, secondAsset!.id);

    await db.insert(productImages).values({
      tenantId: orgA.id,
      productId: productA!.id,
      assetId: firstAsset!.id,
    });

    await expect(
      db.insert(productImages).values({
        tenantId: orgA.id,
        productId: productA!.id,
        assetId: secondAsset!.id,
      }),
    ).rejects.toMatchObject({
      cause: { code: UNIQUE_VIOLATION, constraint: "product_images_tenant_id_product_id_pk" },
    });
  });

  it("rejects binding the same asset to a second product", async () => {
    const [firstProduct, secondProduct] = await db
      .insert(products)
      .values([
        { tenantId: orgA.id, gtin14: "04012345678909", name: "First asset product" },
        { tenantId: orgA.id, gtin14: "04012345678910", name: "Second asset product" },
      ])
      .returning();
    productIds.push(firstProduct!.id, secondProduct!.id);
    productImageProductIds.push(firstProduct!.id, secondProduct!.id);

    const [asset] = await db
      .insert(mediaAssets)
      .values({
        ownerTenantId: orgA.id,
        objectKey: `products/${randomUUID()}.png`,
        contentType: "image/png",
        byteSize: 1,
        checksum: "e".repeat(64),
      })
      .returning();
    mediaAssetIds.push(asset!.id);

    await db.insert(productImages).values({
      tenantId: orgA.id,
      productId: firstProduct!.id,
      assetId: asset!.id,
    });

    await expect(
      db.insert(productImages).values({
        tenantId: orgA.id,
        productId: secondProduct!.id,
        assetId: asset!.id,
      }),
    ).rejects.toMatchObject({
      cause: { code: UNIQUE_VIOLATION, constraint: "product_images_asset_id_uq" },
    });
  });

  it("allows a station without an API key to reference a line in its own tenant", async () => {
    const [line] = await db.insert(lines).values({ tenantId: orgA.id, name: "Line A" }).returning();
    lineIds.push(line!.id);

    const [station] = await db
      .insert(stationDevices)
      .values({ tenantId: orgA.id, name: "Station A", lineId: line!.id })
      .returning();
    stationDeviceIds.push(station!.id);

    expect(station).toMatchObject({
      tenantId: orgA.id,
      lineId: line!.id,
      apiKeyId: null,
    });
  });

  it("rejects a station line that belongs to another tenant", async () => {
    const [foreignLine] = await db
      .insert(lines)
      .values({ tenantId: orgA.id, name: "Foreign line" })
      .returning();
    lineIds.push(foreignLine!.id);

    await expect(
      db.insert(stationDevices).values({
        tenantId: orgB.id,
        name: "Station B",
        lineId: foreignLine!.id,
      }),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } });
  });

  it("rejects a station pairing code for a device of another tenant", async () => {
    const [foreignStation] = await db
      .insert(stationDevices)
      .values({ tenantId: orgB.id, name: "Station B" })
      .returning();
    stationDeviceIds.push(foreignStation!.id);

    await expect(
      db.insert(stationPairingCodes).values({
        tenantId: orgA.id,
        stationDeviceId: foreignStation!.id,
        codeHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
        issuedByUserId: "user-a",
      }),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } });
  });

  it("enforces one live station pairing code per device and code hash", async () => {
    const [stationA] = await db
      .insert(stationDevices)
      .values({ tenantId: orgA.id, name: "Station pairing A" })
      .returning();
    const [stationB] = await db
      .insert(stationDevices)
      .values({ tenantId: orgB.id, name: "Station pairing B" })
      .returning();
    stationDeviceIds.push(stationA!.id, stationB!.id);

    const expiresAt = new Date(Date.now() + 60_000);
    const codeHash = `hash-${randomUUID()}`;
    await db.insert(stationPairingCodes).values({
      tenantId: orgA.id,
      stationDeviceId: stationA!.id,
      codeHash,
      expiresAt,
      issuedByUserId: "user-a",
    });

    await expect(
      db.insert(stationPairingCodes).values({
        tenantId: orgA.id,
        stationDeviceId: stationA!.id,
        codeHash: `hash-${randomUUID()}`,
        expiresAt,
        issuedByUserId: "user-a",
      }),
    ).rejects.toMatchObject({
      cause: { code: UNIQUE_VIOLATION, constraint: "station_pairing_codes_one_live_uq" },
    });

    await expect(
      db.insert(stationPairingCodes).values({
        tenantId: orgB.id,
        stationDeviceId: stationB!.id,
        codeHash,
        expiresAt,
        issuedByUserId: "user-b",
      }),
    ).rejects.toMatchObject({
      cause: { code: UNIQUE_VIOLATION, constraint: "station_pairing_codes_code_hash_live_uq" },
    });
  });
});
