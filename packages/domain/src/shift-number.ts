import { DomainError } from "./errors.js";

const MONTH_KEYS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const;

/**
 * The month bucket a shift number is drawn from, as `MONYY` (`AUG26`).
 * Month names are a fixed English table, NOT `toLocaleString` — the number
 * is a stable identifier and must not depend on the server's locale.
 */
export function shiftMonthKey(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate);
  if (!match) throw new DomainError("SHIFT_DATE_FORMAT", `malformed ISO date: "${isoDate}"`);
  const month = Number(match[2]!);
  if (month < 1 || month > 12) throw new DomainError("SHIFT_DATE_FORMAT", `invalid month: ${match[2]}`);
  return `${MONTH_KEYS[month - 1]}${match[1]!.slice(2)}`;
}

/**
 * The display form of a shift number. `/S` marks a shift created at a
 * station ("Новая смена") — fixed at creation, exactly like the sequence.
 */
export function formatShiftNumber(input: {
  monthKey: string;
  seq: number;
  createdFrom: "admin" | "station";
}): string {
  const seq = String(input.seq).padStart(3, "0");
  return `${input.monthKey}-${seq}${input.createdFrom === "station" ? "/S" : ""}`;
}
