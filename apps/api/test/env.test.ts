import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const requiredEnv = {
  ...PLATFORM_TEST_ENV,
  DATABASE_URL: "postgres://user:pass@localhost/db",
  BETTER_AUTH_SECRET: "insecure-test-placeholder",
  PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
  BETTER_AUTH_URL: "http://localhost:3000",
};

describe("National Catalog environment", () => {
  it("accepts trimmed optional configuration and defaults its bounded timeout", () => {
    const env = loadEnv({
      ...requiredEnv,
      NATIONAL_CATALOG_BASE_URL: " https://catalog.example.test ",
      NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID: " tenant-1 ",
    } as never);
    expect(env.NATIONAL_CATALOG_BASE_URL).toBe("https://catalog.example.test");
    expect(env.NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID).toBe("tenant-1");
    expect(env.NATIONAL_CATALOG_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it("rejects a non-HTTPS National Catalog endpoint", () => {
    expect(() =>
      loadEnv({
        ...requiredEnv,
        NATIONAL_CATALOG_BASE_URL: "http://catalog.example.test",
      } as never),
    ).toThrow();
  });
});
