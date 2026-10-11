const OFFER_NUMBER = /^MRK-CO-([0-9]+)$/;

/** The number that follows `last` in the global commercial-offer sequence (`MRK-CO-000001`, …). */
export function nextOfferNumber(last: string | null | undefined): string {
  const digits = last?.match(OFFER_NUMBER)?.[1] ?? "0";
  return `MRK-CO-${(BigInt(digits) + 1n).toString().padStart(6, "0")}`;
}
