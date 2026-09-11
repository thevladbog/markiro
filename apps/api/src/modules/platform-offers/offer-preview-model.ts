import { ConflictException } from "@nestjs/common";
import { calculateOfferAmounts } from "./offer-totals";

type OfferBreakdownLine = {
  quantity: number;
  agreedUnitPrice: string;
  vatRate: string | null;
  vatIncluded: boolean;
};

/** Preview and publication use the same half-up amounts and storage bounds as new offers. */
export function calculateSavedOfferAmounts(
  lines: readonly OfferBreakdownLine[],
  authoritativeTotal: string,
) {
  const amounts = calculateOfferAmounts(
    lines.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.agreedUnitPrice,
      vatRateBps: line.vatRate === null ? null : Math.round(Number(line.vatRate) * 100),
      vatIncluded: line.vatIncluded,
    })),
  );
  if (amounts.total !== authoritativeTotal)
    throw new ConflictException({ code: "offer_total_inconsistent" });
  return amounts;
}

export function calculateOfferBreakdown(
  lines: readonly OfferBreakdownLine[],
  authoritativeTotal: string,
) {
  const amounts = calculateSavedOfferAmounts(lines, authoritativeTotal);
  return {
    subtotal: amounts.subtotal,
    vatTotal: amounts.vatTotal,
    total: amounts.total,
    lineTotals: amounts.lines.map((line) => line.lineTotal),
  };
}
