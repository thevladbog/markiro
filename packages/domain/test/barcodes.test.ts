import { describe, expect, it } from "vitest";
import { renderCode128Svg, renderDataMatrixSvg, renderQrSvg } from "../src/barcodes/svg.js";

describe("barcode SVG renderers", () => {
  it("renders a DataMatrix SVG containing a crypto-tail KM with a GS byte", () => {
    const GS = "\x1D"; // ASCII 0x1D separator
    const svg = renderDataMatrixSvg(`01046500751959232${GS}1KYC9X7MQ${GS}93Abcd`);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
  });
  it("renders a QR SVG", () => {
    expect(renderQrSvg("MARKIRO-BADGE-4412").startsWith("<svg")).toBe(true);
  });
  it("renders a Code128 SVG for an order number", () => {
    expect(renderCode128Svg("ORD-26-0037").startsWith("<svg")).toBe(true);
  });
});
