import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductsService } from "../src/modules/products/products.service";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildProductRegistryStampSql,
  invalidateProductGtinRegistry,
  productGtinActuallyChanged,
  type ProductGtinVersion,
} from "../src/modules/products/product-registry-invalidation";

describe("product GTIN registry invalidation", () => {
  it("invalidates only an actual canonical GTIN change", () => {
    const before: ProductGtinVersion = {
      tenantId: "tenant-a",
      productId: "product-a",
      gtin14: "04600682000013",
    };
    expect(productGtinActuallyChanged(before, { ...before, gtin14: "04600682000020" })).toBe(true);
    expect(productGtinActuallyChanged(before, { ...before })).toBe(false);
  });

  it("never treats another tenant or product as the updated identity", () => {
    const before: ProductGtinVersion = {
      tenantId: "tenant-a",
      productId: "product-a",
      gtin14: "04600682000013",
    };
    expect(
      productGtinActuallyChanged(before, {
        ...before,
        tenantId: "tenant-b",
        gtin14: "04600682000020",
      }),
    ).toBe(false);
    expect(
      productGtinActuallyChanged(before, {
        ...before,
        productId: "product-b",
        gtin14: "04600682000020",
      }),
    ).toBe(false);
  });

  it("allocates a revision even when the product has no closed SSCC boxes", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const returning = vi.fn().mockResolvedValue([{ currentVersion: 9n }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    await invalidateProductGtinRegistry({ execute, insert } as never, "tenant-a", "product-a");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("allocates once and performs one set-based stamp without materializing box ids", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const returning = vi.fn().mockResolvedValue([{ currentVersion: 9n }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    await invalidateProductGtinRegistry({ execute, insert } as never, "tenant-a", "product-a");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("generates valid unqualified UPDATE SET targets with tenant/product scoping", () => {
    const query = new PgDialect().sqlToQuery(
      buildProductRegistryStampSql("tenant-a", "product-a", 9n),
    ).sql;
    expect(query).toMatch(/update "boxes"\s+set registry_version = \$1,\s+updated_at =/i);
    expect(query).not.toMatch(/set\s+"boxes"\./i);
    expect(query).not.toMatch(/,\s*"boxes"\."updated_at"\s*=/i);
    expect(query).toContain('from "shifts"');
    expect(query).toContain('"boxes"."tenant_id" = $2');
    expect(query).toContain('"shifts"."product_id" = $3');
  });
});

describe("ProductsService update registry boundary", () => {
  const tenantId = "tenant-a";
  const productId = "00000000-0000-4000-8000-000000000001";
  const baseRow = {
    id: productId,
    tenantId,
    gtin14: "04600682000013",
    name: "Before",
    chzProductGroupCode: null,
    boxCapacity: null,
    palletCapacity: null,
    status: "draft" as const,
    defaultCounterpartyId: null,
    defaultLabelTemplateId: null,
    unitPrice: null,
    egaisCode: null,
    externalRef: null,
    createdAt: new Date("2026-08-13T10:00:00.000Z"),
  };

  function serviceFor(returnedGtin: string) {
    const forUpdate = vi.fn().mockResolvedValue([baseRow]);
    const whereSelect = vi.fn(() => ({ for: forUpdate }));
    const from = vi.fn(() => ({ where: whereSelect }));
    const select = vi.fn(() => ({ from }));
    const returning = vi.fn().mockResolvedValue([{ ...baseRow, gtin14: returnedGtin }]);
    const whereUpdate = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where: whereUpdate }));
    const update = vi.fn(() => ({ set }));
    const events: string[] = [];
    const execute = vi.fn().mockImplementation(() => {
      events.push("execute");
      return Promise.resolve({ rows: [] });
    });
    const counterReturning = vi.fn().mockResolvedValue([{ currentVersion: 2n }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning: counterReturning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    forUpdate.mockImplementation(() => {
      events.push("product-for-update");
      return Promise.resolve([baseRow]);
    });
    const tx = { select, update, execute, insert };
    const transaction = vi.fn(async (callback: (executor: typeof tx) => unknown) => callback(tx));
    const limit = vi.fn().mockResolvedValue([
      {
        ...baseRow,
        gtin14: returnedGtin,
        imageChecksum: null,
        imageByteSize: null,
        imageWidth: null,
        imageHeight: null,
      },
    ]);
    const whereProduct = vi.fn(() => ({ limit }));
    const joinAsset = vi.fn(() => ({ where: whereProduct }));
    const joinImage = vi.fn(() => ({ leftJoin: joinAsset }));
    const fromProduct = vi.fn(() => ({ leftJoin: joinImage }));
    const selectProduct = vi.fn(() => ({ from: fromProduct }));
    return {
      service: new ProductsService(
        { transaction, select: selectProduct } as never,
        {} as never,
        {} as never,
        {} as never,
      ),
      execute,
      insert,
      forUpdate,
      events,
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("does not lock or invalidate for a name-only update", async () => {
    const fixture = serviceFor(baseRow.gtin14);
    await fixture.service.updateProduct(tenantId, productId, { name: "After" });
    expect(fixture.forUpdate).toHaveBeenCalledWith("update");
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(fixture.events).toEqual(["product-for-update"]);
  });

  it("locks before the product row but does not invalidate a canonical GTIN no-op", async () => {
    const fixture = serviceFor(baseRow.gtin14);
    await fixture.service.updateProduct(tenantId, productId, { gtin: "4600682000013" });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(fixture.events.slice(0, 2)).toEqual(["execute", "product-for-update"]);
  });

  it("invalidates affected boxes for a persisted GTIN change inside the transaction", async () => {
    const fixture = serviceFor("04600682000020");
    await fixture.service.updateProduct(tenantId, productId, { gtin: "4600682000020" });
    expect(fixture.forUpdate).toHaveBeenCalledWith("update");
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.insert).toHaveBeenCalledTimes(1);
    expect(fixture.events.slice(0, 2)).toEqual(["execute", "product-for-update"]);
  });
});
