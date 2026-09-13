import { describe, expect, it } from "vitest";
import fixtures from "../../platform-contracts/fixtures/offline-grants-v1.json" with { type: "json" };
import { verifyGrant } from "../src/offline-grants/jws.js";

const origin = "https://offline-grants.fixture.invalid";
const key = { ...fixtures.publicKey, origin };
const deviceProducer = fixtures.producers.find((producer) => producer.id === "device");
if (!deviceProducer) throw new Error("Missing device fixture");
const deviceCompact = deviceProducer.compact;
const devicePayloadJson = deviceProducer.payloadJson;
const failures: Record<string, string> = {
  unsupported_algorithm: "malformed",
  invalid_header: "malformed",
  malformed_compact: "malformed",
  invalid_signature: "bad_signature",
  unknown_key: "unknown_key",
  issuer_mismatch: "wrong_origin",
};
describe("offline grant ES256 verification", () => {
  it.each(fixtures.vectors)("verifies original bytes: $id", async (vector) => {
    const result = await verifyGrant(vector.input.compact, [key], vector.input.context.issuer);
    const reason = failures[vector.expected.admission];
    if (reason) expect(result).toEqual({ ok: false, reason });
    else expect(result).toMatchObject({ ok: true, compact: vector.input.compact });
  });
  it("binds key lookup to the configured origin", async () => {
    expect(
      await verifyGrant(deviceCompact, [{ ...key, origin: "https://other.invalid" }], origin),
    ).toEqual({ ok: false, reason: "wrong_origin" });
  });
  it.each([
    "https://offline-grants.fixture.invalid:443",
    "HTTPS://OFFLINE-GRANTS.FIXTURE.INVALID",
    "ftp://offline-grants.fixture.invalid",
  ])("rejects a noncanonical or non-HTTP(S) configured origin: %s", async (configuredOrigin) => {
    expect(
      await verifyGrant(deviceCompact, [{ ...key, origin: configuredOrigin }], configuredOrigin),
    ).toEqual({
      ok: false,
      reason: "wrong_origin",
    });
  });
  it.each([{ crv: "P-384" }, { kty: "RSA" }, { d: "never-import-private-keys" }])(
    "rejects unsuitable keys %j",
    async (override) => {
      expect(
        await verifyGrant(deviceCompact, [{ ...key, jwk: { ...key.jwk, ...override } }], origin),
      ).toEqual({ ok: false, reason: "unknown_key" });
    },
  );
  it("rejects noncanonical trailing base64 bits", async () => {
    const compact = deviceCompact;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const tail = alphabet.indexOf(compact.slice(-1));
    expect(await verifyGrant(compact.slice(0, -1) + alphabet[tail + 1], [key], origin)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("strict signed payload and key boundaries", () => {
  const parts = deviceCompact.split(".");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  it.each([
    { credentialEpoch: 0 },
    { notBefore: 0.1 },
    { startNotAfter: Number.MAX_SAFE_INTEGER + 1 },
    { surprise: true },
  ])("rejects malformed payload before admission: %j", async (override) => {
    const grant = JSON.parse(devicePayloadJson);
    expect(
      await verifyGrant(
        `${parts[0]}.${encode({ ...grant, ...override })}.${parts[2]}`,
        [key],
        origin,
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });
  it("does not reserialize alternate valid JSON for signature verification", async () => {
    const producer = fixtures.producers.find((p) => p.id === "alternate-json");
    if (!producer) throw new Error("Missing alternate fixture");
    const segments = producer.compact.split(".");
    expect(
      await verifyGrant(
        `${encode(JSON.parse(producer.protectedHeaderJson))}.${encode(JSON.parse(producer.payloadJson))}.${segments[2]}`,
        [key],
        origin,
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects ambiguous same-origin key IDs", async () => {
    expect(await verifyGrant(deviceCompact, [key, key], origin)).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });
  it("rejects invalid UTF-8 JSON", async () => {
    expect(
      await verifyGrant(
        `${Buffer.from([0xff]).toString("base64url")}.${parts[1]}.${parts[2]}`,
        [key],
        origin,
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});
