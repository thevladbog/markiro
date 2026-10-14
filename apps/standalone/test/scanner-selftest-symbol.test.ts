import { describe, expect, it } from "vitest";

import {
  parseSymbolSvg,
  symbolPdf,
  symbolSvg,
} from "../src/floor/setup/scanner-selftest-symbol.js";
import { makeTestDataMatrix } from "../src/floor/setup/scanner-selftest.js";

describe("the self-test's symbol", () => {
  it("is a GS1 DataMatrix the domain's encoder makes, as the labels carry it", () => {
    const svg = symbolSvg("dm", makeTestDataMatrix());
    expect(svg).toContain("<svg");
    const geometry = parseSymbolSvg(svg ?? "");
    expect(geometry?.width).toBeGreaterThan(10);
    expect(geometry?.paths[0]?.strokeWidth).toBeNull();
    expect(geometry?.paths[0]?.subpaths.length).toBeGreaterThan(10);
  });

  it("is a Code 128 of lines for the plain code", () => {
    const geometry = parseSymbolSvg(symbolSvg("plain", "MKR-7Q4F2N") ?? "");
    expect(geometry?.paths.some((path) => path.strokeWidth !== null)).toBe(true);
  });

  it("reads nothing it does not know", () => {
    expect(parseSymbolSvg("<svg></svg>")).toBeNull();
    expect(parseSymbolSvg('<svg viewBox="0 0 4 4"><path d="M0 0C1 1 2 2 3 3"/></svg>')).toBeNull();
  });

  it("makes a one-page vector PDF with the word TEST and the code in words", async () => {
    const code = makeTestDataMatrix();
    const blob = symbolPdf("dm", code);
    const text = await blob?.text();
    expect(text?.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("(TEST) Tj");
    expect(text).toContain("<GS>");
    expect(text).toContain("%%EOF");
    expect(text).toContain("f*");
    const declared = /startxref\n(\d+)/.exec(text ?? "")?.[1];
    expect(text?.slice(Number(declared), Number(declared) + 4)).toBe("xref");
  });
});
