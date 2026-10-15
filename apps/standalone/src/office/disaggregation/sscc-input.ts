import { parseScannedSscc } from "@markiro/domain";

import {
  DISAGGREGATION_MAX_LINES_PER_REQUEST,
  type DisaggregationLineInput,
} from "../../host/disaggregation.js";

/** The cloud API's ceiling of one file (`import-parser.ts`, `MAX_IMPORT_LINES`). */
export const MAX_IMPORT_LINES = 10_000;
/** The cloud's multer limit of an imported file: 1 MiB. */
export const MAX_IMPORT_BYTES = 1024 * 1024;

/** SSCCs pasted or scanned into the text field: the cloud page's `splitSsccInput`. */
export function parsePastedSsccs(raw: string): string[] {
  return raw
    .split(/[\s;,]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export type ImportRefusal = "file_too_large" | "file_empty" | "too_many_lines";
export type ImportParse = { ok: true; tokens: string[] } | { ok: false; refusal: ImportRefusal };

/**
 * A file's text: the cloud API's `parseSsccImport` (`\r\n;,`, trimmed, empties
 * dropped). Duplicates stay: the document shows them as `duplicate` lines.
 */
export function parseSsccImport(text: string): ImportParse {
  const tokens = text
    .split(/[\r\n;,]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length > MAX_IMPORT_LINES) return { ok: false, refusal: "too_many_lines" };
  if (tokens.length === 0) return { ok: false, refusal: "file_empty" };
  return { ok: true, tokens };
}

/**
 * Reads a picked file (UTF-8) and parses it; a file over 1 MiB is not read.
 * The BOM Excel writes is dropped here, which the cloud does not do (its first
 * token then carries an invisible U+FEFF and is `not_found`).
 */
export async function readSsccImport(file: Pick<File, "size" | "text">): Promise<ImportParse> {
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, refusal: "file_too_large" };
  const text = await file.text();
  return parseSsccImport(text.replace(/^\uFEFF/u, ""));
}

/** The wire's lines of tokens: the input as typed and the SSCC the domain reads (plan ДЗГ, Р12). */
export function lineInputs(tokens: readonly string[]): DisaggregationLineInput[] {
  return tokens.map((input) => ({ input, sscc: parseScannedSscc(input) }));
}

/** The host's parts: at most `DISAGGREGATION_MAX_LINES_PER_REQUEST` (500) lines a request. */
export function inParts<T>(lines: readonly T[]): T[][] {
  const parts: T[][] = [];
  for (let at = 0; at < lines.length; at += DISAGGREGATION_MAX_LINES_PER_REQUEST) {
    parts.push(lines.slice(at, at + DISAGGREGATION_MAX_LINES_PER_REQUEST));
  }
  return parts;
}
