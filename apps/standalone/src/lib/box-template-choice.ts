import { templateFitsSlot, type TemplateScope } from "./template-eligibility.js";

/** What the choice reads of a product: its group and its box template preference. */
export interface BoxTemplateProduct {
  chzProductGroupCode: number | null;
  defaultBoxTemplateId: string | null;
}

/** A template the choice may pick: its id and what decides whether it fits. */
export interface BoxTemplateCandidate extends TemplateScope {
  id: string;
}

/** The defaults the choice falls back on: the organization's box default and the categories'. */
export interface BoxTemplateDefaults {
  defaultBoxTemplateId: string | null;
  categories: readonly { chzProductGroupCode: number; purpose: string; templateId: string }[];
}

/**
 * The box template a new shift of `product` starts with (stage 1 rule,
 * `apps/standalone/AGENTS.md` «Catalog and label templates»; stage 2a spec,
 * decision 7): the product's preference, then its category's box default,
 * then the organization's, the first that fits the product's group
 * (`templateFitsSlot`: enabled, of the box purpose, covering the group) and
 * is in `templates`. `null` when none does: the person chooses. `defaults`
 * is `null` while the defaults are not read; then only the preference counts.
 * The station's new shift (plan 2a5) takes the same rule.
 */
export function suggestBoxTemplate(
  product: BoxTemplateProduct,
  templates: readonly BoxTemplateCandidate[],
  defaults: BoxTemplateDefaults | null,
): string | null {
  const group = product.chzProductGroupCode;
  const categoryDefault =
    group === null
      ? undefined
      : defaults?.categories.find(
          (entry) => entry.purpose === "box" && entry.chzProductGroupCode === group,
        )?.templateId;
  const candidates = [
    product.defaultBoxTemplateId,
    categoryDefault ?? null,
    defaults?.defaultBoxTemplateId ?? null,
  ];
  for (const id of candidates) {
    if (id === null) continue;
    const template = templates.find((each) => each.id === id);
    if (
      template !== undefined &&
      templateFitsSlot(template, { purpose: "box", chzProductGroupCode: group })
    ) {
      return id;
    }
  }
  return null;
}
