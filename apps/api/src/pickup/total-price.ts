/**
 * Parses a decimal amount string into an exact integer number of kopecks,
 * without binary-float arithmetic (`Number("1.005") * 100` is `100.4999…`).
 * Rounds half away from zero at the 2nd fractional digit — matching how the
 * `numeric(_, 2)` DB column itself rounds. Returns `null` for anything that
 * isn't a plain signed decimal, which the caller treats as "unpriced".
 */
function toKopecks(value: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const digits = m[3] ?? "";
  let kopecks = Number(m[2]) * 100 + Number(digits.slice(0, 2).padEnd(2, "0"));
  if (digits.length > 2 && Number(digits[2]) >= 5) kopecks += 1; // round half up
  return sign * kopecks;
}

/**
 * Sums a pickup order's item prices in integer kopecks (never binary float),
 * so the "Итого" total is exact to the kopeck regardless of item count.
 * Returns `null` when the list is empty or any item is unpriced — mirroring
 * the nullable `pickupOrders.totalPrice` column.
 */
export function computeTotalPrice(items: { unitPrice: string | null }[]): string | null {
  if (items.length === 0) return null;
  let cents = 0;
  for (const item of items) {
    if (item.unitPrice === null) return null;
    const kopecks = toKopecks(item.unitPrice);
    if (kopecks === null) return null;
    cents += kopecks;
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
