import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

type JsonSchema = {
  type?: string;
  format?: string;
  pattern?: string;
  enum?: unknown[];
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

function operation(document: OpenAPIObject, path: string, method: "get" | "post") {
  const value = document.paths[path]?.[method];
  expect(value, `missing ${method.toUpperCase()} ${path}`).toBeDefined();
  return value!;
}

function responseSchema(document: OpenAPIObject, path: string, method: "get" | "post"): JsonSchema {
  const response = operation(document, path, method).responses["200"];
  if (!response || "$ref" in response) throw new Error("Missing inline response");
  const schema = (response.content as Record<string, { schema?: JsonSchema }> | undefined)?.[
    "application/json"
  ]?.schema;
  if (!schema) throw new Error("Missing JSON response schema");
  return schema;
}

function requestSchema(document: OpenAPIObject, path: string): JsonSchema {
  const body = operation(document, path, "post").requestBody;
  if (!body || "$ref" in body) throw new Error("Missing inline request body");
  const schema = (body.content as Record<string, { schema?: JsonSchema }>)["application/json"]
    ?.schema;
  if (!schema) throw new Error("Missing JSON request schema");
  return schema;
}

function exactClosedObject(
  schema: JsonSchema,
  fields: readonly string[],
  required: readonly string[] = fields,
): void {
  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
  expect([...(schema.required ?? [])].sort()).toEqual([...required].sort());
  expect(schema.additionalProperties).toBe(false);
}

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station inventory OpenAPI contract", () => {
  let setup: AuthSetup;
  let app: INestApplication | undefined;
  let document: OpenAPIObject;

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

  it("documents the five station-only inventory task and immutable bundle routes", () => {
    for (const [path, method] of [
      ["/station/inventory-tasks", "get"],
      ["/station/inventory-tasks/resolve-barcode", "post"],
      ["/station/inventories/{id}/join", "post"],
      ["/station/inventories/{id}/bundle/manifest", "get"],
      ["/station/inventories/{id}/bundle/codes", "get"],
    ] as const) {
      operation(document, path, method);
    }
  });

  it("pins strict barcode/join inputs and does not admit a caller-selected line or tenant", () => {
    const barcode = requestSchema(document, "/station/inventory-tasks/resolve-barcode");
    exactClosedObject(barcode, ["barcode"]);
    expect(barcode.properties?.barcode).toEqual({ type: "string", maxLength: 128 });

    const join = requestSchema(document, "/station/inventories/{id}/join");
    exactClosedObject(join, ["operatorId", "barcode", "confirmDifferentLine"], ["operatorId"]);
    expect(join.properties).toEqual({
      operatorId: { type: "string", format: "uuid" },
      barcode: { type: "string", maxLength: 128 },
      confirmDifferentLine: { type: "boolean" },
    });
    expect(JSON.stringify(join)).not.toMatch(/tenantId|deviceId|lineId/);
  });

  it("pins immutable manifest identity, SSCC cursor, and bounded deterministic code pages", () => {
    const manifest = responseSchema(document, "/station/inventories/{id}/bundle/manifest", "get");
    expect(manifest.properties).toMatchObject({
      snapshotId: { type: "string", format: "uuid" },
      snapshotRevision: { type: "integer", minimum: 1, maximum: 1 },
      snapshotFixedAt: { type: "string", format: "date-time" },
      combinedDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      contentDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      codeCount: { type: "integer", minimum: 0 },
      boxCapacity: { type: "integer", minimum: 1 },
    });
    expect(manifest.required).toContain("boxCapacity");
    const sscc = manifest.properties?.sscc;
    if (!sscc) throw new Error("Missing SSCC schema");
    expect(sscc.nullable).toBe(true);
    exactClosedObject(sscc, [
      "allocationOrder",
      "issuerPrefix",
      "extensionDigit",
      "fromSerial",
      "toSerial",
      "consumedThroughSerial",
    ]);
    expect(sscc.properties?.allocationOrder).toEqual({ type: "integer", minimum: 1 });
    expect(sscc.properties?.consumedThroughSerial?.nullable).toBe(true);
    const revokedBlocks = manifest.properties?.ssccRevokedBlocks;
    expect(revokedBlocks?.type).toBe("array");
    exactClosedObject(revokedBlocks?.items ?? {}, ["allocationOrder", "fromSerial", "toSerial"]);

    const page = responseSchema(document, "/station/inventories/{id}/bundle/codes", "get");
    exactClosedObject(page, [
      "snapshotId",
      "snapshotRevision",
      "snapshotFixedAt",
      "combinedDigest",
      "contentDigest",
      "cursor",
      "items",
      "nextCursor",
      "pageDigest",
    ]);
    expect(page.properties?.items?.items?.properties).toMatchObject({
      codeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      canonicalRaw: { type: "string", maxLength: 1024 },
      sourceStatus: {
        type: "string",
        enum: ["EMITTED", "INTRODUCED", "APPLIED", "RETIRED", "WRITTEN_OFF", "DISAGGREGATION"],
      },
    });
    expect(JSON.stringify({ manifest, page })).not.toMatch(/objectKey|fileName|private\//i);

    const operationJson = operation(document, "/station/inventories/{id}/bundle/codes", "get");
    const limit = operationJson.parameters?.find(
      (parameter) => !("$ref" in parameter) && parameter.name === "limit",
    );
    expect(limit && !("$ref" in limit) ? limit.schema : undefined).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 200,
    });
  });
});
