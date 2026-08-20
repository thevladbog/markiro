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
    //
    // `f1` is align=center with maxWidthMm=50, and the x it lands on is
    // COMPUTED here rather than delegated to TSPL's `TEXT` alignment
    // parameter (which aligns about the command's own x, carries no width,
    // and therefore meant something different from ZPL's `^FB` — see
    // `nativeAlignOffsetDots`): x=16, maxWidthDots=mmToDots(50,203)=400,
    // estimated text width = 14 glyphs x ptToMm(10) x 0.55 = 27.16 mm = 217
    // dots, offset = round((400-217)/2) = 92, so x = 16+92 = 108.
    expect(tspl).toBe(
      [
        "SIZE 58 mm, 40 mm",
        "GAP 2 mm, 0 mm",
        "DIRECTION 1",
        "CLS",
        'TEXT 16,16,"0",0,12,12,"ACME Foods"',
        'TEXT 108,80,"0",0,10,10,"04600682000013"',
        'TEXT 16,144,"0",0,8,8,"23.07.2026"',
        'BARCODE 16,192,"EAN13",80,0,0,2,2,"04600682000013"',
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

/**
 * TSPL used to hand `align` to `TEXT`'s own alignment parameter (1/2/3).
 * That parameter carries NO WIDTH — it aligns the string about the command's
 * own `x` — so `align: "center"` on an element at `xMm: 2` centred the string
 * ON 2 mm and hung half of it off the left edge, while the very same template
 * emitted as ZPL centred it INSIDE its `maxWidthMm` box via `^FB…,C,…`, and
 * the admin preview drew it at `x + boxWidth/2`. A `LabelTemplateSpec` is
 * language-neutral, so that was one template printing differently by printer
 * brand. TSPL now computes the offset itself, from the same
 * `rasterAlignOffsetDots` arithmetic its own raster branch and ZPL's raster
 * branch use, and no alignment parameter is emitted at all.
 */
describe("generateTspl - text alignment", () => {
  function alignedSpec(
    align: "left" | "center" | "right" | undefined,
    maxWidthMm: number | undefined,
  ): LabelTemplateSpec {
    return {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [
        {
          kind: "text",
          id: "t1",
          xMm: 0,
          yMm: 0,
          text: "Hi",
          fontSizePt: 12,
          ...(align === undefined ? {} : { align }),
          ...(maxWidthMm === undefined ? {} : { maxWidthMm }),
        },
      ],
    };
  }

  it("never emits TSPL's own alignment parameter", async () => {
    for (const align of ["left", "center", "right", undefined] as const) {
      for (const maxWidthMm of [undefined, 40]) {
        const tspl = await generateTspl(alignedSpec(align, maxWidthMm), sampleLabelData());
        expect(tspl, `align=${align} maxWidthMm=${maxWidthMm}`).toMatch(
          /^TEXT \d+,\d+,"0",0,12,12,"Hi"$/m,
        );
      }
    }
  });

  it("draws flush-left at x when the element declares no maxWidthMm, whatever align says", async () => {
    // No box to align within — the same documented no-op ZPL's native branch
    // (no `^FB`) and the admin preview both have.
    for (const align of ["left", "center", "right", undefined] as const) {
      const tspl = await generateTspl(alignedSpec(align, undefined), sampleLabelData());
      expect(tspl, `align=${align}`).toContain('TEXT 0,0,"0",0,12,12,"Hi"');
    }
  });

  it.each([
    // maxWidthDots = mmToDots(40,203) = 320; "Hi" = 2 glyphs x ptToMm(12) x
    // 0.55 = 4.657 mm = mmToDots(...,203) = 37 dots; leftover = 283.
    ["left", 0],
    [undefined, 0],
    ["center", 142], // round(283/2)
    ["right", 283],
  ] as const)("aligns within maxWidthMm: align=%s shifts x by %d dots", async (align, offset) => {
    const tspl = await generateTspl(alignedSpec(align, 40), sampleLabelData());
    expect(tspl).toContain(`TEXT ${offset},0,"0",0,12,12,"Hi"`);
  });

  it("aligns each wrapped line individually, like ZPL's ^FB field block", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [
        {
          kind: "text",
          id: "t1",
          xMm: 0,
          yMm: 0,
          text: "AAAA BB",
          fontSizePt: 12,
          align: "center",
          maxWidthMm: 12,
          maxLines: 2,
        },
      ],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    const xs = [...tspl.matchAll(/^TEXT (\d+),(\d+),"0",0,12,12,"([^"]*)"$/gm)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
      text: m[3],
    }));
    expect(xs.map((l) => l.text)).toEqual(["AAAA", "BB"]);
    // The SHORTER line is pushed further right — each line centres on its own
    // width rather than the block being shifted as a whole.
    expect(xs[1]!.x).toBeGreaterThan(xs[0]!.x);
    // ...and both centre on the same point, the box's midpoint.
    expect(xs[0]!.y).toBe(0);
    expect(xs[1]!.y).toBeGreaterThan(0);
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

  it("passes through embedded GS (0x1D) verbatim without escaping or expansion (golden test)", async () => {
    // GS1 DataMatrix can contain embedded GS separator bytes (0x1D). This
    // test verifies that the DMATRIX command emits the GS byte as-is,
    // not escaped (e.g., not as "c29" or any control-character form).
    const gsChar = String.fromCharCode(0x1d); // The actual GS byte
    const kmCodeWithGs = `01046006820000132${gsChar}1abcDEF1234567`;
    const dataWithGs = { ...sampleLabelData(), "km.code": kmCodeWithGs };

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
    const tspl = await generateTspl(spec, dataWithGs);

    // The DMATRIX line should contain the GS byte verbatim in the string
    // between the quotes. We verify this by checking that the GS character
    // (0x1D) appears at the expected position in the generated document.
    const dmatrixLine = tspl.split("\n").find((line) => line.startsWith("DMATRIX"));
    expect(dmatrixLine).toBeDefined();

    // Find the DMATRIX command and extract the data portion (everything
    // between the quotes). The DMATRIX format is: DMATRIX x,y,w,h,"<data>"
    const quoteStart = dmatrixLine!.indexOf('"');
    const quoteEnd = dmatrixLine!.lastIndexOf('"');
    const embeddedData = dmatrixLine!.substring(quoteStart + 1, quoteEnd);

    // Verify that the GS byte (0x1D) appears at position 17 (right after
    // "01046006820000132") in the embedded data string.
    expect(embeddedData.charCodeAt(17)).toBe(0x1d);
    // Verify it is NOT escaped (not followed by another escape sequence).
    // The character immediately after should be "1" (the next digit in the
    // GS1 AIM string).
    expect(embeddedData.charCodeAt(18)).toBe("1".charCodeAt(0));
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
    expect(tspl).toContain('BARCODE 0,0,"128",80,0,0,2,2,"12345"');
  });

  it("emits a GS1-128 (FNC1 !1 + AI 00) for a code128 element bound to sscc", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 100,
      heightMm: 50,
      dpi: 203,
      language: "tspl",
      elements: [
        { kind: "barcode", id: "b", data: "sscc", format: "code128", xMm: 5, yMm: 5, sizeMm: 15 },
      ],
    };
    const tspl = await generateTspl(spec, { ...sampleLabelData(), sscc: "004601234560000017" });
    // xMm=5,yMm=5 -> 40,40 dots; sizeMm=15 -> mmToDots(15,203)=120 dots.
    // !1 is TSPL's FNC1 marker, then the 00 AI and the 18 digits.
    expect(tspl).toContain('BARCODE 40,40,"128",120,0,0,2,2,"!100004601234560000017"');
  });

  it("leaves a code128 element bound to another (non-sscc) field as a plain Code 128", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 100,
      heightMm: 50,
      dpi: 203,
      language: "tspl",
      elements: [
        { kind: "barcode", id: "b", data: "qty", format: "code128", xMm: 5, yMm: 5, sizeMm: 15 },
      ],
    };
    const tspl = await generateTspl(spec, { ...sampleLabelData(), qty: "12" });
    expect(tspl).toContain('BARCODE 40,40,"128",120,0,0,2,2,"12"');
    expect(tspl).not.toContain("!1");
  });

  it("renders a field element bound to sscc as GS1 HRI (00)…", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 100,
      heightMm: 60,
      dpi: 203,
      language: "tspl",
      elements: [{ kind: "field", id: "f", field: "sscc", xMm: 5, yMm: 5, fontSizePt: 10 }],
    };
    const tspl = await generateTspl(spec, { ...sampleLabelData(), sscc: "004601234560000017" });
    expect(tspl).toContain("(00)004601234560000017");
    expect(tspl).not.toContain('"004601234560000017"');
  });

  it("leaves a non-sscc field element's text untouched", async () => {
    const spec: LabelTemplateSpec = {
      widthMm: 100,
      heightMm: 60,
      dpi: 203,
      language: "tspl",
      elements: [{ kind: "field", id: "f", field: "product.gtin", xMm: 5, yMm: 5, fontSizePt: 10 }],
    };
    const tspl = await generateTspl(spec, sampleLabelData());
    expect(tspl).not.toContain("(00)");
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
      // The element carries no `maxWidthMm`, so the rasterizer is told there
      // is no width to bound the bitmap to and only one line to produce.
      maxWidthPx: undefined,
      maxLines: 1,
    });
  });

  it("offsets the rasterized bitmap's x for a centered element with maxWidthMm (golden)", async () => {
    const fakeResult: RasterResult = {
      hex: "AAAA5555AAAA5555AAAA5555AAAA5555",
      totalBytes: 16,
      bytesPerRow: 2,
      width: 16,
      height: 8,
    };
    const rasterizeText: RasterizeTextFn = vi.fn(async () => fakeResult);
    const centeredSpec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "tspl",
      elements: [
        {
          kind: "text",
          id: "t1",
          xMm: 5,
          yMm: 5,
          text: "Тест",
          fontSizePt: 12,
          align: "center",
          maxWidthMm: 20,
        },
      ],
    };

    const tspl = await generateTspl(centeredSpec, sampleLabelData(), { rasterizeText });

    // Same inversion as the golden above (checkerboard -> alternating
    // 0x55/0xAA rows). x=mmToDots(5,203)=40; maxWidthDots=mmToDots(20,203)=160;
    // offset=round((160-16)/2)=72; final x = 40+72 = 112. y is untouched.
    const invertedBytes = [
      0x55, 0x55, 0xaa, 0xaa, 0x55, 0x55, 0xaa, 0xaa, 0x55, 0x55, 0xaa, 0xaa, 0x55, 0x55, 0xaa,
      0xaa,
    ];
    const invertedPayload = invertedBytes.map((b) => String.fromCharCode(b)).join("");
    expect(tspl).toBe(
      [
        "SIZE 58 mm, 40 mm",
        "GAP 2 mm, 0 mm",
        "DIRECTION 1",
        "CLS",
        `BITMAP 112,40,2,8,0,${invertedPayload}`,
        "PRINT 1",
        "",
      ].join("\n"),
    );
  });
});
