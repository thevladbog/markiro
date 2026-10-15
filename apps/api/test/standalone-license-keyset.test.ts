import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  configureStandaloneLicenseSigning,
  standaloneLicenseReusesGrantKey,
  STANDALONE_LICENSE_SIGNING_ERROR,
} from "../src/modules/standalone-licenses/standalone-license-keyset";

const issuer = "https://api.example.invalid";

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
  };
}

function licenseEnv(key = pair(), kid = "lic-1") {
  return {
    STANDALONE_LICENSE_ISSUER: issuer,
    STANDALONE_LICENSE_KID: kid,
    STANDALONE_LICENSE_PRIVATE_KEY_PEM: key.pem,
    STANDALONE_LICENSE_KEYSET_JSON: JSON.stringify({
      protocol: "standalone-license-v1",
      origin: issuer,
      revision: "lic-v1",
      keys: [{ kid, jwk: key.jwk }],
      retiredKids: [],
    }),
  };
}

describe("standalone license signing configuration (plan ЛЦ-0)", () => {
  it("keeps the API up with issuance off when all four values are absent or blank", () => {
    expect(configureStandaloneLicenseSigning({})).toBeNull();
    expect(
      configureStandaloneLicenseSigning({
        STANDALONE_LICENSE_ISSUER: "",
        STANDALONE_LICENSE_KID: "",
        STANDALONE_LICENSE_PRIVATE_KEY_PEM: "",
        STANDALONE_LICENSE_KEYSET_JSON: "",
      }),
    ).toBeNull();
  });

  it("refuses a partial or mismatched set with one line and no key material", () => {
    const env = licenseEnv();
    for (const broken of [
      { STANDALONE_LICENSE_KID: "lic-1" },
      { ...env, STANDALONE_LICENSE_ISSUER: "https://other.invalid" },
      { ...env, STANDALONE_LICENSE_PRIVATE_KEY_PEM: pair().pem },
      { ...env, STANDALONE_LICENSE_KID: "lic-2" },
      {
        ...env,
        STANDALONE_LICENSE_KEYSET_JSON: env.STANDALONE_LICENSE_KEYSET_JSON.replace(
          "standalone-license-v1",
          "offline-grants-v1",
        ),
      },
    ]) {
      let message = "";
      try {
        configureStandaloneLicenseSigning(broken);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toBe(STANDALONE_LICENSE_SIGNING_ERROR);
      expect(message).not.toMatch(/PRIVATE KEY|BEGIN/u);
    }
  });

  it("accepts a one-line PEM with escaped newlines from the runtime environment file", () => {
    const env = licenseEnv();
    const oneLine = env.STANDALONE_LICENSE_PRIVATE_KEY_PEM.trimEnd().replaceAll("\n", "\\n");
    expect(oneLine).not.toContain("\n");
    expect(
      configureStandaloneLicenseSigning({ ...env, STANDALONE_LICENSE_PRIVATE_KEY_PEM: oneLine })
        ?.kid,
    ).toBe("lic-1");
  });

  it("detects a license keyset that reuses an offline grant key", () => {
    const shared = pair();
    const grantEnv = {
      OFFLINE_GRANT_ORIGIN: issuer,
      OFFLINE_GRANT_KID: "grant-1",
      OFFLINE_GRANT_PRIVATE_KEY_PEM: shared.pem,
      OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
        protocol: "offline-grants-v1",
        origin: issuer,
        revision: "g-v1",
        keys: [{ kid: "grant-1", jwk: shared.jwk }],
        retiredKids: [],
      }),
    };
    expect(standaloneLicenseReusesGrantKey({ ...grantEnv, ...licenseEnv(shared) })).toBe(true);
    expect(standaloneLicenseReusesGrantKey({ ...grantEnv, ...licenseEnv() })).toBe(false);
    expect(standaloneLicenseReusesGrantKey(licenseEnv())).toBe(false);
    // The shared key is the license keyset's second, not active, entry.
    const active = pair();
    const license = licenseEnv(active);
    const keyset = JSON.parse(license.STANDALONE_LICENSE_KEYSET_JSON) as {
      keys: { kid: string; jwk: unknown }[];
    };
    keyset.keys.push({ kid: "lic-old", jwk: shared.jwk });
    expect(
      standaloneLicenseReusesGrantKey({
        ...grantEnv,
        ...license,
        STANDALONE_LICENSE_KEYSET_JSON: JSON.stringify(keyset),
      }),
    ).toBe(true);
  });
});
