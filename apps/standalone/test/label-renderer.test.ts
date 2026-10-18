import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplate,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
  elementBoundsMm,
  generateTspl,
  generateZpl,
  INTERIOR_MODULES,
  labelFieldDisplayValue,
  mmToDots,
  ptToMm,
  QUIET_ZONE_MODULES,
  rasterizeGs1DataMatrix,
  TOTAL_MODULES,
  type LabelBarcodeElement,
  type LabelElement,
  type LabelTemplateSpec,
  type MonoBitmap,
  type RasterizeTextOptions,
  type RasterResult,
} from "@markiro/domain";

import {
  compositeTextRasters,
  drawLabel,
  paintCodeRasters,
  paintRaster,
  type LabelCanvas,
} from "../src/office/templates/label-renderer.js";
import { labelRenderOptions, labelSampleData } from "../src/office/templates/label-samples.js";

type Op = (string | number)[];

/** A 2D context that records what is drawn; a character measures 10 px. */
function recordingCanvas(): LabelCanvas & { ops: Op[] } {
  const ops: Op[] = [];
  return {
    ops,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textBaseline: "alphabetic",
    textAlign: "start",
    clearRect(x, y, w, h) {
      ops.push(["clearRect", x, y, w, h]);
    },
    fillRect(x, y, w, h) {
      ops.push(["fillRect", String(this.fillStyle), x, y, w, h]);
    },
    strokeRect(x, y, w, h) {
      ops.push(["strokeRect", String(this.strokeStyle), this.lineWidth, x, y, w, h]);
    },
    fillText(text, x, y, maxWidth) {
      ops.push([
        "fillText",
        text,
        x,
        y,
        maxWidth ?? -1,
        this.font,
        this.textAlign,
        this.textBaseline,
      ]);
    },
    measureText: (text) => ({ width: text.length * 10 }),
    beginPath() {
      ops.push(["beginPath"]);
    },
    moveTo(x, y) {
      ops.push(["moveTo", x, y]);
    },
    lineTo(x, y) {
      ops.push(["lineTo", x, y]);
    },
    stroke() {
      ops.push(["stroke", String(this.strokeStyle), this.lineWidth]);
    },
  };
}

const BOX_DATA = labelSampleData("box");

const LAYOUT: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { kind: "box", id: "frame", xMm: 1, yMm: 1, widthMm: 56, heightMm: 38, thicknessMm: 0.5 },
    { kind: "text", id: "lot", xMm: 4, yMm: 4, text: "LOT", fontSizePt: 10 },
    {
      kind: "field",
      id: "name",
      xMm: 4,
      yMm: 10,
      field: "product.printName",
      fontSizePt: 12,
      bold: true,
      align: "center",
      maxWidthMm: 70,
    },
    { kind: "line", id: "rule", xMm: 4, yMm: 30, x2Mm: 54, y2Mm: 30, thicknessMm: 0.3 },
  ],
};

/** A bitmap that answers every rasterize call (by default a one-dot one), and the calls it got. */
function recordingRasterizer(
  raster: RasterResult = { hex: "80", bytesPerRow: 1, totalBytes: 1, width: 1, height: 1 },
) {
  const calls: [string, RasterizeTextOptions][] = [];
  const rasterize = vi.fn(async (text: string, options: RasterizeTextOptions) => {
    calls.push([text, options]);
    return raster;
  });
  return { calls, rasterize };
}

describe("drawing a label layout", () => {
  it("paints the label white, then each element in black at the scale, with the sample's text", () => {
    const canvas = recordingCanvas();
    drawLabel(LAYOUT, canvas, 2, BOX_DATA, {});
    expect(canvas.ops).toEqual([
      ["clearRect", 0, 0, 116, 80],
      ["fillRect", "#ffffff", 0, 0, 116, 80],
      // A box's stroke is inset by half its width, so its outer edge is the element's box.
      ["strokeRect", "#000000", 1, 2.5, 2.5, 111, 75],
      ["fillText", "LOT", 8, 8, -1, `400 ${ptToMm(10) * 2}px sans-serif`, "left", "top"],
      // Within its width, centred: the middle of the box, as the printer aligns it.
      [
        "fillText",
        "Пиво светлое",
        78,
        20,
        140,
        `700 ${ptToMm(12) * 2}px sans-serif`,
        "center",
        "top",
      ],
      ["beginPath"],
      ["moveTo", 8, 60],
      ["lineTo", 108, 60],
      ["stroke", "#000000", 0.6],
    ]);
  });

  it("draws the same schematic code for the same layout every time", () => {
    const qr: LabelTemplateSpec = {
      ...LAYOUT,
      elements: [
        { kind: "barcode", id: "q", xMm: 2, yMm: 2, format: "qr", data: "sscc", sizeMm: 1 },
      ],
    };
    const first = recordingCanvas();
    const second = recordingCanvas();
    drawLabel(qr, first, 3, BOX_DATA, {});
    drawLabel(qr, second, 3, BOX_DATA, {});
    expect(first.ops.length).toBeGreaterThan(10);
    expect(second.ops).toEqual(first.ops);
  });

  it("paints a bitmap's black dots as one rectangle per run, within its width", () => {
    const canvas = recordingCanvas();
    paintRaster(
      canvas,
      { hex: "E0A0", bytesPerRow: 1, totalBytes: 2, width: 3, height: 2 },
      10,
      20,
      2,
    );
    paintRaster(canvas, { hex: "FF", bytesPerRow: 1, totalBytes: 1, width: 3, height: 1 }, 0, 0, 1);
    expect(canvas.ops).toEqual([
      ["fillRect", "#000000", 10, 20, 6, 2],
      ["fillRect", "#000000", 10, 22, 2, 2],
      ["fillRect", "#000000", 14, 22, 2, 2],
      ["fillRect", "#000000", 0, 0, 3, 1],
    ]);
  });

  it("leaves a product duplicate's code white, then paints it as the raster the station prints", async () => {
    const spec = buildDuplicateLabelTemplate();
    const data = labelSampleData("product_duplicate");
    const options = labelRenderOptions("product_duplicate");
    const code = spec.elements.find(
      (element) => element.kind === "barcode" && element.data === "km.code",
    );
    if (code?.kind !== "barcode") throw new Error("the duplicate has no code");
    const drawn = recordingCanvas();
    drawLabel(spec, drawn, 3, data, options);
    const withoutCode = recordingCanvas();
    drawLabel(
      { ...spec, elements: spec.elements.filter((element) => element !== code) },
      withoutCode,
      3,
      data,
      options,
    );
    expect(drawn.ops).toEqual(withoutCode.ops);
    await paintCodeRasters(spec, drawn, 3, data, options, () => false);
    const expected = recordingCanvas();
    const dotPx = (25.4 / spec.dpi) * 3;
    const bounds = elementBoundsMm(code, data, options);
    paintRaster(
      expected,
      rasterizeGs1DataMatrix(data["km.code"], mmToDots(code.sizeMm, spec.dpi)),
      mmToDots(bounds.x, spec.dpi) * dotPx,
      mmToDots(bounds.y, spec.dpi) * dotPx,
      dotPx,
    );
    expect(expected.ops.length).toBeGreaterThan(10);
    expect(drawn.ops.slice(withoutCode.ops.length)).toEqual(expected.ops);
    const cancelled = recordingCanvas();
    await paintCodeRasters(spec, cancelled, 3, data, options, () => true);
    expect(cancelled.ops).toEqual([]);
  });
});

describe("the print bitmaps over the drawing", () => {
  const CYRILLIC: LabelTemplateSpec = {
    ...LAYOUT,
    elements: [
      { kind: "text", id: "lot", xMm: 4, yMm: 4, text: "LOT", fontSizePt: 10 },
      { kind: "text", id: "batch", xMm: 4, yMm: 20, text: "Партия", fontSizePt: 9 },
      ...LAYOUT.elements.slice(2, 3),
    ],
  };

  it("asks the rasterizer what the print asks it, for the text that is not printable ASCII only", async () => {
    const preview = recordingRasterizer();
    await compositeTextRasters(
      CYRILLIC,
      recordingCanvas(),
      3,
      BOX_DATA,
      {},
      preview.rasterize,
      () => false,
    );
    const print = recordingRasterizer();
    await generateZpl(CYRILLIC, BOX_DATA, { rasterizeText: print.rasterize });
    expect(preview.calls.map(([text]) => text)).toEqual(["Партия", "Пиво светлое"]);
    expect(preview.calls).toEqual(print.calls);
  });

  it("covers each element's drawing and paints its bitmap where the printer puts it", async () => {
    const canvas = recordingCanvas();
    const { rasterize } = recordingRasterizer();
    await compositeTextRasters(CYRILLIC, canvas, 2, BOX_DATA, {}, rasterize, () => false);
    const dotPx = (25.4 / 203) * 2;
    const field = CYRILLIC.elements[2];
    if (field === undefined) throw new Error("no field");
    const bounds = elementBoundsMm(field, BOX_DATA);
    // At 203 dpi «Партия» starts at (32, 160) dots; the field at (32, 80), centred in
    // 70 mm (559 dots) as the printer centres a 1-dot bitmap: 279 dots further in.
    // Each bitmap is opaque like the printer's: its own rectangle is white before its dots.
    expect(canvas.ops[1]).toEqual(["fillRect", "#ffffff", 32 * dotPx, 160 * dotPx, dotPx, dotPx]);
    expect(canvas.ops[2]).toEqual(["fillRect", "#000000", 32 * dotPx, 160 * dotPx, dotPx, dotPx]);
    expect(canvas.ops.slice(3)).toEqual([
      ["fillRect", "#ffffff", bounds.x * 2, bounds.y * 2, bounds.w * 2, bounds.h * 2],
      ["fillRect", "#ffffff", (32 + 279) * dotPx, 80 * dotPx, dotPx, dotPx],
      ["fillRect", "#000000", (32 + 279) * dotPx, 80 * dotPx, dotPx, dotPx],
    ]);
  });

  it("whites out the native text of centred and right-aligned text before the bitmap's dots", async () => {
    // A 484-dot bitmap is as wide as the native text («Пиво светлое», 12 characters of
    // 10 px each) at scale 2, with a few dots to spare, and 40 dots high.
    const wide: RasterResult = {
      hex: `80${"00".repeat(61 * 40 - 1)}`,
      bytesPerRow: 61,
      totalBytes: 61 * 40,
      width: 484,
      height: 40,
    };
    const dotPx = (25.4 / 203) * 2;
    for (const align of ["center", "right"] as const) {
      const spec: LabelTemplateSpec = {
        ...LAYOUT,
        elements: [
          {
            kind: "field",
            id: "name",
            xMm: 4,
            yMm: 10,
            field: "product.printName",
            fontSizePt: 12,
            align,
            maxWidthMm: 70,
          },
        ],
      };
      const native = recordingCanvas();
      drawLabel(spec, native, 2, BOX_DATA, {});
      const text = native.ops.find((op) => op[0] === "fillText");
      if (text === undefined) throw new Error("no native text");
      const [, content, x, y, boxPx] = text;
      if (typeof content !== "string" || typeof x !== "number" || typeof y !== "number") {
        throw new Error("a malformed text operation");
      }
      if (typeof boxPx !== "number") throw new Error("the text has no width");
      const widthPx = Math.min(content.length * 10, boxPx);
      const left = align === "center" ? x - widthPx / 2 : x - widthPx;
      const painted = recordingCanvas();
      const { rasterize } = recordingRasterizer(wide);
      await compositeTextRasters(spec, painted, 2, BOX_DATA, {}, rasterize, () => false);
      const firstInk = painted.ops.findIndex((op) => op[1] === "#000000");
      expect(firstInk).toBeGreaterThan(0);
      // Within one printer dot of the native extent: the fake canvas measures in round pixels.
      const covers = painted.ops.slice(0, firstInk).some((op) => {
        const [name, style, rectX, rectY, rectW, rectH] = op;
        return (
          name === "fillRect" &&
          style === "#ffffff" &&
          typeof rectX === "number" &&
          typeof rectY === "number" &&
          typeof rectW === "number" &&
          typeof rectH === "number" &&
          rectX <= left + dotPx &&
          rectX + rectW >= left + widthPx - dotPx &&
          rectY <= y + dotPx &&
          rectY + rectH >= y + ptToMm(12) * 2
        );
      });
      expect({ align, covers }).toEqual({ align, covers: true });
    }
  });

  it("keeps the drawing of an element its bitmap failed for, and stops once cancelled", async () => {
    const canvas = recordingCanvas();
    const rasterize = vi
      .fn<(text: string, options: RasterizeTextOptions) => Promise<RasterResult>>()
      .mockRejectedValueOnce(new Error("no canvas"))
      .mockResolvedValue({ hex: "80", bytesPerRow: 1, totalBytes: 1, width: 1, height: 1 });
    await compositeTextRasters(CYRILLIC, canvas, 2, BOX_DATA, {}, rasterize, () => false);
    expect(rasterize).toHaveBeenCalledTimes(2);
    // Only the second element is painted: the drawing's cover, the bitmap's own white, its dots.
    expect(canvas.ops).toHaveLength(3);
    const cancelled = recordingCanvas();
    await compositeTextRasters(CYRILLIC, cancelled, 2, BOX_DATA, {}, rasterize, () => true);
    expect(cancelled.ops).toEqual([]);
  });
});

/** Rounds the numbers of recorded operations, so floating-point noise does not decide a test. */
function near(ops: Op[]): Op[] {
  return ops.map((op) =>
    op.map((value) => (typeof value === "number" ? Math.round(value * 1e6) / 1e6 : value)),
  );
}

/** The ink modules of a schematic matrix code, one string per interior row. */
function moduleRows(ops: Op[], xPx: number, yPx: number, modulePx: number): string[] {
  const rows = Array.from({ length: INTERIOR_MODULES }, () =>
    Array.from({ length: INTERIOR_MODULES }, () => "."),
  );
  for (const op of ops) {
    const [name, style, x, y, w, h] = op;
    if (
      name !== "fillRect" ||
      style !== "#000000" ||
      typeof x !== "number" ||
      typeof y !== "number" ||
      w !== modulePx ||
      h !== modulePx
    ) {
      throw new Error(`not a module of the pattern: ${JSON.stringify(op)}`);
    }
    const column = (x - xPx) / modulePx - QUIET_ZONE_MODULES;
    const row = (y - yPx) / modulePx - QUIET_ZONE_MODULES;
    const cells = rows[row];
    if (cells === undefined || !Number.isInteger(column) || cells[column] === undefined) {
      throw new Error(`a module outside the interior: ${JSON.stringify(op)}`);
    }
    cells[column] = "#";
  }
  return rows.map((cells) => cells.join(""));
}

describe("text inside its width", () => {
  it("aligns, wraps and cuts the lines as the printer does", () => {
    const spec: LabelTemplateSpec = {
      ...LAYOUT,
      elements: [
        {
          kind: "text",
          id: "a",
          xMm: 2,
          yMm: 5,
          text: "ABCD EFGH IJ",
          fontSizePt: 10,
          maxWidthMm: 10,
          maxLines: 2,
          align: "right",
        },
        {
          kind: "text",
          id: "b",
          xMm: 2,
          yMm: 20,
          text: "ABCD EFGH",
          fontSizePt: 10,
          maxWidthMm: 10,
        },
        { kind: "text", id: "c", xMm: 2, yMm: 30, text: "ABCD", fontSizePt: 10, align: "center" },
      ],
    };
    const canvas = recordingCanvas();
    drawLabel(spec, canvas, 4, BOX_DATA, {});
    const font = `400 ${ptToMm(10) * 4}px sans-serif`;
    const lineHeight = ptToMm(10) * 1.5 * 4;
    // A character measures 10 px and the box is 40 px: four characters a line. A second
    // line is the element's own `maxLines`; the default is one, cut with an ellipsis.
    expect(near(canvas.ops.slice(2))).toEqual(
      near([
        ["fillText", "ABCD", 48, 20, 40, font, "right", "top"],
        ["fillText", "EFG…", 48, 20 + lineHeight, 40, font, "right", "top"],
        ["fillText", "ABC…", 8, 80, 40, font, "left", "top"],
        // Without a width the printer does not align: flush left whatever `align` says.
        ["fillText", "ABCD", 8, 120, -1, font, "left", "top"],
      ]),
    );
  });

  it("draws a field as the print formats it", async () => {
    const font = `400 ${ptToMm(10) * 2}px sans-serif`;
    const quantity: LabelTemplateSpec = {
      ...LAYOUT,
      elements: [{ kind: "field", id: "q", xMm: 4, yMm: 4, field: "qty", fontSizePt: 10 }],
    };
    const canvas = recordingCanvas();
    drawLabel(quantity, canvas, 2, BOX_DATA, {});
    expect(canvas.ops[2]).toEqual(["fillText", "20 шт.", 8, 8, -1, font, "left", "top"]);
    // The formatted text is Cyrillic, so the print rasterizes it; the bare number is ASCII.
    const { calls, rasterize } = recordingRasterizer();
    await compositeTextRasters(
      quantity,
      recordingCanvas(),
      2,
      BOX_DATA,
      {},
      rasterize,
      () => false,
    );
    expect(calls.map(([text]) => text)).toEqual(["20 шт."]);
    const code: LabelTemplateSpec = {
      ...LAYOUT,
      elements: [
        {
          kind: "field",
          id: "k",
          xMm: 4,
          yMm: 4,
          field: "km.code",
          fontSizePt: 10,
          textFormat: "km_without_crypto",
        },
      ],
    };
    const duplicate = recordingCanvas();
    drawLabel(code, duplicate, 2, labelSampleData("product_duplicate"), {});
    expect(duplicate.ops[2]).toEqual([
      "fillText",
      "010460000000001521DEMO-LABEL-42",
      8,
      8,
      -1,
      font,
      "left",
      "top",
    ]);
  });
});

describe("ink", () => {
  it("draws every text in black over the white label", () => {
    const canvas = recordingCanvas();
    const inks: string[] = [];
    const fillText = canvas.fillText;
    canvas.fillText = (...args: Parameters<LabelCanvas["fillText"]>) => {
      inks.push(String(canvas.fillStyle));
      fillText.apply(canvas, args);
    };
    drawLabel(LAYOUT, canvas, 2, BOX_DATA, {});
    expect(inks).toEqual(["#000000", "#000000"]);
  });
});

describe("boxes and lines", () => {
  it("insets a box's stroke by half its thickness at its own coordinates", () => {
    const canvas = recordingCanvas();
    const box: LabelTemplateSpec = {
      ...LAYOUT,
      elements: [
        { kind: "box", id: "b", xMm: 2, yMm: 5, widthMm: 20, heightMm: 10, thicknessMm: 1 },
      ],
    };
    drawLabel(box, canvas, 3, BOX_DATA, {});
    expect(canvas.ops.slice(2)).toEqual([["strokeRect", "#000000", 3, 7.5, 16.5, 57, 27]]);
  });

  it("draws a diagonal line from its start to its end at its thickness", () => {
    const canvas = recordingCanvas();
    const line: LabelTemplateSpec = {
      ...LAYOUT,
      elements: [{ kind: "line", id: "l", xMm: 4, yMm: 6, x2Mm: 30, y2Mm: 20, thicknessMm: 0.4 }],
    };
    drawLabel(line, canvas, 3, BOX_DATA, {});
    expect(near(canvas.ops.slice(2))).toEqual(
      near([["beginPath"], ["moveTo", 12, 18], ["lineTo", 90, 60], ["stroke", "#000000", 1.2]]),
    );
  });
});

describe("schematic codes", () => {
  function matrix(
    format: "qr" | "datamatrix",
    data: LabelBarcodeElement["data"],
  ): LabelTemplateSpec {
    return {
      ...LAYOUT,
      elements: [{ kind: "barcode", id: "c", xMm: 3, yMm: 5, format, data, sizeMm: 1 }],
    };
  }

  // The pattern the cloud's seeded generator makes for the text «ABC».
  const ABC_PATTERN = [
    ".#.##.####.#..#..##.",
    "#..#.###...##.....##",
    "...#....#.##.#######",
    "##..#..#####..#.##.#",
    "..#.######.##...####",
    "...#.#..#.#.##.##..#",
    "##.#..#.##..###.####",
    "#..#.#####.#.##....#",
    "##......#####.##...#",
    "#..##.##..#......#.#",
    "#.#....#....##.##.##",
    "..#..#.##..#....#.#.",
    "#.##.#.##.###.##.##.",
    "#..###.#####..#..##.",
    ".#..#...###.#.#.#.#.",
    "#.########..#.##....",
    "#.##..##......#.##..",
    "....#....##.#.#.###.",
    ".#..#..#.###.#.#.##.",
    ".##.#.#####...#....#",
  ];

  it.each(["qr", "datamatrix"] as const)(
    "draws a %s as a pattern of modules seeded by its text, inside its quiet zone",
    (format) => {
      const canvas = recordingCanvas();
      drawLabel(matrix(format, { literal: "ABC" }), canvas, 3, BOX_DATA, {});
      const side = TOTAL_MODULES * 3;
      expect(canvas.ops[2]).toEqual(["fillRect", "#ffffff", 9, 15, side, side]);
      expect(moduleRows(canvas.ops.slice(3), 9, 15, 3)).toEqual(ABC_PATTERN);
    },
  );

  it("seeds the pattern with the text a field holds just as with a literal", () => {
    const literal = recordingCanvas();
    drawLabel(matrix("qr", { literal: "ABC" }), literal, 3, BOX_DATA, {});
    const field = recordingCanvas();
    drawLabel(matrix("qr", "sscc"), field, 3, { ...BOX_DATA, sscc: "ABC" }, {});
    expect(field.ops).toEqual(literal.ops);
    const other = recordingCanvas();
    drawLabel(matrix("qr", { literal: "ABD" }), other, 3, BOX_DATA, {});
    expect(other.ops).not.toEqual(literal.ops);
  });

  it("draws a linear code as bars over its printed width and the element's height", () => {
    const element: LabelBarcodeElement = {
      kind: "barcode",
      id: "l",
      xMm: 3,
      yMm: 5,
      format: "code128",
      data: { literal: "AB" },
      sizeMm: 10,
    };
    const canvas = recordingCanvas();
    drawLabel({ ...LAYOUT, elements: [element] }, canvas, 2, BOX_DATA, {});
    const { w } = elementBoundsMm(element, BOX_DATA);
    const segment = (w * 2) / 4;
    // Each character a bar, 60 to 140 percent of its segment by the character's code.
    expect(near(canvas.ops.slice(2))).toEqual(
      near([
        ["fillRect", "#ffffff", 6, 10, w * 2, 20],
        ["fillRect", "#000000", 6, 10, segment * 0.8, 20],
        ["fillRect", "#000000", 6 + 2 * segment, 10, segment * 0.9, 20],
      ]),
    );
  });

  it("draws an empty linear code as one bar, as wide as the printer would make it", () => {
    const element: LabelBarcodeElement = {
      kind: "barcode",
      id: "l",
      xMm: 3,
      yMm: 5,
      format: "code128",
      data: { literal: "" },
      sizeMm: 10,
    };
    const canvas = recordingCanvas();
    drawLabel({ ...LAYOUT, elements: [element] }, canvas, 2, BOX_DATA, {});
    const { w } = elementBoundsMm(element, BOX_DATA);
    expect(near(canvas.ops.slice(2))).toEqual(
      near([
        ["fillRect", "#ffffff", 6, 10, w * 2, 20],
        ["fillRect", "#000000", 6, 10, (w * 2 * 1.1) / 2, 20],
      ]),
    );
  });

  it("takes the width of a linear code with a module width from the printed symbol", () => {
    const element: LabelBarcodeElement = {
      kind: "barcode",
      id: "l",
      xMm: 3,
      yMm: 5,
      format: "ean13",
      data: { literal: "4600000000015" },
      sizeMm: 10,
      moduleWidthMm: 0.33,
    };
    const canvas = recordingCanvas();
    drawLabel({ ...LAYOUT, elements: [element] }, canvas, 2, BOX_DATA, {});
    expect(near([canvas.ops[2] ?? []])).toEqual(
      near([["fillRect", "#ffffff", 6, 10, 95 * 0.33 * 2, 20]]),
    );
    expect(canvas.ops).toHaveLength(2 + 1 + 13);
  });
});

describe("which codes the station rasterizes", () => {
  const code = (format: "qr" | "datamatrix", data: "sscc" | "km.code"): LabelTemplateSpec => ({
    ...LAYOUT,
    elements: [{ kind: "barcode", id: "c", xMm: 3, yMm: 5, format, data, sizeMm: 1 }],
  });

  it.each([
    [
      "a datamatrix of another field as a schematic",
      "datamatrix",
      "sscc",
      { kmDataMatrix: "raster" },
      true,
    ],
    ["a qr of the marking code as a schematic", "qr", "km.code", { kmDataMatrix: "raster" }, true],
    [
      "a datamatrix of the marking code drawn natively as a schematic",
      "datamatrix",
      "km.code",
      {},
      true,
    ],
    [
      "a datamatrix of the marking code that is a raster, not as a schematic",
      "datamatrix",
      "km.code",
      { kmDataMatrix: "raster" },
      false,
    ],
  ] as const)("draws %s", (_name, format, data, options, schematic) => {
    const canvas = recordingCanvas();
    drawLabel(code(format, data), canvas, 3, BOX_DATA, options);
    expect(canvas.ops.length > 2).toBe(schematic);
  });

  /** The station's raster of a code, painted as `paintCodeRasters` should. */
  function stationRaster(spec: LabelTemplateSpec, code: LabelBarcodeElement, scale: number) {
    const data = labelSampleData("product_duplicate");
    const expected = recordingCanvas();
    const dotPx = (25.4 / spec.dpi) * scale;
    const bounds = elementBoundsMm(code, data, { kmDataMatrix: "raster" });
    paintRaster(
      expected,
      rasterizeGs1DataMatrix(data["km.code"], mmToDots(code.sizeMm, spec.dpi)),
      mmToDots(bounds.x, spec.dpi) * dotPx,
      mmToDots(bounds.y, spec.dpi) * dotPx,
      dotPx,
    );
    return expected.ops;
  }

  const DUPLICATE = labelSampleData("product_duplicate");
  const RASTER = { kmDataMatrix: "raster" } as const;
  const STATION_CODE: LabelBarcodeElement = {
    kind: "barcode",
    id: "km",
    xMm: 30,
    yMm: 5,
    format: "datamatrix",
    data: "km.code",
    sizeMm: 12,
  };

  it("paints the raster of the marking code's datamatrix only, not of the other codes", async () => {
    const spec: LabelTemplateSpec = {
      ...LAYOUT,
      elements: [
        {
          kind: "barcode",
          id: "a",
          xMm: 3,
          yMm: 5,
          format: "datamatrix",
          data: "sscc",
          sizeMm: 12,
        },
        { kind: "barcode", id: "b", xMm: 3, yMm: 20, format: "qr", data: "km.code", sizeMm: 12 },
        STATION_CODE,
      ],
    };
    const canvas = recordingCanvas();
    await paintCodeRasters(spec, canvas, 3, DUPLICATE, RASTER, () => false);
    expect(canvas.ops.length).toBeGreaterThan(10);
    expect(canvas.ops).toEqual(stationRaster(spec, STATION_CODE, 3));
    const native = recordingCanvas();
    await paintCodeRasters(spec, native, 3, DUPLICATE, {}, () => false);
    expect(native.ops).toEqual([]);
  });

  it("paints the raster in the dots of the layout's own resolution", async () => {
    const spec: LabelTemplateSpec = { ...LAYOUT, dpi: 300, elements: [STATION_CODE] };
    const canvas = recordingCanvas();
    await paintCodeRasters(spec, canvas, 3, DUPLICATE, RASTER, () => false);
    expect(canvas.ops.length).toBeGreaterThan(10);
    expect(canvas.ops).toEqual(stationRaster(spec, STATION_CODE, 3));
  });

  it("skips a code too small to encode and still paints the others", async () => {
    const tiny: LabelBarcodeElement = { ...STATION_CODE, id: "tiny", xMm: 3, sizeMm: 1 };
    const spec: LabelTemplateSpec = { ...LAYOUT, elements: [tiny, STATION_CODE] };
    const canvas = recordingCanvas();
    await paintCodeRasters(spec, canvas, 3, DUPLICATE, RASTER, () => false);
    expect(canvas.ops.length).toBeGreaterThan(10);
    expect(canvas.ops).toEqual(stationRaster(spec, STATION_CODE, 3));
  });
});

describe("the encoder's chunk", () => {
  const CHUNK = "../src/office/templates/label-print.js";
  const station: LabelTemplateSpec = {
    ...LAYOUT,
    elements: [
      {
        kind: "barcode",
        id: "km",
        xMm: 30,
        yMm: 5,
        format: "datamatrix",
        data: "km.code",
        sizeMm: 12,
      },
    ],
  };

  afterEach(() => {
    vi.doUnmock(CHUNK);
    vi.resetModules();
  });

  it("leaves the code white when the chunk does not load", async () => {
    vi.resetModules();
    vi.doMock(CHUNK, () => {
      throw new Error("the chunk did not load");
    });
    const { paintCodeRasters: paint } = await import("../src/office/templates/label-renderer.js");
    const canvas = recordingCanvas();
    await expect(
      paint(
        station,
        canvas,
        3,
        labelSampleData("product_duplicate"),
        { kmDataMatrix: "raster" },
        () => false,
      ),
    ).resolves.toBeUndefined();
    expect(canvas.ops).toEqual([]);
  });

  it("loads the chunk only for a layout that has a raster to paint", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock(CHUNK, () => {
      loads += 1;
      return {
        rasterizeGs1DataMatrix: (): RasterResult => ({
          hex: "80",
          bytesPerRow: 1,
          totalBytes: 1,
          width: 1,
          height: 1,
        }),
      };
    });
    const { paintCodeRasters: paint } = await import("../src/office/templates/label-renderer.js");
    const data = labelSampleData("product_duplicate");
    await paint(station, recordingCanvas(), 3, data, {}, () => false);
    await paint(
      { ...station, elements: [] },
      recordingCanvas(),
      3,
      data,
      { kmDataMatrix: "raster" },
      () => false,
    );
    expect(loads).toBe(0);
    const canvas = recordingCanvas();
    await paint(station, canvas, 3, data, { kmDataMatrix: "raster" }, () => false);
    expect(loads).toBe(1);
    expect(canvas.ops).toHaveLength(1);
  });
});

describe("bitmaps and the print at other resolutions", () => {
  it("reads a bitmap wider than a byte, a row at a time", () => {
    const canvas = recordingCanvas();
    paintRaster(
      canvas,
      { hex: "FFC00080", bytesPerRow: 2, totalBytes: 4, width: 10, height: 2 },
      0,
      0,
      1,
    );
    expect(canvas.ops).toEqual([
      ["fillRect", "#000000", 0, 0, 10, 1],
      ["fillRect", "#000000", 8, 1, 1, 1],
    ]);
  });

  const SPEC_300: LabelTemplateSpec = {
    ...LAYOUT,
    dpi: 300,
    elements: [
      { kind: "text", id: "l", xMm: 4, yMm: 4, text: "Партия", fontSizePt: 9, maxWidthMm: 40 },
      {
        kind: "text",
        id: "c",
        xMm: 4,
        yMm: 12,
        text: "Партия",
        fontSizePt: 9,
        maxWidthMm: 40,
        align: "center",
        bold: true,
      },
      {
        kind: "field",
        id: "r",
        xMm: 4,
        yMm: 20,
        field: "product.printName",
        fontSizePt: 11,
        maxWidthMm: 40,
        align: "right",
        maxLines: 2,
      },
    ],
  };
  // Two dots wide: «Партия» is aligned in 472 dots (40 mm at 300 dpi) by the leftover.
  const TWO_DOTS: RasterResult = { hex: "C0", bytesPerRow: 1, totalBytes: 1, width: 2, height: 1 };

  it("asks for the bitmaps the print of either language asks for, at the layout's resolution", async () => {
    const preview = recordingRasterizer(TWO_DOTS);
    await compositeTextRasters(
      SPEC_300,
      recordingCanvas(),
      3,
      BOX_DATA,
      {},
      preview.rasterize,
      () => false,
    );
    const zpl = recordingRasterizer(TWO_DOTS);
    await generateZpl(SPEC_300, BOX_DATA, { rasterizeText: zpl.rasterize });
    const tspl = recordingRasterizer(TWO_DOTS);
    await generateTspl({ ...SPEC_300, language: "tspl" }, BOX_DATA, {
      rasterizeText: tspl.rasterize,
    });
    expect(preview.calls).toHaveLength(3);
    expect(preview.calls).toEqual(zpl.calls);
    expect(preview.calls).toEqual(tspl.calls);
  });

  it("puts each bitmap in whole dots of the layout's resolution, aligned within its width", async () => {
    const canvas = recordingCanvas();
    const { rasterize } = recordingRasterizer(TWO_DOTS);
    await compositeTextRasters(SPEC_300, canvas, 3, BOX_DATA, {}, rasterize, () => false);
    const dotPx = (25.4 / 300) * 3;
    const expected: Op[] = [];
    for (const [index, offset] of [0, 235, 470].entries()) {
      const element = SPEC_300.elements[index];
      if (element === undefined) throw new Error("no element");
      const bounds = elementBoundsMm(element, BOX_DATA);
      const bitmap: Op = [
        "fillRect",
        "#000000",
        (mmToDots(4, 300) + offset) * dotPx,
        mmToDots(element.yMm, 300) * dotPx,
        2 * dotPx,
        dotPx,
      ];
      expected.push(
        ["fillRect", "#ffffff", bounds.x * 3, bounds.y * 3, bounds.w * 3, bounds.h * 3],
        ["fillRect", "#ffffff", ...bitmap.slice(2)],
        bitmap,
      );
    }
    expect(near(canvas.ops)).toEqual(near(expected));
  });

  it("stops asking once cancelled, even when the bitmap it was waiting for failed", async () => {
    let cancelled = false;
    const rasterize = vi.fn(async (): Promise<RasterResult> => {
      cancelled = true;
      throw new Error("no canvas");
    });
    const canvas = recordingCanvas();
    await compositeTextRasters(SPEC_300, canvas, 3, BOX_DATA, {}, rasterize, () => cancelled);
    expect(rasterize).toHaveBeenCalledTimes(1);
    expect(canvas.ops).toEqual([]);
  });
});

describe("the standard layouts' text model (#703)", () => {
  const FORMATTED = {
    sscc: labelFieldDisplayValue("sscc", BOX_DATA),
    qty: labelFieldDisplayValue("qty", BOX_DATA),
  };
  const logo: LabelElement = {
    kind: "organization_logo",
    id: "organization-logo",
    source: "organization",
    fallback: "markiro",
    xMm: 4,
    yMm: 3,
    widthMm: 32,
    heightMm: 7.3,
  };
  const withElements = (...elements: LabelElement[]): LabelTemplateSpec => ({
    ...LAYOUT,
    elements,
  });
  const ascii: LabelElement = {
    kind: "field",
    id: "sscc",
    field: "sscc",
    xMm: 4,
    yMm: 20,
    fontSizePt: 10,
  };

  it("rasterizes an ASCII-only text that asks for a line height or a font, as the print does, and no other", async () => {
    const plain = recordingRasterizer();
    await compositeTextRasters(
      withElements(ascii, { ...ascii, id: "b", yMm: 24, field: "date" }),
      recordingCanvas(),
      3,
      BOX_DATA,
      {},
      plain.rasterize,
      () => false,
    );
    expect(plain.calls).toEqual([]);

    const spec = withElements(
      { ...ascii, id: "own-height", lineHeight: 1 },
      { ...ascii, id: "own-font", yMm: 24, fontFamily: "monospace" },
      { ...ascii, id: "neither", yMm: 28 },
      { kind: "text", id: "t", xMm: 4, yMm: 32, text: "BOX", fontSizePt: 9, lineHeight: 1.2 },
    );
    const preview = recordingRasterizer();
    await compositeTextRasters(
      spec,
      recordingCanvas(),
      3,
      BOX_DATA,
      {},
      preview.rasterize,
      () => false,
    );
    expect(preview.calls.map(([text]) => text)).toEqual([FORMATTED.sscc, FORMATTED.sscc, "BOX"]);
    const print = recordingRasterizer();
    await generateZpl(spec, BOX_DATA, { rasterizeText: print.rasterize });
    expect(preview.calls).toEqual(print.calls);
  });

  it("hands the rasterizer the element's own family, line height and minimum size, at the layout's resolution", async () => {
    const spec: LabelTemplateSpec = {
      ...withElements({
        kind: "field",
        id: "q",
        field: "qty",
        xMm: 4,
        yMm: 20,
        fontSizePt: 17,
        minFontSizePt: 13,
        lineHeight: 1.13,
        fontFamily: "monospace",
        maxWidthMm: 27,
        bold: true,
      }),
      dpi: 300,
    };
    const { calls, rasterize } = recordingRasterizer();
    await compositeTextRasters(spec, recordingCanvas(), 3, BOX_DATA, {}, rasterize, () => false);
    expect(calls).toEqual([
      [
        FORMATTED.qty,
        {
          fontFamily: "monospace",
          fontSizePx: 71,
          minFontSizePx: 54,
          lineHeight: 1.13,
          bold: true,
          maxWidthPx: 319,
          maxLines: 1,
        },
      ],
    ]);
  });

  it("asks what the print of either language asks, for every stock template of every purpose", async () => {
    const stock = [
      ...buildDefaultLabelTemplates().map(({ spec }) => ["box", spec] as const),
      ...buildDuplicateLabelTemplates().map(({ spec }) => ["product_duplicate", spec] as const),
      ...buildPalletLabelTemplates().map(({ spec }) => ["pallet", spec] as const),
    ];
    // What the wizard seeds: 16 box, 2 duplicate and 3 pallet templates.
    expect(stock).toHaveLength(21);
    let asked = 0;
    for (const [purpose, spec] of stock) {
      const data = labelSampleData(purpose);
      const options = labelRenderOptions(purpose);
      const preview = recordingRasterizer();
      await compositeTextRasters(
        spec,
        recordingCanvas(),
        3,
        data,
        options,
        preview.rasterize,
        () => false,
      );
      const zpl = recordingRasterizer();
      await generateZpl(spec, data, { rasterizeText: zpl.rasterize, ...options });
      const tspl = recordingRasterizer();
      await generateTspl({ ...spec, language: "tspl" }, data, {
        rasterizeText: tspl.rasterize,
        ...options,
      });
      expect(preview.calls).toEqual(zpl.calls);
      expect(preview.calls).toEqual(tspl.calls);
      asked += preview.calls.length;
    }
    // The standard layouts alone ask for a bitmap of every text.
    expect(asked).toBeGreaterThan(100);
  });

  it("spaces the lines of a wrapped text by its own line height, in the family it asks for", () => {
    const spec = withElements({
      kind: "field",
      id: "name",
      field: "product.printName",
      xMm: 4,
      yMm: 10,
      fontSizePt: 13,
      maxWidthMm: 5,
      maxLines: 3,
      lineHeight: 1.13,
      fontFamily: "monospace",
    });
    const canvas = recordingCanvas();
    drawLabel(spec, canvas, 2, BOX_DATA, {});
    const texts = canvas.ops.filter((op) => op[0] === "fillText");
    expect(texts.length).toBeGreaterThan(1);
    const step = ptToMm(13) * 1.13 * 2;
    expect(texts.map((op) => op[3])).toEqual(texts.map((_, i) => 20 + i * step));
    expect(texts.every((op) => op[5] === `400 ${ptToMm(13) * 2}px monospace`)).toBe(true);
    // Without one, the 1.5 em of the print's default.
    const plain = recordingCanvas();
    drawLabel(
      withElements({
        kind: "field",
        id: "name",
        field: "product.printName",
        xMm: 4,
        yMm: 10,
        fontSizePt: 13,
        maxWidthMm: 5,
        maxLines: 3,
      }),
      plain,
      2,
      BOX_DATA,
      {},
    );
    const base = plain.ops.filter((op) => op[0] === "fillText");
    expect(base.map((op) => op[3])).toEqual(base.map((_, i) => 20 + i * ptToMm(13) * 1.5 * 2));
    expect(base.every((op) => op[5] === `400 ${ptToMm(13) * 2}px sans-serif`)).toBe(true);
  });

  it("leaves the organization logo's area empty: nothing is drawn, nothing rasterized, nothing printed", async () => {
    const without = withElements(...LAYOUT.elements);
    const withLogo = withElements(logo, ...LAYOUT.elements);
    const bare = recordingCanvas();
    const marked = recordingCanvas();
    drawLabel(without, bare, 3, BOX_DATA, {});
    expect(() => drawLabel(withLogo, marked, 3, BOX_DATA, {})).not.toThrow();
    expect(marked.ops).toEqual(bare.ops);

    const a = recordingRasterizer();
    const b = recordingRasterizer();
    const canvasA = recordingCanvas();
    const canvasB = recordingCanvas();
    await compositeTextRasters(without, canvasA, 3, BOX_DATA, {}, a.rasterize, () => false);
    await compositeTextRasters(withLogo, canvasB, 3, BOX_DATA, {}, b.rasterize, () => false);
    expect(b.calls).toEqual(a.calls);
    expect(canvasB.ops).toEqual(canvasA.ops);

    for (const language of ["zpl", "tspl"] as const) {
      const emit = language === "zpl" ? generateZpl : generateTspl;
      const base = await emit({ ...without, language }, BOX_DATA, {
        rasterizeText: recordingRasterizer().rasterize,
      });
      const printed = await emit({ ...withLogo, language }, BOX_DATA, {
        rasterizeText: recordingRasterizer().rasterize,
      });
      expect(printed).toBe(base);
    }
  });
});

describe("the organization logo in a drawn layout (#703)", () => {
  const logoBox = (dpi: 203 | 300): LabelTemplateSpec => ({
    widthMm: 58,
    heightMm: 40,
    dpi,
    language: "zpl",
    elements: [
      {
        id: "logo",
        kind: "organization_logo",
        source: "organization",
        fallback: "markiro",
        xMm: 2,
        yMm: 2,
        widthMm: 20,
        heightMm: 10,
      },
    ],
  });
  /** 16 × 2 dots, ink all over. */
  const WIDE: MonoBitmap = {
    width: 16,
    height: 2,
    stride: 2,
    pixels: new Uint8Array(4).fill(0xff),
  };
  /** 2 × 16 dots, ink all over. */
  const TALL: MonoBitmap = {
    width: 2,
    height: 16,
    stride: 1,
    pixels: new Uint8Array(16).fill(0xc0),
  };
  const inkOf = (canvas: { ops: Op[] }) =>
    canvas.ops.filter((op) => op[0] === "fillRect" && op[1] === "#000000");

  it("paints the logo's dots inside the box, scaled and centred as the print places them", () => {
    const canvas = recordingCanvas();
    drawLabel(logoBox(203), canvas, 3, BOX_DATA, { logo: WIDE });
    // 160 × 80 dots of box; 16 × 2 grows by 10 to 160 × 20, 30 dots below the top (2 mm = 16 dots).
    const dotPx = (3 * 25.4) / 203;
    const ink = inkOf(canvas);
    expect(ink).toHaveLength(20);
    ink.forEach((op, row) => {
      expect(op[2]).toBeCloseTo(16 * dotPx, 6);
      expect(op[3]).toBeCloseTo((46 + row) * dotPx, 6);
      expect(op[4]).toBeCloseTo(160 * dotPx, 6);
      expect(op[5]).toBeCloseTo(dotPx, 6);
    });
  });

  it("paints a tall logo as wide as its height allows, at the box's left edge, never past the box", () => {
    const canvas = recordingCanvas();
    drawLabel(logoBox(203), canvas, 3, BOX_DATA, { logo: TALL });
    // 2 × 16 grows by 5 to 10 × 80: ten dots wide, the whole height of the box.
    const dotPx = (3 * 25.4) / 203;
    const ink = inkOf(canvas);
    expect(ink).toHaveLength(80);
    for (const op of ink) {
      expect(op[2]).toBeCloseTo(16 * dotPx, 6);
      expect(op[4]).toBeCloseTo(10 * dotPx, 6);
      expect(Number(op[3])).toBeGreaterThanOrEqual(16 * dotPx - 1e-6);
      expect(Number(op[3]) + Number(op[5])).toBeLessThanOrEqual(96 * dotPx + 1e-6);
    }
  });

  it("uses the layout's resolution for the size of a dot, as the printer prints it", () => {
    const canvas = recordingCanvas();
    drawLabel(logoBox(300), canvas, 3, BOX_DATA, { logo: WIDE });
    // 20 × 10 mm is 236 × 118 dots at 300 dpi; 16 × 2 grows by 14.75 to 236 × 30.
    const dotPx = (3 * 25.4) / 300;
    const ink = inkOf(canvas);
    expect(ink).toHaveLength(30);
    expect(ink[0]?.[4]).toBeCloseTo(236 * dotPx, 6);
    expect(ink[0]?.[5]).toBeCloseTo(dotPx, 6);
  });

  it("leaves the box white without a logo, and nothing else of the label changes", () => {
    const without = recordingCanvas();
    drawLabel(logoBox(203), without, 3, BOX_DATA, {});
    const nullLogo = recordingCanvas();
    drawLabel(logoBox(203), nullLogo, 3, BOX_DATA, { logo: null });
    expect(inkOf(without)).toEqual([]);
    expect(nullLogo.ops).toEqual(without.ops);
    // The white page is the first two operations either way.
    expect(without.ops).toEqual([
      ["clearRect", 0, 0, 174, 120],
      ["fillRect", "#ffffff", 0, 0, 174, 120],
    ]);
  });

  it("keeps the logo of every stock layout inside its box at either resolution, whatever the logo's proportions", () => {
    const layouts = [...buildDefaultLabelTemplates(), ...buildPalletLabelTemplates()];
    let checked = 0;
    for (const template of layouts) {
      for (const element of template.spec.elements) {
        if (element.kind !== "organization_logo") continue;
        for (const dpi of [203, 300] as const) {
          for (const logo of [WIDE, TALL]) {
            const canvas = recordingCanvas();
            drawLabel({ ...template.spec, dpi, elements: [element] }, canvas, 3, BOX_DATA, {
              logo,
            });
            const ink = inkOf(canvas);
            expect(ink.length).toBeGreaterThan(0);
            for (const op of ink) {
              const [x = 0, y = 0, width = 0, height = 0] = op.slice(2).map(Number);
              expect(x).toBeGreaterThanOrEqual(element.xMm * 3 - 0.5);
              expect(x + width).toBeLessThanOrEqual((element.xMm + element.widthMm) * 3 + 0.5);
              expect(y).toBeGreaterThanOrEqual(element.yMm * 3 - 0.5);
              expect(y + height).toBeLessThanOrEqual((element.yMm + element.heightMm) * 3 + 0.5);
            }
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});
