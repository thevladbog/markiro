import { ConflictException } from "@nestjs/common";

type OfferBreakdownLine = {
  quantity: number;
  agreedUnitPrice: string;
  vatRate: string | null;
  vatIncluded: boolean;
};

const maxMinor = BigInt(Number.MAX_SAFE_INTEGER);
function minor(value: string): bigint {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("offer_money_invalid");
  const [whole = "", fraction = ""] = value.split(".");
  return checked(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
}
function checked(value: bigint): bigint {
  if (value < 0n || value > maxMinor) throw new Error("offer_money_out_of_range");
  return value;
}
const money = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
const roundHalfUp = (numerator: bigint, denominator: bigint) =>
  (numerator * 2n + denominator) / (denominator * 2n);

/** Stored offer lineTotal is pre-tax for excluded VAT. Derive gross from price and quantity. */
export function calculateOfferBreakdown(
  lines: readonly OfferBreakdownLine[],
  authoritativeTotal: string,
) {
  let subtotal = 0n;
  let vatTotal = 0n;
  const lineTotals = lines.map((line) => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0)
      throw new Error("offer_quantity_invalid");
    const base = checked(minor(line.agreedUnitPrice) * BigInt(line.quantity));
    const rate = line.vatRate === null ? 0n : minor(line.vatRate);
    if (rate > 10_000n) throw new Error("offer_vat_rate_invalid");
    const vat = line.vatIncluded
      ? roundHalfUp(base * rate, 10_000n + rate)
      : roundHalfUp(base * rate, 10_000n);
    const gross = checked(line.vatIncluded ? base : base + vat);
    subtotal = checked(subtotal + gross - vat);
    vatTotal = checked(vatTotal + vat);
    return money(gross);
  });
  const total = checked(subtotal + vatTotal);
  if (total !== minor(authoritativeTotal))
    throw new ConflictException({ code: "offer_total_inconsistent" });
  return { subtotal: money(subtotal), vatTotal: money(vatTotal), total: money(total), lineTotals };
}
