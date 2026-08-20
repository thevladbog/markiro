/**
 * Pure unit tests for the two shared label modules that OUTLIVED the visual
 * editor's removal (spec 2026-08-20) and therefore moved out of `editor/`:
 * `pages/labels/renderer.ts` and `pages/labels/geometry.ts`. Both are still
 * live production code -- the renderer paints library-card thumbnails
 * (`TemplateThumb.tsx`) and the read-only preview pane
 * (`editor/PreviewPane.tsx`); the geometry helpers keep IMPORTED elements
 * inside the label whenever the settings form resizes it.
 *
 * Canvas 2D drawing itself cannot be pixel-tested under jsdom
 * (`HTMLCanvasElement.prototype.getContext("2d")` returns `null` there, same
 * constraint as `labels/rasterizer.ts`, see `labels-raster.test.ts`), so only
 * the PURE parts are covered here:
 *  - `elementBoundsMm` (renderer.ts): the documented geometry heuristic, one
 *    vector per element kind.
 *  - `fitElementWithinLabel`/`fitSpecElements` (geometry.ts): containment,
 *    atomic whole-spec fitting, and the ELEMENT_TOO_LARGE rejection the
 *    editor page surfaces as its geometry error.
 *  - `simpleHash`/`mulberry32` (renderer.ts): the deterministic PRNG behind
 *    the schematic matrix-barcode patterns.
 *
 * (This file was `labels-canvas.test.tsx`; the canvas/reducer/hit-test blocks
 * went away with the components they covered.)
 */
import { describe, expect, it } from "vitest";

import { sampleLabelData, type LabelElement, type LabelTemplateSpec } from "@markiro/domain";

import { fitElementWithinLabel, fitSpecElements } from "../src/pages/labels/geometry.js";
import { elementBoundsMm, mulberry32, simpleHash } from "../src/pages/labels/renderer.js";

const PT_TO_MM = 25.4 / 72;
/** Same ratios documented in renderer.ts's `elementBoundsMm` -- recomputed
 * independently here (not imported) so these tests actually pin the
 * documented heuristic's numeric behavior, not just "whatever the code
 * currently does". */
const AVG_CHAR_WIDTH_EM = 0.55;
const LINE_HEIGHT_EM = 1.5;
const BAR_WIDTH_PER_CHAR_FACTOR = 0.7;
const TOTAL_MODULES = 24; // 20 interior + 2*2 quiet zone, per renderer.ts

function textWidthMm(text: string, fontSizePt: number): number {
  return Math.max(text.length, 1) * fontSizePt * PT_TO_MM * AVG_CHAR_WIDTH_EM;
}
function textHeightMm(fontSizePt: number): number {
  return fontSizePt * PT_TO_MM * LINE_HEIGHT_EM;
}

function makeSpec(elements: LabelElement[]): LabelTemplateSpec {
  return { widthMm: 100, heightMm: 100, dpi: 203, language: "zpl", elements };
}

describe("elementBoundsMm", () => {
  const sampleData = sampleLabelData();

  it("text: width from char-count heuristic, height from line-height heuristic", () => {
    const bounds = elementBoundsMm(
      {
        kind: "text",
        id: "t1",
        xMm: 5,
        yMm: 7,
        text: "Hello",
        fontSizePt: 12,
      },
      sampleData,
    );
    expect(bounds.x).toBe(5);
    expect(bounds.y).toBe(7);
    expect(bounds.w).toBeCloseTo(textWidthMm("Hello", 12), 6);
    expect(bounds.h).toBeCloseTo(textHeightMm(12), 6);
  });

  it("text: an explicit maxWidthMm overrides the heuristic width", () => {
    const bounds = elementBoundsMm(
      {
        kind: "text",
        id: "t1",
        xMm: 0,
        yMm: 0,
        text: "A very long line of text",
        fontSizePt: 10,
        maxWidthMm: 30,
      },
      sampleData,
    );
    expect(bounds.w).toBe(30);
  });

  it("field: measures the field's value from the provided data (no literal text on the element itself)", () => {
    const sampleText = sampleData["product.name"];
    const bounds = elementBoundsMm(
      {
        kind: "field",
        id: "f1",
        xMm: 2,
        yMm: 3,
        field: "product.name",
        fontSizePt: 10,
      },
      sampleData,
    );
    expect(bounds.w).toBeCloseTo(textWidthMm(sampleText, 10), 6);
    expect(bounds.h).toBeCloseTo(textHeightMm(10), 6);
  });

  it("field: width expands when data is longer than sample", () => {
    const shortData = { ...sampleData, "product.name": "A" };
    const longData = { ...sampleData, "product.name": "A very long product name" };
    const shortBounds = elementBoundsMm(
      {
        kind: "field",
        id: "f1",
        xMm: 0,
        yMm: 0,
        field: "product.name",
        fontSizePt: 10,
      },
      shortData,
    );
    const longBounds = elementBoundsMm(
      {
        kind: "field",
        id: "f1",
        xMm: 0,
        yMm: 0,
        field: "product.name",
        fontSizePt: 10,
      },
      longData,
    );
    expect(longBounds.w).toBeGreaterThan(shortBounds.w);
  });

  it("barcode (code128/ean13, literal data): height = sizeMm, width from char-count heuristic", () => {
    const bounds = elementBoundsMm(
      {
        kind: "barcode",
        id: "b1",
        xMm: 1,
        yMm: 2,
        format: "code128",
        data: { literal: "12345" },
        sizeMm: 10,
      },
      sampleData,
    );
    expect(bounds.h).toBe(10);
    expect(bounds.w).toBeCloseTo(Math.max("12345".length, 1) * BAR_WIDTH_PER_CHAR_FACTOR * 10, 6);
  });

  it("barcode (ean13, field-bound data): measures the field's value from provided data", () => {
    const sampleText = sampleData.sscc;
    const bounds = elementBoundsMm(
      {
        kind: "barcode",
        id: "b2",
        xMm: 0,
        yMm: 0,
        format: "ean13",
        data: "sscc",
        sizeMm: 8,
      },
      sampleData,
    );
    expect(bounds.w).toBeCloseTo(Math.max(sampleText.length, 1) * BAR_WIDTH_PER_CHAR_FACTOR * 8, 6);
  });

  it("barcode (datamatrix/qr): square bounds = TOTAL_MODULES * sizeMm (module square side)", () => {
    const bounds = elementBoundsMm(
      {
        kind: "barcode",
        id: "b3",
        xMm: 4,
        yMm: 4,
        format: "datamatrix",
        data: "km.code",
        sizeMm: 0.5,
      },
      sampleData,
    );
    expect(bounds.w).toBeCloseTo(TOTAL_MODULES * 0.5, 6);
    expect(bounds.h).toBeCloseTo(TOTAL_MODULES * 0.5, 6);

    const qrBounds = elementBoundsMm(
      {
        kind: "barcode",
        id: "b4",
        xMm: 0,
        yMm: 0,
        format: "qr",
        data: { literal: "https://example.com" },
        sizeMm: 0.4,
      },
      sampleData,
    );
    expect(qrBounds.w).toBeCloseTo(TOTAL_MODULES * 0.4, 6);
  });

  it("line: bounding box from endpoints, clamped to thicknessMm on a degenerate axis", () => {
    // Perfectly horizontal: y-span is 0, must clamp up to thicknessMm.
    const horizontal = elementBoundsMm(
      {
        kind: "line",
        id: "l1",
        xMm: 10,
        yMm: 20,
        x2Mm: 40,
        y2Mm: 20,
        thicknessMm: 0.6,
      },
      sampleData,
    );
    expect(horizontal).toEqual({ x: 10, y: 20, w: 30, h: 0.6 });

    // A genuinely diagonal line still gets its bounding rectangle.
    const diagonal = elementBoundsMm(
      {
        kind: "line",
        id: "l2",
        xMm: 5,
        yMm: 5,
        x2Mm: 0,
        y2Mm: 15,
        thicknessMm: 0.2,
      },
      sampleData,
    );
    expect(diagonal).toEqual({ x: 0, y: 5, w: 5, h: 10 });
  });

  it("box: bounds are the element's own literal x/y/width/height", () => {
    const bounds = elementBoundsMm(
      {
        kind: "box",
        id: "bx1",
        xMm: 1,
        yMm: 2,
        widthMm: 20,
        heightMm: 15,
        thicknessMm: 0.5,
      },
      sampleData,
    );
    expect(bounds).toEqual({ x: 1, y: 2, w: 20, h: 15 });
  });
});

describe("editor geometry containment", () => {
  const label = { widthMm: 100, heightMm: 100 };
  const data = sampleLabelData();

  it("clamps every supported element kind by its rendered bounds", () => {
    const elements: LabelElement[] = [
      { kind: "text", id: "text", xMm: 99, yMm: 99, text: "Long text", fontSizePt: 12 },
      { kind: "field", id: "field", xMm: 99, yMm: 99, field: "product.name", fontSizePt: 12 },
      {
        kind: "barcode",
        id: "linear",
        xMm: 99,
        yMm: 99,
        format: "code128",
        data: "sscc",
        sizeMm: 5,
      },
      { kind: "barcode", id: "matrix", xMm: 99, yMm: 99, format: "qr", data: "sscc", sizeMm: 1 },
      { kind: "line", id: "line", xMm: 90, yMm: 95, x2Mm: 120, y2Mm: 95, thicknessMm: 1 },
      { kind: "box", id: "box", xMm: 95, yMm: 95, widthMm: 20, heightMm: 20, thicknessMm: 1 },
    ];

    for (const element of elements) {
      const result = fitElementWithinLabel(element, label, data);
      expect(result.ok, element.id).toBe(true);
      if (!result.ok) continue;
      const bounds = elementBoundsMm(result.element, data);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.w).toBeLessThanOrEqual(label.widthMm);
      expect(bounds.y + bounds.h).toBeLessThanOrEqual(label.heightMm);
    }
  });

  it("translates both endpoints of a line and rejects an element larger than the label", () => {
    const line = fitElementWithinLabel(
      { kind: "line", id: "line", xMm: 90, yMm: 95, x2Mm: 120, y2Mm: 95, thicknessMm: 1 },
      label,
      data,
    );
    expect(line).toEqual({
      ok: true,
      adjusted: true,
      element: expect.objectContaining({ xMm: 70, x2Mm: 100, yMm: 95, y2Mm: 95 }),
    });

    expect(
      fitElementWithinLabel(
        {
          kind: "box",
          id: "too-large",
          xMm: 0,
          yMm: 0,
          widthMm: 101,
          heightMm: 10,
          thicknessMm: 1,
        },
        label,
        data,
      ),
    ).toEqual({ ok: false, reason: "ELEMENT_TOO_LARGE" });
  });

  it("fits a complete spec atomically and reports adjusted ids", () => {
    const spec = makeSpec([
      { kind: "box", id: "inside", xMm: 1, yMm: 1, widthMm: 10, heightMm: 10, thicknessMm: 1 },
      { kind: "box", id: "outside", xMm: 95, yMm: 95, widthMm: 10, heightMm: 10, thicknessMm: 1 },
    ]);
    expect(fitSpecElements(spec, data)).toEqual({
      ok: true,
      adjustedIds: ["outside"],
      spec: expect.objectContaining({
        elements: [
          expect.objectContaining({ id: "inside", xMm: 1 }),
          expect.objectContaining({ id: "outside", xMm: 90, yMm: 90 }),
        ],
      }),
    });
  });
});

describe("Pattern helper determinism", () => {
  it("simpleHash: same input string produces identical hash every call", () => {
    const text = "test-data";
    const hash1 = simpleHash(text);
    const hash2 = simpleHash(text);
    expect(hash1).toBe(hash2);
  });

  it("simpleHash: different inputs produce different hashes", () => {
    const hash1 = simpleHash("input1");
    const hash2 = simpleHash("input2");
    expect(hash1).not.toBe(hash2);
  });

  it("mulberry32: same seed produces identical PRNG sequence every call", () => {
    const seed = simpleHash("test-string");
    const rng1 = mulberry32(seed);
    const rng2 = mulberry32(seed);
    const sequence1 = Array.from({ length: 10 }, () => rng1());
    const sequence2 = Array.from({ length: 10 }, () => rng2());
    expect(sequence1).toEqual(sequence2);
  });

  it("mulberry32: different seeds produce different sequences", () => {
    const rng1 = mulberry32(12345);
    const rng2 = mulberry32(54321);
    const sequence1 = Array.from({ length: 5 }, () => rng1());
    const sequence2 = Array.from({ length: 5 }, () => rng2());
    // At least one value should differ (with overwhelming probability for different seeds)
    expect(sequence1).not.toEqual(sequence2);
  });

  it("pattern generation: same text produces identical matrix pattern grid", () => {
    const testText = "barcode-123";
    const seed = simpleHash(testText);
    const rng1 = mulberry32(seed);
    const rng2 = mulberry32(seed);

    const gridSize = 20; // interior modules
    const pattern1: number[] = [];
    const pattern2: number[] = [];

    for (let i = 0; i < gridSize * gridSize; i++) {
      pattern1.push(rng1() < 0.5 ? 1 : 0);
    }
    for (let i = 0; i < gridSize * gridSize; i++) {
      pattern2.push(rng2() < 0.5 ? 1 : 0);
    }

    expect(pattern1).toEqual(pattern2);
  });

  it("pattern generation: different text produces different patterns", () => {
    const text1 = "data-v1";
    const text2 = "data-v2";
    const rng1 = mulberry32(simpleHash(text1));
    const rng2 = mulberry32(simpleHash(text2));

    const gridSize = 20;
    const pattern1: number[] = [];
    const pattern2: number[] = [];

    for (let i = 0; i < gridSize * gridSize; i++) {
      pattern1.push(rng1() < 0.5 ? 1 : 0);
    }
    for (let i = 0; i < gridSize * gridSize; i++) {
      pattern2.push(rng2() < 0.5 ? 1 : 0);
    }

    // At least one cell should differ
    const diffCount = pattern1.filter((v, i) => v !== pattern2[i]).length;
    expect(diffCount).toBeGreaterThan(0);
  });
});
