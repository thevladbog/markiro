import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";

import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { DashboardController } from "../src/modules/dashboard/dashboard.controller";
import { dashboardOverviewOpenApiSchema, dashboardPeriods } from "../src/modules/dashboard/dto";
import { DashboardService } from "../src/modules/dashboard/dashboard.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard } from "../src/tenancy/tenant.guard";

function getOverview(document: OpenAPIObject) {
  const operation = document.paths["/dashboard/overview"]?.get;
  if (!operation) throw new Error("Missing GET /dashboard/overview");
  return operation;
}

describe("dashboard OpenAPI contract", () => {
  it("documents the exact period query and 200 response schemas", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: {} }],
    })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthorizationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SubscriptionAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("contract test").setVersion("test").build(),
      );
      const operation = getOverview(document);
      const period = operation.parameters?.find(
        (parameter) => !("$ref" in parameter) && parameter.name === "period",
      );
      expect(period && !("$ref" in period) ? period : undefined).toMatchObject({
        in: "query",
        name: "period",
        required: false,
        schema: {
          type: "string",
          enum: [...dashboardPeriods],
          default: "7d",
        },
      });

      const response = operation.responses["200"];
      if (!response || "$ref" in response) throw new Error("Missing inline 200 response");
      expect(response.content?.["application/json"]?.schema).toEqual(
        dashboardOverviewOpenApiSchema,
      );
    } finally {
      await app.close();
    }
  });
});
