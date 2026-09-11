import type { TFunction } from "i18next";
import {
  conditionMatches,
  type CategoryAttributeDefinition,
  type ProductAttributeValue,
  type ProductAttributeValues,
} from "@markiro/domain";
export function attributeVisible(
  definition: CategoryAttributeDefinition,
  values: ProductAttributeValues,
) {
  return (
    definition.requirementRules.length === 0 ||
    definition.requirementRules.some(
      (rule) => rule.when === null || conditionMatches(rule.when, values[rule.when.attributeId]),
    )
  );
}
export function valueText(value: ProductAttributeValue | null | undefined, t: TFunction): string {
  if (!value) return "—";
  if (value.type === "boolean")
    return t("pages.catalog.regulatory." + (value.value ? "yes" : "no"));
  if (value.type === "decimal") return [value.value, value.unit].filter(Boolean).join(" ");
  if (Array.isArray(value.value)) return value.value.join(", ");
  return String(value.value);
}
