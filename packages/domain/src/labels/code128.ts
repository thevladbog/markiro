/**
 * Code 128 / GS1-128 MODULE ARITHMETIC — the only reason a linear barcode's
 * printed WIDTH is knowable outside the printer.
 *
 * A Code 128 symbol is a whole number of modules (narrow-bar widths) wide,
 * and the count depends ONLY on how the data is encoded, not on the printer:
 *
 * | part                          | modules |
 * | ----------------------------- | ------- |
 * | start character               | 11      |
 * | FNC1 (GS1-128 flag) if present| 11      |
 * | each encoded symbol           | 11      |
 * | symbol check character        | 11      |
 * | stop pattern                  | 13      |
 *
 * — so the fixed frame (start + check + stop) is 35 modules, plus 11 per
 * encoded symbol, plus 11 more when the payload is GS1-formatted. Subset C is
 * what makes this useful: it packs a PAIR of digits into a single 11-module
 * symbol, so a 20-digit GS1-128 (an SSCC plus its `(00)` application
 * identifier — see `defaults.ts`) is always exactly
 * `35 + 11 + 10 × 11 = 156` modules. Deterministic width, no layout engine
 * required, which is what lets `defaults.ts` CENTRE the SSCC barcode by
 * computing its `xMm` itself and lets `bounds.ts`/the admin preview report a
 * width that matches the ink.
 *
 * This module is a WIDTH model, not an encoder: nothing here produces bars.
 * Real encoding only ever happens on the printer (ZPL `^BC`, TSPL `BARCODE`).
 */

/** Modules in the fixed frame: start (11) + symbol check (11) + stop (13). */
export const CODE128_FRAME_MODULES = 35;

/** Every encoded symbol (subset A/B character, or subset C digit pair) is 11 modules. */
export const CODE128_SYMBOL_MODULES = 11;

/** FNC1 right after the start character is what marks a payload as GS1-128. */
export const CODE128_FNC1_MODULES = 11;

/**
 * GS1's minimum quiet zone for a GS1-128 symbol: 10 X-dimensions of blank
 * label on EACH side. It is part of the symbol's real estate — a barcode that
 * fits the label only because its quiet zone runs off the edge is a barcode
 * scanners refuse — so `defaults.ts` sizes the module against
 * `moduleCount + 2 × this`, not against the bars alone.
 */
export const GS1_128_QUIET_ZONE_MODULES = 10;

/** EAN-13 is a fixed-length symbology: always exactly 95 modules of bars. */
export const EAN13_MODULES = 95;

/**
 * How many modules wide a Code 128 symbol carrying `value` will print.
 *
 * An all-digit `value` of even length is assumed to encode in subset C (one
 * 11-module symbol per digit PAIR) — which is what both emitters actually ask
 * for on the `sscc` field (`zpl.ts` emits `>;`, `tspl.ts` its `!1`
 * equivalent). An odd digit count needs one character encoded outside subset C,
 * so it costs a whole symbol; `Math.ceil` covers that. Anything non-numeric is
 * costed at subset A/B's one symbol per character.
 *
 * `gs1` adds the FNC1 flag character. Pass it whenever the emitters will —
 * i.e. for a `code128` element bound to the `sscc` field.
 */
export function code128ModuleCount(value: string, gs1 = false): number {
  const symbols = /^\d+$/.test(value) ? Math.ceil(value.length / 2) : value.length;
  return (
    CODE128_FRAME_MODULES + (gs1 ? CODE128_FNC1_MODULES : 0) + symbols * CODE128_SYMBOL_MODULES
  );
}
