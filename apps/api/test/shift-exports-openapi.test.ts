import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { ShiftExportsController } from "../src/modules/shift-exports/shift-exports.controller";
import { ShiftExportsService } from "../src/modules/shift-exports/shift-exports.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard } from "../src/tenancy/tenant.guard";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

function operation(document: OpenAPIObject, path: string, method: "get" | "post") {
  const value = document.paths[path]?.[method];
  if (!value) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return value;
}

function responseSchema(
  document: OpenAPIObject,
  path: string,
  method: "get" | "post",
  status: "200" | "201",
): JsonSchema {
  const response = operation(document, path, method).responses[status];
  if (!response || "$ref" in response) throw new Error(`Missing inline ${status} response`);
  const content = response.content as Record<string, { schema?: JsonSchema }> | undefined;
  const schema = content?.["application/json"]?.schema;
  if (!schema) throw new Error(`Missing JSON response schema for ${method.toUpperCase()} ${path}`);
  return schema;
}

function requestSchema(document: OpenAPIObject, path: string): JsonSchema {
  const body = operation(document, path, "post").requestBody;
  if (!body || "$ref" in body) throw new Error(`Missing inline request body for POST ${path}`);
  const content = body.content as Record<string, { schema?: JsonSchema }>;
  const schema = content["application/json"]?.schema;
  if (!schema) throw new Error(`Missing JSON request schema for POST ${path}`);
  return schema;
}

function property(schema: JsonSchema, name: string): JsonSchema {
  const value = schema.properties?.[name];
  if (!value) throw new Error(`Missing property ${name}`);
  return value;
}

function expectExactFields(schema: JsonSchema, fields: readonly string[]): void {
  expect(schema.type).toBe("object");
  expect([...(schema.required ?? [])].sort()).toEqual([...fields].sort());
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
}

describe("shift exports OpenAPI contract", () => {
  it("documents all eight cabinet operations without exposing private object keys", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ShiftExportsController],
      providers: [{ provide: ShiftExportsService, useValue: {} }],
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

      expect(operation(document, "/shift-exports/formats", "get").responses["200"]).toBeDefined();
      expect(
        operation(document, "/shifts/{shiftId}/exports", "post").responses["201"],
      ).toBeDefined();
      expect(
        operation(document, "/shifts/{shiftId}/exports", "get").responses["200"],
      ).toBeDefined();
      expect(
        operation(document, "/shift-exports/{exportId}/retry", "post").responses["200"],
      ).toBeDefined();
      expect(
        operation(document, "/shift-exports/{exportId}/artifacts/{artifactId}/download", "get")
          .responses["200"],
      ).toBeDefined();

      expect(operation(document, "/pallet-exports/formats", "get").responses["200"]).toBeDefined();
      expect(
        operation(document, "/pallets/{palletId}/exports", "post").responses["201"],
      ).toBeDefined();
      expect(
        operation(document, "/pallets/{palletId}/exports", "get").responses["200"],
      ).toBeDefined();

      const create = requestSchema(document, "/shifts/{shiftId}/exports");
      expectExactFields(create, ["formatId", "formatVersion", "maxLines", "idempotencyKey"]);
      expect(property(create, "formatId").enum).toEqual([
        "shift_txt_flat",
        "shift_txt_boxes",
        "shift_csv_flat",
        "shift_csv_boxes",
        "shift_xml_gismt_aggregation",
        "shift_txt_pallets",
        "shift_csv_pallets",
        "shift_xml_gismt_aggregation_pallets",
        "shift_txt_pallet_boxes",
        "shift_xml_gismt_pallet_boxes",
      ]);
      expect(property(create, "formatVersion")).toMatchObject({ type: "integer", minimum: 1 });
      expect(property(create, "maxLines")).toMatchObject({
        type: "integer",
        nullable: true,
        minimum: 2,
        maximum: 1_000_000,
      });
      expect(property(create, "idempotencyKey")).toMatchObject({
        type: "string",
        format: "uuid",
      });

      const descriptor = responseSchema(document, "/shift-exports/formats", "get", "200").items!;
      expectExactFields(descriptor, ["id", "version", "label", "extension", "mimeType", "boxMode"]);
      expect(property(descriptor, "id").enum).toEqual([
        "shift_txt_flat",
        "shift_txt_boxes",
        "shift_csv_flat",
        "shift_csv_boxes",
        "shift_xml_gismt_aggregation",
        "shift_txt_pallets",
        "shift_csv_pallets",
        "shift_xml_gismt_aggregation_pallets",
        "shift_txt_pallet_boxes",
        "shift_xml_gismt_pallet_boxes",
      ]);

      const createPallet = requestSchema(document, "/pallets/{palletId}/exports");
      expectExactFields(createPallet, ["formatId", "formatVersion", "idempotencyKey"]);
      expect(property(createPallet, "formatId").enum).toEqual(["pallet_xml_gismt_aggregation"]);
      expect(property(createPallet, "formatVersion")).toMatchObject({
        type: "integer",
        minimum: 1,
      });
      expect(property(createPallet, "idempotencyKey")).toMatchObject({
        type: "string",
        format: "uuid",
      });

      const palletDescriptor = responseSchema(
        document,
        "/pallet-exports/formats",
        "get",
        "200",
      ).items!;
      expectExactFields(palletDescriptor, ["id", "version", "label", "extension", "mimeType"]);
      expect(property(palletDescriptor, "id").enum).toEqual(["pallet_xml_gismt_aggregation"]);
      expect(property(palletDescriptor, "version").enum).toEqual([1]);
      expect(property(palletDescriptor, "extension").enum).toEqual(["xml"]);

      const exportFields = [
        "id",
        "shiftId",
        "palletId",
        "formatId",
        "formatVersion",
        "maxLines",
        "status",
        "errorCode",
        "productNameSnapshot",
        "shiftDateSnapshot",
        "totalCodeCount",
        "totalBoxCount",
        "createdByUserId",
        "createdByName",
        "sourceSnapshotStartedAt",
        "completedAt",
        "attemptCount",
        "createdAt",
        "stale",
        "artifacts",
      ] as const;
      const created = responseSchema(document, "/shifts/{shiftId}/exports", "post", "201");
      expectExactFields(created, exportFields);
      expect(property(created, "status").enum).toEqual(["queued", "processing", "ready", "failed"]);
      expect(property(created, "shiftId")).toMatchObject({ type: "string", nullable: true });
      expect(property(created, "palletId")).toMatchObject({ type: "string", nullable: true });
      // One export resource for both targets, so its formatId enumerates every
      // format either route can create.
      expect(property(created, "formatId").enum).toEqual([
        "shift_txt_flat",
        "shift_txt_boxes",
        "shift_csv_flat",
        "shift_csv_boxes",
        "shift_xml_gismt_aggregation",
        "shift_txt_pallets",
        "shift_csv_pallets",
        "shift_xml_gismt_aggregation_pallets",
        "shift_txt_pallet_boxes",
        "shift_xml_gismt_pallet_boxes",
        "pallet_xml_gismt_aggregation",
      ]);
      // 0, not 1: a per-pallet aggregation names box SSCCs and no unit codes.
      expect(property(created, "totalCodeCount")).toMatchObject({ minimum: 0, nullable: true });
      const artifact = property(created, "artifacts").items!;
      expectExactFields(artifact, [
        "id",
        "partNumber",
        "physicalLineCount",
        "codeCount",
        "boxCount",
        "filename",
        "mimeType",
        "byteSize",
        "sha256",
      ]);

      expect(property(artifact, "codeCount")).toMatchObject({ type: "integer", minimum: 0 });

      const history = responseSchema(document, "/shifts/{shiftId}/exports", "get", "200");
      expect(history.type).toBe("array");
      expectExactFields(history.items!, exportFields);
      const palletCreated = responseSchema(document, "/pallets/{palletId}/exports", "post", "201");
      expectExactFields(palletCreated, exportFields);
      const palletHistory = responseSchema(document, "/pallets/{palletId}/exports", "get", "200");
      expect(palletHistory.type).toBe("array");
      expectExactFields(palletHistory.items!, exportFields);
      expectExactFields(
        responseSchema(document, "/shift-exports/{exportId}/retry", "post", "200"),
        exportFields,
      );
      expectExactFields(
        responseSchema(
          document,
          "/shift-exports/{exportId}/artifacts/{artifactId}/download",
          "get",
          "200",
        ),
        ["url", "filename", "expiresInSeconds"],
      );

      expect(JSON.stringify(document.paths)).not.toMatch(/objectKey|object_key/i);
    } finally {
      await app.close();
    }
  });
});
