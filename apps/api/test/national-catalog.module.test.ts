import { NationalCatalogImportService } from "../src/modules/national-catalog/national-catalog-import.service";
import { NationalCatalogImportPreviewService } from "../src/modules/national-catalog/national-catalog-import-preview.service";
import { NationalCatalogImportApplyService } from "../src/modules/national-catalog/national-catalog-import-apply.service";
import { NationalCatalogImageService } from "../src/modules/national-catalog/national-catalog-image.service";
import { EntitlementAdmissionService } from "../src/subscriptions/entitlement-admission.service";
import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { PgBossService } from "../src/jobs/jobs.module";

import { AuthorizationService } from "../src/authorization/authorization.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { NationalCatalogLinkRefreshService } from "../src/modules/national-catalog/national-catalog-link-refresh.service";
import { NationalCatalogFreshnessService } from "../src/modules/national-catalog/national-catalog-freshness.service";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { DB } from "../src/auth/auth.module";
import type { Env } from "../src/env";
import {
  NationalCatalogRequestCoordinator,
  isCatalogBaseUrlConfigured,
} from "../src/modules/national-catalog/national-catalog-request-coordinator";
import { NationalCatalogModule } from "../src/modules/national-catalog/national-catalog.module";
import { NationalCatalogProductsService } from "../src/modules/national-catalog/national-catalog-products.service";
import { NationalCatalogProposalService } from "../src/modules/national-catalog/national-catalog-proposal.service";
import { NationalCatalogSchemaService } from "../src/modules/national-catalog/national-catalog-schema.service";
import { NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID } from "../src/modules/national-catalog/national-catalog.tokens";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard } from "../src/tenancy/tenant.guard";

describe("NationalCatalogModule wiring", () => {
  it("injects the source tenant only into schema refresh", () => {
    const module = NationalCatalogModule.forRoot({
      NATIONAL_CATALOG_BASE_URL: "https://catalog.example.test",
      NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID: "source-tenant",
      NATIONAL_CATALOG_REQUEST_TIMEOUT_MS: 15_000,
      CHZ_TOKEN_ENCRYPTION_KEY: "test-key",
    } as unknown as Env);
    const providers = module.providers ?? [];
    const freshness = providers.find(
      (provider) =>
        typeof provider === "object" && provider?.provide === NationalCatalogFreshnessService,
    );
    expect(freshness).toMatchObject({
      inject: expect.arrayContaining([NationalCatalogLinkRefreshService]),
    });
    const products = providers.find(
      (provider) =>
        typeof provider === "object" && provider?.provide === NationalCatalogProductsService,
    );
    const schemas = providers.find(
      (provider) =>
        typeof provider === "object" && provider?.provide === NationalCatalogSchemaService,
    );

    expect(products).toMatchObject({
      inject: expect.not.arrayContaining([NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID]),
    });
    expect(schemas).toMatchObject({
      inject: expect.arrayContaining([NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID]),
    });
  });

  it("passes the global admission facade into every concrete factory adapter", () => {
    const module = NationalCatalogModule.forRoot({
      NATIONAL_CATALOG_REQUEST_TIMEOUT_MS: 15_000,
    } as Env);
    const admission = { observe: () => {}, capture: () => {} };
    for (const owner of [
      NationalCatalogProductsService,
      NationalCatalogProposalService,
      NationalCatalogImportService,
      NationalCatalogImportPreviewService,
      NationalCatalogImportApplyService,
      NationalCatalogImageService,
      NationalCatalogLinkRefreshService,
    ]) {
      const provider = module.providers?.find(
        (entry) => typeof entry === "object" && "provide" in entry && entry.provide === owner,
      );
      if (!provider || typeof provider !== "object" || !("useFactory" in provider))
        throw new Error("factory missing");
      expect(provider.inject).toContain(EntitlementAdmissionService);
      const instance: unknown = provider.useFactory(
        ...(provider.inject ?? []).map((token) =>
          token === EntitlementAdmissionService ? admission : {},
        ),
      );
      expect(instance).toHaveProperty("admission", admission);
    }
  });

  it("compiles the import graph with explicit global authorization, entitlement, storage and queue dependencies", async () => {
    const ref = await Test.createTestingModule({
      imports: [
        {
          global: true,
          module: class TestDbModule {},
          providers: [
            DB,
            AuthorizationService,
            EntitlementsService,
            EntitlementAdmissionService,
            ObjectStorageService,
            PgBossService,
          ].map((provide) => ({ provide, useValue: {} })),
          exports: [
            DB,
            AuthorizationService,
            EntitlementsService,
            EntitlementAdmissionService,
            ObjectStorageService,
            PgBossService,
          ],
        },
        NationalCatalogModule.forRoot({
          NATIONAL_CATALOG_REQUEST_TIMEOUT_MS: 15_000,
          CHZ_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32),
        } as unknown as Env),
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthorizationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SubscriptionAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();

    expect(ref.get(NationalCatalogProposalService)).toBeInstanceOf(NationalCatalogProposalService);
    expect(ref.get(NationalCatalogRequestCoordinator)).toBeInstanceOf(
      NationalCatalogRequestCoordinator,
    );
    await ref.close();
  });
});

it("enables saved-link provider policy only for explicitly registered endpoints independent of import flags", () => {
  expect(isCatalogBaseUrlConfigured(undefined)).toBe(false);
  expect(isCatalogBaseUrlConfigured("https://arbitrary.example.test")).toBe(false);
  expect(isCatalogBaseUrlConfigured("https://апи.национальный-каталог.рф")).toBe(true);
  expect(isCatalogBaseUrlConfigured("https://api.nk.sandbox.crptech.ru")).toBe(true);
  expect(isCatalogBaseUrlConfigured("https://api.nk.sandbox.crptech.ru:443")).toBe(false);
  const module = NationalCatalogModule.forRoot({
    NATIONAL_CATALOG_BASE_URL: "https://api.nk.sandbox.crptech.ru",
    NATIONAL_CATALOG_OWN_IMPORT_ENABLED: false,
    NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: false,
    NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED: false,
    NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS: [],
  } as unknown as Env);
  const provider = module.providers?.find(
    (p) => typeof p === "object" && p?.provide === NationalCatalogLinkRefreshService,
  );
  expect(provider).toMatchObject({
    inject: expect.not.arrayContaining([NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID]),
  });
});
