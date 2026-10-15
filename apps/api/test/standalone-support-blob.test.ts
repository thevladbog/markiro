import { createHash, generateKeyPairSync } from "node:crypto";
import type * as Zlib from "node:zlib";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_INFLATED_BYTES,
  MAX_PAYLOAD_BYTES,
  openSupportBlob,
  type SupportPrivateKey,
} from "../src/modules/standalone-diagnostics/support-blob";
import {
  TOKEN_OFFSETS,
  flipTokenByte,
  nonCanonicalToken,
  sealSupportToken,
  supportPayloadV2,
  supportText,
} from "./support/standalone-support-token";

// A pass-through spy: a 16 KiB token cannot inflate past ~16 MiB, so the result alone cannot
// tell a bounded inflate from an unbounded one; the ceiling must be passed to zlib itself.
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof Zlib>();
  return { ...actual, inflateRawSync: vi.fn(actual.inflateRawSync) };
});

function pair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { key: { kid, privateKey } satisfies SupportPrivateKey, publicKey };
}
const reason = (result: ReturnType<typeof openSupportBlob>) => (result.ok ? null : result.reason);

describe("opening a support token (plan ДИАГ А1)", () => {
  const a = pair("sup-a");
  const payload = JSON.stringify(supportPayloadV2());

  it("opens a compressed and a plain token found inside the whole support text", () => {
    for (const compress of [true, false]) {
      const token = sealSupportToken(payload, a.publicKey, "sup-a", compress);
      const opened = openSupportBlob(supportText(token), [a.key]);
      expect(opened).toMatchObject({ ok: true, kid: "sup-a", compressed: compress });
      if (!opened.ok) throw new Error("not opened");
      expect(opened.json).toEqual(JSON.parse(payload));
      expect(opened.blobSha256).toBe(createHash("sha256").update(token).digest("hex"));
    }
  });

  it("takes the first token of the text and says no_token when there is none", () => {
    const first = sealSupportToken(JSON.stringify({ n: 1 }), a.publicKey, "sup-a");
    const second = sealSupportToken(JSON.stringify({ n: 2 }), a.publicKey, "sup-a");
    const opened = openSupportBlob(`${first}\n${second}`, [a.key]);
    expect(opened.ok && opened.json).toEqual({ n: 1 });
    expect(reason(openSupportBlob("Версия 1\r\nни одного токена", [a.key]))).toBe("no_token");
    expect(reason(openSupportBlob("", [a.key]))).toBe("no_token");
  });

  it("answers undecryptable for a change in any zone of the token, never an exception", () => {
    const token = sealSupportToken(payload, a.publicKey, "sup-a", false);
    const total = Buffer.from(token.split(".")[2] ?? "", "base64url").length;
    const zones = {
      flag: TOKEN_OFFSETS.flag,
      epk: TOKEN_OFFSETS.epk + 20,
      iv: TOKEN_OFFSETS.iv + 3,
      ciphertext: TOKEN_OFFSETS.sealed + 2,
      tag: total - 1,
    };
    for (const [zone, at] of Object.entries(zones)) {
      expect(reason(openSupportBlob(flipTokenByte(token, at), [a.key])), zone).toBe(
        "undecryptable",
      );
    }
  });

  it("rejects an unknown flag, a short token, a non-canonical body and an off-curve key", () => {
    const token = sealSupportToken(payload, a.publicKey, "sup-a", false);
    const bytes = Buffer.from(token.split(".")[2] ?? "", "base64url");
    const rebuilt = (changed: Buffer) => `MKS1.sup-a.${changed.toString("base64url")}`;
    const flagTwo = Buffer.from(bytes);
    flagTwo[0] = 2;
    expect(reason(openSupportBlob(rebuilt(flagTwo), [a.key]))).toBe("token_malformed");
    expect(reason(openSupportBlob(rebuilt(bytes.subarray(0, 60)), [a.key]))).toBe(
      "token_malformed",
    );
    // Pad the plaintext until the body has unused trailing bits, then alias its last character.
    let aliased: string | null = null;
    for (let pad = 0; pad < 4 && aliased === null; pad += 1) {
      const candidate = sealSupportToken(
        `${payload}${" ".repeat(pad)}`,
        a.publicKey,
        "sup-a",
        false,
      );
      if ((candidate.split(".")[2] ?? "").length % 4 !== 0) aliased = nonCanonicalToken(candidate);
    }
    expect(aliased).not.toBeNull();
    expect(reason(openSupportBlob(aliased ?? "", [a.key]))).toBe("token_malformed");
    const offCurve = Buffer.from(bytes);
    offCurve.fill(0x11, 2, 66);
    expect(reason(openSupportBlob(rebuilt(offCurve), [a.key]))).toBe("undecryptable");
  });

  it("binds the key id: swapping it in the prefix fails, an unknown one is unknown_key", () => {
    const b = pair("sup-b");
    const sameKeyOtherKid: SupportPrivateKey = { kid: "sup-b", privateKey: a.key.privateKey };
    const token = sealSupportToken(payload, a.publicKey, "sup-a");
    const swapped = token.replace("MKS1.sup-a.", "MKS1.sup-b.");
    expect(reason(openSupportBlob(swapped, [a.key, sameKeyOtherKid]))).toBe("undecryptable");
    expect(reason(openSupportBlob(token, [b.key]))).toBe("unknown_key");
    expect(reason(openSupportBlob(token, []))).toBe("unknown_key");
  });

  it("a token under another key with the same kid is undecryptable; a rotated second key opens", () => {
    const impostor = pair("sup-a");
    const token = sealSupportToken(payload, a.publicKey, "sup-a");
    expect(reason(openSupportBlob(token, [impostor.key]))).toBe("undecryptable");
    const b = pair("sup-b");
    const second = sealSupportToken(payload, b.publicKey, "sup-b");
    expect(openSupportBlob(second, [a.key, b.key]).ok).toBe(true);
    expect(openSupportBlob(token, [a.key, b.key]).ok).toBe(true);
  });

  it("refuses a compression bomb without inflating it, and an oversized plain payload", () => {
    const bomb = sealSupportToken(Buffer.alloc(2 * 1024 * 1024, 0x20), a.publicKey, "sup-a", true);
    expect(bomb.length).toBeLessThan(16 * 1024);
    expect(reason(openSupportBlob(bomb, [a.key]))).toBe("payload_too_large");
    const plain = sealSupportToken(
      Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x20),
      a.publicKey,
      "sup-a",
      false,
    );
    expect(reason(openSupportBlob(plain, [a.key]))).toBe("token_too_large");
    const inflatedMedium = sealSupportToken(
      Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x20),
      a.publicKey,
      "sup-a",
      true,
    );
    expect(reason(openSupportBlob(inflatedMedium, [a.key]))).toBe("payload_too_large");
  });

  it("passes the inflate ceiling to zlib, so a bomb is stopped while it grows", () => {
    const bomb = sealSupportToken(Buffer.alloc(2 * 1024 * 1024, 0x20), a.publicKey, "sup-a", true);
    vi.mocked(inflateRawSync).mockClear();
    openSupportBlob(bomb, [a.key]);
    expect(inflateRawSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(inflateRawSync).mock.calls[0]?.[1]).toEqual({
      maxOutputLength: MAX_INFLATED_BYTES,
    });
  });

  it("refuses a token longer than 16 KiB before decoding it", () => {
    const token = sealSupportToken(
      Buffer.from(JSON.stringify({ pad: "x".repeat(13_000) })),
      a.publicKey,
      "sup-a",
      false,
    );
    expect(token.length).toBeGreaterThan(16 * 1024);
    expect(reason(openSupportBlob(token, [a.key]))).toBe("token_too_large");
  });

  it("separates a payload that is not UTF-8 or not JSON from an authentication failure", () => {
    const badUtf8 = sealSupportToken(Buffer.from([0xff, 0xfe, 0xfd]), a.publicKey, "sup-a", false);
    expect(reason(openSupportBlob(badUtf8, [a.key]))).toBe("payload_invalid");
    const notJson = sealSupportToken("{not json", a.publicKey, "sup-a", true);
    expect(reason(openSupportBlob(notJson, [a.key]))).toBe("payload_invalid");
  });

  it("never throws on mangled input of any shape", () => {
    const token = sealSupportToken(payload, a.publicKey, "sup-a");
    const body = Buffer.from(token.split(".")[2] ?? "", "base64url");
    for (let at = 0; at < body.length; at += 7) {
      const copy = Buffer.from(body);
      copy[at] = (copy[at] ?? 0) ^ 0xff;
      expect(() =>
        openSupportBlob(`MKS1.sup-a.${copy.toString("base64url")}`, [a.key]),
      ).not.toThrow();
    }
    for (const junk of ["MKS1.", "MKS1..", "MKS1.x.", "MKS1.sup-a.!!!", "MKS1.sup-a.AA"]) {
      expect(() => openSupportBlob(junk, [a.key])).not.toThrow();
    }
  });
});
