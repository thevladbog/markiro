import { decodeGs1DataMatrixAscii } from "./helpers/decode-data-matrix.js";
import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";
const text: domain.RasterizeTextFn = async () => ({
  hex: "80",
  bytesPerRow: 1,
  totalBytes: 1,
  width: 1,
  height: 1,
});
const spec: domain.LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "tspl",
  elements: [],
};
describe("complete monochrome labels", () => {
  it.each([203, 300] as const)("prints whole-page geometry at %i dpi", async (dpi) => {
    expect(domain).toHaveProperty("renderMonoLabel", expect.any(Function));
    const page = await domain.renderMonoLabel({ ...spec, dpi }, domain.sampleLabelData(), text);
    expect([page.widthDots, page.heightDots]).toEqual(dpi === 203 ? [464, 320] : [685, 472]);
    expect(page.pixels.every((p: number) => p === 0)).toBe(true);
  });
  it("preserves the exact text raster and page placement", async () => {
    const page = await domain.renderMonoLabel(
      {
        ...spec,
        elements: [{ id: "t", kind: "text", text: "Кега", xMm: 1, yMm: 1, fontSizePt: 10 }],
      },
      domain.sampleLabelData(),
      text,
    );
    expect(page.pixels[8 * 58 + 1]).toBe(0x80);
    expect(page.requiredBounds).toEqual({ left: 8, top: 8, right: 9, bottom: 9 });
  });
  it("refuses content outside paper instead of clipping", async () => {
    await expect(
      domain.renderMonoLabel(
        {
          ...spec,
          elements: [{ id: "t", kind: "text", text: "Кега", xMm: 58, yMm: 1, fontSizePt: 10 }],
        },
        domain.sampleLabelData(),
        text,
      ),
    ).rejects.toThrow();
  });
  it("rejects a barcode whose quiet zone runs off the page", async () => {
    await expect(
      domain.renderMonoLabel(
        {
          ...spec,
          elements: [
            {
              id: "b",
              kind: "barcode",
              format: "code128",
              data: { literal: "1234" },
              sizeMm: 8,
              moduleWidthMm: 0.25,
              xMm: 0,
              yMm: 4,
            },
          ],
        },
        domain.sampleLabelData(),
        text,
      ),
    ).rejects.toThrow();
  });
  it("renders a full GS1 code into a validated artifact", async () => {
    const fields = { ...domain.sampleLabelData(), "km.code": "010460000000001521a1\u001d93Abcd" };
    const page = await domain.renderMonoLabel(
      {
        ...spec,
        elements: [
          {
            id: "km",
            kind: "barcode",
            format: "datamatrix",
            data: "km.code",
            sizeMm: 24,
            xMm: 3,
            yMm: 3,
          },
        ],
      },
      fields,
      text,
    );
    // Independent ECC200 decoder reads pixels from the composed page (18x18 fixture).
    const origin = 24 + 15,
      scale = 9;
    const pixs = Array.from({ length: 18 * 18 }, (_, i) => {
      const x = origin + (i % 18) * scale,
        y = origin + Math.floor(i / 18) * scale;
      return (page.pixels[y * page.stride + (x >> 3)] ?? 0) & (0x80 >> (x % 8)) ? 1 : 0;
    });
    expect(decodeGs1DataMatrixAscii([{ pixs, pixx: 18, pixy: 18 }])).toBe(fields["km.code"]);
    expect(domain.decodeMonoRaster(domain.encodeMonoRaster(page)).requiredBounds).toEqual({
      left: 24,
      top: 24,
      right: 216,
      bottom: 216,
    });
  });
});
