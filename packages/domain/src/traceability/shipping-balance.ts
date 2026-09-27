import { isTraceabilityUom } from "./uom.js";

export type ShippingBalanceInput = {
  contributions: readonly { quantity: string; unitOfMeasure: string }[];
  deductions: readonly { quantity: string; unitOfMeasure: string }[];
};

export type ShippingBalance =
  | { state: "known"; unitOfMeasure: string; supply: string; used: string; remaining: string }
  | {
      state: "unknown";
      reason: "no_current_origin" | "mixed_uom" | "invalid_quantity" | "overflow";
    };

/** The numeric(18,3) database range expressed in exact thousandths. */
const MAX_MILLI = 999_999_999_999_999_999n;
const QUANTITY = /^(?:0|[1-9]\d{0,14})(?:\.(\d{1,3}))?$/;

export function shippingQuantityMilli(value: string): bigint | null {
  const match = QUANTITY.exec(value);
  if (!match) return null;
  const [whole] = value.split(".");
  if (whole === undefined) return null;
  const milli = BigInt(whole) * 1000n + BigInt((match[1] ?? "").padEnd(3, "0"));
  return milli > 0n && milli <= MAX_MILLI ? milli : null;
}

export function shippingMilliText(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1000n;
  const fraction = (absolute % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export type ShippingForecast =
  | { state: "unknown"; reason: Extract<ShippingBalance, { state: "unknown" }>["reason"] }
  | { state: "quantity_required" | "invalid_quantity" | "unit_required" | "exhausted" }
  | { state: "uom_mismatch"; expectedUnit: string }
  | { state: "known" | "over_shipment"; projectedRemaining: string };

/** Draft-only preview. Finalization re-reads the ledger under the lot lock. */
export function projectShippingRemaining(
  balance: ShippingBalance,
  proposedQuantity: string | null,
  unitOfMeasure: string | null,
): ShippingForecast {
  if (balance.state === "unknown") return { state: "unknown", reason: balance.reason };
  if (!proposedQuantity) return { state: "quantity_required" };
  const proposed = shippingQuantityMilli(proposedQuantity);
  if (proposed === null) return { state: "invalid_quantity" };
  if (!unitOfMeasure) return { state: "unit_required" };
  if (unitOfMeasure !== balance.unitOfMeasure)
    return { state: "uom_mismatch", expectedUnit: balance.unitOfMeasure };
  const match = /^(-?)(0|[1-9]\d{0,15})(?:\.(\d{1,3}))?$/.exec(balance.remaining);
  if (!match) return { state: "invalid_quantity" };
  const current =
    (match[1] === "-" ? -1n : 1n) *
    (BigInt(match[2] ?? "0") * 1000n + BigInt((match[3] ?? "").padEnd(3, "0")));
  if (current <= 0n) return { state: "exhausted" };
  const projectedRemaining = shippingMilliText(current - proposed);
  return current < proposed
    ? { state: "over_shipment", projectedRemaining }
    : { state: "known", projectedRemaining };
}

/** Caller supplies only current finalized contributions and deductions for one lot. */
export function computeShippingBalance(input: ShippingBalanceInput): ShippingBalance {
  if (input.contributions.length === 0) return { state: "unknown", reason: "no_current_origin" };
  const rows = [...input.contributions, ...input.deductions];
  const quantities = rows.map((row) => shippingQuantityMilli(row.quantity));
  if (quantities.some((quantity) => quantity === null))
    return { state: "unknown", reason: "invalid_quantity" };
  const unitOfMeasure = input.contributions[0]?.unitOfMeasure;
  if (
    !unitOfMeasure ||
    !isTraceabilityUom(unitOfMeasure) ||
    rows.some((row) => row.unitOfMeasure !== unitOfMeasure)
  )
    return { state: "unknown", reason: "mixed_uom" };

  let supply = 0n;
  for (const row of input.contributions) {
    const quantity = shippingQuantityMilli(row.quantity);
    if (quantity === null) return { state: "unknown", reason: "invalid_quantity" };
    supply += quantity;
    if (supply > MAX_MILLI) return { state: "unknown", reason: "overflow" };
  }
  let used = 0n;
  for (const row of input.deductions) {
    const quantity = shippingQuantityMilli(row.quantity);
    if (quantity === null) return { state: "unknown", reason: "invalid_quantity" };
    used += quantity;
    if (used > MAX_MILLI) return { state: "unknown", reason: "overflow" };
  }
  return {
    state: "known",
    unitOfMeasure,
    supply: shippingMilliText(supply),
    used: shippingMilliText(used),
    remaining: shippingMilliText(supply - used),
  };
}
