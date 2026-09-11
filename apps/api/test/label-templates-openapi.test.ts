import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { LabelTemplatesController } from "../src/modules/label-templates/label-templates.controller";
import { LabelTemplatesService } from "../src/modules/label-templates/label-templates.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard } from "../src/tenancy/tenant.guard";

type JsonSchema = {
  type?: string;
  enum?: string[];
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

type Method = "get" | "post";

function operation(document: OpenAPIObject, path: string, method: Method) {
  const value = document.paths[path]?.[method];
  if (!value) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return value;
}

function responseSchema(
  document: OpenAPIObject,
  path: string,
  method: Method,
  status: "200" | "201",
): JsonSchema {
  const response = operation(document, path, method).responses[status];
  if (!response || "$ref" in response) throw new Error(`Missing inline ${status} response`);
  const content = response.content as Record<string, { schema?: JsonSchema }> | undefined;
  const schema = content?.["application/json"]?.schema;
  if (!schema) throw new Error(`Missing JSON response schema for ${method.toUpperCase()} ${path}`);
  return schema;
}

function property(schema: JsonSchema, name: string): JsonSchema {
  const value = schema.properties?.[name];
  if (!value) throw new Error(`Missing property ${name}`);
  return value;
}

/**
 * `LabelTemplatePurpose` (packages/domain/src/product-labels/contracts.ts) is
 * `"box" | "product_duplicate" | "pallet"`. Tenant provisioning seeds a
 * `purpose: "pallet"` row for every tenant, and neither `listLabelTemplates`
 * nor `getLabelTemplate` filter by purpose, so both response schemas below
 * must document every value the endpoint can actually return -- not just the
 * two that existed before slice 06d added pallet templates.
 */
const EXPECTED_PURPOSE_ENUM = ["box", "product_duplicate", "pallet"];

describe("label-templates OpenAPI contract", () => {
  it("documents every purpose the list endpoint (summary schema) can return", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LabelTemplatesController],
      providers: [{ provide: LabelTemplatesService, useValue: {} }],
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
      const list = responseSchema(document, "/label-templates", "get", "200");
      const item = property(list, "items").items;
      if (!item) throw new Error("Missing label template item schema");
      expect(property(item, "purpose")).toMatchObject({
        type: "string",
        enum: EXPECTED_PURPOSE_ENUM,
      });
    } finally {
      await app.close();
    }
  });

  it("documents every purpose the get-by-id endpoint (full schema) can return", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LabelTemplatesController],
      providers: [{ provide: LabelTemplatesService, useValue: {} }],
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
      const single = responseSchema(document, "/label-templates/{id}", "get", "200");
      expect(property(single, "purpose")).toMatchObject({
        type: "string",
        enum: EXPECTED_PURPOSE_ENUM,
      });

      // POST/PATCH reuse the exact same `labelTemplateOpenApiSchema` object,
      // so a template created or updated as "pallet" is documented too.
      const created = responseSchema(document, "/label-templates", "post", "201");
      expect(property(created, "purpose")).toMatchObject({
        type: "string",
        enum: EXPECTED_PURPOSE_ENUM,
      });
    } finally {
      await app.close();
    }
  });
});
