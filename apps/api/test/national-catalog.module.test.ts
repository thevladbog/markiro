import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { NationalCatalogModule } from "../src/modules/national-catalog/national-catalog.module";
import { NationalCatalogProductsService } from "../src/modules/national-catalog/national-catalog-products.service";
import { NationalCatalogSchemaService } from "../src/modules/national-catalog/national-catalog-schema.service";
import { NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID } from "../src/modules/national-catalog/national-catalog.tokens";

describe("NationalCatalogModule wiring", () => {
  it("injects the source tenant only into schema refresh", () => {
    const module = NationalCatalogModule.forRoot({
      NATIONAL_CATALOG_BASE_URL: "https://catalog.example.test",
      NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID: "source-tenant",
      NATIONAL_CATALOG_REQUEST_TIMEOUT_MS: 15_000,
      CHZ_TOKEN_ENCRYPTION_KEY: "test-key",
    } as unknown as Env);
    const providers = module.providers ?? [];
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
});
