import { describe, expect, it, vi } from "vitest";
import { sampleLabelData, type LabelTemplateSpec } from "../src/labels/model.js";
import {
  generateTspl,
  needsImageRendering,
  type RasterResult,
  type RasterizeTextFn,
} from "../src/labels/tspl.js";

describe("needsImageRendering (re-exported from text.ts)", () => {
  it("returns false for plain ASCII text", () => {
    expect(needsImageRendering("ACME Foods 123")).toBe(false);
  });

  it("returns true for Cyrillic text", () => {
    expect(needsImageRendering("Пиво светлое")).toBe(true);
  });
});

describe("generateTspl - native latin-only document (golden)", () => {
  // 58x40mm @ 203dpi -> mmToDots(58,203)=464, mmToDots(40,203)=320 (see
  // labels-model.test.ts for the round() worked examples this reuses).
  const latinOnlySpec: LabelTemplateSpec = {
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "tspl",
    elements: [
      { kind: "text", id: "t1", xMm: 2, yMm: 2, text: "ACME Foods", fontSizePt: 12 },
      {
        kind: "field",
        id: "f1",
        xMm: 2,
        yMm: 10,
        field: "product.gtin",
        fontSizePt: 10,
        align: "center",
        maxWidthMm: 50,
      },
      { kind: "field", id: "f2", xMm: 2, yMm: 18, field: "date", fontSizePt: 8 },
      {
        kind: "barcode",
        id: "b1",
        xMm: 2,
        yMm: 24,
        format: "ean13",
        data: "product.gtin",
        sizeMm: 10,
      },
      { kind: "line", id: "l1", xMm: 0, yMm: 34, x2Mm: 58, y2Mm: 34, thicknessMm: 0.3 },
      { kind: "box", id: "bx1", xMm: 0, yMm: 0, widthMm: 58, heightMm: 40, thicknessMm: 0.2 },
    ],
  };

  it("produces the exact SIZE..PRINT document with no rasterizer dependency", async () => {
    const tspl = await generateTspl(latinOnlySpec, sampleLabelData());

    // Hand-computed dots (round(mm*dpi/25.4)):
    //   x=2mm,y=2mm -> 16,16          y=10mm -> 80        y=18mm -> 144
    //   y=24mm -> 192                 y=34mm -> 272
    //   sizeMm=10 -> 80 dots (barcode height)
    //   thicknessMm=0.3 -> 2 dots     thicknessMm=0.2 -> 2 dots
    //   widthMm=58 -> 464 dots        heightMm=40 -> 320 dots
    // TEXT sizing: font "0"'s x-multiplication/y-multiplication parameters
    // are documented (TSC TSPL2 manual) as directly specifying the true
    // type font's width/height IN POINTS -- unlike the numbered bitmap
    // fonts 1-8 where these parameters are a 1-10 integer scale factor --
    // so fontSizePt is passed straight through with no ptToDots conversion.
    expect(tspl).toBe(
      [
        "SIZE 58 mm, 40 mm",
        "GAP 2 mm, 0 mm",
        "DIRECTION 1",
        "CLS",
        'TEXT 16,16,"0",0,12,12,"ACME Foods"',
        'TEXT 16,80,"0",0,10,10,2,"04600682000013"',
        'TEXT 16,144,"0",0,8,8,"2026-07-23"',
        'BARCODE 16,192,"EAN13",80,1,0,2,2,"04600682000013"',
        "BAR 0,272,464,2",
        "BOX 0,0,464,320,2",
        "PRINT 1",
        "",
      ].join("\n"),
    );
  });
});

describe("generateTspl - special-character escaping", () => {
  it('doubles a literal " in TEXT content per TSPL string-literal escaping', async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [{ kind: "text", id: "t1", xMm: 0, yMm: 0, text: 'A"B', fontSizePt: 12 }],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    expect(tspl).toContain('TEXT 0,0,"0",0,12,12,"A""B"');
  });

  it("leaves plain content untouched (no doubled quotes) when no quote is present", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [
        { kind: "text", id: "t1", xMm: 0, yMm: 0, text: "Plain text 123", fontSizePt: 12 },
      ],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    expect(tspl).toContain('TEXT 0,0,"0",0,12,12,"Plain text 123"');
  });
});

describe("generateTspl - text alignment", () => {
  it("omits the optional alignment parameter when align is not set", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [{ kind: "text", id: "t1", xMm: 0, yMm: 0, text: "Hi", fontSizePt: 12 }],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    expect(tspl).toContain('TEXT 0,0,"0",0,12,12,"Hi"');
  });

  it.each([
    ["left", 1],
    ["center", 2],
    ["right", 3],
  ] as const)("maps align=%s to TSPL alignment parameter %d", async (align, alignment) => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [{ kind: "text", id: "t1", xMm: 0, yMm: 0, text: "Hi", fontSizePt: 12, align }],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    expect(tspl).toContain(`TEXT 0,0,"0",0,12,12,${alignment},"Hi"`);
  });
});

describe("generateTspl - GS1 DataMatrix (km.code) - open question, see report", () => {
  it("emits the km.code payload RAW (no FNC1/GS escaping applied) — TSPL GS1 convention unconfirmed", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [
        {
          kind: "barcode",
          id: "b1",
          xMm: 2,
          yMm: 2,
          format: "datamatrix",
          data: "km.code",
          sizeMm: 0.5,
        },
      ],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    // xMm=2,yMm=2 -> 16,16 dots; sizeMm=0.5 -> mmToDots(0.5,203)=4 dots
    // (used as both the bounding-box width and height -- see tspl.ts's
    // DMATRIX doc comment for why this reuses the model's "module square
    // side" value as a bounding-box side rather than a true module size).
    expect(tspl).toContain('DMATRIX 16,16,4,4,"010460068200001321abcDEF1234567"');
  });

  it("does not mutate a literal datamatrix override either", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [
        {
          kind: "barcode",
          id: "b1",
          xMm: 2,
          yMm: 2,
          format: "datamatrix",
          data: { literal: "just-some-text" },
          sizeMm: 0.5,
        },
      ],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    expect(tspl).toContain('DMATRIX 16,16,4,4,"just-some-text"');
  });
});

describe("generateTspl - barcode formats", () => {
  it("renders a code128 barcode from a literal", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [
        {
          kind: "barcode",
          id: "b1",
          xMm: 0,
          yMm: 0,
          format: "code128",
          data: { literal: "12345" },
          sizeMm: 10,
        },
      ],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    expect(tspl).toContain('BARCODE 0,0,"128",80,1,0,2,2,"12345"');
  });

  it("renders a qr code with a clamped cell width", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [
        {
          kind: "barcode",
          id: "b1",
          xMm: 0,
          yMm: 0,
          format: "qr",
          data: { literal: "https://example.com" },
          sizeMm: 20,
        },
      ],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    // mmToDots(20,203)=160 dots, clamped to QRCODE's cell-width ceiling of 10.
    expect(tspl).toContain('QRCODE 0,0,M,10,A,0,"https://example.com"');
  });
});

describe("generateTspl - raster fallback", () => {
  const cyrillicSpec: LabelTemplateSpec = {
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "tspl",
    elements: [{ kind: "text", id: "t1", xMm: 5, yMm: 5, text: "Тест", fontSizePt: 12 }],
  };

  it("throws DomainError RASTER_REQUIRED when text needs rasterization and no dependency is given", async () => {
    await expect(generateTspl(cyrillicSpec, sampleLabelData())).rejects.toMatchObject({
      name: "DomainError",
      code: "RASTER_REQUIRED",
    });
  });

  it("emits a polarity-inverted BITMAP command for a fake 16x8 checkerboard rasterizer (golden)", async () => {
    // Same fake checkerboard RasterResult as labels-zpl.test.ts (ZPL
    // polarity: bit 1 = black). Packed 8px/byte MSB-first:
    //   Row y even: 0xAA,0xAA   Row y odd: 0x55,0x55   (8 rows alternating)
    const fakeResult: RasterResult = {
      hex: "AAAA5555AAAA5555AAAA5555AAAA5555",
      totalBytes: 16,
      bytesPerRow: 2,
      width: 16,
      height: 8,
    };
    const rasterizeText: RasterizeTextFn = vi.fn(async () => fakeResult);

    const tspl = await generateTspl(cyrillicSpec, sampleLabelData(), { rasterizeText });

    // TSPL BITMAP polarity is inverted relative to ZPL (bit 0 = black; see
    // raster-types.ts's buildBitmapCommand doc comment for the sourcing).
    // Hand-inverting each byte (XOR 0xFF): 0xAA -> 0x55, 0x55 -> 0xAA.
    const invertedBytes = [
      0x55, 0x55, 0xaa, 0xaa, 0x55, 0x55, 0xaa, 0xaa, 0x55, 0x55, 0xaa, 0xaa, 0x55, 0x55, 0xaa,
      0xaa,
    ];
    const invertedPayload = invertedBytes.map((b) => String.fromCharCode(b)).join("");

    // xMm=5,yMm=5 @203dpi -> mmToDots(5,203) = round(5*203/25.4) = 40 dots (both axes).
    expect(tspl).toBe(
      [
        "SIZE 58 mm, 40 mm",
        "GAP 2 mm, 0 mm",
        "DIRECTION 1",
        "CLS",
        `BITMAP 40,40,2,8,0,${invertedPayload}`,
        "PRINT 1",
        "",
      ].join("\n"),
    );

    expect(rasterizeText).toHaveBeenCalledTimes(1);
    // 12pt @ 203dpi -> ptToDots(12,203) = round(12/72*203) = 34.
    expect(rasterizeText).toHaveBeenCalledWith("Тест", {
      fontFamily: "sans-serif",
      fontSizePx: 34,
      bold: false,
    });
  });
});
