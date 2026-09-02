import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { ShiftsController } from "../src/modules/shifts/shifts.controller";
import { ShiftsService } from "../src/modules/shifts/shifts.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard } from "../src/tenancy/tenant.guard";

type JsonSchema = {
  type?: string;
  format?: string;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

type Method = "get" | "patch" | "post";

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

function requestSchema(
  document: OpenAPIObject,
  path: string,
  method: "patch" | "post",
): JsonSchema {
  const body = operation(document, path, method).requestBody;
  if (!body || "$ref" in body) {
    throw new Error(`Missing inline request body for ${method.toUpperCase()} ${path}`);
  }
  const content = body.content as Record<string, { schema?: JsonSchema }>;
  const schema = content["application/json"]?.schema;
  if (!schema) throw new Error(`Missing JSON request schema for ${method.toUpperCase()} ${path}`);
  return schema;
}

function property(schema: JsonSchema, name: string): JsonSchema {
  const value = schema.properties?.[name];
  if (!value) throw new Error(`Missing property ${name}`);
  return value;
}

function expectProperties(schema: JsonSchema, fields: readonly string[]): void {
  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
}

function expectRequired(schema: JsonSchema, fields: readonly string[]): void {
  expect([...(schema.required ?? [])].sort()).toEqual([...fields].sort());
}

const productionDateContract = { type: "string", format: "date", nullable: true };

const shiftProperties = [
  "id",
  "number",
  "status",
  "mode",
  "productId",
  "productName",
  "productPrintName",
  "image",
  "lineId",
  "lineName",
  "counterpartyId",
  "counterpartyName",
  "ssccIssuerCounterpartyId",
  "boxLabelTemplateId",
  "plannedQty",
  "plannedDate",
  "productionDate",
  "boxCapacity",
  "palletCapacity",
  "palletsEnabled",
  "createdFrom",
  "openedAt",
  "closedAt",
  "closeReason",
  "lateDataAt",
  "createdAt",
  "stationCloseAccess",
] as const;

const requiredShiftProperties = shiftProperties.filter(
  (field) => field !== "image" && field !== "stationCloseAccess",
);

describe("shifts OpenAPI contract", () => {
  it("documents productionDate on create and update request bodies", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ShiftsController],
      providers: [{ provide: ShiftsService, useValue: {} }],
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

      const create = requestSchema(document, "/shifts", "post");
      expectProperties(create, [
        "productId",
        "mode",
        "lineId",
        "counterpartyId",
        "ssccIssuerCounterpartyId",
        "boxLabelTemplateId",
        "plannedQty",
        "plannedDate",
        "productionDate",
        "boxCapacity",
        "palletCapacity",
        "palletsEnabled",
      ]);
      expectRequired(create, ["productId", "mode"]);
      expect(property(create, "productionDate")).toMatchObject(productionDateContract);

      const update = requestSchema(document, "/shifts/{id}", "patch");
      expectProperties(update, [
        "mode",
        "lineId",
        "counterpartyId",
        "ssccIssuerCounterpartyId",
        "boxLabelTemplateId",
        "plannedQty",
        "plannedDate",
        "productionDate",
        "boxCapacity",
        "palletCapacity",
        "palletsEnabled",
      ]);
      expectRequired(update, []);
      expect(property(update, "productionDate")).toMatchObject(productionDateContract);
    } finally {
      await app.close();
    }
  });

  it("documents productionDate as a required nullable field on every current shift response", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ShiftsController],
      providers: [{ provide: ShiftsService, useValue: {} }],
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

      const directShiftSchemas = [
        responseSchema(document, "/shifts", "post", "201"),
        responseSchema(document, "/shifts/{id}", "get", "200"),
        responseSchema(document, "/shifts/{id}", "patch", "200"),
        responseSchema(document, "/shifts/{id}/open", "post", "200"),
      ];
      const listShift = property(responseSchema(document, "/shifts", "get", "200"), "items").items!;

      for (const schema of [...directShiftSchemas, listShift]) {
        expectProperties(schema, shiftProperties);
        expectRequired(schema, requiredShiftProperties);
        expect(property(schema, "productionDate")).toMatchObject(productionDateContract);
      }

      for (const path of ["/shifts/{id}/bundle", "/shifts/{id}/reference-bundle"] as const) {
        const bundle = responseSchema(document, path, "get", "200");
        expectProperties(bundle, [
          "shift",
          "product",
          "labelTemplate",
          "boxLabelTemplate",
          "counterpartyGln",
          "operators",
          "sscc",
          "ssccRevokedFrom",
        ]);
        expectRequired(bundle, [
          "shift",
          "product",
          "labelTemplate",
          "boxLabelTemplate",
          "counterpartyGln",
          "operators",
          "sscc",
          "ssccRevokedFrom",
        ]);
        const bundleShift = property(bundle, "shift");
        expectProperties(bundleShift, [...shiftProperties, "labelTemplateId", "labelTemplateName"]);
        expectRequired(bundleShift, [
          ...requiredShiftProperties,
          "image",
          "labelTemplateId",
          "labelTemplateName",
        ]);
        expect(property(bundleShift, "productionDate")).toMatchObject(productionDateContract);
      }
    } finally {
      await app.close();
    }
  });

  it("documents the tenant-scoped shift summary with mode-specific output and participants", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ShiftsController],
      providers: [{ provide: ShiftsService, useValue: {} }],
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
      const summary = responseSchema(document, "/shifts/{id}/summary", "get", "200");

      expectProperties(summary, ["generatedAt", "output", "participants", "unattributed"]);
      expectRequired(summary, ["generatedAt", "output", "participants", "unattributed"]);
      expect(property(summary, "generatedAt")).toMatchObject({
        type: "string",
        format: "date-time",
      });
      expect(property(summary, "participants").items?.properties).toMatchObject({
        employeeId: { type: "string", format: "uuid" },
        fullName: { type: "string" },
        role: { type: "string", nullable: true },
        firstActivityAt: { type: "string", format: "date-time" },
        lastActivityAt: { type: "string", format: "date-time" },
        acceptedScans: { type: "integer", minimum: 0 },
        closedBoxes: { type: "integer", minimum: 0 },
      });
      expect(property(summary, "unattributed").properties).toMatchObject({
        eventCount: { type: "integer", minimum: 0 },
        acceptedScans: { type: "integer", minimum: 0 },
        closedBoxes: { type: "integer", minimum: 0 },
      });
    } finally {
      await app.close();
    }
  });
});
