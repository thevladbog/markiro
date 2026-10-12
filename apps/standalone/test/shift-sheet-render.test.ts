import { describe, expect, it, vi } from "vitest";

import {
  buildPalletSheetPresets,
  decodeMonoRaster,
  isValidSscc,
  palletLabelFields,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";

import { renderShiftSheet, shiftLabelRender } from "../src/floor/print/shift-render.js";
import { renderSheetBytes } from "../src/labels/sheet-render.js";
import { sheetLogoOf } from "../src/labels/logo.js";
import { sheetedShift } from "./support/floor-work.js";
import { FIRST_SSCC } from "./support/printing.js";

const LOGO: MonoBitmap = { width: 16, height: 8, stride: 2, pixels: new Uint8Array(16).fill(0xff) };
const MARKIRO: MonoBitmap = { width: 8, height: 8, stride: 1, pixels: new Uint8Array(8).fill(1) };

/** A text of 4 dots a character, as tall as its line: jsdom has no canvas. */
const text: RasterizeTextFn = async (value, options) => {
  const width = Math.max(1, Math.min(value.length * 4, options.maxWidthPx ?? value.length * 4));
  const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
  const stride = Math.ceil(width / 8);
  return {
    width,
    height,
    bytesPerRow: stride,
    totalBytes: stride * height,
    hex: "00".repeat(stride * height),
  };
};

function fields(overrides: Partial<Parameters<typeof palletLabelFields>[0]> = {}) {
  return palletLabelFields({
    sscc: FIRST_SSCC,
    boxCount: 40,
    itemCount: 480,
    productName: "Молоко 3,2% 0,9 л",
    productPrintName: "Молоко 3,2%",
    gtin14: "04600682000013",
    egaisCode: null,
    shelfLifeDays: 10,
    operatorName: "Иванова",
    counterpartyName: null,
    closedAt: "2026-10-11T09:00:00.000Z",
    productionDate: "2026-10-11",
    shiftNumber: "OCT26-001",
    ...overrides,
  });
}

const [PORTRAIT, LANDSCAPE] = buildPalletSheetPresets();
if (PORTRAIT === undefined || LANDSCAPE === undefined) throw new Error("no stock sheets");
const SHEET = {
  id: "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
  name: PORTRAIT.name,
  revision: 1,
  spec: PORTRAIT.spec,
};
/** The context the sheet renderer takes for `fields()` on `shift`, with the Markiro logo. */
function contextOf(
  shift: Awaited<ReturnType<typeof sheetedShift>>,
  logo: MonoBitmap,
  source: "markiro" | "organization",
) {
  return {
    sscc: FIRST_SSCC,
    productPrintName: "Молоко 3,2%",
    gtin14: shift.snapshot.product.gtin14,
    egaisCode: null,
    productionDate: shift.copy.productionDate,
    shelfLifeDays: shift.snapshot.product.shelfLifeDays,
    boxCount: 40,
    itemCount: 480,
    shiftNumber: "OCT26-001",
    organizationName: "ООО «Молочный завод»",
    organizationInn: "7701234567",
    logo: sheetLogoOf(logo, source),
  };
}

const ORGANIZATION = { name: "ООО «Молочный завод»", inn: "7701234567", logo: LOGO };

describe("renderShiftSheet", () => {
  it("renders the frozen sheet with the frozen organization", async () => {
    expect(isValidSscc(FIRST_SSCC)).toBe(true);
    const shift = await sheetedShift({ palletSheet: SHEET, organization: ORGANIZATION });
    const bytes = await renderShiftSheet(shift, fields(), { sheetRasterize: text });
    expect(decodeMonoRaster(bytes)).toMatchObject({ widthMm: 210, heightMm: 297, dpi: 300 });
  });

  it("is the bytes of the sheet renderer over the shift's own facts, the pallet's fields and the frozen logo", async () => {
    const shift = await sheetedShift({ palletSheet: SHEET, organization: ORGANIZATION });
    const bytes = await renderShiftSheet(shift, fields(), { sheetRasterize: text });
    const expected = await renderSheetBytes(
      SHEET.spec,
      {
        sscc: FIRST_SSCC,
        productPrintName: "Молоко 3,2%",
        gtin14: shift.snapshot.product.gtin14,
        egaisCode: null,
        productionDate: shift.copy.productionDate,
        shelfLifeDays: shift.snapshot.product.shelfLifeDays,
        boxCount: 40,
        itemCount: 480,
        shiftNumber: "OCT26-001",
        organizationName: "ООО «Молочный завод»",
        organizationInn: "7701234567",
        logo: sheetLogoOf(LOGO, "organization"),
      },
      text,
    );
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it("prints the sheet of the sheet it froze, not another", async () => {
    const portrait = await sheetedShift({ palletSheet: SHEET, organization: ORGANIZATION });
    const landscape = await sheetedShift({
      palletSheet: { ...SHEET, name: LANDSCAPE.name, spec: LANDSCAPE.spec },
      organization: ORGANIZATION,
    });
    expect(
      decodeMonoRaster(await renderShiftSheet(portrait, fields(), { sheetRasterize: text })),
    ).toMatchObject({
      widthMm: 210,
      heightMm: 297,
    });
    expect(
      decodeMonoRaster(await renderShiftSheet(landscape, fields(), { sheetRasterize: text })),
    ).toMatchObject({
      widthMm: 297,
      heightMm: 210,
    });
  });

  it("prints the Markiro logo when the shift froze none, loading it once per sheet", async () => {
    const shift = await sheetedShift({
      palletSheet: SHEET,
      organization: { ...ORGANIZATION, logo: null },
    });
    const loadMarkiro = vi.fn(async () => MARKIRO);
    const bytes = await renderShiftSheet(shift, fields(), { sheetRasterize: text, loadMarkiro });
    expect(loadMarkiro).toHaveBeenCalledTimes(1);
    const markiro = await renderSheetBytes(SHEET.spec, contextOf(shift, MARKIRO, "markiro"), text);
    expect(Array.from(bytes)).toEqual(Array.from(markiro));
    // The two pictures differ on the page, so the match above is no tautology.
    const other = await renderSheetBytes(SHEET.spec, contextOf(shift, LOGO, "markiro"), text);
    expect(Array.from(other)).not.toEqual(Array.from(markiro));
  });

  it("does not load the Markiro logo for a shift that has its own", async () => {
    const shift = await sheetedShift({ palletSheet: SHEET, organization: ORGANIZATION });
    const loadMarkiro = vi.fn(async () => MARKIRO);
    await renderShiftSheet(shift, fields(), { sheetRasterize: text, loadMarkiro });
    expect(loadMarkiro).not.toHaveBeenCalled();
  });

  it("does not render without a frozen sheet, or without a frozen organization", async () => {
    const noSheet = await sheetedShift({ palletSheet: null, organization: ORGANIZATION });
    await expect(renderShiftSheet(noSheet, fields(), { sheetRasterize: text })).rejects.toThrow(
      "the shift froze no A4 sheet",
    );
    const noOrganization = await sheetedShift({ palletSheet: SHEET, organization: null });
    await expect(
      renderShiftSheet(noOrganization, fields(), { sheetRasterize: text }),
    ).rejects.toThrow("the shift froze no A4 sheet");
  });

  it("does not render a pallet whose counts are not numbers", async () => {
    const shift = await sheetedShift({ palletSheet: SHEET, organization: ORGANIZATION });
    const broken = { ...fields(), qty: "12 шт" };
    await expect(renderShiftSheet(shift, broken, { sheetRasterize: text })).rejects.toThrow();
    await expect(
      renderShiftSheet(shift, { ...fields(), "qty.boxes": "" }, { sheetRasterize: text }),
    ).rejects.toThrow();
  });

  it("carries the shift's production date and its expiry, never the pallet's close day", async () => {
    const shift = await sheetedShift({ palletSheet: SHEET, organization: ORGANIZATION });
    const drawn = vi.fn(text);
    await renderShiftSheet(shift, fields(), { sheetRasterize: drawn });
    const words = drawn.mock.calls.map(([value]) => value);
    expect(shift.copy.productionDate).toBe("2026-10-08");
    // Ten days of shelf life, the production day the first (plan А4's rule).
    expect(words).toEqual(expect.arrayContaining(["08.10.2026", "17.10.2026", "OCT26-001"]));
    // The pallet's own close day (11 October, `closedAt`) is not the production date.
    expect(words).not.toContain("11.10.2026");
  });

  it("draws the shift's facts: the product, the pallet's counts, the organization, the shift number", async () => {
    const shift = await sheetedShift({ palletSheet: SHEET, organization: ORGANIZATION });
    const drawn = vi.fn(text);
    await renderShiftSheet(shift, fields(), { sheetRasterize: drawn });
    const words = drawn.mock.calls.map(([value]) => value);
    expect(words).toEqual(
      expect.arrayContaining([
        "Молоко 3,2%",
        "ООО «Молочный завод»",
        "ИНН 7701234567",
        "OCT26-001",
        "04600682000013",
      ]),
    );
    // The boxes are counted before «КОРОБОВ», the units before «ЕДИНИЦ» — not the other way round.
    expect(words.join("|")).toContain("40|КОРОБОВ|480|ЕДИНИЦ");
    // A long name is the print name, not the catalog's full one.
    expect(words).not.toContain("Молоко 3,2% 0,9 л");
  });

  it("draws no shift number when the label has none, no INN when the organization has none", async () => {
    const shift = await sheetedShift({
      palletSheet: SHEET,
      organization: { ...ORGANIZATION, inn: null },
    });
    const drawn = vi.fn(text);
    await renderShiftSheet(shift, fields({ shiftNumber: null }), { sheetRasterize: drawn });
    const words = drawn.mock.calls.map(([value]) => value);
    expect(words).not.toContain("СМЕНА");
    expect(words.join("|")).not.toContain("ИНН");
  });

  it("is what an A4 printer gets from the shift's render, and a label printer does not", async () => {
    const shift = await sheetedShift({ palletSheet: SHEET, organization: ORGANIZATION });
    const render = shiftLabelRender(shift, { sheetRasterize: text, rasterize: text });
    const sheet = await render(shift.snapshot.boxTemplate.spec, fields(), {
      language: "zpl",
      dpi: 300,
      mode: "windows_driver",
      paper: "a4",
    });
    expect(decodeMonoRaster(sheet).widthMm).toBe(210);
    const label = await render(shift.snapshot.boxTemplate.spec, fields(), {
      language: "zpl",
      dpi: 300,
      mode: "windows_driver",
    });
    expect(decodeMonoRaster(label).widthMm).toBe(shift.snapshot.boxTemplate.spec.widthMm);
    const raw = await render(shift.snapshot.boxTemplate.spec, fields(), {
      language: "zpl",
      dpi: 203,
    });
    expect(new TextDecoder().decode(raw)).toContain("^XA");
  });

  it("gives the sheet a required area the shell can check", async () => {
    const shift = await sheetedShift({ palletSheet: SHEET, organization: ORGANIZATION });
    const page = decodeMonoRaster(
      await renderShiftSheet(shift, fields(), { sheetRasterize: text }),
    );
    const { left, top, right, bottom } = page.requiredBounds;
    expect(right).toBeGreaterThan(left);
    expect(bottom).toBeGreaterThan(top);
    expect(right).toBeLessThanOrEqual(page.widthDots);
    expect(bottom).toBeLessThanOrEqual(page.heightDots);
  });
});
