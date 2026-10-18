import {
  encodeMonoRaster,
  nominalSheetGeometry,
  renderPalletSheet,
  type MonoRaster,
  type PalletSheetContext,
  type PalletSheetSpecV2,
  type RasterizeTextFn,
  type SheetLogo,
} from "@markiro/domain";

import { rasterizeSheetText } from "./rasterizer.js";

/**
 * A sheet at A4's nominal geometry (plan А4, decision А4-8): the stock
 * sheets' 10 mm margins hold any usual laser printer's unprintable edge, and
 * the shell checks the real printable area before it sends. The domain's
 * renderer runs the sheet's own tree; preview and print call this one function,
 * so they cannot drift.
 */
export function renderSheetRaster(
  spec: PalletSheetSpecV2,
  context: PalletSheetContext,
  rasterize: RasterizeTextFn = rasterizeSheetText,
): Promise<MonoRaster> {
  return renderPalletSheet(spec, context, nominalSheetGeometry(spec), rasterize);
}

/** The sheet as the bytes a print job keeps and the shell prints (`mono-raster-v1`). */
export async function renderSheetBytes(
  spec: PalletSheetSpecV2,
  context: PalletSheetContext,
  rasterize: RasterizeTextFn = rasterizeSheetText,
): Promise<Uint8Array> {
  return encodeMonoRaster(await renderSheetRaster(spec, context, rasterize));
}

/**
 * The synthetic pallet a preview shows (the cloud admin's sheet preview
 * data): never a code of production — the SSCC's company prefix is 9999.
 */
export function sampleSheetContext(
  organization: { name: string; inn: string | null },
  logo: SheetLogo,
): PalletSheetContext {
  return {
    sscc: "199990000000000012",
    productPrintName: "Молоко питьевое ультрапастеризованное 3,2 %, 0,9 л",
    gtin14: "04600000000015",
    // A sample: no EGAIS code (plan ТОВ prints one only from a shift).
    egaisCode: null,
    productionDate: "2026-10-11",
    shelfLifeDays: 10,
    boxCount: 48,
    itemCount: 576,
    shiftNumber: "OCT26-001",
    organizationName: organization.name,
    organizationInn: organization.inn,
    logo,
  };
}

/**
 * A sheet shrunk by a whole `factor` for the screen: an output pixel is black
 * when any dot of its `factor × factor` square is, so a thin bar never
 * vanishes from the preview. RGBA, ready for `ImageData`.
 */
export function downsampleMonoRaster(
  raster: MonoRaster,
  factor: number,
): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new RangeError("the downsample factor must be a whole number of at least 1");
  }
  const width = Math.ceil(raster.widthDots / factor);
  const height = Math.ceil(raster.heightDots / factor);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < raster.heightDots; y++) {
    const row = y * raster.stride;
    for (let byteX = 0; byteX < raster.stride; byteX++) {
      const value = raster.pixels[row + byteX] ?? 0;
      if (value === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if ((value & (0x80 >> bit)) === 0) continue;
        const x = byteX * 8 + bit;
        if (x >= raster.widthDots) continue;
        const offset = (Math.floor(y / factor) * width + Math.floor(x / factor)) * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
      }
    }
  }
  return { width, height, data };
}

/** Draws a sheet shrunk by `factor` on `canvas`, resized to fit it. */
export function paintMonoRaster(canvas: HTMLCanvasElement, raster: MonoRaster, factor: number) {
  const small = downsampleMonoRaster(raster, factor);
  canvas.width = small.width;
  canvas.height = small.height;
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.putImageData(new ImageData(small.data, small.width, small.height), 0, 0);
}
