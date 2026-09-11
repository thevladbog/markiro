import type { LabelField, LabelTemplateSpec } from "./model.js";
import type { LabelTemplatePurpose } from "../product-labels/contracts.js";

/** The selection metadata a template carries besides its print spec. */
export interface BoxLabelTemplateEligibility {
  /** Absent on legacy bundles, which only carried box templates. */
  purpose?: LabelTemplatePurpose;
  enabled: boolean;
  /** `null` means every category; otherwise the ЧЗ product-group codes it applies to. */
  chzProductGroupCodes: readonly number[] | null;
}

/**
 * Whether a template may be offered for a product of the given ЧЗ product
 * group. A product without a group (`null`) can only use universal
 * templates: a scoped template never matches an unknown category.
 */
export function isBoxLabelTemplateEligible(
  template: BoxLabelTemplateEligibility,
  chzProductGroupCode: number | null,
): boolean {
  if (!template.enabled || (template.purpose !== undefined && template.purpose !== "box"))
    return false;
  if (template.chzProductGroupCodes === null) return true;
  return (
    chzProductGroupCode !== null && template.chzProductGroupCodes.includes(chzProductGroupCode)
  );
}

/**
 * Same enabled + category-scope rule as `isBoxLabelTemplateEligible`, gated
 * on `purpose === "pallet"` instead of `"box"` (slice 06d's pallet labels).
 */
export function isPalletLabelTemplateEligible(
  template: BoxLabelTemplateEligibility,
  chzProductGroupCode: number | null,
): boolean {
  if (!template.enabled || (template.purpose !== undefined && template.purpose !== "pallet"))
    return false;
  if (template.chzProductGroupCodes === null) return true;
  return (
    chzProductGroupCode !== null && template.chzProductGroupCodes.includes(chzProductGroupCode)
  );
}

export type BoxLabelTemplateDefaultSource = "category" | "organization";

export interface BoxLabelTemplateDefault {
  templateId: string | null;
  source: BoxLabelTemplateDefaultSource | null;
}

/** Category default → organisation default → none. */
export function resolveBoxLabelTemplateDefault(input: {
  categoryDefaultId: string | null;
  organizationDefaultId: string | null;
}): BoxLabelTemplateDefault {
  if (input.categoryDefaultId !== null) {
    return { templateId: input.categoryDefaultId, source: "category" };
  }
  if (input.organizationDefaultId !== null) {
    return { templateId: input.organizationDefaultId, source: "organization" };
  }
  return { templateId: null, source: null };
}

/** True when any field element or field-bound barcode in the spec reads `field`. */
export function labelTemplateUsesField(spec: LabelTemplateSpec, field: LabelField): boolean {
  return spec.elements.some((element) => {
    if (element.kind === "field") return element.field === field;
    if (element.kind === "barcode") return element.data === field;
    return false;
  });
}
