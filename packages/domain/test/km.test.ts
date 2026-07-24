import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors.js";
import { kmKey, parseKm, parseKmSegments } from "../src/gs1/km.js";

const GS = "\u001d";
// Synthetic but structurally exact Chestny ZNAK beverage code:
// AI 01 (GTIN-14, fixed 14) + AI 21 (serial, GS-terminated) + AI 93 (crypto tail).
const RAW = `010460068200001321abcDEF1234567${GS}93AbCd`;

describe("parseKm", () => {
  it("parses GTIN, serial and trailing AIs", () => {
    const km = parseKm(RAW);
    expect(km.gtin14).toBe("04600682000013");
    expect(km.serial).toBe("abcDEF1234567");
    expect(km.ais["93"]).toBe("AbCd");
    expect(km.raw).toBe(RAW);
  });
  it("strips the ]d2 symbology identifier", () => {
    expect(parseKm(`]d2${RAW}`).gtin14).toBe("04600682000013");
  });
  it("parses a serial terminated by end-of-string (no crypto tail)", () => {
    const km = parseKm("0104600682000013" + "21XyZ9");
    expect(km.serial).toBe("XyZ9");
  });
  it("survives consecutive GS separators in the trailing AIs", () => {
    const km = parseKm("0104600682000013" + "21XyZ9" + GS + GS + "93AbCd");
    expect(km.serial).toBe("XyZ9");
    expect(km.ais["93"]).toBe("AbCd");
  });
  it("rejects empty input with KM_EMPTY", () => {
    expect(() => parseKm("")).toThrowError(expect.objectContaining({ code: "KM_EMPTY" }));
  });
  it("rejects codes not starting with AI 01 with KM_NO_GTIN", () => {
    expect(() => parseKm("21abc")).toThrowError(expect.objectContaining({ code: "KM_NO_GTIN" }));
  });
  it("rejects a missing serial with KM_NO_SERIAL", () => {
    expect(() => parseKm("0104600682000013")).toThrowError(
      expect.objectContaining({ code: "KM_NO_SERIAL" }),
    );
  });
  it("rejects an empty serial (GS right after AI 21) with KM_NO_SERIAL", () => {
    expect(() => parseKm("0104600682000013" + "21" + GS + "93AbCd")).toThrowError(
      expect.objectContaining({ code: "KM_NO_SERIAL" }),
    );
  });
  it("propagates GTIN check-digit failures as DomainError", () => {
    expect(() => parseKm("010460068200001421abc")).toThrow(DomainError);
  });
});

describe("kmKey", () => {
  it("builds the canonical dedup key", () => {
    expect(kmKey(parseKm(RAW))).toBe("010460068200001321abcDEF1234567");
  });
});

describe("parseKmSegments", () => {
  // Three trailing AIs (91/92/93), each GS-separated, to prove ordering
  // survives past the first — this is the shared parser both `parseKm` and
  // the DataMatrix renderer (barcodes/svg.ts) rely on.
  const multiAiRaw = `010460068200001321abcDEF1234567${GS}91X${GS}92Y${GS}93Z`;

  it("returns gtin14, serial and multiple trailing AIs in encounter order", () => {
    const segments = parseKmSegments(multiAiRaw);
    expect(segments.gtin14).toBe("04600682000013");
    expect(segments.serial).toBe("abcDEF1234567");
    expect(segments.ais).toEqual([
      { ai: "91", value: "X" },
      { ai: "92", value: "Y" },
      { ai: "93", value: "Z" },
    ]);
  });

  it("parses identically whether or not a ]d2 symbology-identifier prefix is present", () => {
    expect(parseKmSegments(`]d2${multiAiRaw}`)).toEqual(parseKmSegments(multiAiRaw));
  });

  it("rejects a non-numeric 14-char AI-01 GTIN with a clean DomainError", () => {
    // Shape guard: the AI-01 slot must be 14 digits. Without it, a malformed
    // GTIN flows straight into the DataMatrix renderer, where bwip-js throws a
    // raw `GS1notNumeric` — this surfaces a DomainError at the parse boundary
    // instead. (Check-digit validation stays `parseKm`'s job, not this one's.)
    expect(() => parseKmSegments(`01ABCDEFGHIJKLMN21SER1${GS}93Z`)).toThrowError(
      expect.objectContaining({ code: "KM_BAD_GTIN" }),
    );
  });
});
