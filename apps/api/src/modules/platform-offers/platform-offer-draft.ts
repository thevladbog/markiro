import { assertCatalogCommercialCompatibility } from "../../platform-http/commercial-catalog-compatibility";
import type { CommercialVersion } from "../../platform-http/commercial-version";
import { BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  freezeCommercialLineTerms,
  assertCommercialPlanSequence,
} from "../billing/commercial-line-terms";
import type { CommercialLineTerms } from "@markiro/platform-contracts";
import type { CreateOfferDto } from "./dto";
import { calculateOfferAmounts } from "./offer-totals";
import { normalizeOfferTerms } from "./offer-terms";

type OfferDraftExecutor = Pick<Db, "insert" | "select">;

export async function prepareOfferDraft(
  tx: Pick<Db, "select">,
  input: CreateOfferDto,
  commercialVersion: CommercialVersion = 2,
) {
  assertCommercialPlanSequence(input.lines);
  let termsMarkdown: string | null;
  try {
    termsMarkdown = normalizeOfferTerms(input.termsMarkdown).markdown;
  } catch (error) {
    if (error instanceof Error && error.message === "offer_terms_too_long") {
      throw new BadRequestException({ code: error.message });
    }
    throw error;
  }
  const total = calculateOfferAmounts(
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
    commercialTerms: CommercialLineTerms | null;
    priceOverrideReason: string | null;
  }> = [];
  for (const line of input.lines) {
    if (!line.catalogVersionId) {
      if (line.kind !== "service") {
        throw new BadRequestException({ code: "offer_catalog_version_invalid" });
      }
      validatedLines.push({
        line,
        catalogUnitPrice: null,
        priceOverrideReason: null,
        commercialTerms: freezeCommercialLineTerms(undefined, line),
      });
      continue;
    }
    const [version] = await tx
      .select()
      .from(schema.catalogItemVersions)
      .where(eq(schema.catalogItemVersions.id, line.catalogVersionId))
      .for("share");
    if (!version || version.kind !== line.kind || version.status !== "published") {
      throw new BadRequestException({ code: "offer_catalog_version_invalid" });
    }
    await assertCatalogCommercialCompatibility(tx, version.id, commercialVersion);
    const priceOverrideReason = line.priceOverrideReason?.trim() || null;
    if (line.agreedUnitPrice !== version.unitPrice && !priceOverrideReason) {
      throw new BadRequestException({ code: "offer_price_override_reason_required" });
    }
    validatedLines.push({
      line,
      catalogUnitPrice: version.unitPrice,
      commercialTerms: freezeCommercialLineTerms(version, line),
      priceOverrideReason: line.agreedUnitPrice === version.unitPrice ? null : priceOverrideReason,
    });
  }
  assertCommercialPlanSequence(
    validatedLines.map(({ line, commercialTerms }) => ({ ...line, commercialTerms })),
  );
  const lines = validatedLines.map(
    ({ line, catalogUnitPrice, priceOverrideReason, commercialTerms }, index) => ({
      tenantId: input.tenantId,
      position: index + 1,
      kind: line.kind,
      catalogVersionId: line.catalogVersionId ?? null,
      commercialTerms,
      nameRu: commercialTerms?.documentNameRu ?? line.nameRu,
      nameEn: commercialTerms?.documentNameEn ?? line.nameEn,
      descriptionRu: line.descriptionRu ?? null,
      descriptionEn: line.descriptionEn ?? null,
      quantity: line.quantity,
      unit: commercialTerms?.billingPeriod ?? line.unit,
      catalogUnitPrice,
      agreedUnitPrice: line.agreedUnitPrice,
      vatRate:
        line.vatRateBps === null || line.vatRateBps === undefined
          ? null
          : String(line.vatRateBps / 100),
      vatIncluded: line.vatIncluded,
      priceOverrideReason,
      activationPolicy: line.kind === "plan" ? (line.activationPolicy ?? "immediately") : null,
      lineTotal: total.lines[index]?.lineTotal ?? "0.00",
    }),
  );
  return { termsMarkdown, total: total.total, lines };
}

export async function createOfferDraft(
  tx: OfferDraftExecutor,
  actorUserId: string,
  input: CreateOfferDto,
  commercialVersion: CommercialVersion = 2,
): Promise<string> {
  const prepared = await prepareOfferDraft(tx, input, commercialVersion);
  const [offer] = await tx
    .insert(schema.commercialOffers)
    .values({
      tenantId: input.tenantId,
      sellerBankAccountId: input.sellerBankAccountId ?? null,
      revision: 1,
      status: "draft",
      total: prepared.total,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      termsMarkdown: prepared.termsMarkdown,
      createdByPlatformUserId: actorUserId,
    })
    .returning({ id: schema.commercialOffers.id });
  if (!offer) throw new Error("offer insert failed");
  await tx
    .insert(schema.commercialOfferLines)
    .values(prepared.lines.map((line) => ({ ...line, offerId: offer.id })));
  return offer.id;
}
