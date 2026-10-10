import type { LabelTemplateSpec } from "@markiro/domain";

import type { PrinterLanguage } from "./workstation-settings.js";

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
 * The test label (stage 2a spec §5.7.8): 58 × 40 mm, a Code 128 of `code`
 * and the code in words, all ASCII — no text goes through the rasterizer, so
 * the test proves the printer, its address, language and resolution, and
 * the scanner that reads the code back, and nothing of the webview's canvas.
 */
export function testLabelSpec(code: string, language: PrinterLanguage): LabelTemplateSpec {
  return {
    widthMm: 58,
    heightMm: 40,
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
