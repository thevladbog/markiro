import type { OfferDetailV2 } from "@markiro/platform-contracts";
import type { DocumentDraft } from "../documents/documentDraft.js";

/** Editing starts from saved values; the current catalog never hydrates an existing sale. */
export function offerToDocumentDraft(offer: OfferDetailV2): DocumentDraft {
  return {
    tenantId: offer.tenantId,
    applicationMode: "automatic",
    sellerBankAccountId: offer.sellerBankAccountId ?? null,
    date: offer.expiresAt?.slice(0, 10) ?? "",
    termsMarkdown: offer.termsMarkdown,
    lines: offer.lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      catalogVersionId: line.catalogVersionId,
      catalogItemCode: "",
      version: 0,
      nameRu: line.nameRu,
      nameEn: line.nameEn,
      descriptionRu: line.descriptionRu,
      descriptionEn: line.descriptionEn,
      commercialTerms: line.commercialTerms,
      quantity: line.quantity,
      unit: line.unit,
      catalogUnitPrice: line.catalogUnitPrice,
      agreedUnitPrice: line.agreedUnitPrice,
      priceOverrideReason: line.priceOverrideReason,
      vatRateBps: line.vatRate === null ? null : Math.round(Number(line.vatRate) * 100),
      vatIncluded: line.vatIncluded,
      activationPolicy:
        line.kind === "service"
          ? null
          : line.activationPolicy === "after_current"
            ? "after_current"
            : "immediate",
    })),
  };
}
