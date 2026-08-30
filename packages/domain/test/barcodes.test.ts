import { describe, expect, it } from "vitest";
import bwipjs from "bwip-js";
import { DomainError } from "../src/errors.js";
import {
  renderCode128Svg,
  renderDataMatrixSvg,
  renderLiteralDataMatrixSvg,
  renderQrSvg,
} from "../src/index.js";
import { decodeDataMatrixAscii } from "./helpers/decode-data-matrix.js";

const GS = String.fromCharCode(0x1d); // ASCII 0x1D separator
const GTIN14 = "04006381333931"; // valid GS1 mod-10 check digit
const SERIAL = "KYC9X7MQ";
const GTIN14_2 = "04600682000013"; // valid GS1 mod-10 check digit
const PRODUCTION_LIKE_KM = `01${GTIN14_2}21${SERIAL}${GS}93Z`;
const LITERAL_URL = "https://markiro.app/d/MKR-PD-01/2026.08.01/2026-08-15";

describe("barcode SVG renderers", () => {
  it("renders a DataMatrix SVG containing a crypto-tail KM with a GS byte", () => {
    const svg = renderDataMatrixSvg(`01${GTIN14}21${SERIAL}${GS}93Abcd`);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
  });
  it("encodes the GS as a real AI separator: dropping it changes the symbol", () => {
    // Same characters, minus the GS: AI 21's serial now runs on into "93Abcd"
    // instead of being split into a separate AI 93. If the GS separator were
    // silently dropped by the renderer, both inputs would produce the same
    // gs1datamatrix symbol — they must not.
    const withGs = renderDataMatrixSvg(`01${GTIN14}21${SERIAL}${GS}93Abcd`);
    const withoutGs = renderDataMatrixSvg(`01${GTIN14}21${SERIAL}93Abcd`);
    expect(withGs).not.toBe(withoutGs);
  });
  it("renders literal parentheses and carets from valid KM values without treating them as control syntax", () => {
    const svg = renderDataMatrixSvg(`01${GTIN14_2}21SER)IAL${GS}93Ab(cd^ef`);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
  });
  it("keeps the explicit-FNC1 path equivalent to bwip-js's GS1 encoder for ordinary values", () => {
    const raw = `01${GTIN14}21${SERIAL}${GS}93Abcd`;
    const reference = bwipjs.toSVG({
      bcid: "gs1datamatrix",
      text: `(01)${GTIN14}(21)${SERIAL}(93)Abcd`,
      scale: 3,
    });
    expect(renderDataMatrixSvg(raw)).toBe(reference);
  });
  it("feeds every trailing AI into the symbol, not just the last one", () => {
    // Same GTIN/serial, but the multi-AI variant carries 91/92/93 in order.
    // If the renderer only encoded the last trailing AI (or dropped earlier
    // ones), the two symbols would be indistinguishable.
    const singleAi = renderDataMatrixSvg(`01${GTIN14_2}21${SERIAL}${GS}93Z`);
    const multiAi = renderDataMatrixSvg(`01${GTIN14_2}21${SERIAL}${GS}91X${GS}92Y${GS}93Z`);
    expect(multiAi.startsWith("<svg")).toBe(true);
    expect(multiAi).toContain("</svg>");
    expect(multiAi).not.toBe(singleAi);
  });
  it("surfaces a DomainError (not a raw bwip-js GS1notNumeric) for a non-numeric GTIN", () => {
    // A malformed stored KM whose AI-01 slot isn't 14 digits must fail at the
    // parse boundary with a DomainError, so callers (OrderDetail's ItemCode,
    // the slip renderer) can catch it uniformly instead of a bwip-js internal.
    expect(() => renderDataMatrixSvg(`01ABCDEFGHIJKLMN21${SERIAL}${GS}93Z`)).toThrow(DomainError);
  });
  it("renders a ]d2-prefixed KM identically to the un-prefixed one", () => {
    const raw = `01${GTIN14_2}21${SERIAL}${GS}93Z`;
    expect(renderDataMatrixSvg(`]d2${raw}`)).toBe(renderDataMatrixSvg(raw));
  });
  it("renders a QR SVG", () => {
    expect(renderQrSvg("MARKIRO-BADGE-4412").startsWith("<svg")).toBe(true);
  });
  it("renders a Code128 SVG for an order number", () => {
    expect(renderCode128Svg("ORD-26-0037").startsWith("<svg")).toBe(true);
  });
  it("renders a literal Data Matrix exactly as bwip-js without GS1 transformation", () => {
    expect(renderLiteralDataMatrixSvg(LITERAL_URL)).toBe(
      bwipjs.toSVG({ bcid: "datamatrix", text: LITERAL_URL, scale: 3 }),
    );
    expect(renderLiteralDataMatrixSvg(LITERAL_URL)).not.toBe(
      renderDataMatrixSvg(PRODUCTION_LIKE_KM),
    );
  });

  it("recovers the exact literal URL from the rendered Data Matrix symbol", () => {
    const renderedSymbol = bwipjs.raw({
      bcid: "datamatrix",
      text: LITERAL_URL,
      scale: 3,
    });

    const decoded = decodeDataMatrixAscii(renderedSymbol);
    expect(decoded).toBe(LITERAL_URL);
    expect(decoded.startsWith("]d2")).toBe(false);
    expect(decoded.startsWith(GS)).toBe(false);
    expect(decoded).not.toContain("^FNC1");
  });

  it("rejects literal Data Matrix input outside its UTF-8 byte limit", () => {
    expect(renderLiteralDataMatrixSvg("я".repeat(256))).toMatch(/^<svg/);
    for (const text of ["", `${"я".repeat(256)}a`]) {
      expect(() => renderLiteralDataMatrixSvg(text)).toThrow(
        expect.objectContaining({
          code: "LITERAL_DATA_MATRIX_TEXT_INVALID",
        }),
      );
      expect(() => renderLiteralDataMatrixSvg(text)).toThrow(DomainError);
    }
  });

  it("can omit the human-readable Code128 caption without changing the default", () => {
    expect(renderCode128Svg("ORD-26-0037")).toContain('viewBox="0 0 290 74"');
    expect(renderCode128Svg("ORD-26-0037", { includeText: false })).toContain(
      'viewBox="0 0 290 58"',
    );
  });
});
