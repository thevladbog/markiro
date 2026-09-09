import { describe, expect, it } from "vitest";
import {
  generateZpl,
  sampleLabelData,
  withPrinterDpi,
  type LabelTemplateSpec,
  type RasterResult,
} from "../src/index.js";

const SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  // Plain ASCII keeps the ZPL emitter on its native-text branch (no canvas).
  elements: [{ id: "t", kind: "text", text: "MARKIRO", xMm: 4, yMm: 4, fontSizePt: 10 }],
};

const rasterizeText = async (): Promise<RasterResult> => ({
  hex: "00",
  totalBytes: 1,
  bytesPerRow: 1,
  width: 8,
  height: 1,
});

describe("withPrinterDpi", () => {
  it("returns the same spec when the printer resolution is unknown (legacy fallback)", () => {
    expect(withPrinterDpi(SPEC, null)).toBe(SPEC);
  });

  it("returns the same spec when the printer matches the authoring resolution", () => {
    expect(withPrinterDpi(SPEC, 203)).toBe(SPEC);
  });

  it("substitutes the printer resolution and leaves the millimetre geometry alone", () => {
    const printed = withPrinterDpi(SPEC, 300);
    expect(printed).toEqual({ ...SPEC, dpi: 300 });
    expect(printed).not.toBe(SPEC);
    expect(SPEC.dpi).toBe(203);
  });

  it("makes the emitters convert millimetres into the printer's own dots", async () => {
    const at203 = await generateZpl(withPrinterDpi(SPEC, 203), sampleLabelData(), {
      rasterizeText,
    });
    const at300 = await generateZpl(withPrinterDpi(SPEC, 300), sampleLabelData(), {
      rasterizeText,
    });
    // 58 mm is 464 dots at 203 dpi and 685 at 300 dpi.
    expect(at203).toContain("^PW464");
    expect(at300).toContain("^PW685");
  });
});
