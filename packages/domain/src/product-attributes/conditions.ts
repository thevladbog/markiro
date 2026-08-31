import type {
  AttributeCondition,
  CategoryAttributeDefinition,
  ProductAttributeValue,
  ProductAttributeValues,
} from "./model.js";

type RegulatoryLayer = "code_ordering" | "circulation";

export function conditionMatches(
  condition: AttributeCondition,
  actual: ProductAttributeValue | undefined,
): boolean {
  if (!actual) return false;

  if (condition.operator === "includes") {
    return (
      typeof condition.value === "string" &&
      Array.isArray(actual.value) &&
      actual.value.includes(condition.value)
    );
  }

  return !Array.isArray(actual.value) && actual.value === condition.value;
}

export function isAttributeRequired(
  definition: CategoryAttributeDefinition,
  values: ProductAttributeValues,
  layer: RegulatoryLayer,
): boolean {
  if (definition.requiredLayers.includes(layer)) return true;
  if (layer === "code_ordering") return false;
  return definition.requiredWhen.some((condition) =>
    conditionMatches(condition, values[condition.attributeId]),
  );
}
