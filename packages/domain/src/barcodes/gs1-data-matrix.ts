import bwipjs from "bwip-js/generic";
import { DomainError } from "../errors.js";
import { parseKmSegments } from "../gs1/km.js";
import { bitmapToZplHex } from "../labels/raster.js";
import type { RasterResult } from "../labels/raster-types.js";
import { mmToDots } from "../labels/model.js";
import { parseDuplicateKm } from "../product-labels/km.js";

/** Shared with SVG: literal carets and parentheses must never become AI/control syntax. */
export function toGs1Data(raw: string): string {
  const { gtin14, serial, ais } = parseKmSegments(raw);
  const escapeValue = (value: string) => value.replace(/\^/g, "^^");
  const trailing = ais.map(({ ai, value }) => `^FNC1${ai}${escapeValue(value)}`).join("");
  return `01${gtin14}21${escapeValue(serial)}${trailing}`;
}

function invalidExtent(): never {
  throw new DomainError(
    "DUPLICATE_LABEL_TOO_SMALL",
    "Cannot fit the product code in the requested raster extent",
  );
}

function isModuleGrid(value: unknown): value is { pixs: number[]; pixx: number; pixy: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "pixs" in value &&
    Array.isArray(value.pixs) &&
    "pixx" in value &&
    typeof value.pixx === "number" &&
    "pixy" in value &&
    typeof value.pixy === "number" &&
    Number.isSafeInteger(value.pixx) &&
    Number.isSafeInteger(value.pixy) &&
    value.pixx > 0 &&
    value.pixy > 0 &&
    value.pixx <= 144 &&
    value.pixy <= 144 &&
    value.pixs.length === value.pixx * value.pixy &&
    value.pixs.every((pixel: unknown) => pixel === 0 || pixel === 1)
  );
}

/** Whole-symbol square, including at least one blank module on each side. */
export function rasterizeGs1DataMatrix(raw: string, sideDots: number): RasterResult {
  const canonical = parseDuplicateKm(raw).raw;
  // The largest supported label is 300 mm at 300 dpi. Bound allocations before encoding.
  if (!Number.isSafeInteger(sideDots) || sideDots < 1 || sideDots > mmToDots(300, 300))
    invalidExtent();
  let symbols: ReturnType<typeof bwipjs.raw>;
  try {
    symbols = bwipjs.raw({
      bcid: "datamatrix",
      text: `^FNC1${toGs1Data(canonical)}`,
      parsefnc: true,
    });
  } catch {
    // The encoder's error can contain the full marking code; do not retain it as cause.
    throw new DomainError("DUPLICATE_LABEL_ENCODING_FAILED", "Unable to encode the product label");
  }
  const symbol: unknown = Array.isArray(symbols) && symbols.length === 1 ? symbols[0] : null;
  if (!isModuleGrid(symbol)) {
    throw new DomainError(
      "DUPLICATE_LABEL_ENCODING_FAILED",
      "Unexpected product label symbol geometry",
    );
  }
  const scale = Math.floor(sideDots / (Math.max(symbol.pixx, symbol.pixy) + 2));
  if (scale < 1) invalidExtent();
  const left = Math.floor((sideDots - symbol.pixx * scale) / 2);
  const top = Math.floor((sideDots - symbol.pixy * scale) / 2);
  const pixels = new Uint8Array(sideDots * sideDots);
  for (let row = 0; row < symbol.pixy; row++) {
    for (let column = 0; column < symbol.pixx; column++) {
      if (symbol.pixs[row * symbol.pixx + column] !== 1) continue;
      for (let dy = 0; dy < scale; dy++) {
        const start = (top + row * scale + dy) * sideDots + left + column * scale;
        pixels.fill(1, start, start + scale);
      }
    }
  }
  return { ...bitmapToZplHex(pixels, sideDots, sideDots), width: sideDots, height: sideDots };
}
