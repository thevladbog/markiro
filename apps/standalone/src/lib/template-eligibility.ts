import {
  isBoxLabelTemplateEligible,
  isPalletLabelTemplateEligible,
  type LabelTemplatePurpose,
} from "@markiro/domain";

// Which template may stand in a slot (stage 1 spec §4.3): the host's
// `templates::fits`, written for the webview. The cases both must answer
// alike are in `proto/fixtures/template-eligibility.json`, which
// `host/tests/templates.rs` and `test/template-eligibility.test.ts` both read.

/** What decides whether a template fits a slot (the host's `templates::Scope`). */
export interface TemplateScope {
  purpose: LabelTemplatePurpose;
  enabled: boolean;
  /** `null` for every category, otherwise the ЧЗ product-group codes. */
  chzProductGroupCodes: readonly number[] | null;
}

/**
 * A slot a template may stand in: a purpose and a category. Category `null`
 * is the organization's slot, and the slot of a product without a group: only
 * a template for every category fits it.
 */
export interface TemplateSlot {
  purpose: LabelTemplatePurpose;
  chzProductGroupCode: number | null;
}

/**
 * Whether `template` fits `slot`: enabled, of the slot's purpose, and covering
 * its category. A box or a pallet slot asks `@markiro/domain`
 * (`isBoxLabelTemplateEligible`, `isPalletLabelTemplateEligible`). The domain
 * has no rule for a product duplicate, which the cloud never defaults, so the
 * duplicate slot is the same rule written out here.
 */
export function templateFitsSlot(template: TemplateScope, slot: TemplateSlot): boolean {
  switch (slot.purpose) {
    case "box":
      return isBoxLabelTemplateEligible(template, slot.chzProductGroupCode);
    case "pallet":
      return isPalletLabelTemplateEligible(template, slot.chzProductGroupCode);
    case "product_duplicate":
      return (
        template.enabled &&
        template.purpose === "product_duplicate" &&
        (template.chzProductGroupCodes === null ||
          (slot.chzProductGroupCode !== null &&
            template.chzProductGroupCodes.includes(slot.chzProductGroupCode)))
      );
  }
}
