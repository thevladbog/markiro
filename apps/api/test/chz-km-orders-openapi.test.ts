import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";
import { schema } from "@markiro/db";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { ChzKmOrdersController } from "../src/modules/chz-km-orders/chz-km-orders.controller";
import { ChzKmOrdersService } from "../src/modules/chz-km-orders/chz-km-orders.service";
import { SecurityAuditService } from "../src/authorization/security-audit.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard } from "../src/tenancy/tenant.guard";

type JsonSchema = {
  type?: string;
  enum?: string[];
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
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

function errorSchema(
  document: OpenAPIObject,
  path: string,
  method: Method,
  status: "409",
): JsonSchema {
  const response = operation(document, path, method).responses[status];
  if (!response || "$ref" in response) throw new Error(`Missing inline ${status} response`);
  const content = response.content as Record<string, { schema?: JsonSchema }> | undefined;
  const errorBodySchema = content?.["application/json"]?.schema;
  if (!errorBodySchema) {
    throw new Error(`Missing JSON ${status} schema for ${method.toUpperCase()} ${path}`);
  }
  return errorBodySchema;
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
    providers: [
      { provide: ChzKmOrdersService, useValue: {} },
      { provide: SecurityAuditService, useValue: {} },
    ],
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
  it("documents every route with the order DTO's full field set", async () => {
    const { document, close } = await buildDocument();
    try {
      expect(operation(document, "/chz-km-orders", "get")).toBeTruthy();
      expect(operation(document, "/chz-km-orders", "post")).toBeTruthy();
      expect(operation(document, "/chz-km-orders/{id}", "get")).toBeTruthy();
      expect(operation(document, "/chz-km-orders/{id}/retry", "post")).toBeTruthy();
      expect(operation(document, "/chz-km-orders/{id}/issues", "post")).toBeTruthy();
      expect(operation(document, "/chz-km-orders/{id}/issues/{issueId}/file", "get")).toBeTruthy();
      expect(operation(document, "/chz-km-orders/{id}/issues/{issueId}/codes", "get")).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("documents the issue request body as the export/print discriminated union", async () => {
    const { document, close } = await buildDocument();
    try {
      const body = requestBodySchema(document, "/chz-km-orders/{id}/issues", "post");
      const variants = body.oneOf;
      if (!variants) throw new Error("Missing oneOf on the issue request body");
      expect(variants).toHaveLength(2);
      const [exportVariant, printVariant] = variants;
      if (!exportVariant || !printVariant) throw new Error("Missing an issue body variant");
      expect(property(exportVariant, "kind")).toMatchObject({ enum: ["export"] });
      expect(property(exportVariant, "format")).toMatchObject({
        enum: [...schema.CHZ_KM_ISSUE_FORMATS],
      });
      expect(property(exportVariant, "count")).toMatchObject({ maximum: 150_000 });
      expect(property(printVariant, "kind")).toMatchObject({ enum: ["print"] });
      // A print issue has no format, and its ceiling is a printable page count.
      expect(printVariant.properties?.format).toBeUndefined();
      expect(property(printVariant, "count")).toMatchObject({ maximum: 5_000 });
    } finally {
      await close();
    }
  });

  it("documents the issue DTO, the codes payload and both 409 surfaces", async () => {
    const { document, close } = await buildDocument();
    try {
      const issue = responseSchema(document, "/chz-km-orders/{id}/issues", "post", "201");
      expect(issue.required).toEqual([
        "id",
        "kind",
        "format",
        "fromSeq",
        "toSeq",
        "count",
        "createdBy",
        "createdAt",
      ]);
      expect(property(issue, "kind")).toMatchObject({ enum: [...schema.CHZ_KM_ISSUE_KINDS] });
      expect(property(issue, "format")).toMatchObject({
        enum: [...schema.CHZ_KM_ISSUE_FORMATS],
        nullable: true,
      });

      const codes = responseSchema(
        document,
        "/chz-km-orders/{id}/issues/{issueId}/codes",
        "get",
        "200",
      );
      const item = property(codes, "codes").items;
      if (!item) throw new Error("Missing codes item schema");
      expect(item.required).toEqual(["seq", "code"]);

      const conflict = errorSchema(document, "/chz-km-orders/{id}/issues", "post", "409");
      expect(conflict.oneOf?.map((variant) => property(variant, "code").enum)).toEqual([
        ["CHZ_KM_ISSUE_TOO_MANY"],
        ["CHZ_KM_ORDER_NOT_COMPLETED"],
        ["CHZ_KM_ISSUE_INCONSISTENT"],
      ]);
      const notExport = errorSchema(
        document,
        "/chz-km-orders/{id}/issues/{issueId}/file",
        "get",
        "409",
      );
      expect(property(notExport, "code").enum).toEqual(["CHZ_KM_ISSUE_NOT_EXPORT"]);
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
