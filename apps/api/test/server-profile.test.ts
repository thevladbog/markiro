import { PLATFORM_ONLY_ROUTE_KEYS } from "./platform-route-contracts";
import { PlatformCatalogService } from "../src/modules/platform-catalog/platform-catalog.service";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { createDb } from "@markiro/db";
import { setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { PgBossService } from "../src/jobs/jobs.module";
import { TenantProvisioningService } from "../src/modules/platform-tenants/tenant-provisioning.service";
import { PlatformTenantsService } from "../src/modules/platform-tenants/platform-tenants.service";
import { SupportChatProposalsService } from "../src/modules/support-chat/support-chat-proposals.service";
import { platformCapabilitiesForRole } from "../src/platform-auth/platform-access-policy";

const base = { ...PLATFORM_TEST_ENV, DATABASE_URL: "postgres://unused:unused@localhost/test" };
describe("server profile environment", () => {
  it("boots platform-only without disabled cabinet and pairing secrets", () => {
    const env = loadEnv({ ...base, SERVER_PROFILE: "platform-only" });
    expect(env.SERVER_PROFILE).toBe("platform-only");
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.PAIRING_CODE_PEPPER).toBeUndefined();
  });
  it("rejects unknown and blank profiles", () => {
    for (const SERVER_PROFILE of ["", "platform", "Platform-only"])
      expect(() => loadEnv({ ...base, SERVER_PROFILE })).toThrow();
  });
  it("defaults to legacy and still requires its secrets", () => {
    expect(() => loadEnv(base)).toThrow();
    expect(
      loadEnv({
        ...base,
        BETTER_AUTH_SECRET: "legacy-test-secret",
        BETTER_AUTH_URL: "http://localhost:3000",
        PAIRING_CODE_PEPPER: "legacy-test-pepper",
      }).SERVER_PROFILE,
    ).toBe("legacy");
  });
});

it("constructs the real platform module without cabinet auth and rejects disabled writes before database use", async () => {
  const env = loadEnv({ ...base, SERVER_PROFILE: "platform-only" });
  const connection = createDb(env.DATABASE_URL);
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        ...connection,
        ...setupPlatformAuth(env, connection.db),
        databaseUrl: env.DATABASE_URL,
        env,
      }),
    ],
  })
    .overrideProvider(PgBossService)
    .useValue({ checkReady: async () => undefined })
    .compile();
  const app = module.createNestApplication();
  try {
    await app.init();
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const paths = Object.keys(document.paths);
    const platformKeys = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/platform/"))
      .flatMap(([path, item]) =>
        (["get", "post", "patch", "put", "delete"] as const)
          .filter((method) => item?.[method])
          .map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    expect(platformKeys).toEqual(PLATFORM_ONLY_ROUTE_KEYS);
    expect(paths).toContain("/platform/tenants");
    expect(paths.some((p) => p.includes("standalone"))).toBe(true);
    expect(
      paths.filter(
        (p) =>
          !p.startsWith("/platform/") &&
          !p.startsWith("/health") &&
          p !== "/demo-requests" &&
          p !== "/landing-leads",
      ),
    ).toEqual([
      "/release-publisher/intents",
      "/release-publisher/intents/{id}",
      "/release-publisher/intents/{id}/commit",
      "/release-publisher/publications/{product}/{channel}/{version}",
      "/release-publisher/channels/{product}/{channel}",
    ]);
    for (const [path, method] of [
      ["/release-publisher/intents", "post"],
      ["/release-publisher/intents/{id}", "get"],
      ["/release-publisher/intents/{id}/commit", "post"],
      ["/release-publisher/publications/{product}/{channel}/{version}", "get"],
      ["/release-publisher/channels/{product}/{channel}", "get"],
      ["/release-publisher/channels/{product}/{channel}", "put"],
    ] as const)
      expect(document.paths[path]?.[method]?.security).toEqual([{ releasePublisherOidc: [] }]);
    const actor = {
      userId: "platform-user",
      email: "platform@example.test",
      name: "Platform",
      role: "platform_admin" as const,
      twoFactorReady: true,
      capabilities: platformCapabilitiesForRole("platform_admin"),
    };
    await expect(
      module.get(TenantProvisioningService).provision({
        tenantName: "Tenant",
        tenantSlug: "test-tenant",
        email: "owner@example.test",
        cabinetAccess: "enabled",
      }),
    ).rejects.toMatchObject({ response: { code: "server_profile_disabled" }, status: 410 });
    await expect(
      module.get(PlatformCatalogService).createOfflineGrantPolicy(actor, {
        policyKey: "disabled-cloud-policy",
        version: 1,
        offlineGrant: { version: 1, maxOfflineMs: 60000, maxCompletionMs: 60000, taskBounds: {} },
      }),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      module
        .get(PlatformCatalogService)
        .approveOfflineGrantPolicy(actor, "policy-id", { decisionReference: "disabled" }),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      module.get(PlatformTenantsService).renewActivation(actor, "tenant-id"),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      module
        .get(TenantProvisioningService)
        .grantCabinetAccess("tenant-id", { email: "owner@example.test" }, { actor }),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      module.get(SupportChatProposalsService).propose(actor, "episode-id", {
        title: "Title",
        summary: "Summary",
        idempotencyKey: "test-key",
      }),
    ).rejects.toMatchObject({ status: 410 });
  } finally {
    await app.close();
  }
});
