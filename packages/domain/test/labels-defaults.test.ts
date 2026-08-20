import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  buildDefaultLabelTemplates,
  elementBoundsMm,
  estimatedTextWidthMm,
  generateTspl,
  generateZpl,
  mmToDots,
  parseLabelTemplate,
  sampleLabelData,
  wrapTextToWidth,
  type LabelField,
  type RasterResult,
  type RasterizeTextFn,
} from "../src/index.js";

const FAKE_RASTER: RasterResult = {
  hex: "00",
  totalBytes: 1,
  bytesPerRow: 1,
  width: 8,
  height: 1,
};

/**
 * A realistic Russian product name — the case the stock templates exist for,
 * and the one that used to print off the right edge of a 58 mm label. Long
 * enough that its unwrapped width (~1.9 mm per glyph at 10 pt) exceeds the
 * 54 mm content width of the base template by a wide margin.
 */
const LONG_CYRILLIC_NAME = "Пиво светлое пастеризованное Жигулёвское Оригинальное 0,5 л";

function dataWithLongName(): Record<LabelField, string> {
  return { ...sampleLabelData(), "product.name": LONG_CYRILLIC_NAME };
}

/**
 * A rasterizer double that HONOURS the `maxWidthPx`/`maxLines` contract the
 * emitters now pass (`RasterizeTextOptions`), measuring with the same
 * character-count estimate the DOM-free helpers use. Not a canvas — the point
 * is to assert that the emitter asks for a bounded bitmap and places whatever
 * comes back inside the label, which is exactly what was missing before.
 */
function boundedRasterizer(): RasterizeTextFn {
  return vi.fn(async (text, opts) => {
    const measure = (s: string) => s.length * opts.fontSizePx * 0.55;
    const lines =
      opts.maxWidthPx === undefined
        ? [text]
        : wrapTextToWidth(text, measure, opts.maxWidthPx, opts.maxLines ?? 1);
    const width = Math.max(1, Math.ceil(Math.max(...lines.map(measure))));
    const height = Math.ceil(opts.fontSizePx * 1.5) * lines.length;
    return { hex: "00", totalBytes: 1, bytesPerRow: 1, width, height };
  });
}

describe("buildDefaultLabelTemplates", () => {
  it("returns the five stock box labels with the exact seed names", () => {
    const templates = buildDefaultLabelTemplates();
    expect(templates.map((t) => t.name)).toEqual([
      "Коробка 58×40 (203 dpi)",
      "Коробка 58×40 (300 dpi)",
      "Коробка 75×120 (203 dpi)",
      "Коробка 100×100 (203 dpi)",
      "Коробка 100×150 (203 dpi)",
    ]);
    expect(DEFAULT_BOX_LABEL_TEMPLATE_NAME).toBe("Коробка 58×40 (203 dpi)");
    expect(templates.map((t) => [t.spec.widthMm, t.spec.heightMm, t.spec.dpi])).toEqual([
      [58, 40, 203],
      [58, 40, 300],
      [75, 120, 203],
      [100, 100, 203],
      [100, 150, 203],
    ]);
  });

  it("every spec validates and mirrors the approved mock-up layout", () => {
    for (const { spec } of buildDefaultLabelTemplates()) {
      expect(() => parseLabelTemplate(spec)).not.toThrow();
      const kindsByField = new Map(
        spec.elements.filter((el) => el.kind === "field").map((el) => [el.field, el] as const),
      );
      for (const field of ["product.name", "date", "expiry", "qty", "product.egais"] as const) {
        expect(kindsByField.has(field), `missing field ${field}`).toBe(true);
      }
      const barcode = spec.elements.find((el) => el.kind === "barcode");
      expect(barcode).toMatchObject({ format: "code128", data: "sscc" });
      // Every element starts inside the physical label.
      for (const el of spec.elements) {
        expect(el.xMm).toBeGreaterThanOrEqual(0);
        expect(el.yMm).toBeGreaterThanOrEqual(0);
        expect(el.xMm).toBeLessThanOrEqual(spec.widthMm);
        expect(el.yMm).toBeLessThanOrEqual(spec.heightMm);
      }
    }
  });

  /**
   * The check that was missing. Asserting only that every element's ORIGIN is
   * on the label says nothing about what actually prints: the product name's
   * origin sat at (2, 2) on a 58 mm label while the rendered text ran to
   * ~78 mm, off the right edge and across the next label on the roll.
   */
  it("every element's rendered EXTENT stays on the label, with a long Cyrillic product name", () => {
    const data = dataWithLongName();
    // Guard the premise: this name genuinely does not fit on one line of the
    // base template's 54 mm content width, so the assertions below are
    // exercising the wrap/clip path rather than passing vacuously.
    expect(estimatedTextWidthMm(LONG_CYRILLIC_NAME, 10)).toBeGreaterThan(54);

    for (const { name, spec } of buildDefaultLabelTemplates()) {
      for (const el of spec.elements) {
        const b = elementBoundsMm(el, data);
        expect(b.x, `${name}/${el.id} left`).toBeGreaterThanOrEqual(0);
        expect(b.y, `${name}/${el.id} top`).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w, `${name}/${el.id} right`).toBeLessThanOrEqual(spec.widthMm + 1e-9);
        expect(b.y + b.h, `${name}/${el.id} bottom`).toBeLessThanOrEqual(spec.heightMm + 1e-9);
      }
    }
  });

  /**
   * The layout has to RESERVE the vertical space each block needs, or the
   * fix above is only true because the bounds heuristic says so. Elements are
   * declared top to bottom, so each one's extent must clear the next one's
   * origin.
   */
  it("stacked blocks do not overlap vertically", () => {
    const data = dataWithLongName();
    for (const { name, spec } of buildDefaultLabelTemplates()) {
      // Elements sharing a `yMm` are one horizontal band (the three-column
      // row); bands must not reach into the next band's top edge.
      const bands = new Map<number, { ids: string[]; bottom: number }>();
      for (const el of spec.elements) {
        const b = elementBoundsMm(el, data);
        const band = bands.get(b.y) ?? { ids: [], bottom: b.y };
        band.ids.push(el.id);
        band.bottom = Math.max(band.bottom, b.y + b.h);
        bands.set(b.y, band);
      }
      const ordered = [...bands.entries()].sort(([a], [b]) => a - b);
      for (let i = 0; i < ordered.length - 1; i++) {
        const [, band] = ordered[i]!;
        const [nextTop, next] = ordered[i + 1]!;
        expect(
          band.bottom,
          `${name}: [${band.ids.join(",")}] overlaps [${next.ids.join(",")}]`,
        ).toBeLessThanOrEqual(nextTop + 1e-9);
      }
    }
  });

  it("passes the product name's width budget through to the rasterizer, bounded to the label", async () => {
    for (const { name, spec } of buildDefaultLabelTemplates()) {
      const rasterizeText = boundedRasterizer();
      await generateZpl(spec, dataWithLongName(), { rasterizeText });

      const nameElement = spec.elements.find((el) => el.kind === "field" && el.id === "name");
      expect(nameElement).toBeDefined();
      if (nameElement?.kind !== "field") throw new Error("unreachable");
      const expectedMaxWidthPx = mmToDots(nameElement.maxWidthMm!, spec.dpi);

      const call = vi
        .mocked(rasterizeText)
        .mock.calls.find(([text]) => text === LONG_CYRILLIC_NAME);
      expect(call, `${name}: the product name was never rasterized`).toBeDefined();
      // Before this fix the emitter passed neither, and the rasterizer sized
      // the bitmap from the text's own measured width.
      expect(call![1].maxWidthPx, `${name}: maxWidthPx`).toBe(expectedMaxWidthPx);
      expect(call![1].maxLines, `${name}: maxLines`).toBe(2);

      const raster = await rasterizeText(LONG_CYRILLIC_NAME, call![1]);
      expect(raster.width, `${name}: bitmap width`).toBeLessThanOrEqual(expectedMaxWidthPx);
      expect(
        mmToDots(nameElement.xMm, spec.dpi) + raster.width,
        `${name}: bitmap right edge`,
      ).toBeLessThanOrEqual(mmToDots(spec.widthMm, spec.dpi));
    }
  });

  it("prints the SSCC digits as an element, identically in ZPL and TSPL", async () => {
    for (const { name, spec } of buildDefaultLabelTemplates()) {
      const digits = spec.elements.find((el) => el.kind === "field" && el.field === "sscc");
      expect(digits, `${name}: no human-readable SSCC element`).toBeDefined();

      const data = sampleLabelData();
      const zpl = await generateZpl(spec, data, { rasterizeText: boundedRasterizer() });
      const tspl = await generateTspl(spec, data, { rasterizeText: boundedRasterizer() });

      // The digits print in BOTH languages, from the element (they are ASCII,
      // so both emitters take their native-text path).
      expect(zpl, `${name}: ZPL SSCC digits`).toContain(data.sscc);
      expect(tspl, `${name}: TSPL SSCC digits`).toContain(data.sscc);
      // ...and neither emitter asks the printer for its own interpretation
      // line, which is what used to differ by brand.
      expect(zpl, `${name}: ZPL HRI`).toContain("^BCN,");
      expect(zpl, `${name}: ZPL HRI`).toMatch(/\^BCN,\d+,N,N,N/);
      expect(tspl, `${name}: TSPL HRI`).toMatch(/BARCODE \d+,\d+,"128",\d+,0,0,2,2,/);
    }
  });

  it("every spec emits both ZPL and TSPL with sample data without throwing", async () => {
    const rasterizeText: RasterizeTextFn = vi.fn(async () => ({ ...FAKE_RASTER }));
    for (const { spec } of buildDefaultLabelTemplates()) {
      const zpl = await generateZpl(spec, sampleLabelData(), { rasterizeText });
      expect(zpl.startsWith("^XA")).toBe(true);
      const tspl = await generateTspl(spec, sampleLabelData(), { rasterizeText });
      expect(tspl.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic (two calls produce deep-equal output)", () => {
    expect(buildDefaultLabelTemplates()).toEqual(buildDefaultLabelTemplates());
  });

  it("matches the jsonb inlined into db migration 0048 (drift guard)", async () => {
    const sql = await readFile(
      new URL("../../db/migrations/0048_default_label_templates.sql", import.meta.url),
      "utf8",
    );
    const rows = [...sql.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => ({
      name: m[1]!,
      spec: JSON.parse(m[2]!) as unknown,
    }));
    expect(rows).toEqual(buildDefaultLabelTemplates().map((t) => ({ name: t.name, spec: t.spec })));
  });
});
