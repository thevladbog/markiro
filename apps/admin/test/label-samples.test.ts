import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDuplicateTemplate,
  elementBoundsMm,
  hasValidCheckDigit,
  mmToDots,
  parseLabelCode,
  rasterizeGs1DataMatrix,
  type LabelTemplatePurpose,
} from "@markiro/domain";
import samples from "../../../examples/labels/manifest.json";
import { fitSpecElements } from "../src/pages/labels/geometry.js";
import { labelPreviewData, labelRenderOptions } from "../src/pages/labels/preview-data.js";

describe("copyable label samples", () => {
  it("covers every purpose and documented size for all three groups", () => {
    expect(samples).toHaveLength(30);
    for (const group of [23, 33, 35]) {
      expect(
        samples
          .filter((sample) => sample.group === group)
          .map((sample) => `${sample.purpose}:${sample.widthMm}x${sample.heightMm}`),
      ).toEqual([
        "product_duplicate:30x20",
        "product_duplicate:58x40",
        "product_duplicate:75x120",
        "box:58x40",
        "box:75x120",
        "box:100x100",
        "box:100x150",
        "pallet:100x100",
        "pallet:100x150",
        "pallet:148x210",
      ]);
    }
  });

  /**
   * Markiro cuts box serials from extension digit 0 and pallet serials from 1,
   * and the two spaces must never interleave. The preview is where a reader
   * learns what a real SSCC looks like, so the demonstration values carry the
   * right first digit for their purpose rather than a single shared number.
   */
  it("demonstrates each purpose with an SSCC from its own extension digit", () => {
    for (const sample of samples) {
      const expected = { product_duplicate: "", box: "0", pallet: "1" }[sample.purpose];
      expect(sample.sampleData.sscc.slice(0, 1), sample.id).toBe(expected);
    }
  });

  it.each(samples)(
    "$id imports without movement, overlap or literal production codes",
    (sample) => {
      const source = readFileSync(
        resolve(import.meta.dirname, "../../../examples/labels", sample.source),
        "utf8",
      );
      const { spec, warnings } = parseLabelCode(source, { language: "zpl", dpi: 203 });
      // The manifest's own purpose, not a box/duplicate binary: "pallet" used
      // to fall through to the duplicate branch, which renders KM as a raster
      // and asserts a Data Matrix a pallet label does not have.
      const purpose = sample.purpose as LabelTemplatePurpose;
      const options = labelRenderOptions(purpose);
      const png = readFileSync(
        resolve(import.meta.dirname, "../../../examples/labels", sample.preview),
      );
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(mmToDots(spec.widthMm, 203));
      expect(png.readUInt32BE(20)).toBe(mmToDots(spec.heightMm, 203));
      expect(hasValidCheckDigit(sample.sampleData["product.gtin"])).toBe(true);
      if (purpose !== "product_duplicate")
        expect(hasValidCheckDigit(sample.sampleData.sscc)).toBe(true);
      expect(warnings).toEqual([]);
      expect(Math.abs(spec.widthMm - sample.widthMm)).toBeLessThan(0.07);
      expect(Math.abs(spec.heightMm - sample.heightMm)).toBeLessThan(0.07);
      for (const data of [sample.sampleData, labelPreviewData(purpose)]) {
        expect(fitSpecElements(spec, data, options)).toEqual({ ok: true, spec, adjustedIds: [] });
      }
      // A demonstration SSCC must never be baked into the source: the code a
      // tenant copies has to keep `{{sscc}}` so their own number substitutes.
      expect(source).not.toMatch(
        /ЕГАИС|egais|Дата розлива|DEMO-LABEL|046006820000000013|146006820000000027/,
      );
      const barcodes = spec.elements.filter((element) => element.kind === "barcode");
      expect(barcodes).toHaveLength(1);
      for (const barcode of barcodes) {
        if (purpose === "product_duplicate") {
          expect(() => assertDuplicateTemplate(spec)).not.toThrow();
          expect(barcode).toMatchObject({ format: "datamatrix", data: "km.code" });
          for (const dpi of [203, 300] as const) {
            for (const code of [
              sample.sampleData["km.code"],
              `010460000000001521DEMO-LABEL-42\u001d91ABCD\u001d92${"A".repeat(44)}`,
            ]) {
              expect(() =>
                rasterizeGs1DataMatrix(code, mmToDots(barcode.sizeMm, dpi)),
              ).not.toThrow();
            }
          }
        } else {
          expect(barcode).toMatchObject({ format: "code128", data: "sscc" });
          expect(barcode.moduleWidthMm).toBeGreaterThan(0);
          const bounds = elementBoundsMm(barcode, sample.sampleData, options);
          const quietZone = 10 * (barcode.moduleWidthMm ?? 0);
          expect(bounds.x).toBeGreaterThanOrEqual(quietZone);
          expect(spec.widthMm - bounds.x - bounds.w).toBeGreaterThanOrEqual(quietZone);
        }
      }
      const bounds = spec.elements
        .filter((element) => element.kind !== "line")
        .map((element) => ({
          id: element.id,
          ...elementBoundsMm(element, sample.sampleData, options),
        }));
      for (const [index, a] of bounds.entries()) {
        for (const b of bounds.slice(index + 1)) {
          const overlap =
            Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 &&
            Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.01;
          expect(overlap, `${sample.id}: ${a.id} overlaps ${b.id}`).toBe(false);
        }
      }
    },
  );
});
