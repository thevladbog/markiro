import { generateKeyPairSync } from "node:crypto";
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

describe("validation duplicate rollout gate", () => {
  it.each([undefined, "", "false"])("defaults safely to disabled: %s", (value) => {
    expect(
      loadEnv({ ...requiredEnv, VALIDATION_DM_DUPLICATE_ENABLED: value })
        .VALIDATION_DM_DUPLICATE_ENABLED,
    ).toBe(false);
  });
  it("requires an explicit true and rejects ambiguous flags", () => {
    expect(
      loadEnv({ ...requiredEnv, VALIDATION_DM_DUPLICATE_ENABLED: "true" })
        .VALIDATION_DM_DUPLICATE_ENABLED,
    ).toBe(true);
    expect(() => loadEnv({ ...requiredEnv, VALIDATION_DM_DUPLICATE_ENABLED: "1" })).toThrow();
  });
});

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

describe("National Catalog import rollout configuration", () => {
  it("defaults each independent import flag off and host policy empty", () => {
    const env = loadEnv(requiredEnv);
    expect(env.NATIONAL_CATALOG_OWN_IMPORT_ENABLED).toBe(false);
    expect(env.NATIONAL_CATALOG_GTIN_IMPORT_ENABLED).toBe(false);
    expect(env.NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED).toBe(false);
    expect(env.NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS).toEqual([]);
  });
  it("requires explicit booleans and exact hostname lists", () => {
    expect(
      loadEnv({
        ...requiredEnv,
        NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED: "true",
        NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS: " cdn.example.test, IMG.example.test ",
      }).NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS,
    ).toEqual(["cdn.example.test", "img.example.test"]);
    for (const host of [
      "https://cdn.example.test/path",
      "*.example.test",
      "user@cdn.example.test",
      "127.0.0.1",
      "example.test:443",
    ])
      expect(() =>
        loadEnv({ ...requiredEnv, NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS: host }),
      ).toThrow();
    expect(() => loadEnv({ ...requiredEnv, NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "1" })).toThrow();
  });
  it("accepts the exact ASCII hostname of National Catalog photos on the .рф domain", () => {
    const hostname = new URL("https://национальный-каталог.рф/s3/med/photo.jpg").hostname;
    expect(
      loadEnv({
        ...requiredEnv,
        NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS: ` ${hostname.toUpperCase()} `,
      }).NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS,
    ).toEqual([hostname]);
  });
  it.each(["images.xn--", "images.xn--p1ai-", `images.xn--${"a".repeat(60)}`])(
    "rejects malformed internationalized top-level domains: %s",
    (hostname) => {
      expect(() =>
        loadEnv({ ...requiredEnv, NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS: hostname }),
      ).toThrow();
    },
  );
});

describe("standalone license signing environment (plan ЛЦ-0)", () => {
  function key() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    return {
      pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    };
  }
  const origin = "https://api.example.invalid";
  const licenseVars = (k: ReturnType<typeof key>) => ({
    STANDALONE_LICENSE_ISSUER: origin,
    STANDALONE_LICENSE_KID: "lic-1",
    STANDALONE_LICENSE_PRIVATE_KEY_PEM: k.pem,
    STANDALONE_LICENSE_KEYSET_JSON: JSON.stringify({
      protocol: "standalone-license-v1",
      origin,
      revision: "lic-v1",
      keys: [{ kid: "lic-1", jwk: k.jwk }],
      retiredKids: [],
    }),
  });

  it("boots without the license key and with a complete one", () => {
    expect(loadEnv(requiredEnv).STANDALONE_LICENSE_KID).toBeUndefined();
    expect(loadEnv({ ...requiredEnv, ...licenseVars(key()) }).STANDALONE_LICENSE_KID).toBe("lic-1");
  });

  it("refuses a partial license key and a license key shared with offline grants", () => {
    expect(() => loadEnv({ ...requiredEnv, STANDALONE_LICENSE_KID: "lic-1" })).toThrow(
      /Invalid standalone license signing configuration/u,
    );
    const shared = key();
    expect(() =>
      loadEnv({
        ...requiredEnv,
        ...licenseVars(shared),
        OFFLINE_GRANT_ORIGIN: origin,
        OFFLINE_GRANT_KID: "grant-1",
        OFFLINE_GRANT_PRIVATE_KEY_PEM: shared.pem,
        OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
          protocol: "offline-grants-v1",
          origin,
          revision: "g-v1",
          keys: [{ kid: "grant-1", jwk: shared.jwk }],
          retiredKids: [],
        }),
      }),
    ).toThrow(/must not reuse an offline grant key/u);
  });
});
