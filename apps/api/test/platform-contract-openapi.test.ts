import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import {
  platformAuditContracts,
  platformAuthContracts,
  platformCatalogContracts,
  platformCommercialContracts,
  platformErrorSchema,
  platformTeamContracts,
  platformTenantContracts,
} from "@markiro/platform-contracts";
import { z, type ZodType } from "zod";
import { describe, expect, it } from "vitest";

import { DB } from "../src/auth/auth.module";
import { BillingApplicationService } from "../src/modules/billing/billing-application.service";
import { BillingDocumentsService } from "../src/modules/billing/billing-documents.service";
import { BillingController } from "../src/modules/billing/billing.controller";
import { BillingService } from "../src/modules/billing/billing.service";
import { BillingPaymentsController } from "../src/modules/billing-payments/billing-payments.controller";
import { BillingPaymentsService } from "../src/modules/billing-payments/billing-payments.service";
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

const PLATFORM_SESSION_SECURITY = "platformSession";
const PROTECTED_ERROR_STATUSES = ["400", "401", "403", "404", "409", "422", "429", "500"];
const PUBLIC_ERROR_STATUSES = ["400", "401", "409", "422", "429", "500"];

type HttpMethod = "get" | "post" | "patch";
type SuccessStatus = "200" | "201";

interface PlatformRouteContract {
  method: HttpMethod;
  path: string;
  status: SuccessStatus;
  response: ZodType;
  body?: ZodType;
  public?: true;
}

const route = (
  method: HttpMethod,
  path: string,
  status: SuccessStatus,
  response: ZodType,
  options: Pick<PlatformRouteContract, "body" | "public"> = {},
): PlatformRouteContract => ({ method, path, status, response, ...options });

const CURRENT_SAAS_ROUTES = [
  route("get", "/platform/me", "200", platformAuthContracts.me.response),
  route(
    "post",
    "/platform/activation/complete",
    "201",
    platformAuthContracts.activationComplete.response,
    { body: platformAuthContracts.activationComplete.body, public: true },
  ),
  route("get", "/platform/team", "200", platformTeamContracts.list.response),
  route("post", "/platform/team", "201", platformTeamContracts.invite.response, {
    body: platformTeamContracts.invite.body,
  }),
  route("patch", "/platform/team/{id}/role", "200", platformTeamContracts.changeRole.response, {
    body: platformTeamContracts.changeRole.body,
  }),
  route("post", "/platform/team/{id}/suspend", "201", platformTeamContracts.suspend.response),
  route(
    "post",
    "/platform/team/{id}/activation/renew",
    "201",
    platformTeamContracts.renewActivation.response,
  ),
  route(
    "post",
    "/platform/team/{id}/2fa/recover",
    "201",
    platformTeamContracts.recoverTwoFactor.response,
  ),
  route("get", "/platform/audit", "200", platformAuditContracts.list.response),
  route("get", "/platform/tenants", "200", platformTenantContracts.list.response),
  route("post", "/platform/tenants", "201", platformTenantContracts.create.response, {
    body: platformTenantContracts.create.body,
  }),
  route("get", "/platform/tenants/{id}", "200", platformTenantContracts.detail.response),
  route(
    "post",
    "/platform/tenants/{id}/owner-activation/renew",
    "200",
    platformTenantContracts.renewActivation.response,
  ),
  route(
    "post",
    "/platform/tenants/{id}/subscription/plan",
    "201",
    platformTenantContracts.assignPlan.response,
    { body: platformTenantContracts.assignPlan.body },
  ),
  route(
    "post",
    "/platform/tenants/{id}/subscription/addons",
    "201",
    platformTenantContracts.assignAddon.response,
    { body: platformTenantContracts.assignAddon.body },
  ),
  route("get", "/platform/catalog/items", "200", platformCatalogContracts.list.response),
  route(
    "get",
    "/platform/catalog/items/{id}/versions",
    "200",
    platformCatalogContracts.listVersions.response,
  ),
  route(
    "get",
    "/platform/catalog/items/{id}/versions/{versionId}",
    "200",
    platformCatalogContracts.getVersion.response,
  ),
  route(
    "post",
    "/platform/catalog/items/{id}/versions",
    "201",
    platformCatalogContracts.createVersion.response,
    { body: platformCatalogContracts.createVersion.body },
  ),
  route(
    "patch",
    "/platform/catalog/items/{id}/versions/{versionId}",
    "200",
    platformCatalogContracts.updateVersion.response,
    { body: platformCatalogContracts.updateVersion.body },
  ),
  route(
    "post",
    "/platform/catalog/items/{id}/versions/{versionId}/publish",
    "200",
    platformCatalogContracts.publishVersion.response,
  ),
  route(
    "post",
    "/platform/catalog/items/{id}/versions/{versionId}/retire",
    "200",
    platformCatalogContracts.retireVersion.response,
  ),
  route(
    "post",
    "/platform/catalog/items/{id}/archive",
    "200",
    platformCatalogContracts.archiveItem.response,
  ),
  route(
    "get",
    "/platform/settings/demo-plan",
    "200",
    platformCatalogContracts.getDefaultDemo.response,
  ),
  route(
    "patch",
    "/platform/settings/demo-plan",
    "200",
    platformCatalogContracts.setDefaultDemo.response,
    { body: platformCatalogContracts.setDefaultDemo.body },
  ),
  route("get", "/platform/offers", "200", platformCommercialContracts.offers.list.response),
  route("get", "/platform/offers/{id}", "200", platformCommercialContracts.offers.detail.response),
  route("post", "/platform/offers", "201", platformCommercialContracts.offers.create.response, {
    body: platformCommercialContracts.offers.create.body,
  }),
  route(
    "post",
    "/platform/offers/{id}/publish",
    "200",
    platformCommercialContracts.offers.publish.response,
  ),
  route(
    "get",
    "/platform/offers/{id}/documents",
    "200",
    platformCommercialContracts.offers.documents.list.response,
  ),
  route(
    "post",
    "/platform/offers/{id}/documents",
    "201",
    platformCommercialContracts.offers.documents.render.response,
  ),
  route(
    "get",
    "/platform/offers/{id}/documents/{documentId}/download",
    "200",
    platformCommercialContracts.offers.documents.download.response,
  ),
  route(
    "post",
    "/platform/offers/{id}/cancel",
    "200",
    platformCommercialContracts.offers.cancel.response,
  ),
  route(
    "post",
    "/platform/offers/{id}/payment",
    "201",
    platformCommercialContracts.offers.payment.response,
    { body: platformCommercialContracts.offers.payment.body },
  ),
  route("get", "/platform/invoices", "200", platformCommercialContracts.invoices.list.response),
  route(
    "get",
    "/platform/invoices/{id}",
    "200",
    platformCommercialContracts.invoices.detail.response,
  ),
  route("post", "/platform/invoices", "201", platformCommercialContracts.invoices.create.response, {
    body: platformCommercialContracts.invoices.create.body,
  }),
  route(
    "post",
    "/platform/invoices/{id}/issue",
    "201",
    platformCommercialContracts.invoices.issue.response,
  ),
  route(
    "post",
    "/platform/invoices/{id}/document",
    "201",
    platformCommercialContracts.invoices.document.response,
  ),
  route(
    "get",
    "/platform/invoices/{id}/documents",
    "200",
    platformCommercialContracts.invoices.documents.list.response,
  ),
  route(
    "post",
    "/platform/invoices/{id}/documents",
    "201",
    platformCommercialContracts.invoices.documents.render.response,
  ),
  route(
    "get",
    "/platform/invoices/{id}/document",
    "200",
    platformCommercialContracts.invoices.documentUrl.response,
  ),
  route(
    "get",
    "/platform/invoices/{id}/documents/{documentId}/download",
    "200",
    platformCommercialContracts.invoices.documents.download.response,
  ),
  route(
    "post",
    "/platform/invoices/{id}/apply",
    "201",
    platformCommercialContracts.invoices.apply.response,
    { body: platformCommercialContracts.invoices.apply.body },
  ),
  route(
    "post",
    "/platform/invoices/{id}/cancel",
    "201",
    platformCommercialContracts.invoices.cancel.response,
  ),
  route("get", "/platform/payments", "200", platformCommercialContracts.payments.list.response),
  route(
    "post",
    "/platform/payments/invoices/{invoiceId}",
    "201",
    platformCommercialContracts.payments.manual.response,
    { body: platformCommercialContracts.payments.manual.body },
  ),
  route(
    "post",
    "/platform/payments/imports",
    "201",
    platformCommercialContracts.payments.import.response,
    { body: platformCommercialContracts.payments.import.body },
  ),
] as const satisfies readonly PlatformRouteContract[];

function jsonSchema(schema: ZodType): Record<string, unknown> {
  const wireSchema = z.toJSONSchema(schema, { io: "input" });
  Reflect.deleteProperty(wireSchema, "$schema");
  return wireSchema;
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

describe("current SaaS platform OpenAPI contracts", () => {
  it("publishes the exact current controller route set from shared request and response schemas", async () => {
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
      ],
      providers,
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(
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
      );

      expect(documentedRouteKeys(document)).toEqual(
        CURRENT_SAAS_ROUTES.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort(),
      );

      for (const contract of CURRENT_SAAS_ROUTES) {
        const documented = operation(document, contract);
        expect(inlineJsonSchema(documented.responses[contract.status])).toEqual(
          jsonSchema(contract.response),
        );

        if (contract.body) {
          expect(inlineJsonSchema(documented.requestBody)).toEqual(jsonSchema(contract.body));
        } else {
          expect(documented.requestBody).toBeUndefined();
        }

        expect(documented.security ?? []).toEqual(
          contract.public ? [] : [{ [PLATFORM_SESSION_SECURITY]: [] }],
        );
        const errorStatuses = contract.public ? PUBLIC_ERROR_STATUSES : PROTECTED_ERROR_STATUSES;
        for (const status of errorStatuses) {
          expect(inlineJsonSchema(documented.responses[status])).toEqual(
            jsonSchema(platformErrorSchema),
          );
        }

        expect(JSON.stringify(inlineJsonSchema(documented.responses[contract.status]))).not.toMatch(
          /secret|session|token|password|totp|recovery/i,
        );
      }
    } finally {
      await app.close();
    }
  });
});
