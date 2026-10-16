/**
 * What the IpKeypad and the hardware keyboard type into a network printer's address, port and a
 * COM port's baud rate (design brief «IpKeypad»): pure functions, so the keys, the live check and
 * a paste are all one rule. A value stays the text of the form's field; `printer-draft.ts` judges
 * it again when the form is applied.
 */

/** What a keypad is typing: the address (digits and dots), the port or the baud rate (digits). */
export type IpTarget = "host" | "port" | "baud";

/** The longest dotted IPv4 text: `255.255.255.255`. */
const IPV4_MAX_LENGTH = 15;
/** The longest port, `65535`. */
const PORT_MAX_LENGTH = 5;
/** A baud rate is a number up to 2^32 - 1: ten digits. */
const BAUD_MAX_LENGTH = 10;

const maxLength = (target: IpTarget): number =>
  target === "host" ? IPV4_MAX_LENGTH : target === "port" ? PORT_MAX_LENGTH : BAUD_MAX_LENGTH;

/** `value` after a key of the keypad: a digit, `.` (the address only), nothing else. */
export function appendKey(value: string, key: string, target: IpTarget): string {
  if (value.length >= maxLength(target)) return value;
  if (/^[0-9]$/.test(key)) {
    if (target === "host") {
      // An octet has at most three digits: a fourth would never be a valid one.
      const octet = value.slice(value.lastIndexOf(".") + 1);
      if (octet.length >= 3) return value;
    }
    return value + key;
  }
  if (key === "." && target === "host") {
    // Never a leading dot, a doubled one, or a fourth dot.
    if (value === "" || value.endsWith(".")) return value;
    if (value.split(".").length >= 4) return value;
    return value + ".";
  }
  return value;
}

/** «Стереть»: `value` without its last character. */
export function eraseKey(value: string): string {
  return value.slice(0, -1);
}

/** Whether the keypad of `target` offers the dot key (the cell stays, empty, so the keys never jump). */
export function hasDotKey(target: IpTarget): boolean {
  return target === "host";
}

/**
 * Pasted text as a field's text: every kind of space and the zero-width marks are gone, the way a
 * number copied from a document (`9 100`, `192.168.1.50 `) arrives. Nothing else is changed: what
 * is still wrong is the live check's to say, not the paste's to guess.
 */
export function normalizePaste(text: string): string {
  return text.replace(/[\s\u00a0\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\ufeff]+/gu, "");
}

/** The field's text with `pasted` (normalised) in place of the selection `start`–`end`. */
export function pasteInto(value: string, start: number, end: number, pasted: string): string {
  const from = Math.max(0, Math.min(start, end, value.length));
  const to = Math.min(value.length, Math.max(start, end));
  return value.slice(0, from) + normalizePaste(pasted) + value.slice(to);
}

/** A string of digits and dots only: the shape of an IPv4 address, whether complete or not. */
export function isIpv4Shaped(value: string): boolean {
  return /^[0-9.]+$/.test(value) && /[0-9]/.test(value);
}

/** What the live check of an address says. */
export type AddressCheck =
  | { state: "empty" }
  /** A host name (anything not shaped like IPv4): accepted as it is. */
  | { state: "name" }
  | { state: "ok" }
  /** IPv4-shaped, fewer than four whole numbers so far: a hint, not yet an error. */
  | { state: "incomplete" }
  /** An octet above 255: `octet` is the offending text. */
  | { state: "octet"; octet: string }
  /** IPv4-shaped but not four numbers (too many, an empty one between dots). */
  | { state: "format" };

/**
 * An address as the live check reads it: the octets are judged only for an IPv4-shaped string; a
 * host name (a letter, a hyphen) passes, as it does when the form is applied.
 */
export function checkAddress(value: string): AddressCheck {
  const text = value.trim();
  if (text === "") return { state: "empty" };
  if (!isIpv4Shaped(text)) return { state: "name" };
  const parts = text.split(".");
  const tooBig = parts.find((part) => part !== "" && Number(part) > 255);
  if (tooBig !== undefined) return { state: "octet", octet: tooBig };
  if (parts.length > 4 || parts.slice(0, -1).some((part) => part === "")) {
    return { state: "format" };
  }
  if (parts.length < 4 || parts[3] === "") return { state: "incomplete" };
  return { state: "ok" };
}

/** Whether an address is wrong (not merely unfinished) once it is applied: IPv4-shaped but not an address. */
export function addressInvalid(value: string): boolean {
  const check = checkAddress(value);
  return check.state === "octet" || check.state === "format" || check.state === "incomplete";
}

/** What the live check of a port says. */
export type PortCheck = { state: "empty" } | { state: "ok" } | { state: "range" };

/** A port: a whole number from 1 to 65 535. */
export function checkPort(value: string): PortCheck {
  const text = value.trim();
  if (text === "") return { state: "empty" };
  if (!/^[0-9]+$/.test(text)) return { state: "range" };
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? { state: "ok" } : { state: "range" };
}

/** A baud rate: a whole number from 1 to 4 294 967 295 (the rule of the scanner and printer forms). */
export function checkBaud(value: string): PortCheck {
  const text = value.trim();
  if (text === "") return { state: "empty" };
  if (!/^[0-9]+$/.test(text)) return { state: "range" };
  const baud = Number(text);
  return baud >= 1 && baud <= 4_294_967_295 ? { state: "ok" } : { state: "range" };
}
