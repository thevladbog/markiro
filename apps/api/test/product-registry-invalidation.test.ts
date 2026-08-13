import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductsService } from "../src/modules/products/products.service";
import {
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

  it("does not allocate a revision when the product has no closed SSCC boxes", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ exists: false }] });
    const insert = vi.fn();
    await invalidateProductGtinRegistry({ execute, insert } as never, "tenant-a", "product-a");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it("allocates once and performs one set-based stamp without materializing box ids", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const returning = vi.fn().mockResolvedValue([{ currentVersion: 9n }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    await invalidateProductGtinRegistry({ execute, insert } as never, "tenant-a", "product-a");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
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
    productGroup: null,
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
    const execute = vi.fn().mockResolvedValue({ rows: [{ exists: true }] });
    const counterReturning = vi.fn().mockResolvedValue([{ currentVersion: 2n }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning: counterReturning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const tx = { select, update, execute, insert };
    const transaction = vi.fn(async (callback: (executor: typeof tx) => unknown) => callback(tx));
    return {
      service: new ProductsService({ transaction } as never, {} as never),
      execute,
      insert,
      forUpdate,
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["name-only", { name: "After" }],
    ["canonical GTIN no-op", { gtin: "4600682000013" }],
  ])("does not invalidate for %s update", async (_label, patch) => {
    const fixture = serviceFor(baseRow.gtin14);
    await fixture.service.updateProduct(tenantId, productId, patch);
    expect(fixture.forUpdate).toHaveBeenCalledWith("update");
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
  });

  it("invalidates affected boxes for a persisted GTIN change inside the transaction", async () => {
    const fixture = serviceFor("04600682000020");
    await fixture.service.updateProduct(tenantId, productId, { gtin: "4600682000020" });
    expect(fixture.forUpdate).toHaveBeenCalledWith("update");
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.insert).toHaveBeenCalledTimes(1);
  });
});
