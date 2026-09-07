import { describe, expect, it } from "vitest";
import bwipjs from "bwip-js";
import * as domain from "../src/index.js";
import { decodeGs1DataMatrixAscii } from "./helpers/decode-data-matrix.js";

const RAW = "010460000000001521a1\u001d93Abcd";
const KM: domain.LabelBarcodeElement = {
  kind: "barcode",
  id: "km",
  xMm: 3,
  yMm: 3,
  format: "datamatrix",
  data: "km.code",
  sizeMm: 24,
};
const BASE: domain.LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [KM],
};

function pixel(raster: domain.RasterResult, x: number, y: number): number {
  const offset = (y * raster.bytesPerRow + Math.floor(x / 8)) * 2;
  return (parseInt(raster.hex.slice(offset, offset + 2), 16) >> (7 - (x % 8))) & 1;
}

function bitmapPayload(command: string): { bytes: Uint8Array; widthBytes: number; height: number } {
  const match = /BITMAP \d+,\d+,(\d+),(\d+),0,/.exec(command);
  if (!match || match[1] === undefined || match[2] === undefined)
    throw new Error("Missing BITMAP command");
  const widthBytes = Number(match[1]);
  const height = Number(match[2]);
  const start = match.index + match[0].length;
  const bytes = Uint8Array.from(command.slice(start, start + widthBytes * height), (c) =>
    c.charCodeAt(0),
  );
  return { bytes, widthBytes, height };
}

describe("duplicate template eligibility", () => {
  it("builds a printable 58x40 layout with exactly one product code", () => {
    expect(domain).toHaveProperty("buildDuplicateLabelTemplate", expect.any(Function));
    const spec = domain.buildDuplicateLabelTemplate();
    expect(domain.labelTemplateSpecSchema.parse(spec)).toMatchObject({
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
    });
    expect(() => domain.assertDuplicateTemplate(spec)).not.toThrow();
    expect(
      spec.elements.filter((element) => element.kind === "barcode" && element.data === "km.code"),
    ).toEqual([expect.objectContaining({ format: "datamatrix", xMm: 3, yMm: 3, sizeMm: 24 })]);
  });

  it.each<domain.LabelTemplateSpec>([
    { ...BASE, elements: [] },
    { ...BASE, elements: [{ ...KM, data: { literal: RAW } }] },
    { ...BASE, elements: [{ ...KM, format: "qr" }] },
    { ...BASE, elements: [KM, { ...KM, id: "second" }] },
    {
      ...BASE,
      elements: [
        KM,
        { kind: "field", id: "hidden", xMm: 60, yMm: 0, field: "sscc", fontSizePt: 8 },
      ],
    },
    { ...BASE, elements: [KM, { ...KM, id: "box", data: "sscc" }] },
    { ...BASE, elements: [{ ...KM, xMm: -1 }] },
    { ...BASE, elements: [{ ...KM, yMm: 25 }] },
    { ...BASE, elements: [{ ...KM, sizeMm: 0.01 }] },
  ])("rejects a template that cannot safely carry the product code", (spec) => {
    expect(() => domain.assertDuplicateTemplate(spec)).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_LABEL_TEMPLATE_INVALID" }),
    );
  });

  it("keeps non-box templates out of box choices and preserves legacy metadata", () => {
    expect(
      domain.isBoxLabelTemplateEligible(
        { enabled: true, chzProductGroupCodes: [15], purpose: "product_duplicate" },
        15,
      ),
    ).toBe(false);
    expect(
      domain.isBoxLabelTemplateEligible(
        { enabled: true, chzProductGroupCodes: [15], purpose: "box" },
        8,
      ),
    ).toBe(false);
    expect(
      domain.isBoxLabelTemplateEligible({ enabled: true, chzProductGroupCodes: [15] }, 15),
    ).toBe(true);
  });

  it("gives preview the whole-symbol bounds only for the new product raster path", () => {
    const data = { ...domain.sampleLabelData(), "km.code": RAW };
    expect(domain.elementBoundsMm(KM, data, { kmDataMatrix: "raster" })).toEqual({
      x: 3,
      y: 3,
      w: 24,
      h: 24,
    });
    expect(domain.elementBoundsMm(KM, data)).toEqual({ x: 3, y: 3, w: 576, h: 576 });
  });
});

describe("GS1 raster", () => {
  it("decodes the exact full payload and real FNC1 from the packed pixels", () => {
    const raster = domain.rasterizeGs1DataMatrix(RAW, 200);
    expect(raster).toMatchObject({ width: 200, height: 200, bytesPerRow: 25, totalBytes: 5000 });
    // Independent geometry for this fixed 18x18 symbol: ten-dot modules + one-module border.
    const symbol = {
      pixx: 18,
      pixy: 18,
      pixs: Array.from({ length: 18 * 18 }, (_, i) =>
        pixel(raster, 10 + (i % 18) * 10 + 5, 10 + Math.floor(i / 18) * 10 + 5),
      ),
    };
    expect(decodeGs1DataMatrixAscii([symbol])).toBe(RAW);
    for (let point = 0; point < 200; point++) {
      for (const edge of [0, 9, 190, 199]) {
        expect(pixel(raster, point, edge)).toBe(0);
        expect(pixel(raster, edge, point)).toBe(0);
      }
    }
  });

  it.each([
    { raw: RAW, text: "^FNC1010460000000001521a1^FNC193Abcd" },
    {
      raw: '010460000000001521a(93)"^FNC1\u001d91K1\u001d92tail^value',
      text: '^FNC1010460000000001521a(93)"^^FNC1^FNC191K1^FNC192tail^^value',
    },
  ])("preserves explicit control escaping and every AI ($raw)", ({ raw, text }) => {
    const reference: unknown = bwipjs.raw({ bcid: "datamatrix", text, parsefnc: true });
    if (!Array.isArray(reference) || reference.length !== 1)
      throw new Error("Missing reference symbol");
    const symbol: unknown = reference[0];
    if (
      typeof symbol !== "object" ||
      symbol === null ||
      !("pixx" in symbol) ||
      !("pixy" in symbol) ||
      !("pixs" in symbol) ||
      typeof symbol.pixx !== "number" ||
      typeof symbol.pixy !== "number" ||
      !Array.isArray(symbol.pixs)
    )
      throw new Error("Invalid reference symbol");
    const raster = domain.rasterizeGs1DataMatrix(raw, 200);
    const scale = Math.floor(200 / (Math.max(symbol.pixx, symbol.pixy) + 2));
    const left = Math.floor((200 - symbol.pixx * scale) / 2);
    const top = Math.floor((200 - symbol.pixy * scale) / 2);
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 200; x++) {
        const column = Math.floor((x - left) / scale);
        const row = Math.floor((y - top) / scale);
        const expected: unknown =
          column >= 0 && row >= 0 && column < symbol.pixx && row < symbol.pixy
            ? symbol.pixs[row * symbol.pixx + column]
            : 0;
        expect(pixel(raster, x, y)).toBe(expected);
      }
  });

  it.each([0, -1, 1, 19, NaN, Infinity, 200.5, 100_000])(
    "rejects an unusable raster extent %s",
    (side) => {
      expect(() => domain.rasterizeGs1DataMatrix(RAW, side)).toThrowError(
        expect.objectContaining({ code: "DUPLICATE_LABEL_TOO_SMALL" }),
      );
    },
  );

  it("rejects an incomplete code before it can produce printer graphics", () => {
    expect(() => domain.rasterizeGs1DataMatrix("010460000000001521a1", 200)).toThrowError(
      expect.objectContaining({ code: "KM_REPRINT_INCOMPLETE" }),
    );
  });
});

describe("duplicate TSPL path", () => {
  it("keeps the entire ZPL product code inside the same 24 mm square", async () => {
    const fields = { ...domain.sampleLabelData(), "km.code": RAW };
    const command = await domain.generateZpl(BASE, fields, { kmDataMatrix: "raster" });
    expect(command).not.toContain("^BX");
    const raster = domain.rasterizeGs1DataMatrix(RAW, 192);
    expect(command).toContain(
      `^FO24,24^GFA,${raster.totalBytes},${raster.totalBytes},${raster.bytesPerRow},${raster.hex}^FS`,
    );
    const native = await domain.generateZpl(BASE, fields);
    expect(native).toContain("^BX");
    expect(await domain.generateZpl(BASE, fields, { kmDataMatrix: "native" })).toBe(native);
  });
  it.each([203, 300] as const)(
    "transports packed monochrome bytes unchanged at %s dpi",
    async (dpi) => {
      const fields = { ...domain.sampleLabelData(), "km.code": RAW };
      const spec = { ...BASE, dpi };
      const command = await domain.generateTspl(spec, fields, { kmDataMatrix: "raster" });
      expect(command).not.toContain("DMATRIX ");
      expect(command.endsWith("PRINT 1\n")).toBe(true);
      const { bytes, widthBytes, height } = bitmapPayload(command);
      const raster = domain.rasterizeGs1DataMatrix(RAW, domain.mmToDots(24, dpi));
      expect([widthBytes, height, bytes.length]).toEqual([
        raster.bytesPerRow,
        raster.height,
        raster.totalBytes,
      ]);
      expect(Array.from(bytes).some((byte) => byte > 127)).toBe(true);
      const restored = Array.from(bytes, (byte) => (byte ^ 255).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
      expect(restored).toBe(raster.hex);
    },
  );

  it("leaves existing native TSPL output and other barcode sources alone", async () => {
    const fields = { ...domain.sampleLabelData(), "km.code": RAW };
    const native = await domain.generateTspl(BASE, fields);
    expect(native).toContain("DMATRIX ");
    expect(await domain.generateTspl(BASE, fields, { kmDataMatrix: "native" })).toBe(native);
    const literal = { ...BASE, elements: [{ ...KM, data: { literal: "plain" } }] };
    expect(await domain.generateTspl(literal, fields, { kmDataMatrix: "raster" })).toBe(
      await domain.generateTspl(literal, fields),
    );
  });
});
