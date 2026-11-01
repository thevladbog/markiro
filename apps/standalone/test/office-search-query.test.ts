import { canonicalizeKm, formatShiftTaskBarcode, kmHash } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { officeSearchHref, readOfficeSearch } from "../src/office/search/search-query.js";

const SHIFT = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";

describe("Office system search criteria", () => {
  it("reads a printed shift task, including the scanner's AIM prefix", () => {
    expect(readOfficeSearch(`]d2${formatShiftTaskBarcode(SHIFT)}\r\n`)).toEqual({
      ok: true,
      request: { kind: "shift", id: SHIFT },
    });
  });

  it("sends marking codes as domain hashes, preserving GS and excluding raw text", () => {
    const raw = "]d2010460068200001321MRK-1\u001d93dGVz";
    const reading = readOfficeSearch(raw);
    expect(reading).toEqual({
      ok: true,
      request: { kind: "code", codeHash: kmHash(canonicalizeKm(raw)) },
    });
    expect(JSON.stringify(reading)).not.toContain("MRK-1");
  });

  it.each(["\r", "\n", "\r\n"])("hashes a marking code with transport suffix %j", (suffix) => {
    const raw = "]d2010460068200001321MRK-1\u001d93dGVz";
    const reading = readOfficeSearch(raw + suffix);
    expect(reading).toEqual({
      ok: true,
      request: { kind: "code", codeHash: kmHash(canonicalizeKm(raw)) },
    });
    expect(JSON.stringify(reading)).not.toContain("MRK-1");
  });

  it.each([
    "010460068200001421MRK-1",
    "]d2010460068200001421MRK-1\r\n",
    "01O460068200001321MRK-1",
    "(01)04600682000013(21)MRK-1",
  ])("never falls back to metadata text for an unreadable marking code %j", (raw) => {
    expect(readOfficeSearch(raw)).toEqual({ ok: false, reason: "invalid" });
  });

  it("distinguishes an SSCC, a GTIN and metadata text", () => {
    expect(readOfficeSearch("(00)146006820000000409")).toEqual({
      ok: true,
      request: { kind: "sscc", sscc: "146006820000000409" },
    });
    expect(readOfficeSearch("04600682000013")).toEqual({
      ok: true,
      request: { kind: "gtin", gtin14: "04600682000013" },
    });
    expect(readOfficeSearch("  Дикий крест  ")).toEqual({
      ok: true,
      request: { kind: "text", text: "Дикий крест" },
    });
  });

  it.each([
    "a",
    "x".repeat(121),
    "bad\u001dcode",
    "markiro:shift:v1:not-an-id",
    "broken\uFFFDscan",
  ])("refuses invalid input %s without a host request", (raw) => {
    expect(readOfficeSearch(raw)).toEqual({ ok: false, reason: "invalid" });
  });

  it("keeps an empty input separate from unreadable data", () => {
    expect(readOfficeSearch(" \r\n")).toEqual({ ok: false, reason: "empty" });
  });
  it("uses the host's Unicode text bounds and refuses C1 control characters", () => {
    expect(readOfficeSearch("текст\u0085ещё")).toEqual({ ok: false, reason: "invalid" });
    const text = "🍏".repeat(120);
    expect(readOfficeSearch(text)).toEqual({ ok: true, request: { kind: "text", text } });
  });
});

describe("search navigation", () => {
  it("preserves provenance instead of opening an imported object as local", () => {
    expect(officeSearchHref({ kind: "pallet", id: SHIFT, source: "cloud" })).toBe(
      `/cloud-pallets/${SHIFT}`,
    );
    expect(officeSearchHref({ kind: "warehouse_pallet", id: SHIFT })).toBe(
      `/codes/warehouse-pallet/${SHIFT}`,
    );
    expect(
      officeSearchHref({
        kind: "document",
        id: "saved-file",
        targetType: "shift",
        targetId: SHIFT,
        source: "local",
      }),
    ).toBe(`/shifts?shift=${SHIFT}&tab=exports`);
    expect(officeSearchHref({ kind: "code", codeHash: "ab".repeat(32), source: "cloud" })).toBe(
      `/codes?codeHash=${"ab".repeat(32)}&source=cloud&period=all`,
    );
  });
});
