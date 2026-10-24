import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { describe, expect, it } from "vitest";
import { ReleaseCatalogModule } from "../src/modules/release-catalog/release-catalog.module";
import { CatalogRepository } from "../src/modules/release-catalog/catalog-repository";
import { CatalogService } from "../src/modules/release-catalog/catalog-service";
import { VerifiedCache } from "../src/modules/release-catalog/catalog-cache";
import { S3CatalogStore } from "../src/modules/release-catalog/catalog-store";
import { configureCatalog } from "../src/modules/release-catalog/catalog-config";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
const env = {
  SERVER_PROFILE: "platform-only",
  RELEASE_CATALOG_S3_ENDPOINT: "https://s3.twcstorage.ru",
  RELEASE_CATALOG_S3_REGION: "ru-1",
  RELEASE_CATALOG_S3_BUCKET: "markiro-releases",
  RELEASE_CATALOG_S3_ACCESS_KEY_ID: "fixture",
  RELEASE_CATALOG_S3_SECRET_ACCESS_KEY: "fixture",
  RELEASE_CATALOG_CACHE_DIR: "/tmp/cache-fixture-not-used",
  RELEASE_CATALOG_JOURNAL_DIR: "/tmp/journal-fixture-not-used",
  RELEASE_CATALOG_CACHE_BYTES: "1024",
  RELEASE_CATALOG_OBJECT_BYTES: "1024",
  RELEASE_CATALOG_DISK_RESERVE_BYTES: "1",
  RELEASE_CATALOG_DOWNLOADS: "1",
  RELEASE_CATALOG_TIMEOUT_MS: "1000",
};
describe("catalog bootstrap module", () => {
  it("requires an explicit writer fence with configured storage and pins before enablement", () => {
    expect(() => ReleaseCatalogModule.forRoot({})).not.toThrow();
    expect(ReleaseCatalogModule.forRoot({}).controllers?.map((c) => c.name)).not.toContain(
      "CatalogResolverController",
    );
    expect(
      ReleaseCatalogModule.forRoot({ SERVER_PROFILE: "platform-only" }).controllers?.map(
        (c) => c.name,
      ),
    ).toContain("CatalogResolverController");
    expect(() =>
      ReleaseCatalogModule.forRoot({
        ...env,
        SERVER_PROFILE: "legacy",
        RELEASE_CATALOG_WRITERS_ENABLED: "false",
      }),
    ).toThrow("Invalid release catalog configuration");
    expect(() => ReleaseCatalogModule.forRoot(env)).toThrow(
      "Invalid release catalog configuration",
    );
    expect(() =>
      ReleaseCatalogModule.forRoot({ ...env, RELEASE_CATALOG_WRITERS_ENABLED: "true" }),
    ).toThrow("Invalid release catalog configuration");
    expect(() =>
      ReleaseCatalogModule.forRoot({ ...env, RELEASE_CATALOG_WRITERS_ENABLED: "false" }),
    ).not.toThrow();
  });
  it("wired service refuses publication before DB or S3 while writers are fenced", async () => {
    const module = ReleaseCatalogModule.forRoot({
      ...env,
      RELEASE_CATALOG_WRITERS_ENABLED: "false",
    });
    const provider = module.providers?.find(
      (p) => typeof p === "object" && "provide" in p && p.provide === CatalogService,
    );
    if (
      !provider ||
      typeof provider !== "object" ||
      !("useFactory" in provider) ||
      !provider.useFactory
    )
      throw new Error();
    const { db, pool } = createDb("postgres://fixture:fixture@127.0.0.1:1/unreachable");
    try {
      const config = configureCatalog(env);
      if (!config) throw new Error();
      const service: CatalogService = provider.useFactory(
        db,
        new CatalogRepository(db, new PlatformAuditService()),
        new VerifiedCache(config, new S3CatalogStore(config)),
      );
      await expect(
        service.createIntent(
          {
            product: "handheld",
            machine: true,
            expiresAt: Date.now() + 60000,
            principal: { fingerprint: "a".repeat(64), tokenHash: "b".repeat(64) },
            actor: { actorPlatformUserId: null, actorRole: null, requestId: null },
          },
          randomUUID(),
          {
            identity: { product: "handheld", channel: "stable", version: "1.0.0" },
            sourceSha: "a".repeat(40),
            files: [
              {
                name: "manifest.json",
                sizeBytes: 1,
                sha256: "b".repeat(64),
                contentType: "application/json",
              },
            ],
            evidence: { kind: "handheld", manifestName: "manifest.json", versionCode: 1 },
          },
        ),
      ).rejects.toMatchObject({ code: "not_ready" });
    } finally {
      await pool.end();
    }
  });
});
