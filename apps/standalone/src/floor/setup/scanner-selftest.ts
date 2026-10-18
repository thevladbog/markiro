import { classifyScan, gs1CheckDigit, hasValidCheckDigit } from "@markiro/domain";

import { fromRussianLayout, hasCyrillic } from "../../host/pairing-code.js";
import type { ScanChannel } from "../scan-source.js";
import { makeTestCode } from "./test-label.js";

/**
 * The scanner self-test (owner feedback, beta 3: «для сканеров также нужна возможность проверки,
 * что сканирует ок. Желательно datamatrix с GS символом»). The station makes a code, shows it, the
 * operator scans it off the screen and the station compares what arrived with what it made,
 * character by character: a lost or changed group separator, a symbology prefix, a layout change or
 * a truncation shows as a DIFFERENCE and is explained. A fresh code is made for every check, so an
 * old scan can never pass.
 *
 * The text of a scan is never logged here or kept beyond the session's last few results, and a scan
 * that is not the test code is shown masked only: it may be a badge.
 */

export const GS = "\u001d";
/** How the group separator is drawn wherever the self-test shows a code. */
export const GS_MARK = "␝";

/** The two kinds of check: a plain Code 128, and a GS1 DataMatrix with real separators. */
export type SelfTestKind = "plain" | "dm";

/**
 * The test GTIN: a GTIN-14 in the GS1 «restricted circulation» range (a body starting 02) that no
 * manufacturer is given, so it is not any product's. Its check digit is valid, as a real GTIN's.
 */
const TEST_GTIN_BODY = "0299999999999";
export const TEST_GTIN = `${TEST_GTIN_BODY}${gs1CheckDigit(TEST_GTIN_BODY)}`;

/** Letters of a test serial and tail: capitals and digits without look-alikes (see `makeTestCode`). */
const ALPHABET = "34789ACDEFHKMNPRTWXY";

function randomLetters(
  count: number,
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): string {
  const bytes = new Uint8Array(count);
  random(bytes);
  let letters = "";
  for (const byte of bytes) letters += ALPHABET[byte % ALPHABET.length] ?? "";
  return letters;
}

/** AI 91 of a test code: a short key, in the shape of the real one. */
export const TEST_KEY = "TEST";

/**
 * A fresh test DataMatrix: `01<test GTIN>21<serial><GS>91<key><GS>92<tail>`. The serial and tail
 * are random, the key and the serial and tail's «TEST» prefix say what it is.
 */
export function makeTestDataMatrix(random?: (bytes: Uint8Array<ArrayBuffer>) => void): string {
  const serial = `TEST${randomLetters(6, random)}`;
  const tail = `TEST${randomLetters(40, random)}`;
  return `01${TEST_GTIN}21${serial}${GS}91${TEST_KEY}${GS}92${tail}`;
}

export function makeSelfTestCode(
  kind: SelfTestKind,
  random?: (bytes: Uint8Array<ArrayBuffer>) => void,
): string {
  return kind === "dm" ? makeTestDataMatrix(random) : makeTestCode(random);
}

/** A code for the eyes: separators as a visible mark, other control characters in hex. */
export function visible(text: string): string {
  let out = "";
  for (const symbol of text) {
    const code = symbol.codePointAt(0) ?? 0;
    if (symbol === GS) out += GS_MARK;
    else if (code < 0x20 || code === 0x7f) {
      out += `<${code.toString(16).toUpperCase().padStart(2, "0")}>`;
    } else out += symbol;
  }
  return out;
}

/**
 * A scan with its text hidden: the first and the last few characters, a dot for each one between,
 * and every group separator in place. It tells the length and where the separators are, not the code.
 */
export function maskScan(raw: string): string {
  const symbols = Array.from(raw);
  const head = Math.min(4, Math.floor(symbols.length / 3));
  const tail = Math.min(2, Math.floor(symbols.length / 4));
  return symbols
    .map((symbol, index) => {
      if (symbol === GS) return GS_MARK;
      if (index < head || index >= symbols.length - tail) return visible(symbol);
      return "•";
    })
    .join("");
}

/** Why a scan is, or is not, the code that was shown. */
export type Reason =
  | "match"
  /** The code arrived whole, with an AIM symbology prefix before it. */
  | "prefix"
  /** Bytes that were not UTF-8: a COM port at the wrong speed, most often. */
  | "unreadable"
  /** The separators did not arrive at all. */
  | "gsLost"
  /** The separators arrived as something else. */
  | "gsReplaced"
  /** The Russian layout was on: the letters are Cyrillic. */
  | "layout"
  /** The code stops short. */
  | "truncated"
  /** The code starts late: its beginning is lost. */
  | "headLost"
  /** The code is whole but something is added before or after it. */
  | "extra"
  /** The scan is close to the code but differs. */
  | "different"
  /** The scan is not the code that is on the screen. */
  | "foreign";

export type Status = "ok" | "warning" | "problem";

/** Whether the scan is a marking code, a pallet or a product's number, as the station reads scans. */
export type ScanType = "km" | "sscc" | "gtin" | "unknown" | "plain";

/** One application identifier of a marking code, with the size of its value but never the value. */
export interface StructureItem {
  ai: string;
  length: number;
  /** For AI 01: whether the GTIN's check digit is right. */
  checkDigitValid?: boolean;
}

export interface Verdict {
  status: Status;
  reason: Reason;
  channel: ScanChannel;
  /** The scan's length in characters. */
  length: number;
  expectedLength: number;
  /** Group separators that arrived, and that the code carries. */
  groupSeparators: number;
  expectedGroupSeparators: number;
  /** What the station reads the scan as. */
  type: ScanType;
  /** The AIs of a scan read as a marking code; empty otherwise. */
  structure: StructureItem[];
  /** The scan with its text hidden. */
  masked: string;
  /** `gsReplaced` and `prefix`: what stands where the separator or the prefix is, drawn visibly. */
  found?: string;
  /** `truncated`: how many characters of the code arrived. `different`: the first differing place (1-based). */
  position?: number;
  /** `different` / `extra`: how many characters differ, or are added. */
  count?: number;
  /** `different`: the expected and the arrived character, drawn visibly. */
  expectedChar?: string;
  foundChar?: string;
  /** Cyrillic in the scan without a match for the layout: the Russian layout is the likely cause. */
  russianLayout: boolean;
}

const AIM_PREFIX = /^\][A-Za-z][0-9A-Za-z]/;
const REPLACEMENT = "�";
/** The longest text a scanner puts in place of the separator that is still told apart from other damage. */
const MAX_GS_SUBSTITUTE = 8;

function countOf(text: string, symbol: string): number {
  return text.split(symbol).length - 1;
}

/** What the station reads a scan as, and the AIs of a marking code: sizes only, never values. */
export function describeScan(raw: string): {
  type: ScanType;
  structure: StructureItem[];
} {
  const scan = classifyScan(raw);
  if (scan.kind === "km") {
    const structure: StructureItem[] = [
      { ai: "01", length: scan.km.gtin14.length, checkDigitValid: true },
      { ai: "21", length: scan.km.serial.length },
      ...Object.entries(scan.km.ais).map(([ai, value]) => ({ ai, length: value.length })),
    ];
    return { type: "km", structure };
  }
  if (scan.kind === "sscc") return { type: "sscc", structure: [] };
  if (scan.kind === "gtin") return { type: "gtin", structure: [] };
  // A code that starts like a marking code but is not one: its GTIN's check digit is told when it is wrong.
  const gtin = /^(?:\][A-Za-z]\d)?01(\d{14})/.exec(raw)?.[1];
  if (gtin !== undefined && !hasValidCheckDigit(gtin)) {
    return { type: "unknown", structure: [{ ai: "01", length: 14, checkDigitValid: false }] };
  }
  return { type: "unknown", structure: [] };
}

/**
 * The expected structure of a test DataMatrix, with its values: it is made here and is no secret.
 */
export function expectedStructure(code: string): { ai: string; value: string }[] {
  const [first = "", ...rest] = code.split(GS);
  const head = [
    { ai: "01", value: first.slice(2, 16) },
    { ai: "21", value: first.slice(18) },
  ];
  return [...head, ...rest.map((part) => ({ ai: part.slice(0, 2), value: part.slice(2) }))];
}

/** How alike two texts are, for telling «the code, damaged» from «another code»: positions that agree. */
function similarity(a: string, b: string): { first: number; differing: number } {
  const length = Math.min(a.length, b.length);
  let first = -1;
  let differing = Math.abs(a.length - b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) {
      if (first === -1) first = index;
      differing += 1;
    }
  }
  return { first: first === -1 ? length : first, differing };
}

/**
 * The verdict of one scan against the code that was shown. `expected` is exactly what the scanner
 * should hand over: for a DataMatrix, the element string with real separators, without a symbology
 * prefix (the prefix is told apart).
 */
export function judgeScan(raw: string, expected: string, channel: ScanChannel): Verdict {
  const base = {
    channel,
    length: Array.from(raw).length,
    expectedLength: Array.from(expected).length,
    groupSeparators: countOf(raw, GS),
    expectedGroupSeparators: countOf(expected, GS),
    masked: maskScan(raw),
    ...describeScan(raw),
  };
  const done = (
    status: Status,
    reason: Reason,
    extra: Partial<Verdict> = {},
    russianLayout = false,
  ): Verdict => ({ ...base, status, reason, russianLayout, ...extra });

  if (raw.includes(REPLACEMENT)) return done("problem", "unreadable");
  if (raw === expected) return done("ok", "match");

  const prefix = AIM_PREFIX.exec(raw)?.[0];
  if (prefix !== undefined && raw.slice(prefix.length) === expected) {
    return done("warning", "prefix", { found: prefix });
  }

  if (hasCyrillic(raw)) {
    const back = fromRussianLayout(raw);
    if (back === expected) return done("problem", "layout", {}, true);
  }

  const separators = expected.split(GS);
  if (separators.length > 1) {
    // The same text in every place of the separator: nothing (lost) or something else.
    const fixed = expected.length - (separators.length - 1);
    const extra = raw.length - fixed;
    const gaps = separators.length - 1;
    if (extra >= 0 && extra % gaps === 0 && extra / gaps <= MAX_GS_SUBSTITUTE) {
      const width = extra / gaps;
      const at = (separators[0] ?? "").length;
      const stand = raw.slice(at, at + width);
      if (raw === separators.join(stand)) {
        return width === 0
          ? done("problem", "gsLost")
          : done("problem", "gsReplaced", { found: visible(stand) });
      }
    }
  }

  if (raw.length > 0 && expected.startsWith(raw)) {
    return done("problem", "truncated", { position: Array.from(raw).length });
  }
  if (raw.length > 0 && expected.endsWith(raw)) {
    return done("problem", "headLost", { position: Array.from(raw).length });
  }
  if (raw.includes(expected)) {
    return done("problem", "extra", { count: raw.length - expected.length });
  }

  const alike = similarity(raw, expected);
  const closeEnough =
    alike.first >= 6 || alike.differing <= Math.max(3, Math.floor(expected.length / 5));
  if (closeEnough) {
    return done(
      "problem",
      "different",
      {
        position: alike.first + 1,
        count: alike.differing,
        expectedChar: visible(expected[alike.first] ?? ""),
        foundChar: visible(raw[alike.first] ?? ""),
      },
      hasCyrillic(raw),
    );
  }
  return done("problem", "foreign", {}, hasCyrillic(raw));
}

/** One finished check, for the session's list. */
export interface SelfTestEntry {
  /** The wall-clock time of the scan, `HH:MM:SS`. */
  at: string;
  kind: SelfTestKind;
  verdict: Verdict;
}

/** How many results the list holds. */
export const HISTORY_SIZE = 5;

export function pushHistory(
  history: readonly SelfTestEntry[],
  entry: SelfTestEntry,
): SelfTestEntry[] {
  return [entry, ...history].slice(0, HISTORY_SIZE);
}
