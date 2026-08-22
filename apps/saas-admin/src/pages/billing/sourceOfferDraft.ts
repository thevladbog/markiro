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
  source: Pick<OfferDetail, "tenantId" | "sellerBankAccountId" | "lines">,
  catalog: readonly CatalogVersionDto[],
): DocumentDraft {
  const lines: DocumentLineDraft[] = source.lines.map((line) => {
    const version = catalog.find((candidate) => candidate.id === line.catalogVersionId);
    const sourceVatRateBps = vatRateBps(line.vatRate);
    const catalogBacked =
      version !== undefined &&
      version.kind === line.kind &&
      version.nameRu === line.nameRu &&
      version.nameEn === line.nameEn &&
      version.descriptionRu === (line.descriptionRu ?? null) &&
      version.descriptionEn === (line.descriptionEn ?? null) &&
      version.unit === line.unit &&
      (version.unitPrice ?? null) === (line.catalogUnitPrice ?? null) &&
      (version.vatRateBps ?? null) === sourceVatRateBps &&
      (version.vatIncluded ?? false) === line.vatIncluded;
    return {
      id: `offer-line-${line.id}`,
      kind: catalogBacked ? line.kind : "custom",
      catalogVersionId: catalogBacked ? line.catalogVersionId : null,
      catalogItemCode: catalogBacked ? version.catalogItemCode : "",
      version: catalogBacked ? version.version : 0,
      nameRu: line.nameRu,
      nameEn: line.nameEn,
      descriptionRu: line.descriptionRu ?? null,
      descriptionEn: line.descriptionEn ?? null,
      quantity: line.quantity,
      unit: line.unit,
      catalogUnitPrice: catalogBacked
        ? (version.unitPrice ?? null)
        : (line.catalogUnitPrice ?? null),
      agreedUnitPrice: line.agreedUnitPrice,
      vatRateBps: sourceVatRateBps,
      vatIncluded: line.vatIncluded,
      activationPolicy: catalogBacked
        ? line.activationPolicy === "immediately"
          ? "immediate"
          : line.activationPolicy
        : null,
    };
  });
  return {
    tenantId: source.tenantId,
    ...(source.sellerBankAccountId !== undefined
      ? { sellerBankAccountId: source.sellerBankAccountId }
      : {}),
    applicationMode: "automatic",
    date: "",
    lines,
  };
}
