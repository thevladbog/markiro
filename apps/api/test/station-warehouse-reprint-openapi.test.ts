import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
describe.skipIf(!ready)("warehouse print OpenAPI", () => {
  it("documents a strict body and a station-only credential boundary", async () => {
    const env = loadEnv();
    const setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    const app = ref.createNestApplication();
    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("test").setVersion("test").build(),
      );
      const lookup = document.paths["/station/warehouse-reprint/lookup"]?.post;
      expect(lookup).toBeDefined();
      expect(lookup?.security).toEqual([{ stationApiKey: [] }]);
      expect(lookup?.requestBody).toMatchObject({
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["protocol", "raw", "operatorId"],
              properties: {
                raw: { type: "string", maxLength: 2048 },
                operatorId: { type: "string", format: "uuid" },
              },
            },
          },
        },
      });
      expect(document.paths["/station/warehouse-reprint/templates"]?.get?.security).toEqual([
        { stationApiKey: [] },
      ]);
    } finally {
      await app.close();
    }
  });
});
