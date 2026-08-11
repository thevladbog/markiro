import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env";
import { HealthController } from "../src/health.controller";
import { ReadinessService } from "../src/health/readiness.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

describe("GET /health", () => {
  let app: INestApplication;
  const unavailableReport = {
    status: "unavailable" as const,
    checkedAt: "2026-08-04T09:00:00.000Z",
    checks: {
      database: {
        status: "unavailable" as const,
        category: "database_unavailable" as const,
        checkedAt: "2026-08-04T09:00:00.000Z",
      },
      jobs: {
        status: "healthy" as const,
        checkedAt: "2026-08-04T09:00:00.000Z",
      },
      smtp: {
        status: "degraded" as const,
        category: "smtp_unavailable" as const,
        checkedAt: "2026-08-04T09:00:00.000Z",
      },
      storage: {
        status: "healthy" as const,
        checkedAt: "2026-08-04T09:00:00.000Z",
      },
    },
  };

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: ReadinessService,
          useValue: {
            live: () => ({ status: "ok" }),
            ready: async () => unavailableReport,
          },
        },
      ],
    }).compile();
    app = ref.createNestApplication();
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(() => app.close());

  it("returns liveness and readiness reports with their intended status codes", async () => {
    const server = app.getHttpServer();
    await request(server).get("/health").expect(200, { status: "ok" });
    await request(server).get("/health/live").expect(200, { status: "ok" });
    const ready = await request(server).get("/health/ready").expect(503);
    expect(ready.body).toEqual(unavailableReport);
  });
});

describe("env validation", () => {
  it("loadEnv({}) throws on missing required fields", () => {
    expect(() => loadEnv({} as never)).toThrow();
  });

  it("loadEnv parses valid config with PORT default", () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgres://user:pass@localhost/db",
      BETTER_AUTH_SECRET: "insecure-test-placeholder",
      PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
      BETTER_AUTH_URL: "http://localhost:3000",
    } as never);
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toBe("postgres://user:pass@localhost/db");
  });

  it("loadEnv defaults TRUST_PROXY_HOPS to 0 (untrusted) when unset", () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgres://user:pass@localhost/db",
      BETTER_AUTH_SECRET: "insecure-test-placeholder",
      PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
      BETTER_AUTH_URL: "http://localhost:3000",
    } as never);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
  });

  it("loadEnv coerces a numeric TRUST_PROXY_HOPS from the environment", () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgres://user:pass@localhost/db",
      BETTER_AUTH_SECRET: "insecure-test-placeholder",
      PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
      BETTER_AUTH_URL: "http://localhost:3000",
      TRUST_PROXY_HOPS: "1",
    } as never);
    expect(env.TRUST_PROXY_HOPS).toBe(1);
  });

  it("loadEnv rejects a negative TRUST_PROXY_HOPS", () => {
    expect(() =>
      loadEnv({
        ...PLATFORM_TEST_ENV,
        DATABASE_URL: "postgres://user:pass@localhost/db",
        BETTER_AUTH_SECRET: "insecure-test-placeholder",
        PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
        BETTER_AUTH_URL: "http://localhost:3000",
        TRUST_PROXY_HOPS: "-1",
      } as never),
    ).toThrow();
  });

  it("loadEnv rejects a PORT outside the valid 1-65535 range", () => {
    expect(() =>
      loadEnv({
        ...PLATFORM_TEST_ENV,
        DATABASE_URL: "postgres://user:pass@localhost/db",
        BETTER_AUTH_SECRET: "insecure-test-placeholder",
        PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
        BETTER_AUTH_URL: "http://localhost:3000",
        PORT: "70000",
      } as never),
    ).toThrow();
  });
});
