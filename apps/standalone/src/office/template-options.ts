import type { TFunction } from "i18next";

import type { LabelTemplateSummary, TemplatePurpose } from "../host/protocol.js";
import { templateFitsSlot } from "../lib/template-eligibility.js";
import { byNameThenId } from "./records.js";

export interface TemplateOption {
  value: string;
  label: string;
}

/**
 * The choices of a template for one slot: none (`""`), then every template
 * that fits the slot for the category (`templateFitsSlot`: enabled, of the
 * slot's purpose, covering the category; `null` is a product without a group
 * and the organization's slot), by name, then by id, as «Шаблоны» lists them
 * (`byNameThenId`). Each id in `kept` that does not fit stays a choice of its
 * own, marked: the loaded choice, which a template disabled or narrowed since,
 * or a category changed in the form, does not take away, and the form's
 * current choice. `templates` is `undefined` while the list is not loaded.
 */
export function templateOptions(
  templates: readonly LabelTemplateSummary[] | undefined,
  purpose: TemplatePurpose,
  group: number | null,
  kept: readonly string[],
  t: TFunction,
): TemplateOption[] {
  const fitting = (templates ?? [])
    .filter((template) => templateFitsSlot(template, { purpose, chzProductGroupCode: group }))
    .sort(byNameThenId);
  const options: TemplateOption[] = [
    { value: "", label: t("office.templateChoice.none") },
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
          ? t("office.templateChoice.unfit", { name: template.name })
          : templates === undefined
            ? t("office.templateChoice.id", { id: short })
            : t("office.templateChoice.missing", { id: short }),
    });
  }
  return options;
}
