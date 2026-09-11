import { isCommercialPlanSequenceValid } from "@markiro/platform-contracts";
import type { CommercialLineTerms, SellerTaxPolicy } from "@markiro/platform-contracts";
import { ApiRequestError } from "../../api/client.js";
const codes = new Set([
  "commercial_plan_sequence_invalid",
  "commercial_plan_sequence_review_required",
  "commercial_amount_out_of_range",
  "commercial_review_stale",
  "commercial_terms_review_required",
  "seller_tax_policy_unconfigured",
  "seller_tax_policy_violation",
  "commercial_source_review_required",
  "offer_invoice_lines_mismatch",
  "offer_invoice_exists",
  "offer_not_accepted",
  "commercial_sale_already_fulfilled",
  "commercial_plan_quantity_invalid",
  "commercial_line_terms_invalid",
]);
export function commercialErrorKey(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError && error.code && codes.has(error.code)
    ? `commercial.errors.${error.code}`
    : fallback;
}

export function commercialIssuanceError(
  lines: readonly {
    kind: string;
    quantity: number;
    commercialTerms: CommercialLineTerms | null;
    vatRate: string | null;
    vatIncluded: boolean;
  }[],
  context: { sellerPolicyRevision: number; taxPolicy: SellerTaxPolicy | null },
): string | null {
  if (!isCommercialPlanSequenceValid(lines)) return "commercial_plan_sequence_review_required";
  if (!context.taxPolicy) return "seller_tax_policy_unconfigured";
  for (const line of lines) {
    if (!line.commercialTerms) return "commercial_terms_review_required";
    if (line.commercialTerms.sellerPolicyRevision !== context.sellerPolicyRevision)
      return "commercial_review_stale";
    if (line.kind === "plan" && line.quantity !== 1) return "commercial_plan_quantity_invalid";
    const allowed =
      context.taxPolicy.kind === "without_vat"
        ? line.vatRate === null && !line.vatIncluded
        : line.vatRate !== null &&
          context.taxPolicy.allowedRatesBps.includes(Math.round(Number(line.vatRate) * 100));
    if (!allowed) return "seller_tax_policy_violation";
  }
  return null;
}
