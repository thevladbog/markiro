import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  format?: string;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean;
  minLength?: number;
  pattern?: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

function operation(document: OpenAPIObject, path: string, method: "get" | "patch" | "post") {
  const value = document.paths[path]?.[method];
  expect(value, `missing ${method.toUpperCase()} ${path}`).toBeDefined();
  return value!;
}

function responseSchema(
  document: OpenAPIObject,
  path: string,
  method: "get" | "patch" | "post",
  status: "200" | "201",
): JsonSchema {
  const response = operation(document, path, method).responses[status];
  if (!response || "$ref" in response) throw new Error(`Missing inline ${status} response`);
  const content = response.content as Record<string, { schema?: JsonSchema }> | undefined;
  const schema = content?.["application/json"]?.schema;
  if (!schema) throw new Error(`Missing JSON response for ${method.toUpperCase()} ${path}`);
  return schema;
}

function exactObject(schema: JsonSchema, fields: readonly string[]): void {
  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
  expect([...(schema.required ?? [])].sort()).toEqual([...fields].sort());
}

function exactClosedObject(
  schema: JsonSchema,
  fields: readonly string[],
  required: readonly string[],
): void {
  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
  expect([...(schema.required ?? [])].sort()).toEqual([...required].sort());
  expect(schema.additionalProperties).toBe(false);
}

const EXPECTED_LABEL_FIELDS = [
  "product.name",
  "product.printName",
  "product.gtin",
  "product.egais",
  "km.code",
  "sscc",
  "shift.no",
  "date",
  "expiry",
  "qty",
  "operator",
  "counterparty.name",
] as const;

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("inventories OpenAPI contract", () => {
  let setup: AuthSetup;
  let document: OpenAPIObject;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication();
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("contract test").setVersion("test").build(),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it("documents CRUD plus bounded status-slot multipart upload without private evidence fields", () => {
    const paths = [
      ["/inventories", "get"],
      ["/inventories", "post"],
      ["/inventories/{id}", "get"],
      ["/inventories/{id}", "patch"],
      ["/inventories/{id}/imports/{status}", "post"],
      ["/inventories/{id}/snapshots", "post"],
      ["/inventories/{id}/start", "post"],
    ] as const;
    for (const [path, method] of paths) operation(document, path, method);

    const upload = operation(document, "/inventories/{id}/imports/{status}", "post");
    const requestBody = upload.requestBody;
    if (!requestBody || "$ref" in requestBody) throw new Error("Missing multipart request body");
    const content = requestBody.content as Record<string, { schema?: JsonSchema }>;
    const multipart = content["multipart/form-data"]?.schema;
    if (!multipart) throw new Error("Missing multipart/form-data schema");
    exactObject(multipart, ["file"]);
    expect(multipart.properties?.file).toMatchObject({ type: "string", format: "binary" });

    const statusParameter = upload.parameters?.find(
      (parameter) => !("$ref" in parameter) && parameter.name === "status",
    );
    expect(
      statusParameter && !("$ref" in statusParameter) ? statusParameter.schema : undefined,
    ).toMatchObject({
      type: "string",
      enum: ["EMITTED", "INTRODUCED", "APPLIED", "RETIRED", "WRITTEN_OFF", "DISAGGREGATION"],
    });

    const importResult = responseSchema(
      document,
      "/inventories/{id}/imports/{status}",
      "post",
      "201",
    );
    exactObject(importResult, [
      "id",
      "declaredStatus",
      "parsedStatus",
      "result",
      "rowCount",
      "errorCount",
      "duplicateCount",
      "sha256",
      "diagnostics",
    ]);
    expect(JSON.stringify(document.paths["/inventories/{id}/imports/{status}"])).not.toMatch(
      /objectKey|fileName|canonicalKm|credential|rawCause/i,
    );
  });

  it("documents strict six-slot fixation input and the immutable snapshot summary", () => {
    const fixation = operation(document, "/inventories/{id}/snapshots", "post");
    const requestBody = fixation.requestBody;
    if (!requestBody || "$ref" in requestBody) throw new Error("Missing fixation request body");
    const requestSchema = (requestBody.content as Record<string, { schema?: JsonSchema }>)[
      "application/json"
    ]?.schema;
    if (!requestSchema) throw new Error("Missing fixation JSON schema");
    exactObject(requestSchema, ["imports"]);
    const imports = requestSchema.properties?.imports;
    if (!imports) throw new Error("Missing fixation imports object");
    exactObject(imports, [
      "EMITTED",
      "INTRODUCED",
      "APPLIED",
      "RETIRED",
      "WRITTEN_OFF",
      "DISAGGREGATION",
    ]);
    expect(Object.values(imports.properties ?? {})).toEqual(
      Array.from({ length: 6 }, () => ({ type: "string", format: "uuid" })),
    );

    const result = responseSchema(document, "/inventories/{id}/snapshots", "post", "201");
    exactObject(result, [
      "id",
      "inventoryId",
      "revision",
      "combinedDigest",
      "fixedAt",
      "inputs",
      "counts",
    ]);
    exactObject(result.properties!.inputs!, [
      "EMITTED",
      "INTRODUCED",
      "APPLIED",
      "RETIRED",
      "WRITTEN_OFF",
      "DISAGGREGATION",
    ]);
    exactObject(result.properties!.counts!, [
      "emitted",
      "introduced",
      "applied",
      "retired",
      "writtenOff",
      "disaggregation",
      "protected",
      "expected",
      "packages",
      "loose",
    ]);
    expect(JSON.stringify(fixation)).not.toMatch(
      /objectKey|fileName|canonicalRaw|canonicalKm|sourceState|sourceProductionDate/i,
    );
  });

  it("pins request derivation and response snapshot fields", () => {
    const create = operation(document, "/inventories", "post").requestBody;
    if (!create || "$ref" in create) throw new Error("Missing create request body");
    const createSchema = (create.content as Record<string, { schema?: JsonSchema }>)[
      "application/json"
    ]?.schema;
    if (!createSchema) throw new Error("Missing create JSON schema");
    expect(Object.keys(createSchema.properties ?? {}).sort()).toEqual(
      ["productId", "lineId", "mode", "productionDateFrom", "productionDateTo"].sort(),
    );
    expect(createSchema.required?.sort()).toEqual(
      ["productId", "lineId", "mode", "productionDateFrom", "productionDateTo"].sort(),
    );
    expect(createSchema.properties).not.toHaveProperty("gtin14");
    expect(createSchema.properties).not.toHaveProperty("boxLabelTemplateId");
    expect(createSchema.properties?.mode?.enum).toEqual(["check", "repack"]);

    const fields = [
      "id",
      "number",
      "status",
      "mode",
      "productId",
      "gtin14",
      "productName",
      "lineId",
      "lineName",
      "productionDateFrom",
      "productionDateTo",
      "boxLabelTemplateId",
      "boxLabelTemplate",
      "activeSnapshotId",
      "resultRevision",
      "createdAt",
      "updatedAt",
    ] as const;
    const createdInventory = responseSchema(document, "/inventories", "post", "201");
    exactObject(createdInventory, fields);
    const template = createdInventory.properties?.boxLabelTemplate;
    if (!template) throw new Error("Missing boxLabelTemplate projection");
    exactObject(template, ["id", "name"]);
    expect(template.nullable).toBe(true);
    exactObject(responseSchema(document, "/inventories/{id}", "get", "200"), fields);
    exactObject(responseSchema(document, "/inventories/{id}", "patch", "200"), fields);
    const list = responseSchema(document, "/inventories", "get", "200");
    exactObject(list, ["items"]);
    exactObject(list.properties!.items!.items!, fields);
  });

  it("freezes the exact start manifest, print model, and bounded Plan 2 limits", () => {
    const start = operation(document, "/inventories/{id}/start", "post");
    expect(start.requestBody).toBeUndefined();
    const manifest = responseSchema(document, "/inventories/{id}/start", "post", "201");
    const manifestFields = [
      "inventoryId",
      "inventoryNumber",
      "snapshotId",
      "snapshotRevision",
      "combinedDigest",
      "codeCount",
      "productId",
      "productName",
      "gtin14",
      "mode",
      "lineId",
      "lineName",
      "productionDateFrom",
      "productionDateTo",
      "boxLabelTemplate",
      "limits",
    ] as const;
    exactClosedObject(manifest, manifestFields, manifestFields);
    expect(manifest.nullable).toBeUndefined();
    expect(manifest.properties).toMatchObject({
      inventoryId: { type: "string", format: "uuid" },
      inventoryNumber: { type: "string" },
      snapshotId: { type: "string", format: "uuid" },
      snapshotRevision: { type: "integer", minimum: 1, maximum: 1 },
      combinedDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      codeCount: { type: "integer", minimum: 0 },
      productId: { type: "string", format: "uuid" },
      productName: { type: "string" },
      gtin14: { type: "string", pattern: "^[0-9]{14}$" },
      mode: { type: "string", enum: ["check", "repack"] },
      lineId: { type: "string", format: "uuid" },
      lineName: { type: "string" },
      productionDateFrom: { type: "string", format: "date" },
      productionDateTo: { type: "string", format: "date" },
    });

    const limits = manifest.properties!.limits!;
    const limitFields = ["codePageSize", "eventBatchSize", "progressPageSize"] as const;
    exactClosedObject(limits, limitFields, limitFields);
    expect(limits.nullable).toBeUndefined();
    expect(limits.properties).toEqual({
      codePageSize: { type: "integer", enum: [200] },
      eventBatchSize: { type: "integer", enum: [100] },
      progressPageSize: { type: "integer", enum: [200] },
    });

    const template = manifest.properties!.boxLabelTemplate!;
    expect(template.nullable).toBe(true);
    exactClosedObject(template, ["id", "name", "spec"], ["id", "name", "spec"]);
    const spec = template.properties!.spec!;
    const specFields = ["widthMm", "heightMm", "dpi", "language", "elements"] as const;
    exactClosedObject(spec, specFields, specFields);
    expect(spec.nullable).toBeUndefined();
    expect(spec.properties).toMatchObject({
      widthMm: { type: "number", minimum: 10, maximum: 300 },
      heightMm: { type: "number", minimum: 10, maximum: 300 },
      dpi: { type: "integer", enum: [203, 300] },
      language: { type: "string", enum: ["zpl", "tspl"] },
      elements: { type: "array" },
    });
    const variants = spec.properties!.elements!.items!.oneOf;
    expect(variants).toHaveLength(5);
    const variantsByKind = new Map(
      variants!.map((variant) => [variant.properties?.kind?.enum?.[0], variant]),
    );
    expect([...variantsByKind.keys()].sort()).toEqual(["barcode", "box", "field", "line", "text"]);

    const text = variantsByKind.get("text")!;
    exactClosedObject(
      text,
      ["id", "kind", "xMm", "yMm", "text", "fontSizePt", "bold", "align", "maxWidthMm", "maxLines"],
      ["id", "kind", "xMm", "yMm", "text", "fontSizePt"],
    );
    expect(text.properties).toEqual({
      id: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["text"] },
      xMm: { type: "number" },
      yMm: { type: "number" },
      text: { type: "string" },
      fontSizePt: { type: "number", minimum: 4, maximum: 72 },
      bold: { type: "boolean" },
      align: { type: "string", enum: ["left", "center", "right"] },
      maxWidthMm: { type: "number", minimum: 0, exclusiveMinimum: true },
      maxLines: { type: "integer", minimum: 1, maximum: 16 },
    });

    const field = variantsByKind.get("field")!;
    exactClosedObject(
      field,
      [
        "id",
        "kind",
        "xMm",
        "yMm",
        "field",
        "fontSizePt",
        "bold",
        "align",
        "maxWidthMm",
        "maxLines",
      ],
      ["id", "kind", "xMm", "yMm", "field", "fontSizePt"],
    );
    expect(field.properties).toEqual({
      id: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["field"] },
      xMm: { type: "number" },
      yMm: { type: "number" },
      field: { type: "string", enum: [...EXPECTED_LABEL_FIELDS] },
      fontSizePt: { type: "number", minimum: 4, maximum: 72 },
      bold: { type: "boolean" },
      align: { type: "string", enum: ["left", "center", "right"] },
      maxWidthMm: { type: "number", minimum: 0, exclusiveMinimum: true },
      maxLines: { type: "integer", minimum: 1, maximum: 16 },
    });

    const barcode = variantsByKind.get("barcode")!;
    exactClosedObject(
      barcode,
      ["id", "kind", "xMm", "yMm", "format", "data", "sizeMm", "moduleWidthMm"],
      ["id", "kind", "xMm", "yMm", "format", "data", "sizeMm"],
    );
    expect(barcode.properties).toMatchObject({
      id: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["barcode"] },
      xMm: { type: "number" },
      yMm: { type: "number" },
      format: { type: "string", enum: ["datamatrix", "code128", "ean13", "qr"] },
      sizeMm: { type: "number", minimum: 0, exclusiveMinimum: true },
      moduleWidthMm: { type: "number", minimum: 0, exclusiveMinimum: true },
    });
    const barcodeData = barcode.properties!.data!;
    expect(barcodeData.oneOf).toHaveLength(2);
    expect(barcodeData.oneOf![0]).toEqual({
      type: "string",
      enum: [...EXPECTED_LABEL_FIELDS],
    });
    exactClosedObject(barcodeData.oneOf![1]!, ["literal"], ["literal"]);
    expect(barcodeData.oneOf![1]!.properties).toEqual({ literal: { type: "string" } });

    const line = variantsByKind.get("line")!;
    exactClosedObject(
      line,
      ["id", "kind", "xMm", "yMm", "x2Mm", "y2Mm", "thicknessMm"],
      ["id", "kind", "xMm", "yMm", "x2Mm", "y2Mm", "thicknessMm"],
    );
    expect(line.properties).toEqual({
      id: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["line"] },
      xMm: { type: "number" },
      yMm: { type: "number" },
      x2Mm: { type: "number" },
      y2Mm: { type: "number" },
      thicknessMm: { type: "number", minimum: 0, exclusiveMinimum: true },
    });

    const box = variantsByKind.get("box")!;
    exactClosedObject(
      box,
      ["id", "kind", "xMm", "yMm", "widthMm", "heightMm", "thicknessMm"],
      ["id", "kind", "xMm", "yMm", "widthMm", "heightMm", "thicknessMm"],
    );
    expect(box.properties).toEqual({
      id: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["box"] },
      xMm: { type: "number" },
      yMm: { type: "number" },
      widthMm: { type: "number", minimum: 0, exclusiveMinimum: true },
      heightMm: { type: "number", minimum: 0, exclusiveMinimum: true },
      thicknessMm: { type: "number", minimum: 0, exclusiveMinimum: true },
    });
    expect(JSON.stringify(start)).not.toMatch(
      /startedBy|actorUser|objectKey|fileName|canonicalRaw|rawKm|credential|pinHash|badgeHash/i,
    );
  });
});
