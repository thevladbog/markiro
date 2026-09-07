import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as domain from "../src/index.js";

const RAW = "010460000000001521SERIAL-42\u001d93Abcd";
const LONG_PROFILE = '010460000000001521SERIAL-42\u001d91Key1\u001d92Crypto(93)^FNC1"tail';

describe("duplicate product code", () => {
  it("compares the full code even when the item identity matches", () => {
    expect(domain).toHaveProperty("compareDuplicateKm", expect.any(Function));
    const changedTail = RAW.replace("Abcd", "Efgh");
    expect(domain.kmHash(domain.canonicalizeKm(RAW))).toBe(
      domain.kmHash(domain.canonicalizeKm(changedTail)),
    );
    expect(domain.compareDuplicateKm(RAW, changedTail)).toBe("mismatch");
    expect(domain.compareDuplicateKm(RAW, ` \t]d2${RAW}\t `)).toBe("match");
  });

  it.each([RAW, LONG_PROFILE, RAW.replace("SERIAL-42", 'Case(93)^FNC1"я')])(
    "preserves the complete payload %j",
    (raw) => {
      expect(domain.parseDuplicateKm(raw).raw).toBe(raw);
      expect(domain.duplicatePayloadDigest(`]d2${raw}`)).toBe(
        createHash("sha256").update(raw, "utf8").digest("hex"),
      );
    },
  );

  it.each([
    "010460000000001521SERIAL-42",
    "010460000000001521SERIAL-42\u001d91Key1",
    "010460000000001521SERIAL-42\u001d92Tail",
  ])("rejects an incomplete crypto profile %j", (raw) => {
    expect(() => domain.parseDuplicateKm(raw)).toThrowError(
      expect.objectContaining({ code: "KM_REPRINT_INCOMPLETE" }),
    );
    expect(domain.compareDuplicateKm(RAW, raw)).toBe("invalid");
  });

  it.each([
    "",
    `${RAW}\u001d93Again`,
    `${RAW}\u001d`,
    RAW.replace("\u001d", "\u001d\u001d"),
    RAW.replace("93Abcd", "93"),
    `${RAW}\n`,
    `${RAW}\0`,
    `${RAW}\ufffd`,
    `${RAW}\ud800`,
    `${RAW}\udc00`,
    `${RAW}${"я".repeat(512)}`,
  ])("does not confirm malformed scanner input %j", (raw) => {
    expect(domain.compareDuplicateKm(RAW, raw)).toBe("invalid");
  });

  it("preserves AI order and case rather than comparing a map of fields", () => {
    const reversed = '010460000000001521SERIAL-42\u001d92Crypto(93)^FNC1"tail\u001d91Key1';
    expect(domain.compareDuplicateKm(LONG_PROFILE, reversed)).toBe("mismatch");
    expect(domain.compareDuplicateKm(RAW, RAW.replace("Abcd", "abcd"))).toBe("mismatch");
  });

  it("distinguishes corrupt saved payload from a bad operator scan", () => {
    expect(() => domain.compareDuplicateKm("corrupt saved payload", RAW)).toThrowError(
      expect.objectContaining({ code: "KM_NO_GTIN" }),
    );
  });

  it("keeps the existing exact 1024-byte canonical payload limit", () => {
    const prefix = "010460000000001521SERIAL-42\u001d93";
    const atLimit = prefix + "A".repeat(1024 - prefix.length);
    expect(domain.parseDuplicateKm(atLimit).raw).toHaveLength(1024);
    expect(() => domain.parseDuplicateKm(atLimit + "A")).toThrowError(
      expect.objectContaining({ code: "KM_TOO_LONG" }),
    );
  });
});

describe("product label digests", () => {
  it("hashes canonical JSON without losing nested changes or array order", () => {
    const canonical = '{"a":{"x":1,"y":2},"z":[2,1]}';
    const expected = createHash("sha256").update(canonical).digest("hex");
    expect(domain.productLabelValueDigest({ z: [2, 1], a: { y: 2, x: 1 } })).toBe(expected);
    expect(domain.productLabelValueDigest({ a: { x: 1, y: 2 }, z: [2, 1] })).toBe(expected);
    expect(domain.productLabelValueDigest({ a: { x: 1, y: 2 }, z: [1, 2] })).not.toBe(expected);
  });

  it.each([undefined, NaN, Infinity, () => {}, { a: undefined }, [undefined], new Date()])(
    "rejects values that cannot be retained as exact JSON (%j)",
    (value) =>
      expect(() => domain.productLabelValueDigest(value)).toThrowError(
        expect.objectContaining({ code: "PRODUCT_LABEL_JSON_INVALID" }),
      ),
  );

  it("rejects cycles but permits the same JSON value in two different fields", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => domain.productLabelValueDigest(cyclic)).toThrowError(
      expect.objectContaining({ code: "PRODUCT_LABEL_JSON_INVALID" }),
    );
    const child = { a: 1 };
    expect(domain.productLabelValueDigest([child, child])).toBe(
      createHash("sha256").update('[{"a":1},{"a":1}]').digest("hex"),
    );
  });

  it("hashes printer bytes without UTF-8 expansion", () => {
    const bytes = Uint8Array.of(0, 127, 128, 255);
    expect(domain.productLabelBytesDigest(bytes)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
});
