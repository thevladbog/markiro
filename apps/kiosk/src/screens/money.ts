import type { CartItem } from "../session/cart.js";

/**
 * What a kiosk screen may say about money, in one place.
 *
 * Extracted from `Cart` the moment `Done` had to state the same order's total:
 * two screens showing the same worker the same sum minutes apart, each with its
 * own arithmetic, is how «269,70 ₽» on the cart becomes «269.70 ₽» on the
 * confirmation — or worse, how one of them starts rounding differently. These
 * are display rules only; the server files its own total (`total-price.ts`) and
 * remains the authority.
 */

/**
 * Money in minor units, by the same convention the server files the order
 * under. Replicated from `apps/api/src/pickup/total-price.ts` rather than
 * imported: that module lives inside the Nest application, is not a package
 * this device app depends on, and `toKopecks` is not exported from it — and the
 * kiosk needs the integer for display arithmetic, not `computeTotalPrice`'s
 * decimal string. If a caller outside `screens/` ever appears, this belongs in
 * `@markiro/domain` and both should move there together.
 *
 * `Number(x) * 100` is the trap being avoided, twice over: it drifts on binary
 * floats (`Number("1.005") * 100` is `100.4999…`) and it turns anything it
 * cannot read — «89,90» with the decimal comma a Russian price list writes —
 * into `NaN`, which the old code rounded to a confident, wrong `0.00 ₽`.
 * `null` means "this kiosk cannot price it", never "it is free".
 */
export function toKopecks(value: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const digits = m[3] ?? "";
  let kopecks = Number(m[2]) * 100 + Number(digits.slice(0, 2).padEnd(2, "0"));
  if (digits.length > 2 && Number(digits[2]) >= 5) kopecks += 1; // round half up
  return sign * kopecks;
}

/**
 * A list's total, or `null` when it cannot be known — mirroring the server's
 * `computeTotalPrice`, which returns `null` the moment ANY item is unpriced.
 * Silently omitting an unpriced item and printing the rest would understate the
 * very number the administrator charges against, and nothing on screen would
 * say so.
 *
 * The one clause deliberately not mirrored is the empty list: the server
 * returns `null` there because `pickupOrders.totalPrice` is nullable and "no
 * order" has no total, whereas an empty cart at a kiosk genuinely costs
 * nothing, and «—» sitting in the footer before the first scan reads as a
 * broken screen.
 */
export function totalKopecks(items: CartItem[]): number | null {
  let sum = 0;
  for (const item of items) {
    if (item.unitPrice === null) return null;
    const kopecks = toKopecks(item.unitPrice);
    if (kopecks === null) return null;
    sum += kopecks;
  }
  return sum;
}

/**
 * The money formatter for the language the kiosk is speaking.
 *
 * THE SEPARATOR IS NOT A CONSTANT. A dot was hard-coded once, so a Russian
 * kiosk printed «89.90 ₽» at a worker who reads «89,90» — the very form the
 * source price list is written in, and which `toKopecks` above refuses to parse
 * for exactly that reason. `Intl` is asked instead of a second hard-coded
 * comma, because the answer belongs to the locale and not to this file.
 *
 * Both fraction-digit bounds are pinned at 2: a price is minor units and shows
 * them, so «45 ₽» for 4500 kopecks (`Intl`'s default for a whole number) and a
 * third digit are both wrong here.
 */
export function moneyFormat(language: string): Intl.NumberFormat {
  return new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * `kopecks / 100` is safe where `Number(price) * 100` was not: the quotient of
 * an integer by 100 is within a hair of the two-decimal value it stands for at
 * every magnitude a kiosk can reach, and `Intl` rounds to those two digits — so
 * nothing drifts, while the parse this replaces turned «89,90» into `NaN`.
 */
export function formatMoney(kopecks: number, format: Intl.NumberFormat): string {
  return format.format(kopecks / 100);
}

/**
 * Stands in for a price the kiosk cannot state. An em dash, not a dictionary
 * entry: it is typography rather than copy, identical in every language, and a
 * key for it would be one more thing for the RU/EN lockstep test to keep in
 * step for no gain.
 */
export const UNPRICED = "—";
