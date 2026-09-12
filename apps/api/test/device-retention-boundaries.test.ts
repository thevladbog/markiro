import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { deviceRetentionPreviewRequestSchema } from "@markiro/platform-contracts";
import { DeviceRetentionController } from "../src/modules/device-licensing/device-retention.controller";
import { PlatformDeviceRetentionController } from "../src/modules/device-licensing/platform-device-retention.controller";
import { ROUTE_ACCESS_POLICY } from "../src/authorization/access-policy";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import { TenantGuard } from "../src/tenancy/tenant.guard";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { ROUTE_SUBSCRIPTION_ACCESS_POLICY } from "../src/subscriptions/subscription-access-policy";

const reflector = new Reflector();
describe("retention HTTP trust boundaries", () => {
  it.each(["inspect", "preview", "confirm"] as const)(
    "declares exact cabinet and platform authority for %s",
    (method) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, DeviceRetentionController)).toEqual([
        TenantGuard,
        AuthorizationGuard,
        SubscriptionAccessGuard,
      ]);
      expect(
        reflector.getAllAndOverride(ROUTE_ACCESS_POLICY, [
          DeviceRetentionController.prototype[method],
          DeviceRetentionController,
        ]),
      ).toEqual({
        mode: "cabinet",
        capabilities:
          method === "inspect" ? ["credentials.manage"] : ["credentials.manage", "billing.request"],
      });
      expect(
        reflector.getAllAndOverride(ROUTE_SUBSCRIPTION_ACCESS_POLICY, [
          DeviceRetentionController.prototype[method],
          DeviceRetentionController,
        ]),
      ).toEqual({
        mode: "licensing",
        operation: method === "inspect" ? "inspect" : `retention_${method}`,
      });
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformDeviceRetentionController.prototype[method],
        ),
      ).toEqual({
        mode: "capabilities",
        capabilities: method === "inspect" ? ["tenants.read"] : ["tenants.write", "billing.write"],
      });
    },
  );
  it("refuses a platform controller call with only cabinet or device identity", async () => {
    const service = { inspect: vi.fn() };
    const controller = new PlatformDeviceRetentionController(service as never);
    await expect(
      controller.inspect(
        { tenantId: "tenant", userId: "cabinet-user", stationDeviceId: "device" } as never,
        "tenant",
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(service.inspect).not.toHaveBeenCalled();
  });
  it.each(["force", "ignorePending", "generation", "execute", "actorId", "tenantId"])(
    "rejects forbidden client-controlled %s",
    (key) => {
      expect(
        deviceRetentionPreviewRequestSchema.safeParse({
          requestId: "11111111-1111-4111-8111-111111111111",
          boundaryKey: "a".repeat(64),
          selectedDeviceIds: [],
          expectedRevision: 0,
          reason: "Reason",
          [key]: true,
        }).success,
      ).toBe(false);
    },
  );
});
