import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  buildDefaultLabelTemplates,
  elementBoundsMm,
  estimatedTextWidthMm,
  generateTspl,
  generateZpl,
  labelFieldDisplayValue,
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

    for (const { name, spec } of buildDefaultLabelTemplates()) {
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
   * It has walked forward twice now — `0049_default_label_templates.sql` (the
   * INSERT that first seeded these five templates), then
   * `0050_reseed_default_label_templates.sql`. Both files' inlined JSON is
   * HISTORICAL: it is what already-migrated databases received, and rewriting
   * it would rewrite history without changing a single production row. `0051`
   * is the migration that force-overwrites those rows with the current specs
   * (the centred SSCC digit line), so it is the one that has to stay in step
   * with this module — and this test must be repointed again by whoever adds
   * the next reseed.
   */
  it("matches the jsonb inlined into db migration 0051 (drift guard)", async () => {
    const sql = await readFile(
      new URL("../../db/migrations/0051_center_sscc_digits_label_templates.sql", import.meta.url),
      "utf8",
    );
    const rows = [...sql.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => ({
      name: m[1]!,
      spec: JSON.parse(m[2]!) as unknown,
    }));
    expect(rows).toEqual(buildDefaultLabelTemplates().map((t) => ({ name: t.name, spec: t.spec })));
  });
});
