import {
  renderPalletSheet,
  nominalSheetGeometry,
  logoFromRgba,
  sheetLogoFingerprint,
  type PalletSheetSpecV2,
  type PalletSheetContext,
  type SheetLogo,
  type RasterizeTextFn,
  type MonoRaster,
  type SheetElementRegion,
} from "@markiro/domain";
import markiroLogoUrl from "../../../../assets/markiro-print-logo.svg";
export interface SheetSampleOptions {
  date: boolean;
  egais: boolean;
  longName: boolean;
  maximumCounts: boolean;
}
export function previewSheetContext(
  options: SheetSampleOptions,
  logo: SheetLogo,
): PalletSheetContext {
  return {
    sscc: "146000000000001231",
    productPrintName: options.longName
      ? "Пиво светлое\nнефильтрованное\nпастеризованное\n«Жигулёвское»\nбутылка 0,5 л"
      : "Пиво светлое «Жигулёвское», бутылка 0,5 л",
    gtin14: "04600000000001",
    egaisCode: options.egais ? "0000000000000123456" : null,
    productionDate: options.date ? "2026-10-10" : null,
    shelfLifeDays: 180,
    boxCount: options.maximumCounts ? 999999 : 48,
    itemCount: options.maximumCounts ? 9999999 : 960,
    shiftNumber: "128",
    organizationName: "ООО «Пивоваренная компания»",
    logo,
  };
}
export function renderSheetPreview(
  spec: PalletSheetSpecV2,
  context: PalletSheetContext,
  text: RasterizeTextFn,
  onMeasured?: (regions: SheetElementRegion[]) => void,
): Promise<MonoRaster> {
  return renderPalletSheet(spec, context, nominalSheetGeometry(spec), text, onMeasured);
}
export async function loadSheetPreviewLogo(wide = false): Promise<SheetLogo> {
  const image = new Image();
  image.src = markiroLogoUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((wide ? 640 : image.naturalWidth) * 3.5);
  canvas.height = Math.round(image.naturalHeight * 3.5);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas rendering context is unavailable");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, image.naturalWidth * 3.5, image.naturalHeight * 3.5);
  if (wide) {
    ctx.drawImage(image, 280 * 3.5, 0, image.naturalWidth * 3.5, image.naturalHeight * 3.5);
  }
  const bitmap = logoFromRgba(
    canvas.width,
    canvas.height,
    ctx.getImageData(0, 0, canvas.width, canvas.height).data,
  );
  return {
    ...bitmap,
    source: wide ? "organization" : "markiro",
    digest: sheetLogoFingerprint(bitmap),
  };
}
export function paintSheetRaster(canvas: HTMLCanvasElement, raster: MonoRaster): void {
  canvas.width = raster.widthDots;
  canvas.height = raster.heightDots;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas rendering context is unavailable");
  const image = ctx.createImageData(raster.widthDots, raster.heightDots);
  for (let y = 0; y < raster.heightDots; y++)
    for (let x = 0; x < raster.widthDots; x++) {
      const color =
        (raster.pixels[y * raster.stride + Math.floor(x / 8)] ?? 0) & (0x80 >> (x % 8)) ? 0 : 255;
      const index = (y * raster.widthDots + x) * 4;
      image.data[index] = color;
      image.data[index + 1] = color;
      image.data[index + 2] = color;
      image.data[index + 3] = 255;
    }
  ctx.putImageData(image, 0, 0);
}
