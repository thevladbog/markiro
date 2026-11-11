import type { LabelTemplateSpec } from "@markiro/domain";
import { z } from "zod";

import type { PrinterLanguage } from "./workstation-settings.js";

export const TEST_LABEL_WIDTH_MIN_MM = 50;
export const TEST_LABEL_HEIGHT_MIN_MM = 35;
export const TEST_LABEL_MAX_MM = 300;

export const testLabelSizeSchema = z.object({
  widthMm: z.number().min(TEST_LABEL_WIDTH_MIN_MM).max(TEST_LABEL_MAX_MM),
  heightMm: z.number().min(TEST_LABEL_HEIGHT_MIN_MM).max(TEST_LABEL_MAX_MM),
});

export type TestLabelSize = z.infer<typeof testLabelSizeSchema>;

export const TEST_LABEL_PRESETS = [
  { key: "58x40", widthMm: 58, heightMm: 40 },
  { key: "60x40", widthMm: 60, heightMm: 40 },
  { key: "75x120", widthMm: 75, heightMm: 120 },
  { key: "100x100", widthMm: 100, heightMm: 100 },
  { key: "100x150", widthMm: 100, heightMm: 150 },
] as const;

/**
 * The letters of a test code: digits and capitals without the ones a person
 * confuses on a printed label (0/O, 1/I/L, 5/S, 6/G, U/V, Z/2), as the cloud
 * station's `makeSetupTestCode`.
 */
const ALPHABET = "34789ACDEFHKMNPRTWXY";

/**
 * A fresh code for one test print, «MKR-7Q4F2N»: random, so a label left
 * over from an earlier test can never pass this one.
 */
export function makeTestCode(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): string {
  const bytes = new Uint8Array(6);
  random(bytes);
  let tail = "";
  for (const byte of bytes) tail += ALPHABET[byte % ALPHABET.length] ?? "";
  return `MKR-${tail}`;
}

/**
 * The test label uses the installed media size and a Code 128 of `code`
 * and the code in words, all ASCII — no text goes through the rasterizer, so
 * the test proves the printer, its address, language and resolution, and
 * the scanner that reads the code back, and nothing of the webview's canvas.
 */
export function testLabelSpec(
  code: string,
  language: PrinterLanguage,
  size: TestLabelSize,
): LabelTemplateSpec {
  return {
    ...size,
    dpi: 203,
    language,
    elements: [
      { id: "title", kind: "text", text: "MARKIRO TEST", xMm: 4, yMm: 4, fontSizePt: 10 },
      {
        id: "code",
        kind: "barcode",
        format: "code128",
        data: { literal: code },
        xMm: 4,
        yMm: 11,
        sizeMm: 16,
      },
      { id: "caption", kind: "text", text: code, xMm: 4, yMm: 30, fontSizePt: 10 },
    ],
  };
}

/**
 * The text of a scan, without the AIM prefix a scanner may send before a
 * Code 128 (`]C0`), as the code was printed.
 */
export function scannedTestCode(raw: string): string {
  return raw.trim().replace(/^\][A-Za-z][0-9]/, "");
}

/**
 * The scanner self-test's DataMatrix occupies a square up to 26 mm. Render with
 * `kmDataMatrix: "raster"`: the native emitters interpret sizeMm as a module size,
 * whereas the shared GS1 raster fits the whole symbol and its quiet zones in this square.
 * The code goes in the label data's `km.code`, with ASCII TEST markings beside it.
 */
export function selfTestDataMatrixSpec(
  language: PrinterLanguage,
  size: TestLabelSize,
): LabelTemplateSpec {
  const annotations: LabelTemplateSpec["elements"] =
    size.widthMm < 58
      ? []
      : [
          { id: "word", kind: "text", text: "TEST", xMm: 33, yMm: 14, fontSizePt: 18 },
          { id: "note", kind: "text", text: "NOT A PRODUCT", xMm: 33, yMm: 24, fontSizePt: 7 },
        ];
  return {
    ...size,
    dpi: 203,
    language,
    elements: [
      { id: "title", kind: "text", text: "MARKIRO TEST", xMm: 4, yMm: 3, fontSizePt: 10 },
      {
        id: "code",
        kind: "barcode",
        format: "datamatrix",
        data: "km.code",
        xMm: 4,
        yMm: 9,
        sizeMm: Math.min(26, size.heightMm - 13),
      },
      ...annotations,
    ],
  };
}
