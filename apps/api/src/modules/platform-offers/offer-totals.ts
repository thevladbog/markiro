import { BadRequestException } from "@nestjs/common";
import { assertCommercialMoneyRange } from "../billing/commercial-money-range";

export interface OfferTotalLine {
  quantity: number;
  unitPrice: string;
  vatRateBps: number | null;
  vatIncluded: boolean;
}

export interface OfferTotals {
  total: string;
  currency: "RUB";
}

export function calculateOfferTotals(lines: readonly OfferTotalLine[]): OfferTotals {
  const amounts = calculateOfferAmounts(lines);
  return { total: amounts.total, currency: amounts.currency };
}

/** One offer calculation for new snapshots and exact accepted-offer conversion. */
export function calculateOfferAmounts(lines: readonly OfferTotalLine[]) {
  let subtotalMinor = 0,
    vatMinor = 0,
    totalMinor = 0;
  const amounts = lines.map((line) => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0)
      throw new Error("quantity must be a positive integer");
    const unitMinor = parseMinor(line.unitPrice);
    if (
      line.vatRateBps !== null &&
      (!Number.isSafeInteger(line.vatRateBps) || line.vatRateBps < 0 || line.vatRateBps > 10_000)
    )
      throw new Error("vatRateBps is out of range");
    const base = checkedMultiply(unitMinor, line.quantity);
    const rate = BigInt(line.vatRateBps ?? 0);
    const denominator = line.vatIncluded ? 10_000n + rate : 10_000n;
    const vat = Number((BigInt(base) * rate + denominator / 2n) / denominator);
    assertCommercialMoneyRange(BigInt(vat));
    const subtotal = line.vatIncluded ? base - vat : base;
    const total = checkedAdd(subtotal, vat);
    subtotalMinor = checkedAdd(subtotalMinor, subtotal);
    vatMinor = checkedAdd(vatMinor, vat);
    totalMinor = checkedAdd(totalMinor, total);
    return { lineSubtotal: money(subtotal), lineVat: money(vat), lineTotal: money(total) };
  });
  return {
    subtotal: money(subtotalMinor),
    vatTotal: money(vatMinor),
    total: money(totalMinor),
    currency: "RUB" as const,
    lines: amounts,
  };
}

function money(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

function parseMinor(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error("unitPrice must be a decimal with at most 2 places");
  const [whole, fraction = ""] = value.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor))
    throw new BadRequestException({ code: "commercial_amount_out_of_range" });
  assertCommercialMoneyRange(BigInt(minor));
  return minor;
}

function checkedMultiply(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value))
    throw new BadRequestException({ code: "commercial_amount_out_of_range" });
  assertCommercialMoneyRange(BigInt(value));
  return value;
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value))
    throw new BadRequestException({ code: "commercial_amount_out_of_range" });
  assertCommercialMoneyRange(BigInt(value));
  return value;
}
