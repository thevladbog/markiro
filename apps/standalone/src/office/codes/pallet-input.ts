import { classifyScan } from "@markiro/domain";
import type { PalletCodeError } from "../../host/office-pallet-create.js";

export const PALLET_INPUT_LIMIT = 1000;
export const PALLET_FILE_MAX_BYTES = 1_048_576;
export class PalletInputError extends Error {
  constructor(readonly code: "extension" | "size" | "encoding" | "csv" | "limit") {
    super(code);
  }
}

/** One column, no header. Reject malformed quoting and extra delimiters before replacing input. */
export function parsePalletFile(name: string, bytes: Uint8Array): string[] {
  const extension = name.toLowerCase().split(".").at(-1);
  if (extension !== "txt" && extension !== "csv") throw new PalletInputError("extension");
  if (bytes.length > PALLET_FILE_MAX_BYTES) throw new PalletInputError("size");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PalletInputError("encoding");
  }
  const lines = text.replace(/^\ufeff/u, "").split(/\r\n|\n|\r/u);
  const codes =
    extension === "txt"
      ? lines
      : lines.map((line) => {
          const value = line.trim();
          if (!value.startsWith('"')) {
            if (/[",;\t]/u.test(value)) throw new PalletInputError("csv");
            return value;
          }
          if (!/^"(?:[^"]|"")*"$/u.test(value)) throw new PalletInputError("csv");
          return value.slice(1, -1).replace(/""/gu, '"');
        });
  if (codes.filter((code) => code.trim() !== "").length > PALLET_INPUT_LIMIT)
    throw new PalletInputError("limit");
  return codes;
}

/** Keep raw lines for the host, with the same 1-based line numbers shown by local validation. */
export function inspectPalletInput(text: string) {
  const codes = text.split(/\r\n|\n|\r/u);
  const errors: PalletCodeError[] = [];
  const seen = new Map<string, number[]>();
  let count = 0;
  const normalized: string[] = [];
  codes.forEach((raw, index) => {
    if (raw.trim() === "") return;
    count += 1;
    const scan = classifyScan(raw);
    normalized.push(scan.kind === "sscc" ? scan.sscc : raw.trim());
    if (scan.kind !== "sscc") {
      errors.push({
        line: index + 1,
        code: scan.kind === "km" || scan.kind === "gtin" ? "not_box" : "invalid_sscc",
        sscc: null,
        palletId: null,
      });
    } else {
      const lines = seen.get(scan.sscc) ?? [];
      lines.push(index + 1);
      seen.set(scan.sscc, lines);
      if (!scan.sscc.startsWith("0"))
        errors.push({ line: index + 1, code: "not_box", sscc: scan.sscc, palletId: null });
    }
  });
  for (const [sscc, lines] of seen) {
    if (lines.length > 1)
      for (const line of lines) errors.push({ line, code: "duplicate", sscc, palletId: null });
  }
  errors.sort((a, b) => a.line - b.line);
  return {
    codes,
    count,
    errors,
    key: JSON.stringify(normalized.sort()),
    limitExceeded: count > PALLET_INPUT_LIMIT,
  };
}
