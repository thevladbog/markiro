import type { CatalogVersionDto } from "../catalog/api.js";
import type { DocumentDraft, DocumentLineDraft } from "../documents/documentDraft.js";
import type { OfferDetail } from "../offers/api.js";

function vatRateBps(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{1,3})\.(\d{2})$/.exec(value);
  if (!match) throw new Error("offer_vat_rate_invalid");
  const bps = BigInt(match[1]!) * 100n + BigInt(match[2]!);
  if (bps > 10_000n) throw new Error("offer_vat_rate_invalid");
  return Number(bps);
}

export function sourceOfferDraft(
  source: Pick<OfferDetail, "tenantId" | "sellerBankAccountId" | "lines"> & {
    id?: string;
    total?: string;
    sourceRequestId?: string;
  },
  catalog: readonly CatalogVersionDto[],
): DocumentDraft {
  const lines: DocumentLineDraft[] = source.lines.map((line) => {
    const version = catalog.find((candidate) => candidate.id === line.catalogVersionId);
    const sourceVatRateBps = vatRateBps(line.vatRate);
    return {
      id: `offer-line-${line.id}`,
      kind: line.kind === "service" && !line.catalogVersionId ? "custom" : line.kind,
      catalogVersionId: line.catalogVersionId,
      catalogItemCode: version?.catalogItemCode ?? "",
      version: version?.version ?? 0,
      nameRu: line.nameRu,
      nameEn: line.nameEn,
      descriptionRu: line.descriptionRu ?? null,
      descriptionEn: line.descriptionEn ?? null,
      quantity: line.quantity,
      unit: line.unit,
      catalogUnitPrice: line.catalogUnitPrice ?? null,
      commercialTerms: line.commercialTerms,
      agreedUnitPrice: line.agreedUnitPrice,
      vatRateBps: sourceVatRateBps,
      vatIncluded: line.vatIncluded,
      activationPolicy:
        line.kind === "plan"
          ? line.activationPolicy === "after_current"
            ? "after_current"
            : "immediate"
          : line.kind === "addon"
            ? line.commercialTerms?.activationRule === "after_current"
              ? "after_current"
              : "immediate"
            : null,
    };
  });
  return {
    tenantId: source.tenantId,
    ...(source.total !== undefined ? { sourceTotal: source.total } : {}),
    ...(source.id !== undefined ? { sourceOfferId: source.id } : {}),
    ...(source.sourceRequestId !== undefined ? { sourceRequestId: source.sourceRequestId } : {}),
    ...(source.sellerBankAccountId !== undefined
      ? { sellerBankAccountId: source.sellerBankAccountId }
      : {}),
    applicationMode: "automatic",
    date: "",
    lines,
  };
}
