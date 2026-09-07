import { parseTraceabilityQuantity } from "@markiro/domain";

/** Sum each unit independently at the saved maximum scale, never through Number. */
export function receivingQuantityTotals(
  items: readonly { quantity: string | null; unitOfMeasure: string | null }[],
) {
  const totals = new Map<string, { value: bigint; scale: number }>();
  for (const item of items) {
    if (!item.quantity || !item.unitOfMeasure) throw new Error("Incomplete receiving quantity");
    const quantity = parseTraceabilityQuantity(item.quantity);
    const [integer = "0", fraction = ""] = quantity.split(".");
    const value = BigInt(integer + fraction);
    const previous = totals.get(item.unitOfMeasure) ?? { value: 0n, scale: 0 };
    const scale = Math.max(previous.scale, fraction.length);
    totals.set(item.unitOfMeasure, {
      scale,
      value:
        previous.value * 10n ** BigInt(scale - previous.scale) +
        value * 10n ** BigInt(scale - fraction.length),
    });
  }
  return Array.from(totals, ([unit, { value, scale }]) => {
    const digits = value.toString().padStart(scale + 1, "0");
    return {
      unit,
      quantity: scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits,
    };
  });
}
