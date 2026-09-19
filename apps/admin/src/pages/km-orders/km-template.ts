/**
 * Which label template may print an order's marking codes, and which one is
 * chosen when nobody picked.
 *
 * Two screens ask the same question and must answer it identically:
 * `IssueKmCodesDialog.tsx` fills its template picker from it, and
 * `KmOrderPrintPage.tsx` re-derives a template when the print link carries
 * none -- which is exactly what «Печать ещё раз» does, because an issue
 * record stores no template id. A second, subtly different rule would mean a
 * reprint quietly coming out on different stock from the original print.
 */
import { KM_LABEL_TEMPLATE_NAME } from "@markiro/domain";

import type { ChzProductGroupDto } from "../catalog/api.js";
import type { LabelTemplateSummaryDto } from "../labels/api.js";

/**
 * Whether a label template may print the marking codes of an order in this
 * ЧЗ product group: the KM purpose, and either a universal template
 * (`chzProductGroupCodes === null`) or one scoped to that group. Same
 * category rule as `isBoxLabelTemplateEligible` /
 * `isPalletLabelTemplateEligible` in `@markiro/domain`, which are gated on
 * their own purposes.
 */
export function isKmTemplateEligible(
  template: LabelTemplateSummaryDto,
  chzProductGroupCode: number | null,
): boolean {
  if (template.purpose !== "product_km" || !template.enabled) return false;
  if (template.chzProductGroupCodes === null) return true;
  return (
    chzProductGroupCode !== null && template.chzProductGroupCodes.includes(chzProductGroupCode)
  );
}

/** Every eligible template, in the order the API returned them. */
export function eligibleKmTemplates(
  templates: readonly LabelTemplateSummaryDto[],
  chzProductGroupCode: number | null,
): LabelTemplateSummaryDto[] {
  return templates.filter((template) => isKmTemplateEligible(template, chzProductGroupCode));
}

/**
 * What "the operator has not chosen" resolves to: the stock KM label every
 * tenant is seeded with, and otherwise whatever else is eligible.
 */
export function preferredKmTemplate(
  eligible: readonly LabelTemplateSummaryDto[],
): LabelTemplateSummaryDto | undefined {
  return eligible.find((template) => template.name === KM_LABEL_TEMPLATE_NAME) ?? eligible[0];
}

/**
 * The ЧЗ group code behind an order's `productGroupAlias`. `null` also covers
 * "the reference has not loaded", which drops every group-scoped template --
 * callers that cannot tolerate that must check the reference query itself
 * rather than trusting this answer.
 */
export function kmOrderGroupCode(
  groups: readonly ChzProductGroupDto[] | undefined,
  productGroupAlias: string,
): number | null {
  return groups?.find((group) => group.alias === productGroupAlias)?.code ?? null;
}
