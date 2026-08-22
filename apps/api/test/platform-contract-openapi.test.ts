import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { platformErrorSchema } from "@markiro/platform-contracts";
import { z, type ZodType } from "zod";
import { describe, expect, it } from "vitest";

import { DB } from "../src/auth/auth.module";
import { BillingApplicationService } from "../src/modules/billing/billing-application.service";
import { BillingDocumentsService } from "../src/modules/billing/billing-documents.service";
import { BillingController } from "../src/modules/billing/billing.controller";
import { BillingService } from "../src/modules/billing/billing.service";
import { BillingPaymentsController } from "../src/modules/billing-payments/billing-payments.controller";
import { BillingPaymentsService } from "../src/modules/billing-payments/billing-payments.service";
import { PlatformDadataController } from "../src/modules/platform-dadata/platform-dadata.controller";
import { PlatformDadataRateLimit } from "../src/modules/platform-dadata/platform-dadata-rate-limit";
import { PlatformDadataService } from "../src/modules/platform-dadata/platform-dadata.service";
import { BillingAccountsController } from "../src/modules/billing-accounts/billing-accounts.controller";
import { BillingAccountsService } from "../src/modules/billing-accounts/billing-accounts.service";
import {
  PlatformCatalogController,
  PlatformSettingsController,
} from "../src/modules/platform-catalog/platform-catalog.controller";
import { PlatformCatalogService } from "../src/modules/platform-catalog/platform-catalog.service";
import { OfferDocumentsService } from "../src/modules/platform-offers/offer-documents.service";
import { PlatformOffersController } from "../src/modules/platform-offers/platform-offers.controller";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import { PlatformTenantsController } from "../src/modules/platform-tenants/platform-tenants.controller";
import { PlatformTenantsService } from "../src/modules/platform-tenants/platform-tenants.service";
import { PlatformActivationController } from "../src/platform-auth/platform-activation.controller";
import { PlatformActivationService } from "../src/platform-auth/platform-activation.service";
import { PlatformAuditController } from "../src/platform-auth/platform-audit.controller";
import { PlatformMeController } from "../src/platform-auth/platform-me.controller";
import { PlatformTeamController } from "../src/platform-auth/platform-team.controller";
import { PlatformTeamService } from "../src/platform-auth/platform-team.service";
import {
  CURRENT_SAAS_ROUTE_KEYS,
  CURRENT_SAAS_ROUTES,
  type PlatformRouteContract,
} from "./platform-route-contracts";

const PLATFORM_SESSION_SECURITY = "platformSession";
const PROTECTED_ERROR_STATUSES = ["400", "401", "403", "404", "409", "422", "429", "500"];
const PUBLIC_ERROR_STATUSES = ["400", "401", "404", "409", "422", "429", "500"];

const CURRENT_SHARED_SCHEMAS = [
  platformErrorSchema,
  ...CURRENT_SAAS_ROUTES.flatMap(({ response, body }) => [response, body]).filter(
    (schema): schema is ZodType => schema !== undefined,
  ),
];

function jsonSchema(schema: ZodType): Record<string, unknown> {
  const wireSchema = z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" });
  Reflect.deleteProperty(wireSchema, "$schema");
  return wireSchema;
}

function expectOpenApi30Compatible(value: unknown, path = "schema"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectOpenApi30Compatible(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  const object = value as Record<string, unknown>;
  expect("const" in object, `${path} contains the JSON Schema const keyword`).toBe(false);
  if ("type" in object) {
    expect(Array.isArray(object.type), `${path}.type is an array`).toBe(false);
    expect(object.type, `${path}.type is null-only`).not.toBe("null");
  }
  for (const [key, child] of Object.entries(object)) {
    expectOpenApi30Compatible(child, `${path}.${key}`);
  }
}

function operation(document: OpenAPIObject, contract: PlatformRouteContract) {
  const result = document.paths[contract.path]?.[contract.method];
  if (!result) {
    throw new Error(`Missing ${contract.method.toUpperCase()} ${contract.path}`);
  }
  return result;
}

function inlineJsonSchema(response: unknown): unknown {
  if (!response || typeof response !== "object" || !("content" in response)) return undefined;
  return (response.content as Record<string, { schema?: unknown }>)?.["application/json"]?.schema;
}

function documentedRouteKeys(document: OpenAPIObject): string[] {
  return Object.entries(document.paths)
    .flatMap(([path, item]) =>
      (["get", "post", "patch", "put", "delete"] as const)
        .filter((method) => item?.[method])
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

async function createPlatformDocument(): Promise<{
  document: OpenAPIObject;
  close: () => Promise<void>;
}> {
  const providers = [
    PlatformActivationService,
    PlatformTeamService,
    PlatformTenantsService,
    PlatformCatalogService,
    PlatformOffersService,
    OfferDocumentsService,
    BillingService,
    BillingDocumentsService,
    BillingApplicationService,
    BillingPaymentsService,
    BillingAccountsService,
    PlatformDadataService,
    PlatformDadataRateLimit,
    DB,
  ].map((provide) => ({ provide, useValue: {} }));
  const moduleRef = await Test.createTestingModule({
    controllers: [
      PlatformMeController,
      PlatformActivationController,
      PlatformTeamController,
      PlatformAuditController,
      PlatformTenantsController,
      PlatformCatalogController,
      PlatformSettingsController,
      PlatformOffersController,
      BillingController,
      BillingPaymentsController,
      BillingAccountsController,
      PlatformDadataController,
    ],
    providers,
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    document: SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("platform contract test")
        .setVersion("test")
        .addCookieAuth(
          "markiro-platform.session_token",
          { type: "apiKey", in: "cookie" },
          PLATFORM_SESSION_SECURITY,
        )
        .build(),
    ),
    close: () => app.close(),
  };
}

describe("current SaaS platform OpenAPI contracts", () => {
  it("converts all 83 current shared schemas to OpenAPI 3.0-compatible wire schemas", () => {
    expect(CURRENT_SHARED_SCHEMAS).toHaveLength(83);
    for (const schema of CURRENT_SHARED_SCHEMAS) {
      expectOpenApi30Compatible(jsonSchema(schema));
    }
  });

  it("publishes the strict shared 404 error for public activation without cookie security", async () => {
    const platformDocument = await createPlatformDocument();
    try {
      const activation = operation(platformDocument.document, CURRENT_SAAS_ROUTES[1]);
      expect(inlineJsonSchema(activation.responses["404"])).toEqual(
        jsonSchema(platformErrorSchema),
      );
      expect(activation.security ?? []).toEqual([]);
    } finally {
      await platformDocument.close();
    }
  });

  it("publishes the exact current controller route set from shared request and response schemas", async () => {
    const platformDocument = await createPlatformDocument();

    try {
      const { document } = platformDocument;

      expect(documentedRouteKeys(document)).toEqual(CURRENT_SAAS_ROUTE_KEYS);

      for (const contract of CURRENT_SAAS_ROUTES) {
        const documented = operation(document, contract);
        const successSchema = inlineJsonSchema(documented.responses[contract.status]);
        expect(successSchema).toEqual(jsonSchema(contract.response));
        expectOpenApi30Compatible(successSchema);

        if (contract.body) {
          const bodySchema = inlineJsonSchema(documented.requestBody);
          expect(bodySchema).toEqual(jsonSchema(contract.body));
          expectOpenApi30Compatible(bodySchema);
        } else {
          expect(documented.requestBody).toBeUndefined();
        }

        expect(documented.security ?? []).toEqual(
          contract.public ? [] : [{ [PLATFORM_SESSION_SECURITY]: [] }],
        );
        const errorStatuses = contract.public ? PUBLIC_ERROR_STATUSES : PROTECTED_ERROR_STATUSES;
        for (const status of errorStatuses) {
          const errorSchema = inlineJsonSchema(documented.responses[status]);
          expect(errorSchema).toEqual(jsonSchema(platformErrorSchema));
          expectOpenApi30Compatible(errorSchema);
        }

        expect(JSON.stringify(inlineJsonSchema(documented.responses[contract.status]))).not.toMatch(
          /secret|session|token|password|totp|recovery/i,
        );
      }
    } finally {
      await platformDocument.close();
    }
  });
});
