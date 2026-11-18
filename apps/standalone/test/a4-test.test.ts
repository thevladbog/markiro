import { describe, expect, it } from "vitest";

import {
  buildPalletSheetPresets,
  decodeMonoRaster,
  isValidSscc,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";

import { a4TestSheet, makeA4TestSscc } from "../src/floor/setup/a4-test.js";
import { sheetLogoOf } from "../src/labels/logo.js";
import { renderSheetBytes } from "../src/labels/sheet-render.js";

const LOGO: MonoBitmap = { width: 8, height: 4, stride: 1, pixels: new Uint8Array(4).fill(0xf0) };
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
const WORDS = { title: "Проверка принтера А4", product: "Тестовый лист — не для палеты" };

describe("the A4 test SSCC", () => {
  it("is a valid SSCC of the company prefix 9999, which no production code has", () => {
    expect(makeA4TestSscc(() => undefined)).toBe("999900000000000008");
    expect(isValidSscc(makeA4TestSscc(() => undefined))).toBe(true);
    const random = makeA4TestSscc();
    expect(random).toMatch(/^9999[0-9]{14}$/);
    expect(isValidSscc(random)).toBe(true);
  });

  it("takes each digit of its own random byte, so two tests differ", () => {
    const first = makeA4TestSscc((bytes) => bytes.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
    const second = makeA4TestSscc((bytes) =>
      bytes.set([2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
    );
    expect(first.slice(0, 17)).toBe("99991234567890123");
    expect(second).not.toBe(first);
    expect(isValidSscc(first)).toBe(true);
    expect(isValidSscc(second)).toBe(true);
  });
});

describe("the A4 test sheet", () => {
  it("is a 210 x 297 mm page at 300 dpi for portrait and 297 x 210 for landscape", async () => {
    const sscc = makeA4TestSscc(() => undefined);
    const portrait = await a4TestSheet("portrait", sscc, WORDS, {
      rasterize: text,
      logo: async () => LOGO,
    });
    expect(portrait.raster).toMatchObject({ widthMm: 210, heightMm: 297, dpi: 300 });
    expect(decodeMonoRaster(portrait.bytes)).toMatchObject({ widthMm: 210, heightMm: 297 });
    const landscape = await a4TestSheet("landscape", sscc, WORDS, {
      rasterize: text,
      logo: async () => LOGO,
    });
    expect(landscape.raster).toMatchObject({ widthMm: 297, heightMm: 210, dpi: 300 });
  });

  it("is drawn by the very renderer of a pallet's sheet: the preview is the print", async () => {
    const sscc = makeA4TestSscc(() => undefined);
    const { bytes, raster } = await a4TestSheet("portrait", sscc, WORDS, {
      rasterize: text,
      logo: async () => LOGO,
    });
    const preset = buildPalletSheetPresets().find(
      (each) => each.spec.page.orientation === "portrait" && each.spec.page.copies === 1,
    );
    if (preset === undefined) throw new Error("no stock sheet");
    const real = await renderSheetBytes(
      preset.spec,
      {
        sscc,
        productPrintName: WORDS.product,
        gtin14: "04600000000015",
        egaisCode: null,
        productionDate: null,
        shelfLifeDays: null,
        boxCount: 48,
        itemCount: 576,
        shiftNumber: null,
        organizationName: WORDS.title,
        organizationInn: null,
        logo: sheetLogoOf(LOGO, "markiro"),
      },
      text,
    );
    expect(Array.from(bytes)).toEqual(Array.from(real));
    // What the screen shows is what the bytes decode to.
    expect(Array.from(decodeMonoRaster(bytes).pixels)).toEqual(Array.from(raster.pixels));
  });

  it("carries the SSCC it was given, so another test's sheet is another sheet", async () => {
    const one = await a4TestSheet(
      "portrait",
      makeA4TestSscc(() => undefined),
      WORDS,
      {
        rasterize: text,
        logo: async () => LOGO,
      },
    );
    const other = await a4TestSheet(
      "portrait",
      makeA4TestSscc((bytes) => bytes.fill(7)),
      WORDS,
      { rasterize: text, logo: async () => LOGO },
    );
    expect(Array.from(one.bytes)).not.toEqual(Array.from(other.bytes));
  });

  it("draws the words it was given and a facts-free sheet: no production date, no INN", async () => {
    const drawn: string[] = [];
    await a4TestSheet(
      "portrait",
      makeA4TestSscc(() => undefined),
      WORDS,
      {
        rasterize: async (value, options) => {
          drawn.push(value);
          return text(value, options);
        },
        logo: async () => LOGO,
      },
    );
    expect(drawn).toEqual(expect.arrayContaining([WORDS.title, WORDS.product]));
    expect(drawn.join("|")).not.toMatch(/ИНН/);
    // The bundled logo is the Markiro one, and the sheet says so.
    expect(drawn).toContain("Сформировано в Маркиро");
    expect(drawn).not.toContain("ПРОИЗВЕДЕНО");
  });

  it("does not make a sheet when the logo cannot be had", async () => {
    await expect(
      a4TestSheet(
        "portrait",
        makeA4TestSscc(() => undefined),
        WORDS,
        {
          rasterize: text,
          logo: async () => {
            throw new Error("no canvas");
          },
        },
      ),
    ).rejects.toThrow("no canvas");
  });
});
