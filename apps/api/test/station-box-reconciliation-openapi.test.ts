import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station box reconciliation OpenAPI", () => {
  let app: INestApplication | undefined;
  let operation: Record<string, unknown>;
  beforeAll(async () => {
    const env = loadEnv();
    const setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("contract test").setVersion("test").build(),
    );
    operation = document.paths["/station/boxes/reconciliation"]?.post as unknown as Record<
      string,
      unknown
    >;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("documents a bounded, no-raw-code request and per-box result", () => {
    expect(operation).toBeDefined();
    const request = operation.requestBody as {
      content: Record<
        string,
        {
          schema: {
            properties: Record<
              string,
              { maxItems?: number; items?: { properties?: Record<string, unknown> } }
            >;
          };
        }
      >;
    };
    const boxes = request.content["application/json"]!.schema.properties.boxes;
    expect(boxes).toBeDefined();
    if (!boxes) throw new Error("OpenAPI boxes schema missing");
    expect(boxes.maxItems).toBe(200);
    expect(Object.keys(boxes.items?.properties ?? {})).toEqual(
      expect.arrayContaining([
        "boxId",
        "shiftId",
        "sscc",
        "closedAt",
        "devicePalletId",
        "itemCount",
        "membershipDigest",
        "digestVersion",
      ]),
    );
    expect(boxes.items?.properties).not.toHaveProperty("raw");
    const responses = operation.responses as Record<
      string,
      {
        content?: Record<
          string,
          {
            schema?: {
              properties?: Record<string, { items?: { properties?: Record<string, unknown> } }>;
            };
          }
        >;
      }
    >;
    expect(
      responses["200"]?.content?.["application/json"]?.schema?.properties?.results?.items
        ?.properties,
    ).toHaveProperty("reasonCode");
  });
});
