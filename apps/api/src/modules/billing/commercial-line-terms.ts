import { BadRequestException, ConflictException } from "@nestjs/common";
import { isCommercialTaxAllowed } from "@markiro/domain";
import {
  commercialLineTermsSchema,
  isCommercialPlanSequenceValid,
  type CommercialLineTerms,
} from "@markiro/platform-contracts";
import type { schema } from "@markiro/db";
import {
  readSellerPolicy,
  type SellerPolicyTransaction,
} from "../billing-profiles/billing-profiles.service";

type Version = typeof schema.catalogItemVersions.$inferSelect;
type Line = {
  kind: string;
  quantity: number;
  activationPolicy?: string | null | undefined;
  commercialTerms?: unknown;
};

/** Null means legacy/unreviewed. Never reconstruct authoritative intent from a unit label. */
export function freezeCommercialLineTerms(
  version: Version | undefined,
  line: Line,
): CommercialLineTerms | null {
  if (line.kind === "plan" && line.quantity !== 1)
    throw new BadRequestException({ code: "commercial_plan_quantity_invalid" });
  const supplied =
    line.commercialTerms == null ? null : commercialLineTermsSchema.parse(line.commercialTerms);
  if (!version) return supplied;
  if (!version.documentNameRu || !version.subject || !version.sellerPolicyRevision) return null;
  const license = line.kind === "plan" || line.kind === "addon";
  const resolved = commercialLineTermsSchema.parse({
    version: 1,
    subject: version.subject,
    documentNameRu: version.documentNameRu,
    documentNameEn: version.documentNameEn,
    sellerPolicyRevision: version.sellerPolicyRevision,
    billingPeriod: license ? version.billingPeriod : null,
    billingTimezone: license ? "Europe/Moscow" : null,
    activationRule: license
      ? line.activationPolicy === "after_current"
        ? "after_current"
        : line.activationPolicy === "manual" ||
            (line.kind === "addon" && line.activationPolicy == null)
          ? (supplied?.activationRule ?? "on_application")
          : "on_application"
      : null,
  });
  if (
    supplied &&
    Object.keys(resolved).some(
      (key) =>
        supplied[key as keyof CommercialLineTerms] !== resolved[key as keyof CommercialLineTerms],
    )
  ) {
    throw new ConflictException({ code: "commercial_review_stale" });
  }
  return resolved;
}

/** Caller holds seller advisory lock before all workflow/profile row locks. */
export async function validateCommercialIssuance(
  tx: SellerPolicyTransaction,
  lines: readonly {
    kind: string;
    quantity: number;
    commercialTerms: unknown;
    vatRate: string | null;
    vatIncluded: boolean;
  }[],
): Promise<void> {
  assertCommercialPlanSequence(lines, true);
  const seller = await readSellerPolicy(tx);
  if (!seller.taxPolicy) throw new ConflictException({ code: "seller_tax_policy_unconfigured" });
  for (const line of lines) {
    const parsed = commercialLineTermsSchema.safeParse(line.commercialTerms);
    if (!parsed.success) throw new ConflictException({ code: "commercial_terms_review_required" });
    if (parsed.data.sellerPolicyRevision !== seller.revision)
      throw new ConflictException({ code: "commercial_review_stale" });
    const license = line.kind === "plan" || line.kind === "addon";
    if (
      license !== (parsed.data.subject === "software_license") ||
      (line.kind === "plan" && line.quantity !== 1)
    ) {
      throw new BadRequestException({ code: "commercial_line_terms_invalid" });
    }
    if (
      !isCommercialTaxAllowed(seller.taxPolicy, {
        vatRateBps: line.vatRate === null ? null : Math.round(Number(line.vatRate) * 100),
        vatIncluded: line.vatIncluded,
      })
    ) {
      throw new ConflictException({ code: "seller_tax_policy_violation" });
    }
  }
}

export function readStoredCommercialTerms(value: unknown): CommercialLineTerms | null {
  return value == null ? null : commercialLineTermsSchema.parse(value);
}

export function commercialTermDescription(
  value: unknown,
  legacyDescription: string | null | undefined,
): string | null {
  const terms = readStoredCommercialTerms(value);
  if (!terms || terms.subject !== "software_license") return legacyDescription ?? null;
  const rule =
    terms.activationRule === "after_current"
      ? "после окончания текущего срока"
      : "с момента применения оплаты";
  const term = `Срок права использования: ${terms.billingPeriod === "year" ? "1 год" : "1 месяц"}, ${rule}.`;
  return legacyDescription ? `${legacyDescription}\n${term}` : term;
}

export function assertCommercialPlanSequence(
  lines: Parameters<typeof isCommercialPlanSequenceValid>[0],
  review = false,
): void {
  if (!isCommercialPlanSequenceValid(lines)) {
    if (review) throw new ConflictException({ code: "commercial_plan_sequence_review_required" });
    throw new BadRequestException({ code: "commercial_plan_sequence_invalid" });
  }
}
