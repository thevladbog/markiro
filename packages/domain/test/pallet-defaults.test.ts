import { describe, expect, it } from "vitest";

import {
  buildPalletLabelTemplates,
  buildPrintNameBoxLabelTemplates,
  code128ModuleCount,
  elementBoundsMm,
  GS1_128_QUIET_ZONE_MODULES,
  PALLET_LABEL_58X40_TEMPLATE_NAME,
  PALLET_LABEL_TEMPLATE_NAME,
  parseLabelTemplate,
  sampleLabelData,
  type LabelField,
  type LabelTemplateSpec,
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
  it("ships the 100×150 first and the 58×40 second", () => {
    const names = buildPalletLabelTemplates().map((t) => t.name);
    // Order is load-bearing: provisioning makes [0] the organisation default
    // and the editor starts a new pallet template from [0].
    expect(names).toEqual([PALLET_LABEL_TEMPLATE_NAME, PALLET_LABEL_58X40_TEMPLATE_NAME]);
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

  it("binds the counts and the SSCC", () => {
    const [large, small] = buildPalletLabelTemplates();
    const bound = (spec: LabelTemplateSpec) =>
      new Set(spec.elements.flatMap((el) => (el.kind === "field" ? [el.field] : [])));
    expect(bound(large!.spec).has("qty")).toBe(true);
    expect(bound(large!.spec).has("qty.boxes")).toBe(true);
    expect(bound(large!.spec).has("sscc")).toBe(true);
    // The small label counts boxes only: «120 кор.» beside the dates.
    const smallBound = bound(small!.spec);
    expect(smallBound.has("qty.boxes")).toBe(true);
    expect(smallBound.has("qty")).toBe(false);
    expect(smallBound.has("product.printName")).toBe(true);
    expect(smallBound.has("date")).toBe(true);
    expect(smallBound.has("expiry")).toBe(true);
    expect(smallBound.has("sscc")).toBe(true);
  });

  it("encodes the SSCC as a GS1-128 with an explicit X-dimension", () => {
    for (const { spec } of buildPalletLabelTemplates()) {
      const barcode = spec.elements.find((el) => el.kind === "barcode");
      expect(barcode).toBeDefined();
      if (barcode?.kind !== "barcode") throw new Error("unreachable");
      expect(barcode.format).toBe("code128");
      expect(barcode.data).toBe("sscc");
      // Left to the printer, a modal ^BY from a previously printed label
      // changes the bar width of a template that never mentioned one.
      expect(barcode.moduleWidthMm).toBeGreaterThan(0);
    }
  });

  it("leaves GS1's two mandatory 10X quiet zones inside the label", () => {
    for (const { spec } of buildPalletLabelTemplates()) {
      const barcode = spec.elements.find((el) => el.kind === "barcode");
      if (barcode?.kind !== "barcode") throw new Error("unreachable");
      const modules = code128ModuleCount("0".repeat(20), true);
      const withQuietZones =
        (modules + 2 * GS1_128_QUIET_ZONE_MODULES) * (barcode.moduleWidthMm ?? 0);
      expect(withQuietZones).toBeLessThanOrEqual(spec.widthMm + 1e-9);
    }
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
    for (const { spec } of buildPalletLabelTemplates()) {
      // Elements are declared top to bottom; each band must clear the next.
      // `val-qty` is the box layout's one coordinate-level exception (see
      // `labels-defaults.test.ts`): its bitmap origin sits in the preceding
      // raster box's transparent descent, but its visible content belongs to
      // the native-date row, so it is banded there instead of at its raw yMm.
      const nativeDateRowY = spec.elements.find((el) => el.id === "val-date")?.yMm;
      const bands = new Map<number, { ids: string[]; bottom: number }>();
      for (const el of spec.elements) {
        if (el.kind === "line") continue;
        const b = elementBoundsMm(el, data);
        const bandY = el.id === "val-qty" && nativeDateRowY !== undefined ? nativeDateRowY : b.y;
        const band = bands.get(bandY) ?? { ids: [], bottom: bandY };
        band.ids.push(el.id);
        band.bottom = Math.max(band.bottom, bandY + b.h);
        bands.set(bandY, band);
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
    }
  });

  it("is deterministic", () => {
    expect(buildPalletLabelTemplates()).toEqual(buildPalletLabelTemplates());
  });
});

describe("stock «Паллета 58×40»", () => {
  const spec = () => buildPalletLabelTemplates()[1]!.spec;

  it("is the print-name box 58×40 with the quantity row counting boxes", () => {
    const box = buildPrintNameBoxLabelTemplates().find(
      (t) => t.name === "Коробка 58×40 [Назв. для печати]",
    );
    expect(box).toBeDefined();
    const expected = structuredClone(box!.spec);
    for (const el of expected.elements) {
      if (el.kind === "text" && el.id === "cap-qty") el.text = "Коробов:";
      if (el.kind === "field" && el.id === "val-qty") el.field = "qty.boxes";
    }
    // Byte-for-byte the box layout otherwise: same geometry, same fonts,
    // same SSCC symbol — the owner asked for «ту же коробочную, под паллет».
    expect(spec()).toEqual(expected);
  });

  it("is 58×40 and names no resolution", () => {
    expect(spec().widthMm).toBe(58);
    expect(spec().heightMm).toBe(40);
    expect(PALLET_LABEL_58X40_TEMPLATE_NAME).not.toMatch(/dpi/i);
  });
});
