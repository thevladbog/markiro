import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  buildDateFreeBoxLabelTemplates,
  buildDatedBoxLabelTemplates,
  buildDefaultLabelTemplates,
  elementBoundsMm,
  estimatedTextWidthMm,
  generateTspl,
  generateZpl,
  labelFieldDisplayValue,
  mmToDots,
  parseLabelTemplate,
  ptToMm,
  sampleLabelData,
  wrapTextToWidth,
  WRAP_ELLIPSIS,
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

/** The five sizes, in the order both families are built in. */
const SIZES: Array<[number, number, number]> = [
  [58, 40, 203],
  [58, 40, 300],
  [75, 120, 203],
  [100, 100, 203],
  [100, 150, 203],
];

describe("buildDefaultLabelTemplates", () => {
  it("returns BOTH stock families with the exact seed names", () => {
    const templates = buildDefaultLabelTemplates();
    // The names are the `(tenant_id, name)` idempotency key of provisioning
    // and of every seed migration, so they are pinned literally here.
    expect(templates.map((t) => t.name)).toEqual([
      "Коробка 58×40 (203 dpi)",
      "Коробка 58×40 (300 dpi)",
      "Коробка 75×120 (203 dpi)",
      "Коробка 100×100 (203 dpi)",
      "Коробка 100×150 (203 dpi)",
      "Коробка 58×40 без дат (203 dpi)",
      "Коробка 58×40 без дат (300 dpi)",
      "Коробка 75×120 без дат (203 dpi)",
      "Коробка 100×100 без дат (203 dpi)",
      "Коробка 100×150 без дат (203 dpi)",
    ]);
    // ...and the whole list is exactly the two families, in that order, so
    // provisioning (which consumes this one function) seeds all ten.
    expect(templates).toEqual([
      ...buildDatedBoxLabelTemplates(),
      ...buildDateFreeBoxLabelTemplates(),
    ]);
    // The tenant default is still the DATED 58×40 @203 — adding a family must
    // not move it.
    expect(DEFAULT_BOX_LABEL_TEMPLATE_NAME).toBe("Коробка 58×40 (203 dpi)");
    expect(buildDatedBoxLabelTemplates()[0]!.name).toBe(DEFAULT_BOX_LABEL_TEMPLATE_NAME);
    expect(
      templates.filter((t) => t.name === DEFAULT_BOX_LABEL_TEMPLATE_NAME),
      "the default name must identify exactly one seeded template",
    ).toHaveLength(1);
    // Both families are cut in the same five sizes.
    for (const family of [buildDatedBoxLabelTemplates(), buildDateFreeBoxLabelTemplates()]) {
      expect(family.map((t) => [t.spec.widthMm, t.spec.heightMm, t.spec.dpi])).toEqual(SIZES);
    }
  });

  it("every spec validates and mirrors the approved mock-up layout", () => {
    for (const { spec } of buildDefaultLabelTemplates()) {
      expect(() => parseLabelTemplate(spec)).not.toThrow();
      const kindsByField = new Map(
        spec.elements.filter((el) => el.kind === "field").map((el) => [el.field, el] as const),
      );
      for (const field of ["product.name", "qty", "product.egais"] as const) {
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
    // The dated family — and only it — carries the two date fields.
    for (const { name, spec } of buildDatedBoxLabelTemplates()) {
      for (const field of ["date", "expiry"] as const) {
        expect(
          spec.elements.some((el) => el.kind === "field" && el.field === field),
          `${name}: missing field ${field}`,
        ).toBe(true);
      }
    }
  });

  /**
   * A quantity such as `5 шт.` contains Cyrillic, so both printer languages
   * rasterize it. The two dates are ASCII and stay on the printer's native
   * text path. The shared rasterizer centres glyphs in a 1.5em bitmap, which
   * puts their visible baseline about 0.25em below native text when both
   * elements use the same y origin. The third value therefore needs to start
   * one quarter-em earlier on the DATED stock labels; otherwise the physical
   * print visibly drops «5 шт.» below the two dates.
   */
  it("aligns the rasterized quantity value with the two native date values", () => {
    for (const { name, spec } of buildDatedBoxLabelTemplates()) {
      const date = spec.elements.find((el) => el.id === "val-date");
      const expiry = spec.elements.find((el) => el.id === "val-expiry");
      const qty = spec.elements.find((el) => el.id === "val-qty");
      if (date?.kind !== "field" || expiry?.kind !== "field" || qty?.kind !== "field") {
        throw new Error(`${name}: missing dated value row`);
      }

      expect(expiry.yMm, `${name}: the two native dates share an origin`).toBe(date.yMm);
      expect(qty.fontSizePt, `${name}: quantity/date type size`).toBe(date.fontSizePt);
      expect(qty.yMm, `${name}: raster origin is raised`).toBeLessThan(date.yMm);
      expect(
        qty.yMm + ptToMm(qty.fontSizePt) * 0.25,
        `${name}: visible quantity baseline`,
      ).toBeCloseTo(date.yMm, 1);
    }
  });

  /**
   * THE DATE-FREE FAMILY'S DEFINING PROPERTY. Not just "the two value fields
   * are gone" — the captions have to go with them, or the label prints two
   * empty column headings.
   */
  it("omits both dates — captions, values and printed output — from the date-free family", async () => {
    const data = sampleLabelData();
    for (const { name, spec } of buildDateFreeBoxLabelTemplates()) {
      expect(name, `${name}: seed name`).toContain("без дат");
      for (const el of spec.elements) {
        expect(el.id, `${name}: ${el.id} survived`).not.toBe("cap-date");
        expect(el.id, `${name}: ${el.id} survived`).not.toBe("cap-expiry");
        expect(el.id, `${name}: ${el.id} survived`).not.toBe("val-date");
        expect(el.id, `${name}: ${el.id} survived`).not.toBe("val-expiry");
        if (el.kind === "field") {
          expect(el.field, `${name}: ${el.id} is a date field`).not.toBe("date");
          expect(el.field, `${name}: ${el.id} is an expiry field`).not.toBe("expiry");
        }
        if (el.kind === "text") {
          expect(el.text, `${name}: ${el.id} caption`).not.toContain("Дата");
          expect(el.text, `${name}: ${el.id} caption`).not.toContain("Годен");
        }
      }
      // ...and nothing date-shaped reaches the printer either. Both dates are
      // ASCII `дд.мм.гггг`, so both emitters take their native-text path and
      // the values would appear verbatim in the document.
      const zpl = await generateZpl(spec, data, { rasterizeText: boundedRasterizer() });
      const tspl = await generateTspl(spec, data, { rasterizeText: boundedRasterizer() });
      for (const [language, document] of [
        ["ZPL", zpl],
        ["TSPL", tspl],
      ] as const) {
        expect(document, `${name}: ${language} production date leaked`).not.toContain(data.date);
        expect(document, `${name}: ${language} expiry date leaked`).not.toContain(data.expiry);
        expect(document, `${name}: ${language} date-like text`).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
      }
    }
  });

  /**
   * The quantity row of the date-free family is built the SAME way the ЕГАИС
   * row already is: caption in the first column, value in everything right of
   * it, both on one line. That is what frees the caption row's line box, and
   * it is what keeps the two rows looking like one block.
   */
  it("pairs the quantity caption and value on one row in the date-free family", () => {
    for (const { name, spec } of buildDateFreeBoxLabelTemplates()) {
      const capQty = spec.elements.find((el) => el.id === "cap-qty");
      const valQty = spec.elements.find((el) => el.id === "val-qty");
      const capEgais = spec.elements.find((el) => el.id === "cap-egais");
      const valEgais = spec.elements.find((el) => el.id === "val-egais");
      if (capQty?.kind !== "text" || valQty?.kind !== "field") {
        throw new Error(`${name}: missing quantity row`);
      }
      if (capEgais?.kind !== "text" || valEgais?.kind !== "field") {
        throw new Error(`${name}: missing ЕГАИС row`);
      }
      expect(capQty.text, `${name}: quantity caption`).toBe("Кол-во в упаковке:");
      // One row.
      expect(valQty.yMm, `${name}: quantity caption/value share a row`).toBe(capQty.yMm);
      // Caption left, value right — geometrically identical to ЕГАИС's row.
      expect(capQty.xMm, `${name}: caption x`).toBe(capEgais.xMm);
      expect(capQty.maxWidthMm, `${name}: caption box`).toBe(capEgais.maxWidthMm);
      expect(valQty.xMm, `${name}: value x`).toBe(valEgais.xMm);
      expect(valQty.maxWidthMm, `${name}: value box`).toBe(valEgais.maxWidthMm);
      // Narrowed rather than asserted non-null: `maxWidthMm` is optional on the
      // element schema, and the arithmetic below is meaningless without it, so
      // an absent box must fail as its own named problem instead of silently
      // becoming NaN (which `toBeGreaterThan` would report as a bogus mismatch).
      const capQtyBox = capQty.maxWidthMm;
      if (capQtyBox === undefined) {
        throw new Error(`${name}: quantity caption has no maxWidthMm to sit left of`);
      }
      expect(valQty.xMm, `${name}: value sits right of its caption`).toBeGreaterThan(
        capQty.xMm + capQtyBox - 1e-9,
      );
    }
  });

  /**
   * WHERE THE FREED SPACE WENT. The product owner chose taller bars over a
   * fourth name line: 4.8 mm on the dated 58×40 is well below GS1's guidance
   * for a logistics label. The numbers are produced by the layout's own
   * budget cursor, not hard-coded into it — but they are pinned here, because
   * "the bars got taller" is the entire reason this family exists.
   */
  it("spends the freed row on the barcode, not on a fourth name line", () => {
    const dated = buildDatedBoxLabelTemplates();
    const dateFree = buildDateFreeBoxLabelTemplates();
    const expectedBars: Record<string, number> = {
      "Коробка 58×40 без дат (203 dpi)": 7.6,
      "Коробка 58×40 без дат (300 dpi)": 7.6,
      "Коробка 75×120 без дат (203 dpi)": 10.3,
      "Коробка 100×100 без дат (203 dpi)": 13.5,
      "Коробка 100×150 без дат (203 dpi)": 13.5,
    };

    for (const [index, { name, spec }] of dateFree.entries()) {
      const bars = spec.elements.find((el) => el.kind === "barcode");
      const datedBars = dated[index]!.spec.elements.find((el) => el.kind === "barcode");
      if (bars?.kind !== "barcode" || datedBars?.kind !== "barcode") {
        throw new Error(`${name}: no barcode`);
      }
      expect(bars.sizeMm, `${name}: bar height`).toBe(expectedBars[name]);
      expect(bars.sizeMm, `${name}: taller than the dated label's bars`).toBeGreaterThan(
        datedBars.sizeMm,
      );
      // The name did NOT get a fourth line in exchange.
      const nameEl = spec.elements.find((el) => el.id === "name");
      if (nameEl?.kind !== "field") throw new Error(`${name}: no product name`);
      expect(nameEl.maxLines, `${name}: name maxLines`).toBe(3);
      // ...and nothing else on the label moved sideways or changed size:
      // the two families differ only in the date row.
      const datedName = dated[index]!.spec.elements.find((el) => el.id === "name");
      expect(nameEl, `${name}: product name differs from the dated label's`).toEqual(datedName);
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
      const nativeDateRowY = spec.elements.find((el) => el.id === "val-date")?.yMm;
      // Elements sharing a `yMm` are one horizontal band (the three-column
      // row); bands must not reach into the next band's top edge. The dated
      // quantity is the one exception at the coordinate level: its bitmap
      // origin starts in the preceding raster box's transparent descent, but
      // its visible content belongs to the native-date row (asserted above).
      const bands = new Map<number, { ids: string[]; bottom: number }>();
      for (const el of spec.elements) {
        const b = elementBoundsMm(el, data);
        const visualY = el.id === "val-qty" && nativeDateRowY !== undefined ? nativeDateRowY : b.y;
        const band = bands.get(visualY) ?? { ids: [], bottom: visualY };
        band.ids.push(el.id);
        band.bottom = Math.max(band.bottom, visualY + b.h);
        bands.set(visualY, band);
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
      expect(call![1].maxLines, `${name}: maxLines`).toBe(3);

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
      expect(tspl, `${name}: TSPL HRI`).toMatch(/BARCODE \d+,\d+,"128",\d+,0,0,\d+,\d+,/);
    }
  });

  /**
   * The product name gets THREE lines (it had two, and the first physical
   * print already filled both with a name the owner says is not their
   * longest), and the «SSCC:» caption that used to sit above the barcode is
   * gone — the digits underneath already identify it, and at 5 pt the caption
   * was barely legible on the print.
   */
  it("gives the product name three lines and drops the SSCC caption", () => {
    for (const { name, spec } of buildDefaultLabelTemplates()) {
      const nameEl = spec.elements.find((el) => el.id === "name");
      expect(nameEl, `${name}: no product-name element`).toBeDefined();
      if (nameEl?.kind !== "field") throw new Error("unreachable");
      expect(nameEl.maxLines, `${name}: name maxLines`).toBe(3);

      expect(
        spec.elements.some((el) => el.kind === "text" && el.text.startsWith("SSCC")),
        `${name}: the SSCC caption is back`,
      ).toBe(false);
      // The caption it replaced is still there, one row up: the digits are
      // the human-readable form of the barcode, not a stray number.
      expect(spec.elements.some((el) => el.kind === "field" && el.field === "sscc")).toBe(true);
    }
  });

  /**
   * The SSCC barcode's width is DETERMINISTIC (18 digits + the emitters' own
   * `(00)` prefix = 20 digits = 156 modules in subset C), which is what lets
   * the template centre it by arithmetic. This pins both halves: the widest
   * X-dimension that leaves GS1's 10X quiet zones inside the content width,
   * and the resulting centred `xMm`.
   */
  it("centres the SSCC barcode at the widest GS1-legal module width", () => {
    const expected: Record<string, { moduleWidthMm: number; xMm: number }> = {
      // 203 dpi: 2 dots = 0.2502 mm, already GS1's MINIMUM X-dimension — a
      // 3-dot module would be 58.6 mm of bars on a 58 mm label.
      "Коробка 58×40 (203 dpi)": { moduleWidthMm: 0.2502, xMm: 9.5 },
      // 300 dpi: 3 dots = 0.254 mm. 4 dots (52.8 mm of bars) fits the label
      // but leaves only 2.6 mm of quiet zone where GS1 wants 3.4 mm.
      "Коробка 58×40 (300 dpi)": { moduleWidthMm: 0.254, xMm: 9.2 },
      "Коробка 75×120 (203 dpi)": { moduleWidthMm: 0.3754, xMm: 8.2 },
      "Коробка 100×100 (203 dpi)": { moduleWidthMm: 0.5005, xMm: 11 },
      "Коробка 100×150 (203 dpi)": { moduleWidthMm: 0.5005, xMm: 11 },
      // The date-free family changes the label's vertical budget only, so at
      // each size its symbol is the same WIDTH in the same place — only
      // taller.
      "Коробка 58×40 без дат (203 dpi)": { moduleWidthMm: 0.2502, xMm: 9.5 },
      "Коробка 58×40 без дат (300 dpi)": { moduleWidthMm: 0.254, xMm: 9.2 },
      "Коробка 75×120 без дат (203 dpi)": { moduleWidthMm: 0.3754, xMm: 8.2 },
      "Коробка 100×100 без дат (203 dpi)": { moduleWidthMm: 0.5005, xMm: 11 },
      "Коробка 100×150 без дат (203 dpi)": { moduleWidthMm: 0.5005, xMm: 11 },
    };

    for (const { name, spec } of buildDefaultLabelTemplates()) {
      const barcode = spec.elements.find((el) => el.kind === "barcode");
      if (barcode?.kind !== "barcode") throw new Error(`${name}: no barcode`);
      expect(barcode.moduleWidthMm, `${name}: module width`).toBe(expected[name]!.moduleWidthMm);
      expect(barcode.xMm, `${name}: centred x`).toBe(expected[name]!.xMm);

      // Whole dots, or the printer rounds the template's intent away.
      const moduleDots = (barcode.moduleWidthMm! * spec.dpi) / 25.4;
      expect(moduleDots, `${name}: module in dots`).toBeCloseTo(Math.round(moduleDots), 3);

      // Centred, and its quiet zones are real blank label on both sides.
      const bars = 156 * barcode.moduleWidthMm!;
      expect(barcode.xMm, `${name}: centred`).toBeCloseTo((spec.widthMm - bars) / 2, 1);
      const quietZone = (spec.widthMm - bars) / 2;
      expect(quietZone, `${name}: quiet zone`).toBeGreaterThanOrEqual(10 * barcode.moduleWidthMm!);
    }
  });

  /**
   * SSCC BLOCK CENTRING, the second physical print's first correction.
   *
   * The barcode was already centred — `defaults.ts` computes its `xMm` by
   * arithmetic. What was skewed was the human-readable digit line beneath it:
   * a left-flush `field` at the content margin, so on the 58×40 its digits
   * started at 2 mm against the bars' 9.5 mm. It now carries
   * `align: "center"` inside the same full-width content box the barcode is
   * centred in, so the two share a centre line at every size.
   */
  it("centres the SSCC digit line on the same axis as the bars, at every size", () => {
    const data = sampleLabelData();
    const digits = labelFieldDisplayValue("sscc", data);
    expect(digits).toBe("(00)346006820000000014");

    for (const { name, spec } of buildDefaultLabelTemplates()) {
      const digitEl = spec.elements.find((el) => el.id === "val-sscc");
      const barcode = spec.elements.find((el) => el.id === "bc-sscc");
      if (digitEl?.kind !== "field" || barcode?.kind !== "barcode") {
        throw new Error(`${name}: missing SSCC block`);
      }
      expect(digitEl.align, `${name}: digit-line align`).toBe("center");
      expect(digitEl.maxWidthMm, `${name}: digit line needs a box to centre in`).toBeGreaterThan(0);

      // Where the digits actually get DRAWN, using the same estimate every
      // renderer's alignment offset is built on.
      const textW = estimatedTextWidthMm(digits, digitEl.fontSizePt);
      const digitsX = digitEl.xMm + (digitEl.maxWidthMm! - textW) / 2;
      const barsW = 156 * barcode.moduleWidthMm!;

      const digitsCentre = digitsX + textW / 2;
      const barsCentre = barcode.xMm + barsW / 2;
      // Half a printer dot at 300 dpi is 0.042 mm; the two centre lines agree
      // to well inside that, i.e. to the same column of ink.
      expect(Math.abs(digitsCentre - barsCentre), `${name}: centre offset`).toBeLessThan(0.05);
      // The digits sit UNDER the bars, not beside them.
      expect(digitsX, `${name}: digits start right of the bars' left edge`).toBeGreaterThan(
        barcode.xMm,
      );
      expect(digitsX + textW, `${name}: digits end left of the bars' right edge`).toBeLessThan(
        barcode.xMm + barsW,
      );
      // The regression itself: flush-left would put them at the margin.
      expect(digitsX, `${name}: digits are no longer flush left`).toBeGreaterThan(digitEl.xMm + 1);
    }
  });

  /**
   * ...and the centring must be honoured by ALL THREE renderers, or the same
   * template prints differently depending on which printer the station has.
   * ZPL delegates to `^FB`'s justification parameter; TSPL has no equivalent
   * (its `TEXT` alignment parameter carries no width) and computes the x
   * offset itself; the admin preview draws at `x + boxWidth/2`. This asserts
   * the two EMITTERS agree with each other and with the arithmetic the
   * preview uses.
   */
  it("emits the centred digit line as centred ZPL and centred TSPL alike", async () => {
    const data = sampleLabelData();
    const digits = labelFieldDisplayValue("sscc", data);

    for (const { name, spec } of buildDefaultLabelTemplates()) {
      const digitEl = spec.elements.find((el) => el.id === "val-sscc");
      const barcode = spec.elements.find((el) => el.id === "bc-sscc");
      if (digitEl?.kind !== "field" || barcode?.kind !== "barcode") {
        throw new Error(`${name}: missing SSCC block`);
      }
      const barsLeftDots = mmToDots(barcode.xMm, spec.dpi);
      const barsCentreDots = barsLeftDots + (156 * mmToDots(barcode.moduleWidthMm!, spec.dpi)) / 2;

      const zpl = await generateZpl(spec, data, { rasterizeText: boundedRasterizer() });
      const tspl = await generateTspl(spec, data, { rasterizeText: boundedRasterizer() });

      // ZPL: a field block of the element's full width, justified CENTRE,
      // anchored at the element's own x — the printer does the centring.
      const boxDots = mmToDots(digitEl.maxWidthMm!, spec.dpi);
      const elementXDots = mmToDots(digitEl.xMm, spec.dpi);
      const zplLine = new RegExp(
        `\\^FO${elementXDots},\\d+\\^A0N,\\d+,\\d+\\^FB${boxDots},1,0,C,0\\^FD${digits.replace(
          /[()]/g,
          (c) => `\\${c}`,
        )}\\^FS`,
      );
      expect(zpl, `${name}: ZPL centred field block`).toMatch(zplLine);
      // The block's midpoint IS the bars' midpoint (to the dot).
      expect(
        Math.abs(elementXDots + boxDots / 2 - barsCentreDots),
        `${name}: ZPL block centre vs bars centre`,
      ).toBeLessThanOrEqual(1);

      // TSPL: no alignment parameter at all — the x is already shifted.
      const tsplMatch = tspl.match(
        new RegExp(`^TEXT (\\d+),\\d+,"0",0,\\d+,\\d+,"${digits.replace(/[()]/g, "\\$&")}"$`, "m"),
      );
      expect(tsplMatch, `${name}: TSPL digit line`).not.toBeNull();
      const tsplX = Number(tsplMatch![1]);
      const tsplWidthDots = mmToDots(estimatedTextWidthMm(digits, digitEl.fontSizePt), spec.dpi);
      expect(
        Math.abs(tsplX + tsplWidthDots / 2 - barsCentreDots),
        `${name}: TSPL digit centre vs bars centre`,
      ).toBeLessThanOrEqual(1);
      // And it is genuinely shifted off the element's own x — the bug was
      // that it printed there.
      expect(tsplX, `${name}: TSPL digit line was not shifted`).toBeGreaterThan(elementXDots);
    }
  });

  /**
   * QUANTITY UNIT, the second physical print's other correction: the value
   * printed as a bare `5` where the approved mock-up reads «5 шт.». The unit
   * comes from `labelFieldDisplayValue`, so both emitters AND the bounds
   * heuristic (hence the admin preview) get it from one place.
   */
  it("prints the quantity with its «шт.» unit in both languages", async () => {
    for (const qty of ["5", "24"]) {
      const data = { ...sampleLabelData(), qty };
      for (const { name, spec } of buildDefaultLabelTemplates()) {
        const zpl = await generateZpl(spec, data, { rasterizeText: boundedRasterizer() });
        const tspl = await generateTspl(spec, data, { rasterizeText: boundedRasterizer() });
        // «шт.» is Cyrillic, so both emitters take their RASTER path for it;
        // assert through the rasterizer's own call log rather than the
        // document, which carries a bitmap rather than the string.
        for (const [language, rasterize] of [
          ["ZPL", generateZpl],
          ["TSPL", generateTspl],
        ] as const) {
          const rasterizeText = boundedRasterizer();
          await rasterize(spec, data, { rasterizeText });
          const texts = vi.mocked(rasterizeText).mock.calls.map(([t]) => t);
          expect(texts, `${name}: ${language} qty`).toContain(`${qty} шт.`);
          expect(texts, `${name}: ${language} bare qty leaked`).not.toContain(qty);
        }
        expect(zpl.length, `${name}: ZPL emitted`).toBeGreaterThan(0);
        expect(tspl.length, `${name}: TSPL emitted`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The unit makes the value string longer, and «Кол-во в упаковке:» is the
   * tightest column on the label. `labelFieldDisplayValue` feeds `bounds.ts`,
   * so this is measured through the SAME heuristic the containment check and
   * the preview use, at every size.
   */
  it("fits the quantity value, unit included, inside its column at every size", () => {
    for (const qty of ["5", "24", "100", "1000"]) {
      const data = { ...sampleLabelData(), qty };
      for (const { name, spec } of buildDefaultLabelTemplates()) {
        const valQty = spec.elements.find((el) => el.id === "val-qty");
        if (valQty?.kind !== "field") throw new Error(`${name}: no val-qty`);
        const rendered = estimatedTextWidthMm(`${qty} шт.`, valQty.fontSizePt);
        expect(rendered, `${name}: "${qty} шт." vs column`).toBeLessThanOrEqual(valQty.maxWidthMm!);
        // ...and it neither wraps nor gets clipped: one line, un-ellipsized.
        const b = elementBoundsMm(valQty, data);
        expect(b.w, `${name}: bounds width`).toBeCloseTo(rendered, 6);
        expect(b.x + b.w, `${name}: right edge`).toBeLessThanOrEqual(spec.widthMm);
      }
    }
  });

  /**
   * THE GENERAL INVARIANT: nothing on any stock template is wider than the box
   * it was given. This is the class-level guard for the defect the two 100 mm
   * templates shipped with — «Дата производства:» and «Кол-во в упаковке:»
   * both measured 31.43 mm in a 31.10 mm column and printed ellipsized —
   * whose cause was NOT the wording but `pt()`'s whole-point rounding: at
   * scale 100/58 a 5 pt caption wants 8.62 pt, `Math.round` gave it 9, and the
   * column it lives in does not round up with it.
   *
   * Sizes are now derived from the fit (`fitPt` in `defaults.ts`), so this
   * holds by construction — but only for as long as nobody replaces that with
   * bare proportional scaling again, or adds a size where the arithmetic
   * happens to be kind. Measured through `estimatedTextWidthMm`, the same
   * predicate `wrap.ts` uses to decide whether to ellipsize, so "passes here"
   * means "is not clipped there".
   */
  it("fits every element's estimated content inside its own box, at every size", () => {
    // Sample data, plus the widest realistic value each field can carry: a
    // five-digit pack count with its «шт.» unit and a full 19-digit alcocode.
    const datasets: Array<[string, Record<LabelField, string>]> = [
      ["sample", sampleLabelData()],
      [
        "widest",
        { ...sampleLabelData(), qty: "10000", "product.egais": "0".repeat(19) } as Record<
          LabelField,
          string
        >,
      ],
    ];

    for (const [label, data] of datasets) {
      for (const { name, spec } of buildDefaultLabelTemplates()) {
        for (const el of spec.elements) {
          if (el.kind !== "text" && el.kind !== "field") continue;
          const text = el.kind === "text" ? el.text : labelFieldDisplayValue(el.field, data);
          const box = el.maxWidthMm;
          expect(box, `${name}/${el.id}: every element needs a width budget`).toBeGreaterThan(0);

          const measure = (s: string) => estimatedTextWidthMm(s, el.fontSizePt);
          const lines = wrapTextToWidth(text, measure, box!, el.maxLines ?? 1);
          for (const line of lines) {
            expect(measure(line), `${label} ${name}/${el.id}: "${line}"`).toBeLessThanOrEqual(box!);
          }
          // The product name is the ONE string with unbounded content: it is
          // width-safe by wrapping to `maxLines` and, for a name longer than
          // three lines, by a VISIBLE ellipsis. Everything else — every
          // caption, every value — must print in full.
          if (el.id === "name") continue;
          expect(lines.length, `${label} ${name}/${el.id}: line count`).toBe(1);
          expect(lines.join(""), `${label} ${name}/${el.id}: clipped`).not.toContain(WRAP_ELLIPSIS);
          expect(measure(text), `${label} ${name}/${el.id}: "${text}" vs box`).toBeLessThanOrEqual(
            box!,
          );
        }
      }
    }
  });

  /**
   * ...and the fit must not be bought with illegibility. The five templates
   * are one design at five sizes, so the type has to stay essentially
   * proportional to the 58×40 base; the fit rule may only ever give back the
   * one point `pt()`'s rounding took. A future caption long enough to need
   * more than that is a wording problem, and this test says so out loud
   * rather than letting the label shrink to 4 pt in silence.
   */
  it("keeps the fitted type within one point of the proportional size", () => {
    const base: Record<string, number> = {
      name: 10,
      "cap-date": 5,
      "cap-expiry": 5,
      "cap-qty": 5,
      "cap-egais": 5,
      "val-sscc": 5,
      "val-date": 8,
      "val-expiry": 8,
      "val-qty": 8,
      "val-egais": 8,
    };

    for (const { name, spec } of buildDefaultLabelTemplates()) {
      const scale = Math.min(spec.widthMm / 58, spec.heightMm / 40);
      for (const el of spec.elements) {
        if (el.kind !== "text" && el.kind !== "field") continue;
        const proportional = Math.round(base[el.id]! * scale);
        expect(el.fontSizePt, `${name}/${el.id}: above proportional`).toBeLessThanOrEqual(
          proportional,
        );
        expect(el.fontSizePt, `${name}/${el.id}: shrunk to illegibility`).toBeGreaterThanOrEqual(
          proportional - 1,
        );
        expect(el.fontSizePt, `${name}/${el.id}: model range`).toBeGreaterThanOrEqual(4);
      }
      // The three column captions are one row and must read as one row.
      const captionSizes = new Set(
        spec.elements
          .filter((el) => ["cap-date", "cap-expiry", "cap-qty"].includes(el.id))
          .map((el) => (el.kind === "text" ? el.fontSizePt : NaN)),
      );
      expect(captionSizes.size, `${name}: caption row has mixed sizes`).toBe(1);
    }
  });

  /** The bars got taller — the whole point of reclaiming the caption's row. */
  it("prints a taller barcode than the 3.5 mm the first physical label used", () => {
    for (const { name, spec } of buildDefaultLabelTemplates()) {
      const barcode = spec.elements.find((el) => el.kind === "barcode");
      if (barcode?.kind !== "barcode") throw new Error(`${name}: no barcode`);
      expect(barcode.sizeMm, `${name}: bar height`).toBeGreaterThan(3.5);
    }
  });

  /**
   * DATE FORMAT REGRESSION GUARD. The first physical print read `2026-08-20`
   * where the customer-approved mock-up says `20.08.2026`. Both label date
   * fields are asserted through the RENDERED output, not just the data, so a
   * future change that reintroduces ISO anywhere between `sampleLabelData()`
   * and the emitters fails here.
   */
  it("prints both dates as дд.мм.гггг, never ISO", async () => {
    const data = sampleLabelData();
    expect(data.date).toBe("23.07.2026");
    expect(data.expiry).toBe("19.01.2027");

    // The DATED family only — the other five print no dates at all, which is
    // asserted separately above.
    for (const { name, spec } of buildDatedBoxLabelTemplates()) {
      const zpl = await generateZpl(spec, data, { rasterizeText: boundedRasterizer() });
      const tspl = await generateTspl(spec, data, { rasterizeText: boundedRasterizer() });
      for (const [language, document] of [
        ["ZPL", zpl],
        ["TSPL", tspl],
      ] as const) {
        expect(document, `${name}: ${language} production date`).toContain("23.07.2026");
        expect(document, `${name}: ${language} expiry date`).toContain("19.01.2027");
        expect(document, `${name}: ${language} ISO leak`).not.toMatch(/\d{4}-\d{2}-\d{2}/);
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

  /**
   * DRIFT GUARD, pointed at the CURRENT migration.
   *
   * It has walked forward from the initial `0049` seed through the `0050` and
   * `0052` force-overwrites. Those files' inlined JSON is HISTORICAL: changing
   * it would rewrite history without updating a single production row. `0056`
   * is the current force-overwrite (the raster/native baseline correction),
   * so it is the one that must stay in step with this module. Whoever adds the
   * next stock-template reseed must point this guard at that migration.
   */
  async function inlinedRows(file: string): Promise<Array<{ name: string; spec: unknown }>> {
    const sql = await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8");
    return [...sql.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => ({
      name: m[1]!,
      spec: JSON.parse(m[2]!) as unknown,
    }));
  }

  it("matches the jsonb inlined into db migration 0056 (drift guard)", async () => {
    expect(await inlinedRows("0056_align_dated_label_quantity.sql")).toEqual(
      buildDatedBoxLabelTemplates().map((t) => ({ name: t.name, spec: t.spec })),
    );
  });

  /**
   * The DATE-FREE family's own drift guard. Its migration is an
   * insert-if-absent (these names have never existed, so nothing needs
   * overwriting), and like 0052's it must stay in step with this module —
   * whoever changes the layout has to regenerate the SQL.
   */
  it("matches the jsonb inlined into db migration 0053 (drift guard)", async () => {
    expect(await inlinedRows("0053_date_free_label_templates.sql")).toEqual(
      buildDateFreeBoxLabelTemplates().map((t) => ({ name: t.name, spec: t.spec })),
    );
  });
});
