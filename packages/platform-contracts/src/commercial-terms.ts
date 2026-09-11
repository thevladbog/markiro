import {
  resolveCommercialPeriod,
  type CommercialPeriod,
  type SellerTaxPolicy,
} from "@markiro/domain";
import { z } from "zod";

export const COMMERCIAL_VERSION_HEADER = "X-Markiro-Commercial-Version";
export const COMMERCIAL_VERSION = "2";
export const commercialVersionSchema = z.literal(COMMERCIAL_VERSION);
export const resourceQuotaSchema = z.number().int().min(0).max(2_147_483_647).nullable();
export const commercialSubjectSchema = z.enum(["software_license", "service", "development_work"]);
export const commercialDocumentNameSchema = z.string().trim().min(1).max(300);
export const sellerPolicyRevisionSchema = z.number().int().positive().max(2_147_483_647);
const vatRateBpsSchema = z.number().int().min(0).max(10_000);

export const sellerTaxPolicySchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("without_vat"), regime: z.enum(["npd", "other"]) }).strict(),
    z
      .object({
        kind: z.literal("vat"),
        regime: z.literal("other"),
        allowedRatesBps: z.array(vatRateBpsSchema).min(1),
        defaultRateBps: vatRateBpsSchema,
        defaultIncluded: z.boolean(),
      })
      .strict(),
  ])
  .superRefine((policy, ctx) => {
    if (
      policy.kind === "vat" &&
      (new Set(policy.allowedRatesBps).size !== policy.allowedRatesBps.length ||
        !policy.allowedRatesBps.includes(policy.defaultRateBps))
    )
      ctx.addIssue({ code: "custom", message: "VAT rates must be unique and contain the default" });
  }) satisfies z.ZodType<SellerTaxPolicy>;

export const commercialPeriodSchema = z
  .object({
    billingPeriod: z.enum(["month", "year"]),
    billingTimezone: z.literal("Europe/Moscow"),
    calendarPolicyVersion: z.literal(1),
    anchorAt: z.iso.datetime({ offset: true }),
    cycle: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((period, ctx) => {
    try {
      const expected = resolveCommercialPeriod(period);
      if (
        Date.parse(period.startsAt) !== Date.parse(expected.startsAt) ||
        Date.parse(period.endsAt) !== Date.parse(expected.endsAt)
      )
        ctx.addIssue({
          code: "custom",
          message: "Commercial boundaries must match the original calendar anchor",
        });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid commercial calendar period" });
    }
  }) satisfies z.ZodType<CommercialPeriod>;

export const commercialLineTermsSchema = z
  .object({
    version: z.literal(1),
    subject: commercialSubjectSchema,
    documentNameRu: commercialDocumentNameSchema,
    documentNameEn: commercialDocumentNameSchema.nullable(),
    sellerPolicyRevision: sellerPolicyRevisionSchema,
    billingPeriod: z.enum(["month", "year"]).nullable(),
    billingTimezone: z.literal("Europe/Moscow").nullable(),
    activationRule: z.enum(["on_application", "after_current"]).nullable(),
  })
  .strict()
  .superRefine((terms, ctx) => {
    const license = terms.subject === "software_license";
    if (
      license
        ? terms.billingPeriod === null ||
          terms.billingTimezone === null ||
          terms.activationRule === null
        : terms.billingPeriod !== null ||
          terms.billingTimezone !== null ||
          terms.activationRule !== null
    )
      ctx.addIssue({ code: "custom", message: "Subject and commercial period must agree" });
  });

export const catalogCommercialMetadataShape = {
  documentNameRu: commercialDocumentNameSchema.nullable(),
  documentNameEn: commercialDocumentNameSchema.nullable(),
  subject: commercialSubjectSchema.nullable(),
  sellerPolicyRevision: sellerPolicyRevisionSchema.nullable(),
};
export function validateCommercialLineKind(
  line: {
    kind: string;
    quantity: number;
    commercialTerms?: z.output<typeof commercialLineTermsSchema> | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (line.commercialTerms == null) return;
  const license = line.kind === "plan" || line.kind === "addon";
  if (license !== (line.commercialTerms.subject === "software_license"))
    ctx.addIssue({
      code: "custom",
      path: ["commercialTerms", "subject"],
      message: "Subject does not match line kind",
    });
  if (line.kind === "plan" && line.quantity !== 1)
    ctx.addIssue({
      code: "custom",
      path: ["quantity"],
      message: "A plan line quantity must be one",
    });
}
export type CommercialLineTerms = z.output<typeof commercialLineTermsSchema>;
export type { CommercialPeriod, SellerTaxPolicy } from "@markiro/domain";

/** Document order is sale intent; response schemas deliberately do not enforce this new-sale rule. */
export function isCommercialPlanSequenceValid(
  lines: readonly {
    kind: string;
    activationPolicy?: string | null | undefined;
    commercialTerms?: unknown;
  }[],
): boolean {
  const plans = lines.filter((line) => line.kind === "plan");
  if (plans.length <= 1) return true;
  const rule = (line: (typeof plans)[number] | undefined) => {
    if (!line) return null;
    const terms = commercialLineTermsSchema.safeParse(line.commercialTerms);
    if (terms.success) return terms.data.activationRule;
    if (line.activationPolicy === "after_current") return "after_current";
    if (line.activationPolicy === "manual") return null;
    return "on_application";
  };
  return (
    plans.length === 2 && rule(plans[0]) === "on_application" && rule(plans[1]) === "after_current"
  );
}
