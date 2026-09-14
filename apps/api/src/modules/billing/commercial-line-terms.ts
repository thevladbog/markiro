import { BadRequestException, ConflictException } from "@nestjs/common";
import { isCommercialTaxAllowed } from "@markiro/domain";
import {
  commercialLineTermsV4Schema,
  isCommercialPlanSequenceValid,
  monthlyServiceTermsSchema,
  type CommercialLineTermsV4,
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
): CommercialLineTermsV4 | null {
  if (line.kind === "plan" && line.quantity !== 1)
    throw new BadRequestException({ code: "commercial_plan_quantity_invalid" });
  if (version?.billingMode === "recurring" && line.kind === "service" && line.quantity !== 1)
    throw new BadRequestException({ code: "commercial_service_quantity_invalid" });
  const supplied =
    line.commercialTerms == null ? null : commercialLineTermsV4Schema.parse(line.commercialTerms);
  if (!version) return supplied;
  if (!version.documentNameRu || !version.subject || !version.sellerPolicyRevision) return null;
  const license = line.kind === "plan" || line.kind === "addon";
  const resolved = commercialLineTermsV4Schema.parse(
    version.billingMode === "recurring" && line.kind === "service"
      ? {
          version: 2,
          subject: version.subject,
          documentNameRu: version.documentNameRu,
          documentNameEn: version.documentNameEn,
          sellerPolicyRevision: version.sellerPolicyRevision,
          billingPeriod: "month",
          billingTimezone: "Europe/Moscow",
          activationRule: "after_current",
          serviceTerms: monthlyServiceTermsSchema.parse(version.serviceTerms),
        }
      : {
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
        },
  );
  if (supplied && JSON.stringify(supplied) !== JSON.stringify(resolved)) {
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
    const parsed = commercialLineTermsV4Schema.safeParse(line.commercialTerms);
    if (!parsed.success) throw new ConflictException({ code: "commercial_terms_review_required" });
    if (parsed.data.sellerPolicyRevision !== seller.revision)
      throw new ConflictException({ code: "commercial_review_stale" });
    const license = line.kind === "plan" || line.kind === "addon";
    if (
      license !== (parsed.data.subject === "software_license") ||
      (line.kind === "plan" && line.quantity !== 1) ||
      (parsed.data.version === 2 && (line.kind !== "service" || line.quantity !== 1))
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

export function readStoredCommercialTerms(value: unknown): CommercialLineTermsV4 | null {
  return value == null ? null : commercialLineTermsV4Schema.parse(value);
}

export function commercialTermDescription(
  value: unknown,
  legacyDescription: string | null | undefined,
): string | null {
  const terms = readStoredCommercialTerms(value);
  if (terms?.version === 2) {
    const details = [
      `Абонентское сопровождение: ${terms.serviceTerms.includedMinutes} минут в месяц.`,
      `Состав: ${terms.serviceTerms.scopeRu}`,
      terms.serviceTerms.operatingHoursRu
        ? `Часы работы: ${terms.serviceTerms.operatingHoursRu}`
        : null,
      terms.serviceTerms.schedulingTermsRu
        ? `Порядок планирования: ${terms.serviceTerms.schedulingTermsRu}`
        : null,
      "Неиспользованные минуты не переносятся. Работы сверх лимита выполняются после отдельного согласования.",
    ].filter((item): item is string => item !== null);
    return [legacyDescription, ...details].filter(Boolean).join("\n");
  }
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
