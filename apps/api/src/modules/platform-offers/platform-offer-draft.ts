import { BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { CreateOfferDto } from "./dto";
import { calculateOfferTotals } from "./offer-totals";
import { normalizeOfferTerms } from "./offer-terms";

type OfferDraftExecutor = Pick<Db, "insert" | "select">;

export async function createOfferDraft(
  tx: OfferDraftExecutor,
  actorUserId: string,
  input: CreateOfferDto,
): Promise<string> {
  let termsMarkdown: string | null;
  try {
    termsMarkdown = normalizeOfferTerms(input.termsMarkdown).markdown;
  } catch (error) {
    if (error instanceof Error && error.message === "offer_terms_too_long") {
      throw new BadRequestException({ code: error.message });
    }
    throw error;
  }
  const total = calculateOfferTotals(
    input.lines.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.agreedUnitPrice,
      vatRateBps: line.vatRateBps ?? null,
      vatIncluded: line.vatIncluded,
    })),
  );
  const validatedLines: Array<{
    line: CreateOfferDto["lines"][number];
    catalogUnitPrice: string | null;
    priceOverrideReason: string | null;
  }> = [];
  for (const line of input.lines) {
    if (!line.catalogVersionId) {
      if (line.kind !== "service") {
        throw new BadRequestException({ code: "offer_catalog_version_invalid" });
      }
      validatedLines.push({ line, catalogUnitPrice: null, priceOverrideReason: null });
      continue;
    }
    const [version] = await tx
      .select({
        kind: schema.catalogItemVersions.kind,
        status: schema.catalogItemVersions.status,
        unitPrice: schema.catalogItemVersions.unitPrice,
      })
      .from(schema.catalogItemVersions)
      .where(eq(schema.catalogItemVersions.id, line.catalogVersionId))
      .for("share");
    if (!version || version.kind !== line.kind || version.status !== "published") {
      throw new BadRequestException({ code: "offer_catalog_version_invalid" });
    }
    const priceOverrideReason = line.priceOverrideReason?.trim() || null;
    if (line.agreedUnitPrice !== version.unitPrice && !priceOverrideReason) {
      throw new BadRequestException({ code: "offer_price_override_reason_required" });
    }
    validatedLines.push({
      line,
      catalogUnitPrice: version.unitPrice,
      priceOverrideReason: line.agreedUnitPrice === version.unitPrice ? null : priceOverrideReason,
    });
  }
  const [offer] = await tx
    .insert(schema.commercialOffers)
    .values({
      tenantId: input.tenantId,
      sellerBankAccountId: input.sellerBankAccountId ?? null,
      revision: 1,
      status: "draft",
      total: total.total,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      termsMarkdown,
      createdByPlatformUserId: actorUserId,
    })
    .returning({ id: schema.commercialOffers.id });
  if (!offer) throw new Error("offer insert failed");
  await tx.insert(schema.commercialOfferLines).values(
    validatedLines.map(({ line, catalogUnitPrice, priceOverrideReason }, index) => ({
      tenantId: input.tenantId,
      offerId: offer.id,
      position: index + 1,
      kind: line.kind,
      catalogVersionId: line.catalogVersionId ?? null,
      nameRu: line.nameRu,
      nameEn: line.nameEn,
      descriptionRu: line.descriptionRu ?? null,
      descriptionEn: line.descriptionEn ?? null,
      quantity: line.quantity,
      unit: line.unit,
      catalogUnitPrice,
      agreedUnitPrice: line.agreedUnitPrice,
      vatRate:
        line.vatRateBps === null || line.vatRateBps === undefined
          ? null
          : String(line.vatRateBps / 100),
      vatIncluded: line.vatIncluded,
      priceOverrideReason,
      activationPolicy: line.kind === "plan" ? (line.activationPolicy ?? "immediately") : null,
      lineTotal: (Number(line.agreedUnitPrice) * line.quantity).toFixed(2),
    })),
  );
  return offer.id;
}
