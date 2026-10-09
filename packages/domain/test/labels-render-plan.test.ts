import bwipjs from "bwip-js/generic";
import { expect, it, vi } from "vitest";
import {
  createLabelRenderPlan,
  emitLabelRenderPlan,
  labelRasterSvgPath,
  sampleLabelData,
  rasterizeGs1DataMatrix,
  generateZpl,
  type LabelTemplateSpec,
} from "../src/index.js";

const raw = "010460000000001521a1\u001d93Abcd";
const bitmap = { width: 9, height: 1, hex: "80ff", bytesPerRow: 2, totalBytes: 2 };
const spec: LabelTemplateSpec = {
  language: "zpl",
  dpi: 203,
  widthMm: 58,
  heightMm: 40,
  elements: [
    {
      id: "ascii",
      kind: "text",
      text: "PACK BOX CODE LONG TITLE",
      xMm: 2,
      yMm: 4,
      fontSizePt: 10,
      maxWidthMm: 20,
      maxLines: 2,
      align: "center",
    },
    { id: "name", kind: "field", field: "product.name", xMm: 2, yMm: 8, fontSizePt: 10 },
    {
      id: "identity",
      kind: "field",
      field: "km.code",
      textFormat: "km_without_crypto",
      xMm: 2,
      yMm: 9,
      fontSizePt: 8,
    },
    {
      id: "km",
      kind: "barcode",
      format: "datamatrix",
      data: "km.code",
      xMm: 4,
      yMm: 10,
      sizeMm: 22,
    },
    {
      id: "sscc",
      kind: "barcode",
      format: "code128",
      data: "sscc",
      xMm: 4,
      yMm: 34,
      sizeMm: 4,
      moduleWidthMm: 0.2502,
    },
  ],
};

it.each([203, 300] as const)(
  "uses the same resolved bounded text and full GS1 raster in both emitters at %s DPI",
  async (dpi) => {
    for (const language of ["tspl", "zpl"] as const) {
      const fields = { ...sampleLabelData(), "km.code": raw };
      const rasterizeText = vi.fn(async () => bitmap);
      const plan = await createLabelRenderPlan(spec, fields, { dpi, language, rasterizeText });
      expect(plan.dpi).toBe(dpi);
      expect(plan.language).toBe(language);
      expect(rasterizeText).toHaveBeenCalledWith("PACK BOX CODE LONG TITLE", {
        fontFamily: "sans-serif",
        fontSizePx: dpi === 203 ? 28 : 42,
        bold: false,
        maxWidthPx: dpi === 203 ? 160 : 236,
        maxLines: 2,
      });
      expect(rasterizeText).toHaveBeenCalledWith(fields["product.name"], expect.anything());
      expect(rasterizeText).toHaveBeenCalledWith("010460000000001521a1", expect.anything());
      const ascii = plan.elements[0];
      expect(ascii).toMatchObject({
        kind: "raster",
        xDots: dpi === 203 ? 92 : 138,
        yDots: dpi === 203 ? 32 : 47,
        raster: bitmap,
      });
      const km = plan.elements[3];
      expect(km).toMatchObject({
        kind: "raster",
        text: raw,
        raster: rasterizeGs1DataMatrix(raw, dpi === 203 ? 176 : 260),
      });
      if (ascii?.kind !== "raster" || km?.kind !== "raster")
        throw new Error("Missing render rasters");
      expect(labelRasterSvgPath(ascii.raster)).toBe("M0 0h1v1h-1zM8 0h1v1h-1z");
      expect(labelRasterSvgPath(km.raster)).not.toBe("");
      const output = emitLabelRenderPlan(plan);
      expect(rasterizeText).toHaveBeenCalledTimes(3);
      if (language === "zpl") {
        expect(output).toContain(`^FO${ascii.xDots},${ascii.yDots}^GFA,2,2,2,80ff^FS`);
        expect(output).toContain(
          `^FO${km.xDots},${km.yDots}^GFA,${km.raster.totalBytes},${km.raster.totalBytes},${km.raster.bytesPerRow},${km.raster.hex}^FS`,
        );
        expect(output).toContain(`^FD>;>800${fields.sscc}^FS`);
        expect(output).not.toContain("^A0");
      } else {
        expect(output).toContain(
          `BITMAP ${ascii.xDots},${ascii.yDots},2,1,0,${String.fromCharCode(0x7f, 0)}`,
        );
        expect(output).toContain(
          `BITMAP ${km.xDots},${km.yDots},${km.raster.bytesPerRow},${km.raster.height},0,`,
        );
        expect(output).toContain(
          `"EAN128",${dpi === 203 ? 32 : 47},0,0,${dpi === 203 ? 2 : 3},${dpi === 203 ? 2 : 3},"00${fields.sscc}"`,
        );
        expect(output).not.toContain("TEXT ");
      }
      expect(plan.elements[4]).toMatchObject({
        kind: "barcode",
        gs1: true,
        value: fields.sscc,
        widthDots: 156 * (dpi === 203 ? 2 : 3),
        heightDots: dpi === 203 ? 32 : 47,
      });
    }
  },
);

it("freezes all field values before an asynchronous raster resolves", async () => {
  const fields = sampleLabelData();
  const originalSscc = fields.sscc;
  const freezeSpec: LabelTemplateSpec = {
    ...spec,
    elements: spec.elements.filter((e) => e.id === "ascii" || e.id === "sscc"),
  };
  const rasterizeText = async () => {
    fields.sscc = "346006820000000021";
    return bitmap;
  };
  const plan = await createLabelRenderPlan(freezeSpec, fields, {
    language: "tspl",
    dpi: 203,
    rasterizeText,
  });
  expect(plan.fields.sscc).toBe(originalSscc);
  expect(plan.elements[1]).toMatchObject({ kind: "barcode", value: originalSscc });
  expect(emitLabelRenderPlan(plan)).toContain(`"00${originalSscc}"`);
});

it("keeps EAN13 bars-only in both warehouse emitters without altering legacy production bytes", async () => {
  const ean: LabelTemplateSpec = {
    ...spec,
    elements: [
      {
        id: "ean",
        kind: "barcode",
        format: "ean13",
        data: { literal: "5901234123457" },
        xMm: 2,
        yMm: 2,
        sizeMm: 10,
      },
    ],
  };
  for (const language of ["zpl", "tspl"] as const) {
    const plan = await createLabelRenderPlan(ean, sampleLabelData(), {
      language,
      dpi: 203,
      rasterizeText: async () => bitmap,
    });
    expect(plan.elements[0]).toMatchObject({ kind: "barcode", widthDots: 190, heightDots: 80 });
    const text = emitLabelRenderPlan(plan);
    expect(text).toContain(
      language === "zpl" ? "^BEN,80,N^FD5901234123457" : '"EAN13",80,0,0,2,2,"5901234123457"',
    );
  }
  expect(await generateZpl(ean, sampleLabelData())).toContain("^BEN,80^FD5901234123457");
});

it("uses the destination QR error correction and dot module size in SVG and native commands", async () => {
  const value = "https://example.test/warehouse/123456789012345678901234567890";
  const qrSpec: LabelTemplateSpec = {
    ...spec,
    elements: [
      {
        id: "qr",
        kind: "barcode",
        format: "qr",
        data: { literal: value },
        xMm: 1.15,
        yMm: 2.15,
        sizeMm: 0.3,
      },
    ],
  };
  for (const language of ["zpl", "tspl"] as const) {
    const plan = await createLabelRenderPlan(qrSpec, sampleLabelData(), {
      language,
      dpi: 300,
      rasterizeText: async () => bitmap,
    });
    const e = plan.elements[0];
    if (e?.kind !== "barcode") throw new Error("Missing QR plan");
    const encoding = {
      bcid: "qrcode",
      text: value,
      scale: 3,
      eclevel: language === "zpl" ? "Q" : "M",
      fixedeclevel: true,
    };
    const expected = bwipjs.toSVG(encoding);
    expect(e.svg).toBe(expected);
    expect(e.xDots).toBe(14);
    expect(e.yDots).toBe(25);
    const command = emitLabelRenderPlan(plan);
    expect(command).toContain(
      language === "zpl" ? `^FO14,25^BQN,2,4^FDQA,${value}` : `QRCODE 14,25,M,4,A,0,"${value}"`,
    );
  }
});
