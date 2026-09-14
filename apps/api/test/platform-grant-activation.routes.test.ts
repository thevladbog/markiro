import { describe, expect, it } from "vitest";
import { PlatformGrantActivationController } from "../src/modules/device-grants/platform-grant-activation.controller";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";

describe("offline grant activation platform route policy", () => {
  it("keeps reads separate from activation mutations", () => {
    for (const method of ["list", "detail"] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformGrantActivationController.prototype[method],
        ),
      ).toEqual({ mode: "capabilities", capabilities: ["tenants.read", "catalog.read"] });
    }
    for (const method of ["prepare", "confirm", "cancel"] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformGrantActivationController.prototype[method],
        ),
      ).toEqual({
        mode: "capabilities",
        capabilities: ["tenants.read", "catalog.read", "catalog.write", "offlineGrants.activate"],
      });
    }
  });
});
