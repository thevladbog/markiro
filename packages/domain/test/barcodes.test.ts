import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors.js";
import { renderCode128Svg, renderDataMatrixSvg, renderQrSvg } from "../src/barcodes/svg.js";

const GS = String.fromCharCode(0x1d); // ASCII 0x1D separator
const GTIN14 = "04006381333931"; // valid GS1 mod-10 check digit
const SERIAL = "KYC9X7MQ";
const GTIN14_2 = "04600682000013"; // valid GS1 mod-10 check digit

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
  it("rejects a KM whose AI value contains a literal paren (bwip-js GS1 element-string injection guard)", () => {
    expect(() => renderDataMatrixSvg(`01${GTIN14}21${SERIAL}${GS}93Ab(cd`)).toThrow(/parenthesis/);
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
});
