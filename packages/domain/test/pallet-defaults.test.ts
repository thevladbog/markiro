import { describe, expect, it } from "vitest";

import {
  buildPalletLabelTemplates,
  code128ModuleCount,
  elementBoundsMm,
  GS1_128_QUIET_ZONE_MODULES,
  PALLET_LABEL_TEMPLATE_NAME,
  parseLabelTemplate,
  sampleLabelData,
  type LabelField,
} from "../src/index.js";

/**
 * A realistic Russian product name — the case that used to print off the
 * right edge before the stock box labels reserved room for wrapping.
 */
const LONG_NAME = 'Сидр полусухой газированный "ДИКИЙ КРЕСТ" 0.45 л.';

function palletData(): Record<LabelField, string> {
  return {
    ...sampleLabelData(),
    "product.name": LONG_NAME,
    "product.printName": LONG_NAME,
    // The widest realistic pallet: five digits of units, three of boxes.
    qty: "10000",
    "qty.boxes": "120",
  };
}

describe("stock pallet label template", () => {
  it("ships exactly one pallet template", () => {
    expect(buildPalletLabelTemplates()).toHaveLength(1);
    expect(buildPalletLabelTemplates()[0]!.name).toBe(PALLET_LABEL_TEMPLATE_NAME);
  });

  it("keeps the name resolution-neutral", () => {
    // Templates stopped being dpi-specific in spec 2026-09-10: the station
    // prints at its own printer's resolution.
    for (const { name } of buildPalletLabelTemplates()) {
      expect(name).not.toMatch(/dpi/i);
    }
  });

  it("parses as a valid label template", () => {
    for (const { spec } of buildPalletLabelTemplates()) {
      expect(() => parseLabelTemplate(spec)).not.toThrow();
    }
  });

  it("binds both counts and the SSCC", () => {
    const spec = buildPalletLabelTemplates()[0]!.spec;
    const bound = new Set(
      spec.elements.flatMap((el) =>
        el.kind === "field" ? [el.field] : el.kind === "barcode" ? [] : [],
      ),
    );
    expect(bound.has("qty")).toBe(true);
    expect(bound.has("qty.boxes")).toBe(true);
    expect(bound.has("sscc")).toBe(true);
  });

  it("encodes the SSCC as a GS1-128 with an explicit X-dimension", () => {
    const spec = buildPalletLabelTemplates()[0]!.spec;
    const barcode = spec.elements.find((el) => el.kind === "barcode");
    expect(barcode).toBeDefined();
    if (barcode?.kind !== "barcode") throw new Error("unreachable");
    expect(barcode.format).toBe("code128");
    expect(barcode.data).toBe("sscc");
    // Left to the printer, a modal ^BY from a previously printed label
    // changes the bar width of a template that never mentioned one.
    expect(barcode.moduleWidthMm).toBeGreaterThan(0);
  });

  it("leaves GS1's two mandatory 10X quiet zones inside the label", () => {
    const spec = buildPalletLabelTemplates()[0]!.spec;
    const barcode = spec.elements.find((el) => el.kind === "barcode");
    if (barcode?.kind !== "barcode") throw new Error("unreachable");
    const modules = code128ModuleCount("0".repeat(20), true);
    const withQuietZones =
      (modules + 2 * GS1_128_QUIET_ZONE_MODULES) * (barcode.moduleWidthMm ?? 0);
    expect(withQuietZones).toBeLessThanOrEqual(spec.widthMm + 1e-9);
  });

  it("keeps every element inside the label, even with the longest name", () => {
    const data = palletData();
    for (const { name, spec } of buildPalletLabelTemplates()) {
      for (const el of spec.elements) {
        const b = elementBoundsMm(el, data);
        expect(b.x, `${name}/${el.id} left`).toBeGreaterThanOrEqual(0);
        expect(b.y, `${name}/${el.id} top`).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w, `${name}/${el.id} right`).toBeLessThanOrEqual(spec.widthMm + 1e-9);
        expect(b.y + b.h, `${name}/${el.id} bottom`).toBeLessThanOrEqual(spec.heightMm + 1e-9);
      }
    }
  });

  it("does not overlap its rows vertically", () => {
    const data = palletData();
    const spec = buildPalletLabelTemplates()[0]!.spec;
    // Elements are declared top to bottom; each band must clear the next.
    const bands = new Map<number, { ids: string[]; bottom: number }>();
    for (const el of spec.elements) {
      if (el.kind === "line") continue;
      const b = elementBoundsMm(el, data);
      const band = bands.get(b.y) ?? { ids: [], bottom: b.y };
      band.ids.push(el.id);
      band.bottom = Math.max(band.bottom, b.y + b.h);
      bands.set(b.y, band);
    }
    const ordered = [...bands.entries()].sort(([a], [b]) => a - b);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const [, current] = ordered[i]!;
      const [nextY, next] = ordered[i + 1]!;
      expect(
        current.bottom,
        `${current.ids.join(",")} into ${next.ids.join(",")}`,
      ).toBeLessThanOrEqual(nextY + 1e-9);
    }
  });

  it("is deterministic", () => {
    expect(buildPalletLabelTemplates()).toEqual(buildPalletLabelTemplates());
  });
});
