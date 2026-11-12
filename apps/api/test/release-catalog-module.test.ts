import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";
import {
  ReleaseCatalogModule,
  recheckCatalogCaller,
} from "../src/modules/release-catalog/release-catalog.module";
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
const legacyStandaloneCaller = {
  product: "standalone",
  machine: true,
  expiresAt: Number.MAX_SAFE_INTEGER,
  principal: { fingerprint: "a".repeat(64), tokenHash: "b".repeat(64) },
  actor: { actorPlatformUserId: null, actorRole: null, requestId: null },
} as const;
const taggedCaller = { ...legacyStandaloneCaller, publisherMode: "pinned-tag" } as const;

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

  it("admits a tagged standalone machine and denies the same machine without the tag mode", async () => {
    const { db, pool } = createDb("postgres://fixture:fixture@127.0.0.1:1/unreachable");
    try {
      await expect(recheckCatalogCaller(db, taggedCaller)).resolves.toBeUndefined();
      await expect(recheckCatalogCaller(db, legacyStandaloneCaller)).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        recheckCatalogCaller(db, { ...taggedCaller, product: "station" }),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
    } finally {
      await pool.end();
    }
  });

  it("restricts tagged standalone publication to stable and forward operations", async () => {
    const { db, pool } = createDb("postgres://fixture:fixture@127.0.0.1:1/unreachable");
    const module = ReleaseCatalogModule.forRoot({
      ...env,
      RELEASE_CATALOG_WRITERS_ENABLED: "true",
      RELEASE_CATALOG_PUBLISHERS_JSON: JSON.stringify({
        repository: "owner/repo",
        repositoryId: "123",
        ownerId: "456",
        workflows: [
          {
            product: "handheld",
            environment: "handheld-release",
            workflowRef: "owner/repo/.github/workflows/handheld-release.yml@refs/heads/main",
            workflowSha: "c".repeat(40),
            subject: "repo:owner/repo:environment:handheld-release",
          },
        ],
      }),
    });
    try {
      const provider = module.providers?.find(
        (p) => typeof p === "object" && "provide" in p && p.provide === CatalogService,
      );
      const config = configureCatalog(env);
      if (!provider || typeof provider !== "object" || !("useFactory" in provider) || !config)
        throw new Error();
      const repository = new CatalogRepository(db, new PlatformAuditService());
      const stable = { product: "standalone", channel: "stable" } as const;
      const beta = { ...stable, channel: "beta" } as const;
      const channel = vi.spyOn(repository, "readChannel").mockResolvedValue({
        identity: stable,
        revision: "0",
        publicationId: null,
        readable: false,
      });
      const reserve = vi.spyOn(repository, "reserveIntent");
      const activeEpoch = vi.spyOn(repository, "activeEpoch");
      const service: CatalogService = provider.useFactory(
        db,
        repository,
        new VerifiedCache(config, new S3CatalogStore(config)),
      );
      await expect(service.getChannel(taggedCaller, stable)).resolves.toMatchObject({
        identity: stable,
      });
      await expect(service.getChannel(taggedCaller, beta)).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(channel).toHaveBeenCalledTimes(1);
      await expect(
        service.createIntent(taggedCaller, randomUUID(), {
          identity: { ...beta, version: "1.6.2" },
          sourceSha: "c".repeat(40),
          files: [
            {
              name: "markiro-standalone-1.6.2.update.jws",
              sizeBytes: 1,
              sha256: "b".repeat(64),
              contentType: "application/octet-stream",
            },
          ],
          evidence: { kind: "standalone", manifestName: "markiro-standalone-1.6.2.update.jws" },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(reserve).not.toHaveBeenCalled();
      await expect(
        service.changeChannel(taggedCaller, stable, {
          operationId: randomUUID(),
          expectedRevision: "1",
          targetPublicationId: randomUUID(),
          kind: "rollback",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(activeEpoch).not.toHaveBeenCalled();
    } finally {
      await pool.end();
    }
  });
});
