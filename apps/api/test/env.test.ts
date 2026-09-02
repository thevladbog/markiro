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
      NATIONAL_CATALOG_LIVE_GTIN: " 04600000000015 ",
    } as never);
    expect(env.NATIONAL_CATALOG_BASE_URL).toBe("https://catalog.example.test");
    expect(env.NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID).toBe("tenant-1");
    expect(env.NATIONAL_CATALOG_LIVE_GTIN).toBe("04600000000015");
    expect(env.NATIONAL_CATALOG_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it.each(["", "   "])("treats a blank configured live GTIN as disabled", (liveGtin) => {
    const env = loadEnv({
      ...requiredEnv,
      NATIONAL_CATALOG_LIVE_GTIN: liveGtin,
    } as never);
    expect(env.NATIONAL_CATALOG_LIVE_GTIN).toBeUndefined();
  });

  it.each(["0460000000001x", "4600000000015", "046000000000150"])(
    "rejects a non-14-digit configured live GTIN %s",
    (liveGtin) => {
      expect(() =>
        loadEnv({
          ...requiredEnv,
          NATIONAL_CATALOG_LIVE_GTIN: liveGtin,
        } as never),
      ).toThrow();
    },
  );

  it("rejects a non-HTTPS National Catalog endpoint", () => {
    expect(() =>
      loadEnv({
        ...requiredEnv,
        NATIONAL_CATALOG_BASE_URL: "http://catalog.example.test",
      } as never),
    ).toThrow();
  });
});
