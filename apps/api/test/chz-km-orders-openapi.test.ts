import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";
import { schema } from "@markiro/db";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { ChzKmOrdersController } from "../src/modules/chz-km-orders/chz-km-orders.controller";
import { ChzKmOrdersService } from "../src/modules/chz-km-orders/chz-km-orders.service";
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
  const responseBodySchema = content?.["application/json"]?.schema;
  if (!responseBodySchema) {
    throw new Error(`Missing JSON response schema for ${method.toUpperCase()} ${path}`);
  }
  return responseBodySchema;
}

function property(schemaObject: JsonSchema, name: string): JsonSchema {
  const value = schemaObject.properties?.[name];
  if (!value) throw new Error(`Missing property ${name}`);
  return value;
}

function requestBodySchema(document: OpenAPIObject, path: string, method: Method): JsonSchema {
  const body = operation(document, path, method).requestBody;
  if (!body || "$ref" in body) throw new Error(`Missing inline request body`);
  const content = body.content as Record<string, { schema?: JsonSchema }> | undefined;
  const bodySchema = content?.["application/json"]?.schema;
  if (!bodySchema)
    throw new Error(`Missing JSON request schema for ${method.toUpperCase()} ${path}`);
  return bodySchema;
}

async function buildDocument(): Promise<{ document: OpenAPIObject; close: () => Promise<void> }> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ChzKmOrdersController],
    providers: [{ provide: ChzKmOrdersService, useValue: {} }],
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
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("contract test").setVersion("test").build(),
  );
  return { document, close: () => app.close() };
}

describe("chz-km-orders OpenAPI contract", () => {
  it("documents the four routes with the order DTO's full field set", async () => {
    const { document, close } = await buildDocument();
    try {
      expect(operation(document, "/chz-km-orders", "get")).toBeTruthy();
      expect(operation(document, "/chz-km-orders", "post")).toBeTruthy();
      expect(operation(document, "/chz-km-orders/{id}", "get")).toBeTruthy();
      expect(operation(document, "/chz-km-orders/{id}/retry", "post")).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("documents every preflight code the create endpoint can refuse with", async () => {
    const { document, close } = await buildDocument();
    try {
      const failed = operation(document, "/chz-km-orders", "post").responses["422"];
      if (!failed || "$ref" in failed) throw new Error("Missing inline 422 response");
      const content = failed.content as Record<string, { schema?: JsonSchema }> | undefined;
      const failedSchema = content?.["application/json"]?.schema;
      if (!failedSchema) throw new Error("Missing 422 response schema");
      expect(property(failedSchema, "blockedBy").items).toMatchObject({
        type: "string",
        enum: [
          "OMS_SETTINGS_MISSING",
          "AGENT_NOT_PAIRED",
          "OMS_TOKEN_UNAVAILABLE",
          "PRODUCT_NOT_FOUND",
          "PRODUCT_ARCHIVED",
          "PRODUCT_GTIN_MISSING",
          "PRODUCT_GROUP_MISSING",
          "PRODUCT_GROUP_UNSUPPORTED",
        ],
      });
    } finally {
      await close();
    }
  });

  it("documents every state the list endpoint's items can report", async () => {
    const { document, close } = await buildDocument();
    try {
      const list = responseSchema(document, "/chz-km-orders", "get", "200");
      const item = property(list, "orders").items;
      if (!item) throw new Error("Missing order list item schema");
      expect(property(item, "state")).toMatchObject({
        type: "string",
        enum: [...schema.CHZ_KM_ORDER_STATES],
      });
      // The list item omits `issues`; only the full order DTO documents it.
      expect(item.properties?.issues).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("documents the full order DTO including issues on get and create", async () => {
    const { document, close } = await buildDocument();
    try {
      const created = responseSchema(document, "/chz-km-orders", "post", "201");
      const single = responseSchema(document, "/chz-km-orders/{id}", "get", "200");
      for (const orderSchema of [created, single]) {
        expect(orderSchema.required).toEqual(expect.arrayContaining(["issues", "createdBy"]));
        expect(property(orderSchema, "issues")).toMatchObject({ type: "array" });
        expect(property(orderSchema, "createdBy")).toMatchObject({
          type: "object",
          required: ["id", "name"],
        });
      }
    } finally {
      await close();
    }
  });

  it("documents productId/quantity/contactPerson as the create request body", async () => {
    const { document, close } = await buildDocument();
    try {
      const body = requestBodySchema(document, "/chz-km-orders", "post");
      expect(body.required).toEqual(expect.arrayContaining(["productId", "quantity"]));
      expect(property(body, "productId")).toMatchObject({ type: "string", format: "uuid" });
      expect(property(body, "quantity")).toMatchObject({ type: "integer" });
      expect(property(body, "contactPerson")).toMatchObject({ type: "string" });
    } finally {
      await close();
    }
  });
});
