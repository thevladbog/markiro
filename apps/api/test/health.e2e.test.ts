import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";

describe("GET /health", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  it("returns ok", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("env validation", () => {
  it("loadEnv({}) throws on missing required fields", () => {
    expect(() => loadEnv({} as never)).toThrow();
  });

  it("loadEnv parses valid config with PORT default", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://user:pass@localhost/db",
      BETTER_AUTH_SECRET: "1234567890123456",
      BETTER_AUTH_URL: "http://localhost:3000",
    } as never);
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toBe("postgres://user:pass@localhost/db");
  });

  it("loadEnv rejects a PORT outside the valid 1-65535 range", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: "postgres://user:pass@localhost/db",
        BETTER_AUTH_SECRET: "1234567890123456",
        BETTER_AUTH_URL: "http://localhost:3000",
        PORT: "70000",
      } as never),
    ).toThrow();
  });
});
