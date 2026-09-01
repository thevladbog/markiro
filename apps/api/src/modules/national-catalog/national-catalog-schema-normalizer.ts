import { createHash } from "node:crypto";

import {
  categorySchemaDefinitionSchema,
  type CategoryAttributeDefinition,
  type CategorySchemaDefinition,
  type RequirementLevel,
} from "@markiro/domain";

import type {
  NationalCatalogAttributeDefinition,
  NationalCatalogCategory,
} from "./national-catalog.types";

export type NationalCatalogSchemaBlockCode =
  | "duplicate_attribute_id"
  | "unsupported_dependency"
  | "unsupported_requirement_type"
  | "unsupported_unique_multiplicity"
  | "unsupported_value_type"
  | "invalid_preset_contract";

export interface NationalCatalogSchemaBlockReason {
  code: NationalCatalogSchemaBlockCode;
  attributeId: string;
}

export type NationalCatalogSchemaNormalization =
  | {
      status: "valid";
      definition: CategorySchemaDefinition;
      contentHash: string;
    }
  | {
      status: "blocked";
      reasons: NationalCatalogSchemaBlockReason[];
    };

export function normalizeNationalCatalogSchema(
  category: NationalCatalogCategory,
  sourceAttributes: readonly NationalCatalogAttributeDefinition[],
): NationalCatalogSchemaNormalization {
  const reasons: NationalCatalogSchemaBlockReason[] = [];
  const seenIds = new Set<number>();
  const attributes: CategoryAttributeDefinition[] = [];

  for (const source of [...sourceAttributes].sort((left, right) => left.id - right.id)) {
    const attributeId = String(source.id);
    if (seenIds.has(source.id)) {
      reasons.push({ code: "duplicate_attribute_id", attributeId });
      continue;
    }
    seenIds.add(source.id);

    // `b` means the provider has contextually blocked the attribute and it is
    // unavailable for filling. It is evidence in the raw observation, but it
    // must not become an editable Markiro field or block the usable siblings.
    if (source.type === "b") continue;

    const blocked = blockReason(source);
    if (blocked) {
      reasons.push({ code: blocked, attributeId });
      continue;
    }

    const valueType = normalizedValueType(source);
    const level = requirementLevel(source.type);
    if (!valueType || !level) continue;
    const presets = [...new Set(source.preset)]
      .sort((left, right) => left.localeCompare(right, "ru"))
      .map((value) => ({ value, label: value }));
    attributes.push({
      id: attributeId,
      label: source.name,
      valueType,
      multiplicity: source.multiplicity ? "many" : "one",
      unit: normalizedUnit(source),
      requirementRules: [
        ...(source.firstLayer ? [{ layer: "code_ordering" as const, level, when: null }] : []),
        ...(source.secondLayer ? [{ layer: "circulation" as const, level, when: null }] : []),
      ],
      presetMode: presets.length === 0 ? "none" : source.presetOnly ? "restricted" : "suggested",
      presets,
    });
  }

  appendConditionalRequirements(sourceAttributes, attributes, reasons);

  if (reasons.length > 0) {
    return {
      status: "blocked",
      reasons: reasons.sort(
        (left, right) =>
          Number(left.attributeId) - Number(right.attributeId) ||
          left.code.localeCompare(right.code),
      ),
    };
  }

  const definition = categorySchemaDefinitionSchema.parse({
    formatVersion: 2,
    categoryId: String(category.id),
    scopeKey: `national-catalog:category:${category.id}`,
    attributes,
  });
  return {
    status: "valid",
    definition,
    contentHash: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
  };
}

function normalizedUnit(
  attribute: NationalCatalogAttributeDefinition,
): CategoryAttributeDefinition["unit"] {
  if (attribute.fieldType !== "number" || attribute.valueTypes.length === 0) return null;
  const allowed = [...new Set(attribute.valueTypes)].sort((left, right) =>
    left.localeCompare(right, "ru"),
  );
  return { canonical: allowed[0]!, allowed };
}

function blockReason(
  attribute: NationalCatalogAttributeDefinition,
): NationalCatalogSchemaBlockCode | null {
  if (attribute.multiplicityType === "unique") return "unsupported_unique_multiplicity";
  if (requirementLevel(attribute.type) === null) return "unsupported_requirement_type";
  if (attribute.presetOnly && attribute.preset.length === 0) return "invalid_preset_contract";
  if (normalizedValueType(attribute) === null) return "unsupported_value_type";
  return null;
}

function appendConditionalRequirements(
  sourceAttributes: readonly NationalCatalogAttributeDefinition[],
  attributes: CategoryAttributeDefinition[],
  reasons: NationalCatalogSchemaBlockReason[],
): void {
  const targets = new Map(attributes.map((attribute) => [attribute.id, attribute]));
  const sources = new Map(sourceAttributes.map((attribute) => [String(attribute.id), attribute]));
  const rulesByTarget = new Map(
    attributes.map((attribute) => [
      attribute.id,
      new Set(attribute.requirementRules.map((rule) => JSON.stringify(rule))),
    ]),
  );

  for (const trigger of sourceAttributes) {
    if (trigger.dependentAttributes.length === 0) continue;
    const triggerId = String(trigger.id);
    const triggerType = normalizedValueType(trigger);
    const operator =
      triggerType === "string_list" || triggerType === "enum_list"
        ? ("includes" as const)
        : triggerType === "string" || triggerType === "enum" || triggerType === "date"
          ? ("equals" as const)
          : null;
    let invalid = operator === null || !targets.has(triggerId);
    for (const dependency of trigger.dependentAttributes) {
      if (dependency.value === null || dependency.attributes.length === 0) {
        invalid = true;
        continue;
      }
      for (const candidate of dependency.attributes) {
        const targetId = candidate.id === null ? null : String(candidate.id);
        const target = targetId === null ? undefined : targets.get(targetId);
        const level = requirementLevel(candidate.type);
        if (!target || !level || (!candidate.firstLayer && !candidate.secondLayer) || !operator) {
          invalid = true;
          continue;
        }
        for (const layer of [
          ...(candidate.firstLayer ? (["code_ordering"] as const) : []),
          ...(candidate.secondLayer ? (["circulation"] as const) : []),
        ]) {
          const rule = {
            layer,
            level,
            when: { attributeId: triggerId, operator, value: dependency.value },
          };
          const key = JSON.stringify(rule);
          const existing = rulesByTarget.get(target.id)!;
          if (!existing.has(key)) {
            target.requirementRules.push(rule);
            existing.add(key);
          }
        }
      }
    }
    if (invalid || !sources.has(triggerId)) {
      reasons.push({ code: "unsupported_dependency", attributeId: triggerId });
    }
  }
}

function requirementLevel(type: string | null): RequirementLevel | null {
  if (type === "m") return "mandatory";
  if (type === "r") return "recommended";
  if (type === "o") return "optional";
  return null;
}

function normalizedValueType(
  attribute: NationalCatalogAttributeDefinition,
): CategoryAttributeDefinition["valueType"] | null {
  if (attribute.fieldType === "date") return attribute.multiplicity ? null : "date";
  if (attribute.fieldType === "number") return attribute.multiplicity ? null : "decimal";
  if (attribute.fieldType !== "text") return null;
  if (attribute.preset.length > 0) return attribute.multiplicity ? "enum_list" : "enum";
  return attribute.multiplicity ? "string_list" : "string";
}
