import type { TFunction } from "i18next";

import type { LabelTemplateSummary } from "../../host/protocol.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";

/** Template names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

export interface TemplateOption {
  value: string;
  label: string;
}

/**
 * The choices of a product's default template for one slot: none (`""`), then
 * every template that fits the slot for the form's group (`templateFitsSlot`:
 * enabled, of the slot's purpose, covering the group), by name. Each id in
 * `kept` that does not fit stays a choice of its own, marked: the product's
 * own preference, which a template disabled or narrowed since, or a group
 * changed in the form, does not take away, and the form's current choice.
 * `templates` is `undefined` while the list is not loaded.
 */
export function templateOptions(
  templates: readonly LabelTemplateSummary[] | undefined,
  purpose: "box" | "pallet",
  group: number | null,
  kept: readonly string[],
  t: TFunction,
): TemplateOption[] {
  const fitting = (templates ?? [])
    .filter((template) => templateFitsSlot(template, { purpose, chzProductGroupCode: group }))
    .sort((a, b) => NAMES.compare(a.name, b.name));
  const options: TemplateOption[] = [
    { value: "", label: t("office.products.noTemplate") },
    ...fitting.map((template) => ({ value: template.id, label: template.name })),
  ];
  for (const id of kept) {
    if (id === "" || options.some((option) => option.value === id)) continue;
    const template = templates?.find((each) => each.id === id);
    const short = id.slice(0, 8);
    options.push({
      value: id,
      label:
        template !== undefined
          ? t("office.products.templateUnfit", { name: template.name })
          : templates === undefined
            ? t("office.products.templateId", { id: short })
            : t("office.products.templateMissing", { id: short }),
    });
  }
  return options;
}
