import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { deviceReplacementPreviewRequestSchema } from "@markiro/platform-contracts";
import { DeviceReplacementController } from "../src/modules/device-licensing/device-replacement.controller";
import { PlatformDeviceReplacementController } from "../src/modules/device-licensing/platform-device-replacement.controller";
import { ROUTE_ACCESS_POLICY } from "../src/authorization/access-policy";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import { TenantGuard } from "../src/tenancy/tenant.guard";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { ROUTE_SUBSCRIPTION_ACCESS_POLICY } from "../src/subscriptions/subscription-access-policy";

const reflector = new Reflector();
describe("replacement HTTP trust boundaries", () => {
  it.each(["list", "preview", "confirm", "cancel"] as const)(
    "declares exact cabinet and platform authority for %s",
    (method) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, DeviceReplacementController)).toEqual([
        TenantGuard,
        AuthorizationGuard,
        SubscriptionAccessGuard,
      ]);
      expect(
        reflector.getAllAndOverride(ROUTE_ACCESS_POLICY, [
          DeviceReplacementController.prototype[method],
          DeviceReplacementController,
        ]),
      ).toEqual({ mode: "cabinet", capabilities: ["credentials.manage"] });
      expect(
        reflector.getAllAndOverride(ROUTE_SUBSCRIPTION_ACCESS_POLICY, [
          DeviceReplacementController.prototype[method],
          DeviceReplacementController,
        ]),
      ).toEqual({
        mode: "licensing",
        operation: method === "list" ? "inspect" : `replacement_${method}`,
      });
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformDeviceReplacementController.prototype[method],
        ),
      ).toEqual({
        mode: "capabilities",
        capabilities: method === "list" ? ["tenants.read"] : ["tenants.write", "billing.write"],
      });
    },
  );
  it("derives cabinet actor exclusively from trusted request context", async () => {
    const service = { list: vi.fn().mockResolvedValue({ canPrepare: true, items: [] }) };
    const controller = new DeviceReplacementController(service as never);
    await controller.list({ tenantId: "tenant", userId: "cabinet-user" } as never);
    expect(service.list).toHaveBeenCalledWith("tenant", { domain: "cabinet", id: "cabinet-user" });
  });
  it("refuses a platform controller call with only cabinet or device identity", async () => {
    const service = { list: vi.fn() };
    const controller = new PlatformDeviceReplacementController(service as never);
    await expect(
      controller.list(
        { tenantId: "tenant", userId: "cabinet-user", stationDeviceId: "device" } as never,
        "tenant",
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(service.list).not.toHaveBeenCalled();
  });
  it.each(["force", "ignorePending", "generation", "execute", "actorId", "tenantId"])(
    "rejects forbidden client-controlled %s",
    (key) => {
      expect(
        deviceReplacementPreviewRequestSchema.safeParse({
          requestId: "11111111-1111-4111-8111-111111111111",
          target: { name: "Replacement", kind: "station" },
          reason: "Reason",
          [key]: true,
        }).success,
      ).toBe(false);
    },
  );
});
