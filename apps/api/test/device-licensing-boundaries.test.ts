import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import {
  cancelDeviceReservationSchema,
  deviceReservationReceiptSchema,
  platformCapabilitiesForRole,
  workingDevicePoolSchema,
  type PlatformPrincipal,
} from "@markiro/platform-contracts";
import { describe, expect, it, vi } from "vitest";

import { ROUTE_ACCESS_POLICY } from "../src/authorization/access-policy";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { DeviceLicensingController } from "../src/modules/device-licensing/device-licensing.controller";
import { PlatformDeviceLicensingController } from "../src/modules/device-licensing/platform-device-licensing.controller";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import {
  ROUTE_SUBSCRIPTION_ACCESS_POLICY,
  type SubscriptionAccessPolicy,
} from "../src/subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard } from "../src/tenancy/tenant.guard";

const tenantId = "tenant-public-id";
const userId = "cabinet-user";
const deviceId = "22222222-2222-4222-8222-222222222222";
const assignmentId = "33333333-3333-4333-8333-333333333333";
const input = {
  requestId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 1,
};
const pool = {
  tenantId,
  usage: 1,
  limit: null,
  canCancelReservations: true,
  integrity: "ready",
  devices: [],
} as const;
const receipt = {
  requestId: input.requestId,
  deviceId,
  assignmentId,
  revision: 2,
  state: "released",
  releaseReason: "reservation_cancelled",
  releasedAt: "2026-09-12T09:30:00.000Z",
} as const;

const reflector = new Reflector();

describe("device licensing HTTP boundaries", () => {
  it("derives the cabinet actor and delegates only validated contract values", async () => {
    const service = {
      inspect: vi.fn().mockResolvedValue(pool),
      cancel: vi.fn().mockResolvedValue(receipt),
    };
    const controller = new DeviceLicensingController(service as never);
    const request = { tenantId, userId } as never;

    await expect(controller.inspect(request)).resolves.toEqual(pool);
    await expect(controller.cancelReservation(request, deviceId, input)).resolves.toEqual(receipt);
    expect(service.inspect).toHaveBeenCalledWith(tenantId, { domain: "cabinet", id: userId });
    expect(service.cancel).toHaveBeenCalledWith(tenantId, deviceId, input, {
      domain: "cabinet",
      id: userId,
    });
    expect(workingDevicePoolSchema.parse(pool)).toEqual(pool);
    expect(cancelDeviceReservationSchema.parse(input)).toEqual(input);
    expect(deviceReservationReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("declares cabinet guards, capability and read/licensing subscription policies", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, DeviceLicensingController) ?? [];
    expect(guards).toEqual([TenantGuard, AuthorizationGuard, SubscriptionAccessGuard]);
    expect(
      reflector.getAllAndOverride(ROUTE_ACCESS_POLICY, [
        DeviceLicensingController.prototype.inspect,
        DeviceLicensingController,
      ]),
    ).toEqual({ mode: "cabinet", capabilities: ["credentials.manage"] });
    expect(
      reflector.getAllAndOverride<SubscriptionAccessPolicy>(ROUTE_SUBSCRIPTION_ACCESS_POLICY, [
        DeviceLicensingController.prototype.inspect,
        DeviceLicensingController,
      ]),
    ).toEqual({ mode: "licensing", operation: "inspect" });
    expect(
      reflector.getAllAndOverride<SubscriptionAccessPolicy>(ROUTE_SUBSCRIPTION_ACCESS_POLICY, [
        DeviceLicensingController.prototype.cancelReservation,
        DeviceLicensingController,
      ]),
    ).toEqual({ mode: "licensing", operation: "cancel_reservation" });
    expect(Reflect.getMetadata(PATH_METADATA, DeviceLicensingController)).toBe("device-licensing");
  });

  it("derives the platform actor and declares exact read/write capabilities", async () => {
    const principal: PlatformPrincipal = {
      userId: "platform-user",
      role: "platform_admin",
      capabilities: platformCapabilitiesForRole.platform_admin,
      twoFactorReady: true,
    };
    const service = {
      inspect: vi.fn().mockResolvedValue(pool),
      cancel: vi.fn().mockResolvedValue(receipt),
    };
    const controller = new PlatformDeviceLicensingController(service as never);
    const request = { platformPrincipal: principal } as never;

    await expect(controller.inspect(request, tenantId)).resolves.toEqual(pool);
    await expect(controller.cancelReservation(request, tenantId, deviceId, input)).resolves.toEqual(
      receipt,
    );
    expect(service.inspect).toHaveBeenCalledWith(tenantId, {
      domain: "platform",
      principal,
    });
    expect(service.cancel).toHaveBeenCalledWith(tenantId, deviceId, input, {
      domain: "platform",
      principal,
    });
    expect(
      Reflect.getMetadata(
        PLATFORM_ACCESS_POLICY,
        PlatformDeviceLicensingController.prototype.inspect,
      ),
    ).toEqual({ mode: "capabilities", capabilities: ["tenants.read"] });
    expect(
      Reflect.getMetadata(
        PLATFORM_ACCESS_POLICY,
        PlatformDeviceLicensingController.prototype.cancelReservation,
      ),
    ).toEqual({
      mode: "capabilities",
      capabilities: ["tenants.write", "billing.write"],
    });
  });
});
