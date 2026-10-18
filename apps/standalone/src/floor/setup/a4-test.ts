import {
  buildPalletSheetPresets,
  encodeMonoRaster,
  gs1CheckDigit,
  type MonoBitmap,
  type MonoRaster,
  type RasterizeTextFn,
} from "@markiro/domain";

import { loadBundledMarkiroLogo, sheetLogoOf } from "../../labels/logo.js";
import { rasterizeSheetText } from "../../labels/rasterizer.js";
import { renderSheetRaster } from "../../labels/sheet-render.js";

/**
 * A synthetic SSCC for one A4 test print (the cloud station's
 * `makeA4TestSscc`): company prefix 9999, never one of production's, random,
 * so a sheet left over from an earlier test never passes this one.
 */
export function makeA4TestSscc(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): string {
  const bytes = new Uint8Array(13);
  random(bytes);
  const body = `9999${Array.from(bytes, (byte) => String(byte % 10)).join("")}`;
  return `${body}${gs1CheckDigit(body)}`;
}

/** What `a4TestSheet` makes it from: the renderer's text and the logo, a test gives its own. */
export interface A4TestDeps {
  rasterize?: RasterizeTextFn;
  logo?: () => Promise<MonoBitmap>;
}

/**
 * The A4 test sheet (#704): the stock single sheet of `orientation` with the
 * bundled Markiro logo, the words of `text` and the synthetic `sscc`. It is
 * drawn by the very function a pallet's sheet is (`renderSheetRaster`), so the
 * raster for the on-screen preview and its bytes for the driver are what a
 * real print would be — only the facts are made up.
 */
export async function a4TestSheet(
  orientation: "portrait" | "landscape",
  sscc: string,
  text: { title: string; product: string },
  deps: A4TestDeps = {},
): Promise<{ raster: MonoRaster; bytes: Uint8Array }> {
  const preset = buildPalletSheetPresets().find(
    (each) => each.spec.page.orientation === orientation && each.spec.page.copies === 1,
  );
  if (preset === undefined) throw new Error("no stock A4 sheet");
  const logo = await (deps.logo ?? loadBundledMarkiroLogo)();
  const raster = await renderSheetRaster(
    preset.spec,
    {
      sscc,
      productPrintName: text.product,
      gtin14: "04600000000015",
      // A sample: no EGAIS code (plan ТОВ prints one only from a shift).
      egaisCode: null,
      productionDate: null,
      shelfLifeDays: null,
      boxCount: 48,
      itemCount: 576,
      shiftNumber: null,
      organizationName: text.title,
      organizationInn: null,
      logo: sheetLogoOf(logo, "markiro"),
    },
    deps.rasterize ?? rasterizeSheetText,
  );
  return { raster, bytes: encodeMonoRaster(raster) };
}
