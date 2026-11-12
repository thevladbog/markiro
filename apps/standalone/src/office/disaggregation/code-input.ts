import { parseScannedSscc } from "@markiro/domain";

import {
  DISAGGREGATION_MAX_LINES_PER_REQUEST,
  type DisaggregationLineInput,
} from "../../host/disaggregation.js";

/** The cloud API's ceiling of one file (`import-parser.ts`, `MAX_IMPORT_LINES`). */
export const MAX_IMPORT_LINES = 10_000;
/** The cloud's multer limit of an imported file: 1 MiB. */
export const MAX_IMPORT_BYTES = 1024 * 1024;

const KM_PREFIX = /^(?:\]d2[\t ]*)?01\d{14}21/u;

function splitCodes(raw: string, ssccSeparators: RegExp): string[] {
  return raw.split(/[\r\n]+/u).flatMap((line) => {
    let start = 0;
    let end = line.length;
    while (line[start] === " " || line[start] === "\t") start++;
    while (end > start && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
    const code = line.slice(start, end);
    // Commas and semicolons can be part of a set's serial or crypto tail.
    if (KM_PREFIX.test(code)) return [code];
    return line
      .split(ssccSeparators)
      .map((token) => token.trim())
      .filter(Boolean);
  });
}

/** Pasted SSCCs can use legacy separators; a set code occupies its own line. */
export function parsePastedCodes(raw: string): string[] {
  return splitCodes(raw, /[\s;,]+/u);
}

export type ImportRefusal = "file_too_large" | "file_empty" | "too_many_lines";
export type ImportParse = { ok: true; tokens: string[] } | { ok: false; refusal: ImportRefusal };

/**
 * A file's text: the cloud API's `parseSsccImport` (`\r\n;,`, trimmed, empties
 * dropped). Duplicates stay: the document shows them as `duplicate` lines.
 */
export function parseCodeImport(text: string): ImportParse {
  const unquoted = text.replace(/^"((?:[^"\r\n]|"")*)"$/gmu, (row, field: string) => {
    const code = field.replaceAll('""', '"');
    return KM_PREFIX.test(code) ? code : row;
  });
  const tokens = splitCodes(unquoted, /[;,]+/u);
  if (tokens.length > MAX_IMPORT_LINES) return { ok: false, refusal: "too_many_lines" };
  if (tokens.length === 0) return { ok: false, refusal: "file_empty" };
  return { ok: true, tokens };
}

/**
 * Reads a picked file (UTF-8) and parses it; a file over 1 MiB is not read.
 * The BOM Excel writes is dropped here, which the cloud does not do (its first
 * token then carries an invisible U+FEFF and is `not_found`).
 */
export async function readCodeImport(file: Pick<File, "size" | "text">): Promise<ImportParse> {
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, refusal: "file_too_large" };
  const text = await file.text();
  return parseCodeImport(text.replace(/^\uFEFF/u, ""));
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
