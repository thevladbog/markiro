import { describe, expect, it } from "vitest";
import { PlatformStandaloneDiagnosticsController } from "../src/modules/standalone-diagnostics/platform-standalone-diagnostics.controller";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import { platformCapabilitiesForRole } from "../src/platform-auth/platform-access-policy";

const policy = (method: keyof PlatformStandaloneDiagnosticsController) =>
  Reflect.getMetadata(
    PLATFORM_ACCESS_POLICY,
    PlatformStandaloneDiagnosticsController.prototype[method],
  );

describe("standalone diagnostics route policy (plan ДИАГ А3)", () => {
  it("writes need tenant read plus the licensing capability", () => {
    expect(policy("ingest")).toEqual({
      mode: "capabilities",
      capabilities: ["tenants.read", "standaloneLicenses.manage"],
    });
  });

  it("every read needs only tenant read", () => {
    for (const method of ["history", "overview", "statistics", "detail"] as const) {
      expect(policy(method), method).toEqual({
        mode: "capabilities",
        capabilities: ["tenants.read"],
      });
    }
  });

  it("no platform role gets the licensing capability except the administrator", () => {
    expect(platformCapabilitiesForRole("platform_admin")).toContain("standaloneLicenses.manage");
    expect(platformCapabilitiesForRole("support")).not.toContain("standaloneLicenses.manage");
    expect(platformCapabilitiesForRole("support")).toContain("tenants.read");
  });
});
