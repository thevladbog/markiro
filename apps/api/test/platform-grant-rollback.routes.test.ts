import { describe, expect, it } from "vitest";
import { PlatformGrantRollbackController } from "../src/modules/device-grants/platform-grant-rollback.controller";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";

describe("offline grant rollback platform route policy", () => {
  it("protects candidate and preparation reads separately from mutations", () => {
    for (const method of ["candidates", "list", "detail"] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformGrantRollbackController.prototype[method],
        ),
      ).toEqual({ mode: "capabilities", capabilities: ["tenants.read", "catalog.read"] });
    }
    for (const method of ["prepare", "confirm", "cancel"] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformGrantRollbackController.prototype[method],
        ),
      ).toEqual({
        mode: "capabilities",
        capabilities: ["tenants.read", "catalog.read", "catalog.write", "offlineGrants.activate"],
      });
    }
  });
});
