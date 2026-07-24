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
    cents += Math.round(Number(item.unitPrice) * 100);
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
