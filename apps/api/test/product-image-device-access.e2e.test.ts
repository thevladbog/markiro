import { describe, expect, it, vi } from "vitest";
import { KioskController } from "../src/modules/kiosk/kiosk.controller";
import { StationProductImagesController } from "../src/modules/shifts/station-product-images.controller";

describe("device product-image delivery contracts", () => {
  it("kiosk delegates image reads with tenant, kiosk, product, and checksum", async () => {
    const pickupOrders = {
      getKioskImageRead: vi.fn().mockResolvedValue("tenants/t/products/p/a.webp"),
    };
    const storage = { presignRead: vi.fn().mockResolvedValue("https://private/image") };
    const controller = new KioskController(pickupOrders as never, storage as never);
    const response = { redirect: vi.fn() };

    await controller.readProductImage(
      { tenantId: "tenant-1", kioskId: "kiosk-1" } as never,
      "product-1",
      "a".repeat(64),
      response as never,
    );

    expect(pickupOrders.getKioskImageRead).toHaveBeenCalledWith(
      "tenant-1",
      "kiosk-1",
      "product-1",
      "a".repeat(64),
    );
    expect(storage.presignRead).toHaveBeenCalledWith("tenants/t/products/p/a.webp", 300);
    expect(response.redirect).toHaveBeenCalledWith(302, "https://private/image");
  });

  it("station delegates image reads using the authenticated tenant", async () => {
    const products = {
      getCurrentImageRead: vi.fn().mockResolvedValue("tenants/t/products/p/a.webp"),
    };
    const storage = { presignRead: vi.fn().mockResolvedValue("https://private/image") };
    const controller = new StationProductImagesController(products as never, storage as never);
    const response = { redirect: vi.fn() };

    await controller.readProductImage(
      { tenantId: "tenant-1", deviceId: "station-1" } as never,
      "product-1",
      "b".repeat(64),
      response as never,
    );

    expect(products.getCurrentImageRead).toHaveBeenCalledWith(
      "tenant-1",
      "product-1",
      "b".repeat(64),
    );
    expect(response.redirect).toHaveBeenCalledWith(302, "https://private/image");
  });
});
