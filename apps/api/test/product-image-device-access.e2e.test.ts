import { Test } from "@nestjs/testing";
import { request as expressRequest, response as expressResponse, type Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { KioskController } from "../src/modules/kiosk/kiosk.controller";
import { BoxRegistryService } from "../src/modules/kiosk/box-registry.service";
import { OrgProfileService } from "../src/modules/org-profile/org-profile.service";
import { PickupOrdersService } from "../src/modules/pickup-orders/pickup-orders.service";
import { ProductsController } from "../src/modules/products/products.controller";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { StationProductImagesController } from "../src/modules/shifts/station-product-images.controller";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { KioskDeviceGuard, type RequestWithKiosk } from "../src/tenancy/kiosk-device.guard";

function imageResponse(): Response {
  const response = Object.create(expressResponse) as Response;
  vi.spyOn(response, "set").mockReturnValue(response);
  vi.spyOn(response, "status").mockReturnValue(response);
  vi.spyOn(response, "send").mockReturnValue(response);
  return response;
}

function kioskRequest(tenantId: string, kioskId: string): RequestWithKiosk {
  return Object.assign(Object.create(expressRequest), { tenantId, kioskId }) as RequestWithKiosk;
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
      getKioskImageRead: vi
        .fn<PickupOrdersService["getKioskImageRead"]>()
        .mockResolvedValue("tenants/t/products/p/a.webp"),
    } satisfies Pick<PickupOrdersService, "getKioskImageRead">;
    const storage = {
      get: vi
        .fn<ObjectStorageService["get"]>()
        .mockResolvedValue({ body: imageBytes, contentType: "image/webp" }),
    } satisfies Pick<ObjectStorageService, "get">;
    const moduleRef = await Test.createTestingModule({
      controllers: [KioskController],
      providers: [
        { provide: PickupOrdersService, useValue: pickupOrders },
        { provide: OrgProfileService, useValue: {} satisfies Partial<OrgProfileService> },
        { provide: BoxRegistryService, useValue: {} satisfies Partial<BoxRegistryService> },
        { provide: ObjectStorageService, useValue: storage },
      ],
    })
      .overrideGuard(KioskDeviceGuard)
      .useValue({ canActivate: async () => true } satisfies Partial<KioskDeviceGuard>)
      .overrideGuard(SubscriptionAccessGuard)
      .useValue({ canActivate: async () => true } satisfies Partial<SubscriptionAccessGuard>)
      .compile();
    const controller = moduleRef.get(KioskController);
    const response = imageResponse();

    await controller.readProductImage(
      kioskRequest("tenant-1", "kiosk-1"),
      "product-1",
      checksum,
      response,
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
