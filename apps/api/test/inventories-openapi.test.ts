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
  format?: string;
  nullable?: boolean;
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
});
