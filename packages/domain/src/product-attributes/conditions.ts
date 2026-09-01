import type {
  AttributeCondition,
  AttributeRequirementRule,
  CategoryAttributeDefinition,
  ProductAttributeValue,
  ProductAttributeValues,
  RegulatoryLayer,
  RequirementLevel,
} from "./model.js";

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
  return activeRequirementRules(definition, values, layer, "mandatory").length > 0;
}

export function activeRequirementRules(
  definition: CategoryAttributeDefinition,
  values: ProductAttributeValues,
  layer: RegulatoryLayer,
  level: RequirementLevel,
): AttributeRequirementRule[] {
  return definition.requirementRules.filter(
    (rule) =>
      rule.layer === layer &&
      rule.level === level &&
      (rule.when === null || conditionMatches(rule.when, values[rule.when.attributeId])),
  );
}
