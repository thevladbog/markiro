/**
 * Pairing-code input in the webview (stage 1 spec §4.7): a code typed from
 * the office screen, or the whole DataMatrix payload read by a scanner.
 * `normalizePairingCode` is `markiro_proto::pairing::normalize` rewritten:
 * `proto/fixtures/pairing-codes.json` pins the two to the same answers.
 */

/** Crockford base32: no I, L, O or U (`markiro_proto::pairing::ALPHABET`). */
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 10;

/** Unicode White_Space, exactly what Rust's `char::is_whitespace` accepts. */
const WHITE_SPACE = /^\p{White_Space}$/u;
/** The ASCII hyphen, the dashes U+2010..U+2015 and the minus sign U+2212. */
const DASH = /^[-\u2010-\u2015\u2212]$/;

/**
 * The canonical form of a typed or scanned code: separators skipped (any
 * white space and the dashes above), ASCII letters upper-cased, O read as
 * 0, I and L as 1. `null` when the input cannot be a code.
 */
export function normalizePairingCode(input: string): string | null {
  let code = "";
  for (const symbol of input) {
    if (WHITE_SPACE.test(symbol) || DASH.test(symbol)) continue;
    // ASCII only: `toUpperCase` would turn "ß" into "SS" and "ı" into "I".
    const upper = /^[a-z]$/.test(symbol) ? symbol.toUpperCase() : symbol;
    const canonical = upper === "O" ? "0" : upper === "I" || upper === "L" ? "1" : upper;
    if (canonical.length !== 1 || !PAIRING_CODE_ALPHABET.includes(canonical)) return null;
    code += canonical;
    if (code.length > PAIRING_CODE_LENGTH) return null;
  }
  return code.length === PAIRING_CODE_LENGTH ? code : null;
}

/** What the office's DataMatrix carries: `markiro-host:1?h=<a,b>&p=<port>&f=<fingerprint>&c=<code>`. */
export interface PairingPayload {
  /** The host's IPv4 addresses in the local network; empty when it has none. */
  addresses: string[];
  port: number;
  /** Lower-case hex SHA-256 of the host's certificate. */
  fingerprint: string;
  /** The code in canonical form. */
  code: string;
}

/**
 * The Russian ЙЦУКЕН layout back to the US keys, position by position. A
 * keyboard-wedge scanner presses keys, not characters: with the Russian
 * layout on, the payload arrives in Cyrillic. Digits, `-`, `=` and space sit
 * on the same keys in both layouts.
 */
const RUSSIAN_KEYS =
  "йцукенгшщзхъфывапролджэячсмитьбюё" + "ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮЁ" + '.,"№;:?/';
const US_KEYS =
  "qwertyuiop[]asdfghjkl;'zxcvbnm,.`" + 'QWERTYUIOP{}ASDFGHJKL:"ZXCVBNM<>~' + "/?@#$^&|";
const RUSSIAN_TO_US = new Map(
  Array.from(RUSSIAN_KEYS, (symbol, index) => [symbol, US_KEYS.charAt(index)] as const),
);

/** Text typed under the Russian layout, as the same keys type it under the US one. */
export function fromRussianLayout(text: string): string {
  return Array.from(text, (symbol) => RUSSIAN_TO_US.get(symbol) ?? symbol).join("");
}

const CYRILLIC = /[\u0400-\u04ff]/;
/** Each octet as `Ipv4Addr::from_str` reads it: no leading zero besides a bare `0`. */
const IPV4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

function isIpv4(address: string): boolean {
  const match = IPV4.exec(address);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * A Cyrillic letter with its case swapped; anything else unchanged. Caps
 * Lock inverts the case of every letter key, including the three letters
 * that type `,`, `.` and `:`/`;` on the US layout, so a scan taken with Caps
 * Lock on has every Cyrillic letter's case flipped from the plain one,
 * punctuation letters included, while digits, `-`, `=` and the shifted
 * digit-row symbols (not letters) stay the same either way.
 */
function withCyrillicCaseSwapped(text: string): string {
  return Array.from(text, (symbol) => {
    if (!CYRILLIC.test(symbol)) return symbol;
    const lower = symbol.toLowerCase();
    return symbol === lower ? symbol.toUpperCase() : lower;
  }).join("");
}

/**
 * The office's pairing payload, as a scanner typed it: under the Russian
 * layout, Caps Lock included (recovered by retrying with every Cyrillic
 * letter's case swapped, since only one of the two variants can match the
 * scheme, `:` vs `;`), with Caps Lock under the US layout, or behind the
 * AIM identifier `]d1`/`]D1` a scanner may prepend. `null` when the text is
 * not a payload of protocol 1.
 */
export function parsePairingPayload(text: string): PairingPayload | null {
  if (!CYRILLIC.test(text)) return parseTyped(text.trim());
  const plain = parseTyped(fromRussianLayout(text).trim());
  if (plain !== null) return plain;
  return parseTyped(fromRussianLayout(withCyrillicCaseSwapped(text)).trim());
}

/** The body already mapped out of the Russian layout (if it was in it) and trimmed. */
function parseTyped(typed: string): PairingPayload | null {
  const body = typed.replace(/^\][dD]\d/, "");
  const query = body.indexOf("?");
  if (query < 0 || body.slice(0, query).toLowerCase() !== "markiro-host:1") return null;
  const fields = new Map<string, string>();
  for (const field of body.slice(query + 1).split("&")) {
    const equals = field.indexOf("=");
    if (equals < 0) return null;
    const key = field.slice(0, equals).toLowerCase();
    if (fields.has(key)) return null;
    fields.set(key, field.slice(equals + 1));
  }
  const hosts = fields.get("h");
  const port = fields.get("p");
  const fingerprint = fields.get("f")?.toLowerCase();
  const code = normalizePairingCode(fields.get("c") ?? "");
  if (hosts === undefined || port === undefined || fingerprint === undefined || code === null) {
    return null;
  }
  const addresses = hosts === "" ? [] : hosts.split(",");
  const portNumber = /^\d{1,5}$/.test(port) ? Number(port) : 0;
  if (!addresses.every(isIpv4) || portNumber < 1 || portNumber > 65535) return null;
  if (!FINGERPRINT.test(fingerprint)) return null;
  return { addresses, port: portNumber, fingerprint, code };
}
