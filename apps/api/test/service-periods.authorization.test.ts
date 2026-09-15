import {
  PLATFORM_ACCESS_POLICY,
  hasPlatformCapabilities,
  platformCapabilitiesForRole,
} from "../src/platform-auth/platform-access-policy";
import type { PlatformCapability } from "../src/platform-auth/platform-access-policy";
import { AppModule } from "../src/app.module";
import { PlatformServicePeriodsController } from "../src/modules/service-periods/platform-service-periods.controller";
import { PlatformServicePeriodsModule } from "../src/modules/service-periods/platform-service-periods.module";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { describe, expect, it } from "vitest";

function required(method: keyof PlatformServicePeriodsController): readonly PlatformCapability[] {
  const handler = PlatformServicePeriodsController.prototype[method];
  const policy = Reflect.getMetadata(PLATFORM_ACCESS_POLICY, handler) as
    { mode: "capabilities"; capabilities: readonly PlatformCapability[] } | undefined;
  return policy?.capabilities ?? [];
}

describe("platform service-period authorization", () => {
  it("lets support write usage but keeps excess approval behind billing.write", () => {
    const support = platformCapabilitiesForRole("support");
    const accountant = platformCapabilitiesForRole("accountant");
    const admin = platformCapabilitiesForRole("platform_admin");

    expect(hasPlatformCapabilities(support, required("postUsage"))).toBe(true);
    expect(hasPlatformCapabilities(accountant, required("postUsage"))).toBe(false);
    expect(hasPlatformCapabilities(accountant, required("addApproval"))).toBe(true);
    expect(hasPlatformCapabilities(support, required("addApproval"))).toBe(false);
    expect(hasPlatformCapabilities(admin, required("postUsage"))).toBe(true);
    expect(hasPlatformCapabilities(admin, required("addApproval"))).toBe(true);
  });

  it("declares a capability policy on every platform route", () => {
    expect([
      required("list"),
      required("detail"),
      required("postUsage"),
      required("correctUsage"),
      required("addApproval"),
      required("withdrawApproval"),
    ]).toEqual([
      ["services.read"],
      ["services.read"],
      ["services.write"],
      ["services.write"],
      ["billing.write"],
      ["billing.write"],
    ]);
  });

  it("registers the controller module only when platform auth is configured", () => {
    const setup = {
      auth: {} as never,
      db: {} as never,
      pool: {} as never,
      databaseUrl: "postgres://test.invalid/markiro",
      env: PLATFORM_TEST_ENV as never,
    };
    const withoutPlatform = AppModule.forRoot(setup).imports ?? [];
    const withPlatform = AppModule.forRoot({ ...setup, platformAuth: {} as never }).imports ?? [];
    expect(withoutPlatform).not.toContain(PlatformServicePeriodsModule);
    expect(withPlatform).toContain(PlatformServicePeriodsModule);
  });
});
