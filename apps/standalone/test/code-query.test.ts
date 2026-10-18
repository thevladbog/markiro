import { describe, expect, it } from "vitest";

import { canonicalizeKm, kmHash } from "@markiro/domain";

import {
  classifySearchInput,
  searchQuery,
  zonedDayStartMs,
} from "../src/office/codes/code-query.js";

const GS = "\u001d";
const KM = `0104600682000013215Abc!d${GS}93Tail`;
const HASH = kmHash(canonicalizeKm(KM));

describe("what was typed or scanned into «Поиск кодов»", () => {
  it("reads a code of marking as the station does, its group separator kept", () => {
    expect(classifySearchInput(KM)).toEqual({ kind: "code", codeHash: HASH });
    // The AIM prefix and edge spaces a scanner adds change nothing.
    expect(classifySearchInput(`]d2${KM}`)).toEqual({ kind: "code", codeHash: HASH });
    expect(classifySearchInput(`  ${KM}\t`)).toEqual({ kind: "code", codeHash: HASH });
    // Without the separator the tail is part of the serial: another code.
    expect(classifySearchInput(KM.replace(GS, ""))).not.toEqual({
      kind: "code",
      codeHash: HASH,
    });
  });

  it("reads a GTIN of any length as GTIN-14, and an SSCC with or without (00)", () => {
    expect(classifySearchInput("4600682000013")).toEqual({
      kind: "gtin",
      gtin14: "04600682000013",
    });
    expect(classifySearchInput("04600682000013")).toEqual({
      kind: "gtin",
      gtin14: "04600682000013",
    });
    const sscc = "046006820000015000";
    for (const typed of [sscc, `(00)${sscc}`, `00${sscc}`, `]C1(00)${sscc}`]) {
      expect(classifySearchInput(typed)).toEqual({ kind: "sscc", sscc });
    }
  });

  it("reads a shift's number in any case, with the station's /S or without", () => {
    expect(classifySearchInput("oct26-3")).toEqual({ kind: "shift", number: "OCT26-3" });
    expect(classifySearchInput(" OCT26-004/s ")).toEqual({
      kind: "shift",
      number: "OCT26-004/S",
    });
  });

  it("says nothing was typed, and that anything else is no criterion", () => {
    expect(classifySearchInput("   ")).toEqual({ kind: "empty" });
    for (const typed of ["молоко", "4600682000014", "OCT26", "12345", "OCT26-1234567"]) {
      expect(classifySearchInput(typed)).toEqual({ kind: "unknown" });
    }
  });
});

describe("a day's start in the organization's zone", () => {
  it("is the zone's midnight, whatever this PC's zone", () => {
    expect(new Date(zonedDayStartMs("2026-10-08", "Europe/Moscow")).toISOString()).toBe(
      "2026-10-07T21:00:00.000Z",
    );
    expect(new Date(zonedDayStartMs("2026-10-08", "UTC")).toISOString()).toBe(
      "2026-10-08T00:00:00.000Z",
    );
    // Summer and winter time on either side of a change.
    expect(new Date(zonedDayStartMs("2026-03-29", "Europe/Berlin")).toISOString()).toBe(
      "2026-03-28T23:00:00.000Z",
    );
    expect(new Date(zonedDayStartMs("2026-03-30", "Europe/Berlin")).toISOString()).toBe(
      "2026-03-29T22:00:00.000Z",
    );
    expect(new Date(zonedDayStartMs("2024-02-29", "Asia/Vladivostok")).toISOString()).toBe(
      "2024-02-28T14:00:00.000Z",
    );
  });
});

describe("the query a search sends", () => {
  const zone = "Europe/Moscow";

  it("sends the criterion and the period's days as [first midnight, the midnight after the last)", () => {
    expect(
      searchQuery({ kind: "gtin", gtin14: "04600682000013" }, "2026-10-08", "2026-10-09", zone, 2),
    ).toEqual({
      gtin: "04600682000013",
      fromMs: Date.parse("2026-10-07T21:00:00.000Z"),
      toMs: Date.parse("2026-10-09T21:00:00.000Z"),
      page: 2,
    });
    expect(searchQuery({ kind: "empty" }, "2026-10-08", "", zone, 1)).toEqual({
      fromMs: Date.parse("2026-10-07T21:00:00.000Z"),
    });
    expect(searchQuery({ kind: "sscc", sscc: "046006820000015000" }, "", "", zone, 1)).toEqual({
      sscc: "046006820000015000",
    });
    expect(searchQuery({ kind: "shift", number: "OCT26-004/S" }, "", "", zone, 1)).toEqual({
      shift: "OCT26-004/S",
    });
    expect(searchQuery({ kind: "code", codeHash: HASH }, "", "", zone, 1)).toEqual({
      codeHash: HASH,
    });
  });

  it("asks nothing without a criterion or with a period that ends before it starts", () => {
    expect(searchQuery({ kind: "empty" }, "", "", zone, 1)).toBeNull();
    expect(searchQuery({ kind: "unknown" }, "2026-10-08", "", zone, 1)).toBeNull();
    expect(
      searchQuery({ kind: "gtin", gtin14: "04600682000013" }, "2026-10-09", "2026-10-08", zone, 1),
    ).toBeNull();
  });
});
