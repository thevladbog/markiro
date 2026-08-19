import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  buildDefaultLabelTemplates,
  generateTspl,
  generateZpl,
  parseLabelTemplate,
  sampleLabelData,
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
        spec.elements
          .filter((el) => el.kind === "field")
          .map((el) => [el.field, el] as const),
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

  it("matches the jsonb inlined into db migration 0047 (drift guard)", async () => {
    const sql = await readFile(
      new URL("../../db/migrations/0047_default_label_templates.sql", import.meta.url),
      "utf8",
    );
    const rows = [...sql.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => ({
      name: m[1]!,
      spec: JSON.parse(m[2]!) as unknown,
    }));
    expect(rows).toEqual(
      buildDefaultLabelTemplates().map((t) => ({ name: t.name, spec: t.spec })),
    );
  });
});
