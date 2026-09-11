import { EntitlementAdmissionService } from "../../subscriptions/entitlement-admission.service";
import { Global, Module, type DynamicModule } from "@nestjs/common";

import { DB } from "../../auth/auth.module";
import type { Env } from "../../env";
import { ChzTokenService } from "../chz-exports/chz-token.service";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import {
  NationalCatalogRequestCoordinator,
  isCatalogBaseUrlConfigured,
} from "./national-catalog-request-coordinator";
import { NationalCatalogClient } from "./national-catalog.client";
import { NationalCatalogController } from "./national-catalog.controller";
import {
  nationalCatalogProductsRepositoryProvider,
  NationalCatalogProductsService,
} from "./national-catalog-products.service";
import {
  NATIONAL_CATALOG_BASE_URL,
  NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID,
} from "./national-catalog.tokens";
import { NationalCatalogProposalService } from "./national-catalog-proposal.service";
import {
  nationalCatalogFreshnessRepositoryProvider,
  NationalCatalogFreshnessService,
} from "./national-catalog-freshness.service";
import {
  nationalCatalogSchemaRepositoryProvider,
  NationalCatalogSchemaService,
} from "./national-catalog-schema.service";

import { AuthorizationService } from "../../authorization/authorization.service";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { ProductsModule } from "../products/products.module";
import { ProductsService } from "../products/products.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { NationalCatalogImportRepository } from "./national-catalog-import.repository";
import { NationalCatalogImportService } from "./national-catalog-import.service";
import { NationalCatalogImportPreviewService } from "./national-catalog-import-preview.service";
import { NationalCatalogImportApplyService } from "./national-catalog-import-apply.service";
import { NationalCatalogImageService } from "./national-catalog-image.service";
import { NationalCatalogLinkRefreshService } from "./national-catalog-link-refresh.service";
import { NationalCatalogLinkService } from "./national-catalog-link.service";
import { NationalCatalogImportController } from "./national-catalog-import.controller";
import { NationalCatalogLinkController } from "./national-catalog-link.controller";
import { NationalCatalogCapabilitiesService } from "./national-catalog-capabilities.service";

import { NationalCatalogJobRepository } from "./national-catalog-job-repository";
import { NationalCatalogJobsService } from "./national-catalog-jobs.service";

@Global()
@Module({})
export class NationalCatalogModule {
  static forRoot(env: Env): DynamicModule {
    const photos = {
      enabled: env.NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED,
      verifiedHosts: env.NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS,
    };
    return {
      module: NationalCatalogModule,
      imports: [ProductsModule],
      controllers: [
        NationalCatalogController,
        NationalCatalogImportController,
        NationalCatalogLinkController,
      ],
      providers: [
        {
          provide: NationalCatalogJobRepository,
          inject: [DB],
          useFactory: (db: ConstructorParameters<typeof NationalCatalogJobRepository>[0]) =>
            new NationalCatalogJobRepository(db),
        },
        {
          provide: NationalCatalogJobsService,
          inject: [
            NationalCatalogJobRepository,
            NationalCatalogImportService,
            NationalCatalogImportPreviewService,
            NationalCatalogImportApplyService,
            NationalCatalogImageService,
            NationalCatalogLinkRefreshService,
          ],
          useFactory: (
            repository: NationalCatalogJobRepository,
            sessions: NationalCatalogImportService,
            previews: NationalCatalogImportPreviewService,
            applies: NationalCatalogImportApplyService,
            images: NationalCatalogImageService,
            refreshes: NationalCatalogLinkRefreshService,
          ) =>
            new NationalCatalogJobsService(
              repository,
              sessions,
              previews,
              applies,
              images,
              refreshes,
            ),
        },
        {
          provide: NationalCatalogImportRepository,
          inject: [DB],
          useFactory: (db: ConstructorParameters<typeof NationalCatalogImportRepository>[0]) =>
            new NationalCatalogImportRepository(db),
        },
        {
          provide: NationalCatalogImportService,
          inject: [
            NationalCatalogImportRepository,
            NationalCatalogClient,
            NationalCatalogRequestCoordinator,
            AuthorizationService,
            EntitlementsService,
            EntitlementAdmissionService,
          ],
          useFactory: (
            repository: NationalCatalogImportRepository,
            client: NationalCatalogClient,
            coordinator: NationalCatalogRequestCoordinator,
            authorization: AuthorizationService,
            entitlements: EntitlementsService,
            admission: EntitlementAdmissionService,
          ) =>
            new NationalCatalogImportService(
              repository,
              client,
              coordinator,
              authorization,
              entitlements,
              {
                ownCatalog: env.NATIONAL_CATALOG_OWN_IMPORT_ENABLED,
                gtinLookup: env.NATIONAL_CATALOG_GTIN_IMPORT_ENABLED,
              },
              admission,
            ),
        },
        {
          provide: NationalCatalogImportPreviewService,
          inject: [
            NationalCatalogImportRepository,
            NationalCatalogImportService,
            NationalCatalogClient,
            NationalCatalogRequestCoordinator,
            EntitlementAdmissionService,
          ],
          useFactory: (
            repository: NationalCatalogImportRepository,
            sessions: NationalCatalogImportService,
            client: NationalCatalogClient,
            coordinator: NationalCatalogRequestCoordinator,
            admission: EntitlementAdmissionService,
          ) =>
            new NationalCatalogImportPreviewService(
              repository,
              sessions,
              client,
              coordinator,
              photos,
              admission,
            ),
        },
        {
          provide: NationalCatalogImportApplyService,
          inject: [
            NationalCatalogImportRepository,
            NationalCatalogImportService,
            EntitlementAdmissionService,
          ],
          useFactory: (
            repository: NationalCatalogImportRepository,
            sessions: NationalCatalogImportService,
            admission: EntitlementAdmissionService,
          ) => new NationalCatalogImportApplyService(repository, sessions, admission),
        },
        {
          provide: NationalCatalogImageService,
          inject: [
            NationalCatalogImportRepository,
            NationalCatalogImportService,
            NationalCatalogRequestCoordinator,
            ObjectStorageService,
            ProductsService,
            EntitlementAdmissionService,
          ],
          useFactory: (
            repository: NationalCatalogImportRepository,
            sessions: NationalCatalogImportService,
            coordinator: NationalCatalogRequestCoordinator,
            storage: ObjectStorageService,
            products: ProductsService,
            admission: EntitlementAdmissionService,
          ) =>
            new NationalCatalogImageService(
              repository,
              sessions,
              coordinator,
              storage,
              products,
              photos,
              undefined,
              admission,
            ),
        },
        {
          provide: NationalCatalogLinkRefreshService,
          inject: [
            DB,
            AuthorizationService,
            EntitlementsService,
            NationalCatalogClient,
            NationalCatalogRequestCoordinator,
            EntitlementAdmissionService,
          ],
          useFactory: (
            db: ConstructorParameters<typeof NationalCatalogLinkRefreshService>[0],
            authorization: AuthorizationService,
            entitlements: EntitlementsService,
            client: NationalCatalogClient,
            coordinator: NationalCatalogRequestCoordinator,
            admission: EntitlementAdmissionService,
          ) =>
            new NationalCatalogLinkRefreshService(
              db,
              authorization,
              entitlements,
              client,
              coordinator,
              { enabled: isCatalogBaseUrlConfigured(env.NATIONAL_CATALOG_BASE_URL), photos },
              undefined,
              admission,
            ),
        },
        {
          provide: NationalCatalogLinkService,
          inject: [
            DB,
            AuthorizationService,
            EntitlementsService,
            NationalCatalogLinkRefreshService,
          ],
          useFactory: (
            db: ConstructorParameters<typeof NationalCatalogLinkService>[0],
            authorization: AuthorizationService,
            entitlements: EntitlementsService,
            refreshes: NationalCatalogLinkRefreshService,
          ) => new NationalCatalogLinkService(db, authorization, entitlements, refreshes),
        },
        {
          provide: NationalCatalogCapabilitiesService,
          inject: [DB, ChzTokenService],
          useFactory: (
            db: ConstructorParameters<typeof NationalCatalogCapabilitiesService>[0],
            tokens: ChzTokenService,
          ) => new NationalCatalogCapabilitiesService(db, tokens, env),
        },
        {
          provide: NationalCatalogClient,
          useFactory: () =>
            new NationalCatalogClient(undefined, env.NATIONAL_CATALOG_REQUEST_TIMEOUT_MS),
        },
        {
          provide: ChzCryptoService,
          useFactory: () => new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
        },
        ChzTokenService,
        {
          provide: NationalCatalogRequestCoordinator,
          inject: [DB, ChzTokenService, NATIONAL_CATALOG_BASE_URL],
          useFactory: (
            db: ConstructorParameters<typeof NationalCatalogRequestCoordinator>[0],
            tokens: ChzTokenService,
            baseUrl: string | undefined,
          ) => new NationalCatalogRequestCoordinator(db, tokens, baseUrl),
        },
        {
          provide: NationalCatalogProposalService,
          inject: [DB, EntitlementAdmissionService],
          useFactory: (
            db: ConstructorParameters<typeof NationalCatalogProposalService>[0],
            admission: EntitlementAdmissionService,
          ) => new NationalCatalogProposalService(db, undefined, admission),
        },
        nationalCatalogProductsRepositoryProvider,
        nationalCatalogSchemaRepositoryProvider,
        nationalCatalogFreshnessRepositoryProvider,
        {
          provide: NATIONAL_CATALOG_BASE_URL,
          useValue: env.NATIONAL_CATALOG_BASE_URL,
        },
        {
          provide: NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID,
          useValue: env.NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID,
        },
        {
          provide: NationalCatalogProductsService,
          inject: [
            nationalCatalogProductsRepositoryProvider.provide,
            NationalCatalogClient,
            ChzTokenService,
            NATIONAL_CATALOG_BASE_URL,
            EntitlementAdmissionService,
          ],
          useFactory: (
            repository: ConstructorParameters<typeof NationalCatalogProductsService>[0],
            client: NationalCatalogClient,
            tokens: ChzTokenService,
            baseUrl: string | undefined,
            admission: EntitlementAdmissionService,
          ) =>
            new NationalCatalogProductsService(
              repository,
              client,
              tokens,
              baseUrl,
              undefined,
              admission,
            ),
        },
        {
          provide: NationalCatalogSchemaService,
          inject: [
            nationalCatalogSchemaRepositoryProvider.provide,
            NationalCatalogClient,
            ChzTokenService,
            NATIONAL_CATALOG_BASE_URL,
            NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID,
          ],
          useFactory: (
            repository: ConstructorParameters<typeof NationalCatalogSchemaService>[0],
            client: NationalCatalogClient,
            tokens: ChzTokenService,
            baseUrl: string | undefined,
            sourceTenantId: string | undefined,
          ) =>
            new NationalCatalogSchemaService(repository, client, tokens, baseUrl, sourceTenantId),
        },
        {
          provide: NationalCatalogFreshnessService,
          inject: [
            nationalCatalogFreshnessRepositoryProvider.provide,
            NationalCatalogLinkRefreshService,
          ],
          useFactory: (
            repository: ConstructorParameters<typeof NationalCatalogFreshnessService>[0],
            refreshes: NationalCatalogLinkRefreshService,
          ) => new NationalCatalogFreshnessService(repository, refreshes),
        },
      ],
      exports: [
        NationalCatalogJobsService,
        NationalCatalogJobRepository,
        NationalCatalogImportService,
        NationalCatalogImportPreviewService,
        NationalCatalogImportApplyService,
        NationalCatalogImageService,
        NationalCatalogLinkRefreshService,
        NationalCatalogLinkService,
        NationalCatalogCapabilitiesService,
        NationalCatalogRequestCoordinator,
        NationalCatalogClient,
        NationalCatalogProductsService,
        NationalCatalogSchemaService,
        NationalCatalogFreshnessService,
        NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID,
      ],
    };
  }
}
