import { describe, expect, it } from "vitest";

import {
  code128ModuleCount,
  elementBoundsMm,
  GS1_128_QUIET_ZONE_MODULES,
  generateTspl,
  generateZpl,
  sampleLabelData,
  type LabelBarcodeElement,
  type LabelTemplateSpec,
} from "../src/index.js";

describe("code128ModuleCount", () => {
  /**
   * The number the whole centring story rests on: an SSCC is 18 digits, the
   * emitters prefix the `(00)` application identifier, and a 20-digit GS1-128
   * in subset C is start(11) + FNC1(11) + 10×11 + check(11) + stop(13) = 156.
   */
  it("costs a 20-digit GS1-128 SSCC payload at exactly 156 modules", () => {
    expect(code128ModuleCount("0".repeat(20), true)).toBe(156);
    expect(code128ModuleCount(`00${"3460068200000000".padEnd(18, "1")}`, true)).toBe(156);
  });

  it("charges 11 modules for the FNC1 flag only when the payload is GS1", () => {
    expect(code128ModuleCount("0".repeat(20), false)).toBe(145);
    expect(code128ModuleCount("0".repeat(20), true) - code128ModuleCount("0".repeat(20))).toBe(11);
  });

  it("packs digit PAIRS in subset C but one symbol per non-numeric character", () => {
    // Two more digits = one more 11-module subset-C symbol.
    expect(code128ModuleCount("1234") - code128ModuleCount("12")).toBe(11);
    // An odd digit cannot share a symbol, so it costs a whole one.
    expect(code128ModuleCount("123")).toBe(code128ModuleCount("1234"));
    // Non-numeric falls back to one symbol per character.
    expect(code128ModuleCount("AB")).toBe(35 + 2 * 11);
  });

  it("pins GS1's 10X quiet zone requirement", () => {
    expect(GS1_128_QUIET_ZONE_MODULES).toBe(10);
  });
});

/**
 * `moduleWidthMm` has to reach BOTH emitters and the bounds heuristic, or the
 * admin preview and the print diverge on exactly the element the templates
 * now position by arithmetic.
 */
describe("barcode moduleWidthMm", () => {
  function specWith(barcode: LabelBarcodeElement, dpi: 203 | 300 = 203): LabelTemplateSpec {
    return { widthMm: 58, heightMm: 40, dpi, language: "zpl", elements: [barcode] };
  }

  const base: LabelBarcodeElement = {
    kind: "barcode",
    id: "bc",
    xMm: 5,
    yMm: 5,
    format: "code128",
    data: "sscc",
    sizeMm: 5,
  };

  it("emits ^BY in ZPL and the narrow/wide pair in TSPL, in whole dots", async () => {
    const spec = specWith({ ...base, moduleWidthMm: 0.2502 });
    expect(await generateZpl(spec, sampleLabelData())).toContain("^BY2^BCN,");
    expect(await generateTspl(spec, sampleLabelData())).toContain('"128",40,0,0,2,2,');

    const spec300 = specWith({ ...base, moduleWidthMm: 0.254 }, 300);
    expect(await generateZpl(spec300, sampleLabelData())).toContain("^BY3^BCN,");
    expect(await generateTspl(spec300, sampleLabelData())).toContain('"128",59,0,0,3,3,');
  });

  /**
   * The compatibility contract: an element that declares no module width must
   * emit byte-identically to what shipped before the field existed — no `^BY`
   * at all in ZPL, TSPL's historical fixed `2,2`.
   */
  it("emits exactly the previous output when no module width is declared", async () => {
    const spec = specWith(base);
    const zpl = await generateZpl(spec, sampleLabelData());
    expect(zpl).not.toContain("^BY");
    expect(zpl).toContain("^FO40,40^BCN,40,N,N,N");
    expect(await generateTspl(spec, sampleLabelData())).toContain('"128",40,0,0,2,2,');
  });

  it("reports a real printed width in bounds once a module width is known", () => {
    const data = sampleLabelData();
    const withModule = elementBoundsMm({ ...base, moduleWidthMm: 0.2502 }, data);
    // 156 modules x 0.2502 mm — the SSCC's deterministic width, not a fudge.
    expect(withModule.w).toBeCloseTo(156 * 0.2502, 6);

    // Without one there is no X-dimension to multiply, so the legacy
    // character-count approximation still stands.
    const withoutModule = elementBoundsMm(base, data);
    expect(withoutModule.w).toBeCloseTo(18 * 0.7 * 5, 6);
  });

  it("costs an ean13 element at its fixed 95 modules", () => {
    const bounds = elementBoundsMm(
      { ...base, format: "ean13", data: "product.gtin", moduleWidthMm: 0.33 },
      sampleLabelData(),
    );
    expect(bounds.w).toBeCloseTo(95 * 0.33, 6);
  });
});
