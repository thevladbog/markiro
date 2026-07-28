import { describe, expect, it } from "vitest";
import { sampleLabelData, type LabelTemplateSpec, type RasterResult } from "@markiro/domain";
import { latin1ToBytes, renderLabelBytes } from "../src/lib/print-label.js";

// Deterministic 8x1 all-white raster so the emitters reach their raster branch
// without a canvas. TSPL inverts it to 0xFF — a byte above 0x7F, which is
// exactly what must survive the encoding.
const fakeRasterize = async (): Promise<RasterResult> => ({
  hex: "00",
  totalBytes: 1,
  bytesPerRow: 1,
  width: 8,
  height: 1,
});

const SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [{ id: "a", kind: "field", field: "product.name", xMm: 4, yMm: 4, fontSizePt: 10 }],
};

describe("latin1ToBytes", () => {
  it("keeps a byte above 0x7F as one byte", () => {
    expect(Array.from(latin1ToBytes("ÿA"))).toEqual([0xff, 0x41]);
  });

  it("encodes an empty string to no bytes", () => {
    expect(Array.from(latin1ToBytes(""))).toEqual([]);
  });
});

describe("renderLabelBytes", () => {
  it("emits ZPL when the printer speaks ZPL", async () => {
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "zpl", fakeRasterize);
    expect(new TextDecoder().decode(bytes)).toContain("^XA");
  });

  it("emits TSPL from the same spec when the printer speaks TSPL", async () => {
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "tspl", fakeRasterize);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("SIZE");
    expect(text).toContain("PRINT 1");
  });

  it("ignores the template's own language field", async () => {
    // SPEC declares "zpl"; the printer says TSPL and must win.
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "tspl", fakeRasterize);
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("^XA");
  });

  it("preserves TSPL's binary payload bytes intact", async () => {
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "tspl", fakeRasterize);
    expect(Array.from(bytes)).toContain(0xff);
  });
});
