import { hasCyrillic, parsePairingPayload } from "../host/pairing-code.js";

/**
 * What the scanner check of the station's scanner settings says about one
 * scan (owner feedback, first Windows test): whether a scan reached the app
 * at all, and whether it is the office's pairing code. Anything else is told
 * by its length, a group separator and the Russian layout only, never by its
 * text: a scan may be a badge.
 */
export type ScanCheck =
  /** The office's pairing code, read as the pairing screen reads it. */
  | { kind: "pairing"; addresses: string[]; russianLayout: boolean }
  /** Bytes that were not UTF-8 (the shell's U+FFFD): a COM port at the wrong speed, most often. */
  | { kind: "unreadable" }
  | { kind: "other"; length: number; groupSeparator: boolean; russianLayout: boolean };

const GROUP_SEPARATOR = "\u001d";
const REPLACEMENT = "�";

export function checkScan(raw: string): ScanCheck {
  if (raw.includes(REPLACEMENT)) return { kind: "unreadable" };
  const russianLayout = hasCyrillic(raw);
  const payload = parsePairingPayload(raw);
  if (payload !== null) return { kind: "pairing", addresses: payload.addresses, russianLayout };
  return {
    kind: "other",
    length: Array.from(raw).length,
    groupSeparator: raw.includes(GROUP_SEPARATOR),
    russianLayout,
  };
}
