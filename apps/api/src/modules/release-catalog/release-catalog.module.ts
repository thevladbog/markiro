import { CatalogResolver } from "./catalog-resolver";
import { CatalogResolverController } from "./catalog-resolver.controller";
import { createHash } from "node:crypto";
import { Module, type DynamicModule } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { PlatformAuditModule } from "../../platform-auth/platform-audit.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { platformCapabilitiesForRole } from "../../platform-auth/platform-access-policy";
import { configureCatalog } from "./catalog-config";
import { CatalogPublisherController } from "./catalog-publisher.controller";
import { CatalogPublisherGuard, CATALOG_PUBLISHER_VERIFY } from "./catalog-publisher.guard";
import { publisherConfiguration, verifyPublisherToken } from "./catalog-oidc";
import { CatalogService, type CatalogCaller } from "./catalog-service";
import { CatalogRepository } from "./catalog-repository";
import { CatalogLedger } from "./catalog-ledger";
import { VerifiedCache } from "./catalog-cache";
import { S3CatalogStore } from "./catalog-store";
import { CatalogFault } from "./catalog-types";
export function platformCatalogFingerprint(userId: string) {
  return createHash("sha256").update(`release-catalog:platform:${userId}`).digest("hex");
}
export async function recheckCatalogCaller(db: Db, caller: CatalogCaller) {
  if (caller.machine) {
    if (
      !caller.principal.tokenHash ||
      (caller.product !== "station" && caller.product !== "handheld") ||
      caller.actor.actorPlatformUserId !== null ||
      caller.actor.actorRole !== null
    )
      throw new CatalogFault("forbidden");
    return;
  }
  const id = caller.actor.actorPlatformUserId;
  if (
    !id ||
    caller.product !== "standalone" ||
    caller.principal.tokenHash !== undefined ||
    caller.principal.fingerprint !== platformCatalogFingerprint(id)
  )
    throw new CatalogFault("forbidden");
  const [user] = await db
    .select({
      role: schema.platformUsers.role,
      status: schema.platformUsers.status,
      twoFactorEnabled: schema.platformUsers.twoFactorEnabled,
    })
    .from(schema.platformUsers)
    .where(eq(schema.platformUsers.id, id));
  if (
    !user ||
    user.status !== "active" ||
    !user.twoFactorEnabled ||
    user.role !== caller.actor.actorRole ||
    !platformCapabilitiesForRole(user.role).includes("standaloneReleases.manage")
  )
    throw new CatalogFault("forbidden");
  const [factor] = await db
    .select({ verified: schema.platformTwoFactors.verified })
    .from(schema.platformTwoFactors)
    .where(
      and(eq(schema.platformTwoFactors.userId, id), eq(schema.platformTwoFactors.verified, true)),
    );
  if (!factor?.verified) throw new CatalogFault("forbidden");
}
@Module({})
export class ReleaseCatalogModule {
  static forRoot(env: Readonly<Record<string, unknown>>): DynamicModule {
    const strings = Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value]] : [],
      ),
    );
    const config = configureCatalog(strings);
    const publisher = publisherConfiguration(strings.RELEASE_CATALOG_PUBLISHERS_JSON);
    if (config && env.SERVER_PROFILE !== "platform-only")
      throw new Error("Invalid release catalog configuration");
    const writers = strings.RELEASE_CATALOG_WRITERS_ENABLED;
    if (config && !["false", "true"].includes(writers ?? ""))
      throw new Error("Invalid release catalog configuration");
    if (writers === "true" && (!config || !publisher))
      throw new Error("Invalid release catalog configuration");
    if (publisher && !config) throw new Error("Invalid release catalog configuration");
    return {
      module: ReleaseCatalogModule,
      imports: [PlatformAuditModule],
      controllers: [
        CatalogPublisherController,
        ...(env.SERVER_PROFILE === "platform-only" ? [CatalogResolverController] : []),
      ],
      providers: [
        CatalogPublisherGuard,
        {
          provide: CatalogRepository,
          inject: [DB, PlatformAuditService],
          useFactory: (db: Db, audit: PlatformAuditService) => new CatalogRepository(db, audit),
        },
        {
          provide: VerifiedCache,
          useFactory: () => (config ? new VerifiedCache(config, new S3CatalogStore(config)) : null),
        },
        {
          provide: CatalogResolver,
          inject: [CatalogRepository, VerifiedCache],
          useFactory: (repository: CatalogRepository, cache: VerifiedCache | null) =>
            cache ? new CatalogResolver(repository, cache) : null,
        },
        {
          provide: CATALOG_PUBLISHER_VERIFY,
          useValue: (token: string) => {
            if (!publisher || !config) throw new CatalogFault("not_ready");
            return verifyPublisherToken(token, publisher);
          },
        },
        {
          provide: CatalogService,
          inject: [DB, CatalogRepository, VerifiedCache],
          useFactory: (db: Db, repository: CatalogRepository, cache: VerifiedCache | null) => {
            if (!config || !cache) return null;
            const store = new S3CatalogStore(config);
            return new CatalogService({
              repository,
              ledger: new CatalogLedger(
                {
                  journalDir: config.journalDir,
                  bucket: config.bucket,
                  timeoutMs: config.timeoutMs,
                  maxPages: 100,
                  maxRecords: 10000,
                  maxBytes: 67108864,
                },
                store,
              ),
              cache,
              bucket: config.bucket,
              authorize: (caller, action) => {
                if (action !== "read" && writers !== "true") throw new CatalogFault("not_ready");
                return recheckCatalogCaller(db, caller);
              },
            });
          },
        },
      ],
      exports: [CatalogService, CatalogRepository, CatalogResolver],
    };
  }
}
