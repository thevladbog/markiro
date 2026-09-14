import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGrant, type DeviceGrant } from "@markiro/domain";
import { configureGrantSigning, signOfflineGrant } from "../src/modules/device-grants/grant-keyset";
const origin = "https://api.example.invalid";
function configured() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    OFFLINE_GRANT_ORIGIN: origin,
    OFFLINE_GRANT_KID: "test-active",
    OFFLINE_GRANT_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
      protocol: "offline-grants-v1",
      origin,
      revision: "test-v1",
      keys: [{ kid: "test-active", jwk }],
      retiredKids: [],
    }),
  };
}
describe("offline grant signing configuration", () => {
  it("keeps startup available with all signing configuration absent", () => {
    expect(configureGrantSigning({})).toBeNull();
  });
  it("refuses partial configuration without exposing private material", () => {
    expect(() => configureGrantSigning({ OFFLINE_GRANT_KID: "test" })).toThrow(
      "Invalid offline grant signing configuration",
    );
  });
  it("signs exact compact ES256 bytes with a 64-byte P1363 signature", async () => {
    const signer = configureGrantSigning(configured());
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
    expect(Buffer.from(compact.split(".")[2] ?? "", "base64url")).toHaveLength(64);
    expect(
      await verifyGrant(
        compact,
        signer.keyset.keys.map((key) => ({
          kid: key.kid,
          origin,
          jwk: { kty: key.jwk.kty, crv: key.jwk.crv, x: key.jwk.x, y: key.jwk.y },
        })),
        origin,
      ),
    ).toEqual({ ok: true, grant, compact });
  });
  it("requires the active private key to match its distributed public key", () => {
    const a = configured(),
      b = configured();
    expect(() =>
      configureGrantSigning({
        ...a,
        OFFLINE_GRANT_PRIVATE_KEY_PEM: b.OFFLINE_GRANT_PRIVATE_KEY_PEM,
      }),
    ).toThrow("Invalid offline grant signing configuration");
  });
  it("retains old verification keys while switching signer and forbids retired active keys", () => {
    const source = configured(),
      next = configured();
    const oldSet = JSON.parse(source.OFFLINE_GRANT_KEYSET_JSON),
      newSet = JSON.parse(next.OFFLINE_GRANT_KEYSET_JSON);
    newSet.keys[0].kid = "test-next";
    const keyset = { ...oldSet, revision: "test-v2", keys: [...oldSet.keys, ...newSet.keys] };
    expect(
      configureGrantSigning({
        ...next,
        OFFLINE_GRANT_KID: "test-next",
        OFFLINE_GRANT_KEYSET_JSON: JSON.stringify(keyset),
      })?.keyset.keys,
    ).toHaveLength(2);
    keyset.retiredKids = ["test-next"];
    expect(() =>
      configureGrantSigning({
        ...next,
        OFFLINE_GRANT_KID: "test-next",
        OFFLINE_GRANT_KEYSET_JSON: JSON.stringify(keyset),
      }),
    ).toThrow();
  });
  it("rejects a keyset claiming a different origin", () => {
    const config = configured();
    expect(() =>
      configureGrantSigning({ ...config, OFFLINE_GRANT_ORIGIN: "https://other.invalid" }),
    ).toThrow();
  });
});
