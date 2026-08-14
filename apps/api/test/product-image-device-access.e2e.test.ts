import { describe, expect, it, vi } from "vitest";
import { KioskController } from "../src/modules/kiosk/kiosk.controller";
import { ProductsController } from "../src/modules/products/products.controller";
import { StationProductImagesController } from "../src/modules/shifts/station-product-images.controller";

function imageResponse() {
  const response = {
    set: vi.fn(),
    status: vi.fn(),
    send: vi.fn(),
  };
  response.set.mockReturnValue(response);
  response.status.mockReturnValue(response);
  return response;
}

const imageBytes = Buffer.from("normalized-webp");
const imageHeaders = (checksum: string) => ({
  "Cache-Control": "private, max-age=300, immutable",
  "Content-Length": String(imageBytes.byteLength),
  "Content-Type": "image/webp",
  ETag: `"${checksum}"`,
});

describe("device product-image delivery contracts", () => {
  it("kiosk serves private image bytes from the API origin", async () => {
    const checksum = "a".repeat(64);
    const pickupOrders = {
      getKioskImageRead: vi.fn().mockResolvedValue("tenants/t/products/p/a.webp"),
    };
    const storage = {
      get: vi.fn().mockResolvedValue({ body: imageBytes, contentType: "image/webp" }),
    };
    const controller = new KioskController(
      pickupOrders as never,
      {} as never,
      {} as never,
      storage as never,
    );
    const response = imageResponse();

    await controller.readProductImage(
      { tenantId: "tenant-1", kioskId: "kiosk-1" } as never,
      "product-1",
      checksum,
      response as never,
    );

    expect(pickupOrders.getKioskImageRead).toHaveBeenCalledWith(
      "tenant-1",
      "kiosk-1",
      "product-1",
      checksum,
    );
    expect(storage.get).toHaveBeenCalledWith("tenants/t/products/p/a.webp");
    expect(response.set).toHaveBeenCalledWith(imageHeaders(checksum));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith(imageBytes);
  });

  it("station serves private image bytes from the API origin", async () => {
    const checksum = "b".repeat(64);
    const products = {
      getCurrentImageRead: vi.fn().mockResolvedValue("tenants/t/products/p/a.webp"),
    };
    const storage = {
      get: vi.fn().mockResolvedValue({ body: imageBytes, contentType: "image/webp" }),
    };
    const controller = new StationProductImagesController(products as never, storage as never);
    const response = imageResponse();

    await controller.readProductImage(
      { tenantId: "tenant-1", deviceId: "station-1" } as never,
      "product-1",
      checksum,
      response as never,
    );

    expect(products.getCurrentImageRead).toHaveBeenCalledWith("tenant-1", "product-1", checksum);
    expect(storage.get).toHaveBeenCalledWith("tenants/t/products/p/a.webp");
    expect(response.set).toHaveBeenCalledWith(imageHeaders(checksum));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith(imageBytes);
  });

  it("cabinet serves private image bytes from the API origin", async () => {
    const checksum = "c".repeat(64);
    const products = {
      getCurrentImageRead: vi.fn().mockResolvedValue("tenants/t/products/p/a.webp"),
    };
    const storage = {
      get: vi.fn().mockResolvedValue({ body: imageBytes, contentType: "image/webp" }),
    };
    const controller = new ProductsController(products as never, storage as never);
    const response = imageResponse();

    await controller.readImage(
      { tenantId: "tenant-1" } as never,
      "product-1",
      checksum,
      response as never,
    );

    expect(products.getCurrentImageRead).toHaveBeenCalledWith("tenant-1", "product-1", checksum);
    expect(storage.get).toHaveBeenCalledWith("tenants/t/products/p/a.webp");
    expect(response.set).toHaveBeenCalledWith(imageHeaders(checksum));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith(imageBytes);
  });
});
