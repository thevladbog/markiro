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

const MAX_MINOR = Number.MAX_SAFE_INTEGER;

export function calculateOfferTotals(lines: readonly OfferTotalLine[]): OfferTotals {
  let totalMinor = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new Error("quantity must be a positive integer");
    }
    const unitMinor = parseMinor(line.unitPrice);
    if (
      line.vatRateBps !== null &&
      (!Number.isSafeInteger(line.vatRateBps) || line.vatRateBps < 0 || line.vatRateBps > 10_000)
    ) {
      throw new Error("vatRateBps is out of range");
    }
    const base = checkedMultiply(unitMinor, line.quantity);
    const lineMinor =
      line.vatIncluded || line.vatRateBps === null
        ? base
        : Math.floor((base * (10_000 + line.vatRateBps) + 5_000) / 10_000);
    totalMinor = checkedAdd(totalMinor, lineMinor);
  }
  return {
    total: `${Math.floor(totalMinor / 100)}.${String(totalMinor % 100).padStart(2, "0")}`,
    currency: "RUB",
  };
}

function parseMinor(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error("unitPrice must be a decimal with at most 2 places");
  const [whole, fraction = ""] = value.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error("unitPrice is too large");
  return minor;
}

function checkedMultiply(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value > MAX_MINOR)
    throw new Error("offer total is too large");
  return value;
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > MAX_MINOR)
    throw new Error("offer total is too large");
  return value;
}
