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
  "palletLabelTemplateId",
  "validationPrint",
  "plannedQty",
  "plannedDate",
  "productionDate",
  "boxCapacity",
  "palletBoxCapacity",
  "palletsEnabled",
  "createdFrom",
  "openedAt",
  "closedAt",
  "closeReason",
  "lateDataAt",
  "createdAt",
  "stationCloseAccess",
  "output",
] as const;

const requiredShiftProperties = shiftProperties.filter(
  (field) => field !== "image" && field !== "stationCloseAccess",
);

describe("shifts OpenAPI contract", () => {
  it("documents the product-specific duplicate template picker without exposing specs", async () => {
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
    try {
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const palletPicker = responseSchema(document, "/shifts/pallet-label-templates", "get", "200");
      expectProperties(palletPicker, ["items", "defaultPalletLabelTemplateId", "defaultSource"]);
      expectRequired(palletPicker, ["items", "defaultPalletLabelTemplateId", "defaultSource"]);
      const palletItem = property(palletPicker, "items").items;
      expect(palletItem).toBeDefined();
      if (!palletItem) throw new Error("Missing pallet option schema");
      expectProperties(palletItem, ["id", "name", "widthMm", "heightMm", "dpi", "language"]);
      const planning = responseSchema(document, "/shifts/planning-config", "get", "200");
      expectRequired(planning, [
        "defaultBoxLabelTemplateId",
        "defaultSource",
        "validationPrintProtocol",
      ]);
      expect(property(planning, "validationPrintProtocol")).toMatchObject({
        enum: ["validation-dm-duplicate-v1"],
        nullable: true,
      });
      for (const [route, method] of [
        ["/shifts", "post"],
        ["/shifts/{id}/open", "post"],
        ["/shifts/{id}/enter", "post"],
        ["/shifts/{id}/bundle", "get"],
        ["/shifts/{id}/reference-bundle", "get"],
      ] as const) {
        const op = operation(document, route, method);
        expect(op.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "x-station-capabilities",
              in: "header",
              required: false,
            }),
          ]),
        );
        expect(op.responses).toHaveProperty("409");
      }
      const path = "/shifts/product-label-templates";
      const schema = responseSchema(document, path, "get", "200");
      expectProperties(schema, ["items"]);
      const item = property(schema, "items").items;
      if (!item) throw new Error("Missing template item schema");
      expectProperties(item, ["id", "name", "widthMm", "heightMm", "dpi"]);
      expectRequired(item, ["id", "name", "widthMm", "heightMm", "dpi"]);
      expect(operation(document, path, "get").parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "productId", in: "query", required: true }),
        ]),
      );
    } finally {
      await app.close();
    }
  });

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
        "palletLabelTemplateId",
        "validationPrint",
        "plannedQty",
        "plannedDate",
        "productionDate",
        "boxCapacity",
        "palletBoxCapacity",
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
        "palletLabelTemplateId",
        "validationPrint",
        "plannedQty",
        "plannedDate",
        "productionDate",
        "boxCapacity",
        "palletBoxCapacity",
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
          "palletLabelTemplate",
          "counterpartyGln",
          "operators",
          "sscc",
          "ssccRevokedFrom",
          "palletSscc",
          "palletSsccRevokedFrom",
        ]);
        expectRequired(bundle, [
          "shift",
          "product",
          "labelTemplate",
          "boxLabelTemplate",
          "palletLabelTemplate",
          "counterpartyGln",
          "operators",
          "sscc",
          "ssccRevokedFrom",
          "palletSscc",
          "palletSsccRevokedFrom",
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
