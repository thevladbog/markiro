import bwipjs from "bwip-js/generic";
import { DomainError } from "../errors.js";
import {
  labelTemplateSpecStrictSchema,
  mmToDots,
  type LabelField,
  type LabelTemplateSpec,
} from "./model.js";
import { createLabelRenderPlan, type LabelRenderElement } from "./render-plan.js";
import { encodeMonoRaster, type MonoRaster } from "./mono-raster.js";
import type { RasterizeTextFn } from "./raster-types.js";

function invalid(): never {
  throw new DomainError(
    "LABEL_RASTER_BOUNDS",
    "Label content or barcode quiet zone does not fit the paper",
  );
}
/** Raster output deliberately has no dependency on the profile's last RAW language. */
export async function renderMonoLabel(
  spec: LabelTemplateSpec,
  fields: Record<LabelField, string>,
  rasterizeText: RasterizeTextFn,
): Promise<MonoRaster> {
  const validated = labelTemplateSpecStrictSchema.parse(spec);
  const plan = await createLabelRenderPlan(validated, fields, {
    language: "zpl",
    dpi: validated.dpi,
    rasterizeText,
  });
  const stride = Math.ceil(plan.widthDots / 8);
  const page: MonoRaster = {
    format: "mono-raster-v1",
    widthMm: plan.widthMm,
    heightMm: plan.heightMm,
    dpi: plan.dpi,
    widthDots: plan.widthDots,
    heightDots: plan.heightDots,
    stride,
    pixels: new Uint8Array(stride * plan.heightDots),
    requiredBounds: { left: 0, top: 0, right: 0, bottom: 0 },
  };
  let hasBounds = false;
  const include = (left: number, top: number, width: number, height: number) => {
    if (
      ![left, top, width, height].every(Number.isSafeInteger) ||
      left < 0 ||
      top < 0 ||
      width < 1 ||
      height < 1 ||
      left + width > page.widthDots ||
      top + height > page.heightDots
    )
      invalid();
    const b = page.requiredBounds;
    page.requiredBounds = hasBounds
      ? {
          left: Math.min(b.left, left),
          top: Math.min(b.top, top),
          right: Math.max(b.right, left + width),
          bottom: Math.max(b.bottom, top + height),
        }
      : { left, top, right: left + width, bottom: top + height };
    hasBounds = true;
  };
  const black = (x: number, y: number) => {
    const i = y * stride + (x >> 3);
    page.pixels[i] = (page.pixels[i] ?? 0) | (0x80 >> (x % 8));
  };
  const rect = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) black(xx, yy);
  };
  for (const e of plan.elements) {
    if (e.kind === "raster") {
      include(e.xDots, e.yDots, e.raster.width, e.raster.height);
      if (
        e.raster.hex.length !== e.raster.bytesPerRow * e.raster.height * 2 ||
        !/^[0-9a-f]*$/i.test(e.raster.hex)
      )
        invalid();
      for (let y = 0; y < e.raster.height; y++)
        for (let x = 0; x < e.raster.width; x++) {
          const byte = Number.parseInt(
            e.raster.hex.slice(
              (y * e.raster.bytesPerRow + (x >> 3)) * 2,
              (y * e.raster.bytesPerRow + (x >> 3)) * 2 + 2,
            ),
            16,
          );
          if (byte & (0x80 >> (x % 8))) black(e.xDots + x, e.yDots + y);
        }
    } else if (e.kind === "rectangle") {
      include(e.xDots, e.yDots, e.widthDots, e.heightDots);
      for (let y = 0; y < e.heightDots; y++)
        for (let x = 0; x < e.widthDots; x++)
          if (
            e.filled ||
            x < e.thicknessDots ||
            y < e.thicknessDots ||
            x >= e.widthDots - e.thicknessDots ||
            y >= e.heightDots - e.thicknessDots
          )
            black(e.xDots + x, e.yDots + y);
    } else {
      drawBarcode(e, plan.dpi, include, rect);
    }
  }
  encodeMonoRaster(page); // validates row padding and declared bounds before leaving the renderer
  return page;
}
function drawBarcode(
  e: Extract<LabelRenderElement, { kind: "barcode" }>,
  dpi: number,
  include: (x: number, y: number, w: number, h: number) => void,
  rect: (x: number, y: number, w: number, h: number) => void,
): void {
  const format = e.element.format;
  const moduleDots =
    format === "qr"
      ? Math.max(1, Math.min(10, mmToDots(e.element.sizeMm, dpi)))
      : format === "datamatrix"
        ? mmToDots(e.element.sizeMm, dpi)
        : mmToDots(e.element.moduleWidthMm ?? (2 * 25.4) / dpi, dpi);
  if (moduleDots < 1) invalid();
  let symbols: ReturnType<typeof bwipjs.raw>;
  try {
    symbols = bwipjs.raw({
      bcid: e.gs1 ? "gs1-128" : format === "qr" ? "qrcode" : format,
      text: e.gs1 ? `(00)${e.value}` : e.value,
      ...(format === "qr" ? { eclevel: "Q", fixedeclevel: true } : {}),
    });
  } catch {
    throw new DomainError("LABEL_ENCODING_FAILED", "Unable to encode the label barcode");
  }
  const symbol: unknown = Array.isArray(symbols) && symbols.length === 1 ? symbols[0] : undefined;
  if (!isMatrix(symbol) && !isBars(symbol)) invalid();
  if ("pixs" in symbol) {
    const q = format === "qr" ? 4 : 1;
    include(
      e.xDots - q * moduleDots,
      e.yDots - q * moduleDots,
      (symbol.pixx + 2 * q) * moduleDots,
      (symbol.pixy + 2 * q) * moduleDots,
    );
    for (let y = 0; y < symbol.pixy; y++)
      for (let x = 0; x < symbol.pixx; x++)
        if (symbol.pixs[y * symbol.pixx + x] === 1)
          rect(e.xDots + x * moduleDots, e.yDots + y * moduleDots, moduleDots, moduleDots);
  } else {
    const widths = symbol.sbs;
    if (!widths.every((w) => Number.isInteger(w) && w > 0)) invalid();
    const leftQuiet = format === "ean13" ? 11 : 10,
      rightQuiet = format === "ean13" ? 7 : 10;
    const width = widths.reduce((sum, w) => sum + w, 0) * moduleDots;
    include(
      e.xDots - leftQuiet * moduleDots,
      e.yDots,
      width + (leftQuiet + rightQuiet) * moduleDots,
      e.heightDots,
    );
    let x = e.xDots;
    widths.forEach((w, index) => {
      if (index % 2 === 0) rect(x, e.yDots, w * moduleDots, e.heightDots);
      x += w * moduleDots;
    });
  }
}

function isMatrix(s: unknown): s is { pixs: number[]; pixx: number; pixy: number } {
  return (
    typeof s === "object" &&
    s !== null &&
    "pixx" in s &&
    "pixy" in s &&
    "pixs" in s &&
    typeof s.pixx === "number" &&
    typeof s.pixy === "number" &&
    Number.isSafeInteger(s.pixx) &&
    Number.isSafeInteger(s.pixy) &&
    s.pixx > 0 &&
    s.pixy > 0 &&
    s.pixx <= 177 &&
    s.pixy <= 177 &&
    Array.isArray(s.pixs) &&
    s.pixs.length === s.pixx * s.pixy &&
    s.pixs.every((p: unknown) => p === 0 || p === 1)
  );
}
function isBars(s: unknown): s is { sbs: number[] } {
  return (
    typeof s === "object" &&
    s !== null &&
    "sbs" in s &&
    Array.isArray(s.sbs) &&
    s.sbs.length > 0 &&
    s.sbs.length <= 20000 &&
    s.sbs.every((p: unknown) => typeof p === "number" && Number.isSafeInteger(p) && p > 0)
  );
}
