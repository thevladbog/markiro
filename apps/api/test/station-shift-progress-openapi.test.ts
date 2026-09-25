import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

// Same minimal shape as station-inventory-openapi.test.ts's own `JsonSchema`,
// trimmed to what this route's closed four-field response needs.
type JsonSchema = {
  type?: string;
  format?: string;
  nullable?: boolean;
  minimum?: number;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
};

function operation(document: OpenAPIObject, path: string, method: "get") {
  const value = document.paths[path]?.[method];
  if (!value) throw new Error(`missing ${method.toUpperCase()} ${path}`);
  return value;
}

function responseSchema(document: OpenAPIObject, path: string, method: "get"): JsonSchema {
  const response = operation(document, path, method).responses["200"];
  if (!response || "$ref" in response) throw new Error("Missing inline response");
  const schema = (response.content as Record<string, { schema?: JsonSchema }> | undefined)?.[
    "application/json"
  ]?.schema;
  if (!schema) throw new Error("Missing JSON response schema");
  return schema;
}

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Missing-coverage task 5: an OpenAPI contract test for `GET
 * /station/shifts/{id}/progress`, pinning the closed response schema the
 * way station-inventory-openapi.test.ts pins its own station routes. That
 * sibling only pins 200 response/request shapes -- it never asserts a 404
 * schema, since every station route's 404 shares the same generic
 * `httpErrorSchema` (apps/api/src/lib/openapi.ts's `ApiHttpErrors`), so
 * there is nothing route-specific to pin there either; this file follows
 * the same scope and only checks that a 404 response is documented at all.
 */
describe.skipIf(!ready)("station shift progress OpenAPI contract", () => {
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

  it("documents GET /station/shifts/{id}/progress with a closed four-field response and a documented 404", () => {
    const op = operation(document, "/station/shifts/{id}/progress", "get");
    expect(op.responses["404"]).toBeDefined();

    const schema = responseSchema(document, "/station/shifts/{id}/progress", "get");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ["acceptedUnits", "asOf", "deviceAcceptedUnits", "shiftId"].sort(),
    );
    expect([...(schema.required ?? [])].sort()).toEqual(
      ["acceptedUnits", "asOf", "deviceAcceptedUnits", "shiftId"].sort(),
    );
    expect(schema.properties).toEqual({
      shiftId: { type: "string", format: "uuid" },
      acceptedUnits: { type: "integer", minimum: 0 },
      deviceAcceptedUnits: { type: "integer", minimum: 0 },
      asOf: { type: "string", format: "date-time" },
    });
  });
});
