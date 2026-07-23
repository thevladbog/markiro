import { describe, expect, it, vi } from "vitest";
import { sampleLabelData, type LabelField, type LabelTemplateSpec } from "../src/labels/model.js";
import {
  buildGfaCommand,
  generateZpl,
  needsImageRendering,
  type RasterResult,
  type RasterizeTextFn,
} from "../src/labels/zpl.js";

describe("needsImageRendering", () => {
  it("returns false for plain ASCII text", () => {
    expect(needsImageRendering("ACME Foods 123")).toBe(false);
  });

  it("returns false for Latin-1 Supplement accented text", () => {
    expect(needsImageRendering("café naïve")).toBe(false);
  });

  it("returns true for Cyrillic text", () => {
    expect(needsImageRendering("Пиво светлое")).toBe(true);
  });

  it("returns true for CJK text", () => {
    expect(needsImageRendering("啤酒")).toBe(true);
  });

  it("returns true when only one character out of many is out of range", () => {
    expect(needsImageRendering("Beer А")).toBe(true);
  });
});

describe("generateZpl - native latin-only document (golden)", () => {
  // 58x40mm @ 203dpi -> mmToDots(58,203)=464, mmToDots(40,203)=320 (see
  // labels-model.test.ts for the round() worked examples this reuses).
  const latinOnlySpec: LabelTemplateSpec = {
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
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

  it("produces the exact ^XA..^XZ document with no rasterizer dependency", async () => {
    const zpl = await generateZpl(latinOnlySpec, sampleLabelData());

    // Hand-computed dots (round(mm*dpi/25.4), round(pt/72*dpi)):
    //   x=2mm,y=2mm -> 16,16          y=10mm -> 80        y=18mm -> 144
    //   y=24mm -> 192                 y=34mm -> 272
    //   12pt -> 34 dots   10pt -> 28 dots   8pt -> 23 dots
    //   maxWidthMm=50 -> 400 dots     sizeMm=10 -> 80 dots
    //   thicknessMm=0.3 -> 2 dots     thicknessMm=0.2 -> 2 dots
    expect(zpl).toBe(
      [
        "^XA",
        "^PW464",
        "^LL320",
        "^FO16,16^A0N,34,34^FDACME Foods^FS",
        "^FO16,80^A0N,28,28^FB400,1,0,C,0^FD04600682000013^FS",
        "^FO16,144^A0N,23,23^FD2026-07-23^FS",
        "^FO16,192^BEN,80^FD04600682000013^FS",
        "^FO0,272^GB464,2,2^FS",
        "^FO0,0^GB464,320,2^FS",
        "^XZ",
        "",
      ].join("\n"),
    );
  });
});

describe("generateZpl - special-character escaping", () => {
  it("wraps ^FD in ^FH_ and hex-escapes ^, ~, and _ in native text", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl",
      elements: [{ kind: "text", id: "t1", xMm: 0, yMm: 0, text: "A^B~C_D", fontSizePt: 12 }],
    };
    const zpl = await generateZpl(spec, sampleLabelData());
    // '^'=0x5E, '~'=0x7E, '_'=0x5F.
    expect(zpl).toContain("^FH_^FDA_5EB_7EC_5FD^FS");
  });

  it("leaves ^FD data untouched (no ^FH prefix) when no special chars are present", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl",
      elements: [
        { kind: "text", id: "t1", xMm: 0, yMm: 0, text: "Plain text 123", fontSizePt: 12 },
      ],
    };
    const zpl = await generateZpl(spec, sampleLabelData());
    expect(zpl).toContain("^FDPlain text 123^FS");
    expect(zpl).not.toContain("^FH");
  });
});

describe("generateZpl - GS1 DataMatrix FNC1/GS encoding (km.code)", () => {
  const baseSpec: LabelTemplateSpec = {
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
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

  it("pins the leading FNC1 (`_1`) escape ahead of the raw km.code payload", async () => {
    // sampleLabelData().km.code has no embedded GS, so this pins ONLY the
    // leading-FNC1 half of the decision.
    const zpl = await generateZpl(baseSpec, sampleLabelData());
    // xMm=2,yMm=2 -> 16,16 dots; sizeMm=0.5 -> mmToDots(0.5,203)=4 dots module.
    expect(zpl).toContain("^FO16,16^BXN,4,200^FH_^FD_1010460068200001321abcDEF1234567^FS");
  });

  it("pins an embedded GS separator (^\\u001d^) as the `_1D` hex escape", async () => {
    const data: Record<LabelField, string> = {
      ...sampleLabelData(),
      "km.code": `0104600682000013211234${String.fromCharCode(0x1d)}915678`,
    };
    const zpl = await generateZpl(baseSpec, data);
    expect(zpl).toContain("^FO16,16^BXN,4,200^FH_^FD_10104600682000013211234_1D915678^FS");
  });

  it("does NOT auto-apply GS1 FNC1 escaping to a literal datamatrix override", async () => {
    const literalSpec: LabelTemplateSpec = {
      ...baseSpec,
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
    const zpl = await generateZpl(literalSpec, sampleLabelData());
    expect(zpl).toContain("^FO16,16^BXN,4,200^FDjust-some-text^FS");
    expect(zpl).not.toContain("_1");
  });
});

describe("generateZpl - barcode formats", () => {
  it("renders a code128 barcode from a literal", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl",
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
    const zpl = await generateZpl(spec, sampleLabelData());
    expect(zpl).toContain("^FO0,0^BCN,80,N,N,N^FD12345^FS");
  });

  it("renders a qr code with a clamped magnification and QA-prefixed data", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl",
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
    const zpl = await generateZpl(spec, sampleLabelData());
    // mmToDots(20,203)=160 dots, clamped to the ^BQ magnification ceiling of 10.
    expect(zpl).toContain("^FO0,0^BQN,2,10^FDQA,https://example.com^FS");
  });
});

describe("generateZpl - raster fallback", () => {
  const cyrillicSpec: LabelTemplateSpec = {
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    elements: [{ kind: "text", id: "t1", xMm: 5, yMm: 5, text: "Тест", fontSizePt: 12 }],
  };

  it("throws DomainError RASTER_REQUIRED when text needs rasterization and no dependency is given", async () => {
    await expect(generateZpl(cyrillicSpec, sampleLabelData())).rejects.toMatchObject({
      name: "DomainError",
      code: "RASTER_REQUIRED",
    });
  });

  it("emits ^FO + buildGfaCommand for a fake 16x8 checkerboard rasterizer (golden)", async () => {
    // Hand-computed 16x8 checkerboard, packed 8px/byte MSB-first per the
    // ^GFA convention: pixel (x,y) is black when (x+y) is even.
    //   Row y even: bits 1,0,1,0,1,0,1,0 per byte -> 0xAA, twice -> "AAAA"
    //   Row y odd:  bits 0,1,0,1,0,1,0,1 per byte -> 0x55, twice -> "5555"
    // 8 rows alternating AAAA/5555 -> 32 hex chars, 16 bytes, 2 bytes/row.
    const fakeResult: RasterResult = {
      hex: "AAAA5555AAAA5555AAAA5555AAAA5555",
      totalBytes: 16,
      bytesPerRow: 2,
      width: 16,
      height: 8,
    };
    const rasterizeText: RasterizeTextFn = vi.fn(async () => fakeResult);

    const zpl = await generateZpl(cyrillicSpec, sampleLabelData(), { rasterizeText });

    // xMm=5,yMm=5 @203dpi -> mmToDots(5,203) = round(5*203/25.4) = 40 dots (both axes).
    expect(zpl).toBe(
      [
        "^XA",
        "^PW464",
        "^LL320",
        "^FO40,40^GFA,16,16,2,AAAA5555AAAA5555AAAA5555AAAA5555^FS",
        "^XZ",
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

  it("buildGfaCommand assembles the ^GFA command from a RasterResult in isolation", () => {
    const r: RasterResult = { hex: "AAAA5555", totalBytes: 4, bytesPerRow: 1, width: 8, height: 4 };
    expect(buildGfaCommand(r)).toBe("^GFA,4,4,1,AAAA5555");
  });
});
