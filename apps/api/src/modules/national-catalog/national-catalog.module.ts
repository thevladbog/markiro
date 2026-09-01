import { Global, Module, type DynamicModule } from "@nestjs/common";

import type { Env } from "../../env";
import { ChzTokenService } from "../chz-exports/chz-token.service";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
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

@Global()
@Module({})
export class NationalCatalogModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: NationalCatalogModule,
      controllers: [NationalCatalogController],
      providers: [
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
        NationalCatalogProposalService,
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
          ],
          useFactory: (
            repository: ConstructorParameters<typeof NationalCatalogProductsService>[0],
            client: NationalCatalogClient,
            tokens: ChzTokenService,
            baseUrl: string | undefined,
          ) => new NationalCatalogProductsService(repository, client, tokens, baseUrl),
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
            NationalCatalogProductsService,
          ],
          useFactory: (
            repository: ConstructorParameters<typeof NationalCatalogFreshnessService>[0],
            products: NationalCatalogProductsService,
          ) => new NationalCatalogFreshnessService(repository, products),
        },
      ],
      exports: [
        NationalCatalogClient,
        NationalCatalogProductsService,
        NationalCatalogSchemaService,
        NationalCatalogFreshnessService,
        NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID,
      ],
    };
  }
}
