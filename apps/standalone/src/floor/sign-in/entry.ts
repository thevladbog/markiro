import { appendDigit, dropDigit, type KeypadKey } from "../kit/numeric-entry.js";

/**
 * The sign-in's two fields, a personnel number and a PIN, and the one flat keypad that edits
 * whichever of them is active (design kit 2026-10, variant A of the sign-in). Pure: the screen
 * keeps one `Entry` and asks these functions for the next one; the checks themselves
 * (`sign-in.ts`) and the lockouts (`lockout.ts`) know nothing of it.
 */

export type EntryField = "login" | "pin";

export interface Entry {
  /** The field the keypad edits. */
  active: EntryField;
  login: string;
  pin: string;
}

export type EntryKey = KeypadKey;

/** A personnel number the keypad could have typed (`operatorLoginRule`) and a PIN (`operatorPinRule`). */
export const LOGIN_RULE = /^[0-9]{3,12}$/;
export const PIN_RULE = /^[0-9]{4,6}$/;
export const LOGIN_MAX = 12;
export const PIN_MAX = 6;

const MAX: Record<EntryField, number> = { login: LOGIN_MAX, pin: PIN_MAX };

export const entryValue = (entry: Entry, field: EntryField): string => entry[field];

/** «Войти» is offered for a valid number together with a valid PIN. */
export function canSubmit(entry: Entry): boolean {
  return LOGIN_RULE.test(entry.login) && PIN_RULE.test(entry.pin);
}

/** A tap on a field gives it the keypad. */
export function selectField(entry: Entry, field: EntryField): Entry {
  return entry.active === field ? entry : { ...entry, active: field };
}

/**
 * One key of the keypad, applied to the active field. A number that is full cannot take another
 * digit, so the keypad moves on to the PIN; «Стереть» on an empty PIN only goes back to the
 * number (it takes no digit of it away); «Сброс» empties the active field alone.
 */
export function editEntry(entry: Entry, key: EntryKey): Entry {
  const field = entry.active;
  const value = entry[field];
  if (key.kind === "clear") return value === "" ? entry : { ...entry, [field]: "" };
  if (key.kind === "backspace") {
    if (value === "") return field === "pin" ? { ...entry, active: "login" } : entry;
    return { ...entry, [field]: dropDigit(value) };
  }
  const next = appendDigit(value, key.digit, MAX[field], true);
  if (next === value) return entry;
  const moved = field === "login" && next.length >= LOGIN_MAX;
  return { ...entry, [field]: next, active: moved ? "pin" : field };
}

/**
 * After a check's answer: the PIN it was given does not stay (whatever the answer), and after a
 * PIN's answer the keypad is on the PIN, ready to try again.
 */
export function afterAttempt(entry: Entry, via: "pin" | "badge"): Entry {
  return { ...entry, pin: "", active: via === "pin" ? "pin" : entry.active };
}

export type FieldStatus = "empty" | "active" | "accepted" | "filled" | "error" | "locked";

export interface FieldFlags {
  /** The field whose last answer was a refusal. */
  error?: EntryField | null;
  /** The fields a lockout holds. */
  locked?: readonly EntryField[];
}

const RULE: Record<EntryField, RegExp> = { login: LOGIN_RULE, pin: PIN_RULE };

/** Priority: locked, error, active, then what the value is (accepted: valid and not active). */
export function fieldStatus(field: EntryField, entry: Entry, flags: FieldFlags): FieldStatus {
  if (flags.locked?.includes(field) === true) return "locked";
  if (flags.error === field) return "error";
  if (entry.active === field) return "active";
  const value = entry[field];
  if (value === "") return "empty";
  return RULE[field].test(value) ? "accepted" : "filled";
}
