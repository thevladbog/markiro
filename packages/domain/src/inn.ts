/**
 * The Russian taxpayer number (ИНН): 10 digits for an organization, 12 for an
 * individual entrepreneur, with the Federal Tax Service's check digits. One
 * implementation for the cloud (the National Catalog client) and the
 * standalone product's license (spec 2026-10-13 §4.9); the host's Rust port
 * (`apps/standalone/host/src/inn.rs`) answers `fixtures/inn-cases.json` alike.
 */
const TEN = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const TWELVE_FIRST = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const TWELVE_SECOND = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;

function checkDigit(digits: readonly number[], weights: readonly number[]): number {
  return (weights.reduce((sum, weight, index) => sum + weight * (digits[index] ?? 0), 0) % 11) % 10;
}

/** Exactly 10 or 12 ASCII digits whose check digits hold; nothing is trimmed. */
export function isValidInn(value: string): boolean {
  if (!/^\d{10}(?:\d{2})?$/.test(value)) return false;
  const digits = [...value].map(Number);
  if (digits.length === 10) return checkDigit(digits, TEN) === digits[9];
  return (
    checkDigit(digits, TWELVE_FIRST) === digits[10] &&
    checkDigit(digits, TWELVE_SECOND) === digits[11]
  );
}

/**
 * `value` without the whitespace `String.prototype.trim` removes, when that is
 * a valid INN; otherwise `null`. Inner spaces, letters and other digits than
 * ASCII are never removed: such a value is no INN.
 */
export function normalizeInn(value: string): string | null {
  const trimmed = value.trim();
  return isValidInn(trimmed) ? trimmed : null;
}
