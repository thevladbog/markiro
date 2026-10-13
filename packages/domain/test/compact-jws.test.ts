import { describe, expect, it } from "vitest";

import grants from "../../platform-contracts/fixtures/offline-grants-v1.json" with { type: "json" };
import {
  decodeBase64UrlCanonical,
  encodeBase64Url,
  signCompactJws,
  verifyCompactJws,
  type TrustedKey,
} from "../src/signed-documents/compact-jws.js";

const TYP = "markiro-test+jws";
const encoder = new TextEncoder();
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const key: TrustedKey = { kid: "k1", jwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
const keys = [key];

/** Signs any header and payload bytes, to build what signCompactJws never would. */
async function signRaw(privateKey: CryptoKey, header: unknown, payload: Uint8Array) {
  const input = `${encodeBase64Url(encoder.encode(JSON.stringify(header)))}.${encodeBase64Url(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(input),
  );
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

describe("compact JWS ES256", () => {
  it("verifies what it signs and hands back the exact payload bytes", async () => {
    const compact = await signCompactJws(pair.privateKey, { typ: TYP, kid: "k1" }, { a: 1 });
    const result = await verifyCompactJws(compact, { typ: TYP, keys });
    expect(result).toEqual({ ok: true, kid: "k1", payload: encoder.encode('{"a":1}') });
    const [header] = compact.split(".");
    expect(JSON.parse(new TextDecoder().decode(decodeBase64UrlCanonical(header ?? "")))).toEqual({
      typ: TYP,
      alg: "ES256",
      kid: "k1",
    });
  });

  it("verifies the cloud's offline grant bytes under their own typ only", async () => {
    const device = grants.producers.find((producer) => producer.id === "device");
    if (!device) throw new Error("Missing device fixture");
    const grantKeys = [{ kid: grants.publicKey.kid, jwk: grants.publicKey.jwk }];
    const own = await verifyCompactJws(device.compact, {
      typ: "markiro-offline-grant+jws",
      keys: grantKeys,
    });
    expect(own).toMatchObject({ ok: true, kid: grants.publicKey.kid });
    expect(
      await verifyCompactJws(device.compact, {
        typ: "markiro-standalone-license+jws",
        keys: grantKeys,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a header other than typ, alg ES256 and kid, even when signed", async () => {
    const payload = encoder.encode("{}");
    for (const header of [
      { typ: TYP, alg: "ES256", kid: "k1", cty: "json" },
      { typ: TYP, alg: "ES384", kid: "k1" },
      { typ: TYP, alg: "ES256" },
      { typ: TYP, alg: "ES256", kid: "" },
      { typ: TYP, alg: "ES256", kid: "k".repeat(129) },
      [TYP, "ES256", "k1"],
    ]) {
      expect(
        await verifyCompactJws(await signRaw(pair.privateKey, header, payload), { typ: TYP, keys }),
      ).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
    const plain = await signRaw(pair.privateKey, { typ: TYP, alg: "ES256", kid: "k1" }, payload);
    expect((await verifyCompactJws(plain, { typ: TYP, keys })).ok).toBe(true);
  });

  it("refuses non-canonical base64url and other segment counts", async () => {
    const compact = await signCompactJws(pair.privateKey, { typ: TYP, kid: "k1" }, { a: 1 });
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bumped = alphabet[alphabet.indexOf(compact.slice(-1)) + 1] ?? "";
    const [header, payload, signature] = compact.split(".");
    for (const broken of [
      compact.slice(0, -1) + bumped,
      `${compact}=`,
      `${header}.${payload}`,
      `${compact}.${signature}`,
      `${header}..${signature}`,
      `${header}.${payload}.${(signature ?? "").replace(/-/g, "+").replace(/_/g, "/")}`,
      ` ${compact}`,
      "",
    ]) {
      expect(await verifyCompactJws(broken, { typ: TYP, keys })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuses an unknown, retired, repeated or unsuitable key", async () => {
    const compact = await signCompactJws(pair.privateKey, { typ: TYP, kid: "k1" }, { a: 1 });
    const refuse = { ok: false, reason: "unknown_key" };
    expect(await verifyCompactJws(compact, { typ: TYP, keys: [{ ...key, kid: "k2" }] })).toEqual(
      refuse,
    );
    expect(await verifyCompactJws(compact, { typ: TYP, keys, retiredKids: ["k1"] })).toEqual(
      refuse,
    );
    expect(await verifyCompactJws(compact, { typ: TYP, keys: [key, key] })).toEqual(refuse);
    for (const override of [{ crv: "P-384" }, { kty: "RSA" }, { d: "never" }, { use: "enc" }]) {
      expect(
        await verifyCompactJws(compact, {
          typ: TYP,
          keys: [{ kid: "k1", jwk: { ...key.jwk, ...override } }],
        }),
      ).toEqual(refuse);
    }
  });

  it("refuses a changed payload, a foreign signature and a short one", async () => {
    const compact = await signCompactJws(pair.privateKey, { typ: TYP, kid: "k1" }, { stations: 5 });
    const [header, , signature] = compact.split(".");
    const raised = `${header}.${encodeBase64Url(encoder.encode('{"stations":50}'))}.${signature}`;
    const foreign = await signCompactJws(
      other.privateKey,
      { typ: TYP, kid: "k1" },
      { stations: 5 },
    );
    const bytes = decodeBase64UrlCanonical(signature ?? "");
    const [h, p] = compact.split(".");
    const short = `${h}.${p}.${encodeBase64Url(bytes.subarray(0, 63))}`;
    for (const broken of [raised, foreign, short]) {
      expect(await verifyCompactJws(broken, { typ: TYP, keys })).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });
});
