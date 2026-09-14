import type { z } from "zod";

interface CatalogPatchCommercialFields {
  readonly plan?: object | undefined;
  readonly addon?: object | undefined;
  readonly service?: object | undefined;
  readonly subject?: "software_license" | "service" | "development_work" | null | undefined;
  readonly billingMode?: "one_time" | "recurring" | undefined;
  readonly billingPeriod?: "month" | "year" | null | undefined;
}

function isRecurringServicePayload(value: object | undefined): boolean {
  return value !== undefined && "cadence" in value && value.cadence === "month";
}

// Internal shared invariant; each negotiated schema retains its own strict field definitions.
export function validateCatalogPatchCommercialTerms(
  value: CatalogPatchCommercialFields,
  ctx: z.RefinementCtx,
): void {
  const recurringService = isRecurringServicePayload(value.service);
  const recurring =
    value.plan !== undefined ||
    value.addon !== undefined ||
    value.subject === "software_license" ||
    recurringService;
  const service =
    value.service !== undefined ||
    value.subject === "service" ||
    value.subject === "development_work";
  if (
    (recurring && (value.billingMode === "one_time" || value.billingPeriod === null)) ||
    (service &&
      !recurringService &&
      (value.billingMode === "recurring" ||
        (value.billingPeriod !== undefined && value.billingPeriod !== null))) ||
    (recurringService &&
      (value.billingMode === "one_time" ||
        value.billingPeriod === null ||
        value.billingPeriod === "year")) ||
    (value.billingMode === "one_time" && value.billingPeriod != null) ||
    (value.billingMode === "recurring" && value.billingPeriod === null)
  )
    ctx.addIssue({ code: "custom", message: "Kind and billing period must agree" });

  if ((value.plan || value.addon) && value.subject != null && value.subject !== "software_license")
    ctx.addIssue({ code: "custom", path: ["subject"], message: "License subject required" });
  if (value.service && value.subject === "software_license")
    ctx.addIssue({ code: "custom", path: ["subject"], message: "Service subject required" });
}
