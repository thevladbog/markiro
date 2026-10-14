import { generateKeyPairSync, webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptBlob,
  findBlob,
  parseBlob,
  publicEntry,
  table,
} from "../../../tools/standalone-support/decrypt.mjs";
import {
  BLOB_PATTERN,
  encryptSupportPayload,
  toBase64Url,
} from "../src/office/info/support-crypto.js";
import {
  activeSupportKey,
  BUILT_IN_SUPPORT_KEYS,
  parseSupportKeyset,
  supportKeysetSchema,
} from "../src/office/info/support-keys.js";

/** A throwaway pair, made when the test runs: nothing of it is stored. */
function pair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
  const jwk = publicKey.export({ format: "jwk" });
  return {
    pem,
    key: {
      kid,
      jwk: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x ?? "", y: jwk.y ?? "" },
    },
  };
}

const PAYLOAD = JSON.stringify({
  v: 1,
  generatedAt: "2026-10-14T09:00:00.000Z",
  appVersion: "0.2.0",
  hostVersion: "0.2.0",
  months: [
    {
      month: "2026-09",
      shifts: {
        aggregation: 6,
        validation: 1,
        validationPrint: 0,
        fromOffice: 5,
        fromStation: 2,
        withPallets: 2,
      },
      scans: { accepted: 7020, duplicates: 64, rejected: 9 },
      boxes: { closed: 585, disassembled: 0, codes: 7020 },
      pallets: { closed: 13, disassembled: 0 },
      exceptions: {
        boxUndo: 4,
        boxClear: 0,
        boxReprint: 2,
        boxDisassemble: 0,
        palletReprint: 0,
        palletDisassemble: 0,
      },
      conflicts: { late: 1, displaced: 0, reviewed: 0 },
      reprints: { warehouse: 0, unitLabel: 0 },
      disaggregationApplied: 0,
      syncRejected: 0,
    },
  ],
  devices: { station: 3, office: 2, handheld: 1 },
});

describe("the encrypted usage statistics (beta 3)", () => {
  it("opens with the private key through the maker's tool, compressed or not", async () => {
    const { pem, key } = pair("sup-test1");
    for (const compress of [true, false]) {
      const token = await encryptSupportPayload(PAYLOAD, key, { compress });
      expect(token).toMatch(BLOB_PATTERN);
      expect(token.startsWith("MKS1.sup-test1.")).toBe(true);
      const opened = decryptBlob(token, pem);
      expect(opened).toEqual({ kid: "sup-test1", json: JSON.parse(PAYLOAD) });
      expect(parseBlob(token).flag).toBe(compress ? 1 : 0);
    }
    // A text around the token (the whole support text) opens too.
    const token = await encryptSupportPayload(PAYLOAD, key);
    expect(decryptBlob(findBlob(`Версия: 1\r\n${token}\r\nконец`), pem).json).toEqual(
      JSON.parse(PAYLOAD),
    );
  });

  it("is not readable without the key: nothing of the payload is in the token", async () => {
    const { key } = pair("sup-test1");
    const token = await encryptSupportPayload(PAYLOAD, key, { compress: false });
    const body = Buffer.from(token.split(".")[2] ?? "", "base64url");
    for (const word of ["scans", "accepted", "7020", "2026-09", "hostVersion"]) {
      expect(token).not.toContain(word);
      expect(body.includes(Buffer.from(word))).toBe(false);
    }
    // Two encryptions of one payload differ: a fresh ephemeral key and nonce each time.
    expect(await encryptSupportPayload(PAYLOAD, key)).not.toBe(
      await encryptSupportPayload(PAYLOAD, key),
    );
  });

  it("does not open with another key", async () => {
    const { key } = pair("sup-test1");
    const other = pair("sup-test1");
    const token = await encryptSupportPayload(PAYLOAD, key);
    expect(() => decryptBlob(token, other.pem)).toThrow();
  });

  it("fails on a changed key id, flag, ephemeral key, nonce or ciphertext", async () => {
    const { pem, key } = pair("sup-test1");
    const token = await encryptSupportPayload(PAYLOAD, key, { compress: false });
    const [version, kid, body] = token.split(".");
    const bytes = Buffer.from(body ?? "", "base64url");
    const rebuilt = (changed: Buffer, id = kid): string =>
      `${version}.${id}.${changed.toString("base64url")}`;
    const flip = (at: number): Buffer => {
      const copy = Buffer.from(bytes);
      copy[at] = (copy[at] ?? 0) ^ 0x01;
      return copy;
    };
    expect(decryptBlob(token, pem).kid).toBe("sup-test1");
    // Another key id (the label is in the key derivation and the AAD).
    expect(() => decryptBlob(rebuilt(bytes, "sup-test2"), pem)).toThrow();
    // The flag, the ephemeral key, the nonce, the ciphertext and the tag.
    for (const at of [0, 1 + 20, 1 + 65 + 3, 1 + 65 + 12 + 2, bytes.length - 1]) {
      expect(() => decryptBlob(rebuilt(flip(at)), pem), `byte ${at}`).toThrow();
    }
    // A truncated token and another version are no token.
    expect(() => decryptBlob(rebuilt(bytes.subarray(0, 60)), pem)).toThrow();
    expect(() => decryptBlob(token.replace("MKS1", "MKS2"), pem)).toThrow();
    expect(() => decryptBlob(`${token}x`.slice(0, -1) + "!", pem)).toThrow();
  });

  it("refuses a key that is not a P-256 public key, a private one or an unknown field", () => {
    const { key } = pair("sup-a");
    expect(supportKeysetSchema.safeParse({ keys: [key], retiredKids: [] }).success).toBe(true);
    const bad = [
      { ...key, jwk: { ...key.jwk, d: "A".repeat(43) } },
      { ...key, jwk: { ...key.jwk, crv: "P-384" } },
      { ...key, jwk: { ...key.jwk, kty: "RSA" } },
      { ...key, extra: 1 },
      { ...key, kid: "has space" },
    ];
    for (const entry of bad) {
      expect(supportKeysetSchema.safeParse({ keys: [entry], retiredKids: [] }).success).toBe(false);
    }
    expect(supportKeysetSchema.safeParse({ keys: [key, key], retiredKids: [] }).success).toBe(
      false,
    );
    // A file that does not parse is an empty keyset: no statistics, never plaintext.
    expect(parseSupportKeyset({ keys: [bad[0]], retiredKids: [] })).toEqual({
      keys: [],
      retiredKids: [],
    });
  });

  it("uses the newest key that is not retired, and the production keyset is empty until the owner adds one", () => {
    const a = pair("sup-a").key;
    const b = pair("sup-b").key;
    expect(activeSupportKey({ keys: [a, b], retiredKids: [] })?.kid).toBe("sup-b");
    expect(activeSupportKey({ keys: [a, b], retiredKids: ["sup-b"] })?.kid).toBe("sup-a");
    expect(activeSupportKey({ keys: [a], retiredKids: ["sup-a"] })).toBeNull();
    expect(BUILT_IN_SUPPORT_KEYS).toEqual({ keys: [], retiredKids: [] });
  });

  it("prints the public entry of a private key, never the private half", () => {
    const { pem, key } = pair("ignored");
    const entry = publicEntry(pem, "sup-1");
    expect(entry).toEqual({ kid: "sup-1", jwk: key.jwk });
    expect(JSON.stringify(entry)).not.toContain('"d"');
    expect(publicEntry(pem).kid).toMatch(/^sup-[0-9a-f]{8}$/);
  });

  it("prints a readable table of the months", () => {
    const text = table(JSON.parse(PAYLOAD));
    expect(text).toContain("2026-09");
    expect(text).toContain("7020");
    expect(text).toContain("12.0");
    expect(text).toContain("станций 3, офисов 2, ТСД 1");
  });

  it("encodes base64url without padding", () => {
    expect(toBase64Url(Uint8Array.of(251, 255, 254))).toBe("-__-");
    expect(toBase64Url(Uint8Array.of(1))).toBe("AQ");
  });

  it("runs on the runtime's WebCrypto", () => {
    expect(typeof globalThis.crypto.subtle.deriveBits).toBe("function");
    expect(webcrypto.subtle).toBeDefined();
  });
});
