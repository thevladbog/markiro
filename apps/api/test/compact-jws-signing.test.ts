import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGrant, type DeviceGrant } from "@markiro/domain";
import { loadCompactJwsSigningKey, signCompactJws } from "../src/signing/compact-jws";
import { configureGrantSigning, signOfflineGrant } from "../src/modules/device-grants/grant-keyset";

const origin = "https://api.example.invalid";

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    entry: {
      kid,
      jwk: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x ?? "", y: jwk.y ?? "" },
    },
  };
}

function decodeSegment(segment: string | undefined): unknown {
  return JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8"));
}

describe("generalized compact JWS signer (plan ЛЦ-0)", () => {
  it("signs exact header.payload bytes with ES256 and a 64-byte P1363 signature for any typ", () => {
    const pair = keyPair("lic-1");
    const key = loadCompactJwsSigningKey({
      origin,
      kid: "lic-1",
      pem: pair.pem,
      keyset: { origin, keys: [pair.entry], retiredKids: [] },
    });
    const compact = signCompactJws(key, "markiro-standalone-license+jws", { a: 1, b: "в" });
    const [header, payload, signature] = compact.split(".");
    expect(decodeSegment(header)).toEqual({
      alg: "ES256",
      typ: "markiro-standalone-license+jws",
      kid: "lic-1",
    });
    expect(decodeSegment(payload)).toEqual({ a: 1, b: "в" });
    const bytes = Buffer.from(signature ?? "", "base64url");
    expect(bytes).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        {
          key: createPublicKey({ key: { ...pair.entry.jwk }, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        bytes,
      ),
    ).toBe(true);
  });

  it("refuses a retired active kid, a foreign origin, a mismatched private key and an unknown kid", () => {
    const a = keyPair("a");
    const b = keyPair("b");
    const keyset = { origin, keys: [a.entry, b.entry], retiredKids: ["b"] };
    expect(() => loadCompactJwsSigningKey({ origin, kid: "b", pem: b.pem, keyset })).toThrow();
    expect(() =>
      loadCompactJwsSigningKey({ origin: "https://other.invalid", kid: "a", pem: a.pem, keyset }),
    ).toThrow();
    expect(() => loadCompactJwsSigningKey({ origin, kid: "a", pem: b.pem, keyset })).toThrow();
    expect(() =>
      loadCompactJwsSigningKey({
        origin,
        kid: "c",
        pem: a.pem,
        keyset: { ...keyset, retiredKids: [] },
      }),
    ).toThrow();
  });

  it("keeps offline grants byte-compatible: same header order and a grant the domain verifies", async () => {
    const pair = keyPair("test-active");
    const signer = configureGrantSigning({
      OFFLINE_GRANT_ORIGIN: origin,
      OFFLINE_GRANT_KID: "test-active",
      OFFLINE_GRANT_PRIVATE_KEY_PEM: pair.pem,
      OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
        protocol: "offline-grants-v1",
        origin,
        revision: "test-v1",
        keys: [pair.entry],
        retiredKids: [],
      }),
    });
    if (!signer) throw new Error("fixture");
    const grant: DeviceGrant = {
      version: 1,
      issuer: origin,
      grantId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "tenant-a",
      deviceId: "550e8400-e29b-41d4-a716-446655440001",
      kind: "station",
      credentialEpoch: 1,
      entitlementRevision: "1",
      policyRevision: "policy",
      issuedAt: 1000,
      notBefore: 1000,
      kindOfGrant: "device",
      startNotAfter: 2000,
      capabilities: ["shift.start.v1"],
    };
    const compact = signOfflineGrant(signer, grant);
    expect(Buffer.from(compact.split(".")[0] ?? "", "base64url").toString("utf8")).toBe(
      '{"alg":"ES256","typ":"markiro-offline-grant+jws","kid":"test-active"}',
    );
    await expect(
      verifyGrant(compact, [{ kid: "test-active", origin, jwk: { ...pair.entry.jwk } }], origin),
    ).resolves.toEqual({ ok: true, grant, compact });
  });
});
