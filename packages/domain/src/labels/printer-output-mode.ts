export const PRINTER_OUTPUT_MODES = ["normal", "peel", "cutter"] as const;
export type PrinterOutputMode = (typeof PRINTER_OUTPUT_MODES)[number];

/** Apply only to freshly rendered RAW output, before freezing bytes/digests. */
export function applyPrinterOutputMode(
  bytes: Uint8Array,
  language: "zpl" | "tspl",
  mode?: PrinterOutputMode,
): Uint8Array {
  // Legacy profiles retain the printer's own configuration and exact saved bytes.
  if (mode === undefined) return bytes;
  const commands =
    language === "zpl"
      ? `^XA\n^MM${{ normal: "T", peel: "P", cutter: "C" }[mode]}\n`
      : mode === "cutter"
        ? "SET PEEL OFF\nSET CUTTER 1\n"
        : `SET CUTTER OFF\nSET PEEL ${mode === "peel" ? "ON" : "OFF"}\n`;
  if (language === "zpl" && (bytes[0] !== 94 || bytes[1] !== 88 || bytes[2] !== 65))
    throw new Error("ZPL document must start with ^XA");
  const prefix = new TextEncoder().encode(commands);
  const body = language === "zpl" ? bytes.subarray(3) : bytes;
  const result = new Uint8Array(prefix.length + body.length);
  result.set(prefix);
  result.set(body, prefix.length);
  return result;
}
