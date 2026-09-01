import { z } from "zod";

export const PRODUCT_ATTRIBUTE_SOURCES = ["manual", "1c", "national_catalog", "migration"] as const;
export type ProductAttributeSource = (typeof PRODUCT_ATTRIBUTE_SOURCES)[number];

export const READINESS_DIMENSIONS = [
  "production",
  "code_ordering",
  "circulation",
  "egais",
] as const;
export type ReadinessDimension = (typeof READINESS_DIMENSIONS)[number];

export const READINESS_STATES = ["ready", "not_ready", "not_applicable", "stale"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const REGULATORY_LAYERS = ["code_ordering", "circulation"] as const;
export type RegulatoryLayer = (typeof REGULATORY_LAYERS)[number];

export const REQUIREMENT_LEVELS = ["mandatory", "recommended", "optional"] as const;
export type RequirementLevel = (typeof REQUIREMENT_LEVELS)[number];

const nonEmptyStringSchema = z.string().trim().min(1);

export const productAttributeValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), value: nonEmptyStringSchema }).strict(),
  z
    .object({
      type: z.literal("string_list"),
      value: z.array(nonEmptyStringSchema).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("decimal"),
      value: z.string().regex(/^-?\d+(\.\d+)?$/),
      unit: nonEmptyStringSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("date"),
      value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict(),
  z.object({ type: z.literal("enum"), value: nonEmptyStringSchema }).strict(),
  z
    .object({
      type: z.literal("enum_list"),
      value: z.array(nonEmptyStringSchema).min(1),
    })
    .strict(),
]);

export type ProductAttributeValue = z.infer<typeof productAttributeValueSchema>;
export type ProductAttributeValues = Record<string, ProductAttributeValue>;

export const attributeConditionSchema = z
  .object({
    attributeId: nonEmptyStringSchema,
    operator: z.enum(["equals", "includes"]),
    value: z.union([nonEmptyStringSchema, z.boolean()]),
  })
  .strict();

export type AttributeCondition = z.infer<typeof attributeConditionSchema>;

export const attributeRequirementRuleSchema = z
  .object({
    layer: z.enum(REGULATORY_LAYERS),
    level: z.enum(REQUIREMENT_LEVELS),
    when: attributeConditionSchema.nullable(),
  })
  .strict();

export type AttributeRequirementRule = z.infer<typeof attributeRequirementRuleSchema>;

export const attributeUnitDefinitionSchema = z
  .object({
    canonical: nonEmptyStringSchema,
    allowed: z.array(nonEmptyStringSchema).min(1),
  })
  .strict();

export type AttributeUnitDefinition = z.infer<typeof attributeUnitDefinitionSchema>;

const attributeValueTypeSchema = z.enum([
  "string",
  "string_list",
  "decimal",
  "boolean",
  "date",
  "enum",
  "enum_list",
]);

const attributePresetSchema = z
  .object({ value: nonEmptyStringSchema, label: nonEmptyStringSchema })
  .strict();

export const categoryAttributeDefinitionSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    valueType: attributeValueTypeSchema,
    multiplicity: z.enum(["one", "many"]),
    unit: attributeUnitDefinitionSchema.nullable(),
    requirementRules: z.array(attributeRequirementRuleSchema),
    presetMode: z.enum(["none", "suggested", "restricted"]),
    presets: z.array(attributePresetSchema).default([]),
  })
  .strict();

export type CategoryAttributeDefinition = z.infer<typeof categoryAttributeDefinitionSchema>;

export const categorySchemaDefinitionSchema = z
  .object({
    formatVersion: z.literal(2),
    categoryId: nonEmptyStringSchema,
    scopeKey: nonEmptyStringSchema,
    attributes: z.array(categoryAttributeDefinitionSchema),
  })
  .strict()
  .superRefine(validateDefinition);

export type CategorySchemaDefinition = z.infer<typeof categorySchemaDefinitionSchema>;

const legacyCategoryAttributeDefinitionSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    valueType: attributeValueTypeSchema,
    multiplicity: z.enum(["one", "many"]),
    requiredLayers: z.array(z.enum(REGULATORY_LAYERS)),
    requiredWhen: z.array(attributeConditionSchema),
    presets: z.array(attributePresetSchema).default([]),
  })
  .strict();

const legacyCategorySchemaDefinitionSchema = z
  .object({
    categoryId: nonEmptyStringSchema,
    scopeKey: nonEmptyStringSchema,
    attributes: z.array(legacyCategoryAttributeDefinitionSchema),
  })
  .strict();

export function parseCategorySchemaDefinition(value: unknown): CategorySchemaDefinition {
  const current = categorySchemaDefinitionSchema.safeParse(value);
  if (current.success) return current.data;

  const legacy = legacyCategorySchemaDefinitionSchema.parse(value);
  return categorySchemaDefinitionSchema.parse({
    formatVersion: 2,
    categoryId: legacy.categoryId,
    scopeKey: legacy.scopeKey,
    attributes: legacy.attributes.map((attribute) => ({
      id: attribute.id,
      label: attribute.label,
      valueType: attribute.valueType,
      multiplicity: attribute.multiplicity,
      unit: null,
      requirementRules: [
        ...attribute.requiredLayers.map((layer) => ({
          layer,
          level: "mandatory" as const,
          when: null,
        })),
        ...attribute.requiredWhen.map((when) => ({
          layer: "circulation" as const,
          level: "mandatory" as const,
          when,
        })),
      ],
      presetMode: attribute.presets.length === 0 ? "none" : "suggested",
      presets: attribute.presets,
    })),
  });
}

export function validateProductAttributeValue(
  definition: CategoryAttributeDefinition,
  value: ProductAttributeValue,
): boolean {
  if (
    !productAttributeValueSchema.safeParse(value).success ||
    value.type !== definition.valueType
  ) {
    return false;
  }

  if (value.type === "decimal") {
    if (definition.unit === null) return value.unit === null;
    if (value.unit === null || !definition.unit.allowed.includes(value.unit)) return false;
  }

  if (definition.presetMode !== "restricted") return true;
  const allowed = new Set(definition.presets.map((preset) => preset.value));
  const actual = Array.isArray(value.value) ? value.value : [String(value.value)];
  return actual.every((item) => allowed.has(item));
}

function validateDefinition(
  definition: {
    attributes: CategoryAttributeDefinition[];
  },
  context: z.RefinementCtx,
): void {
  const attributes = new Map<string, CategoryAttributeDefinition>();
  for (const [attributeIndex, attribute] of definition.attributes.entries()) {
    if (attributes.has(attribute.id)) {
      context.addIssue({
        code: "custom",
        path: ["attributes", attributeIndex, "id"],
        message: `Duplicate attribute id ${attribute.id}`,
      });
    }
    attributes.set(attribute.id, attribute);

    if (attribute.valueType !== "decimal" && attribute.unit !== null) {
      context.addIssue({
        code: "custom",
        path: ["attributes", attributeIndex, "unit"],
        message: "Only decimal attributes can declare units",
      });
    }
    if (attribute.unit !== null) {
      const units = new Set(attribute.unit.allowed);
      if (units.size !== attribute.unit.allowed.length) {
        context.addIssue({
          code: "custom",
          path: ["attributes", attributeIndex, "unit", "allowed"],
          message: "Allowed units must be unique",
        });
      }
      if (!units.has(attribute.unit.canonical)) {
        context.addIssue({
          code: "custom",
          path: ["attributes", attributeIndex, "unit", "canonical"],
          message: "Canonical unit must be allowed",
        });
      }
    }
    if (attribute.presetMode === "none" && attribute.presets.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["attributes", attributeIndex, "presets"],
        message: "Preset mode none cannot declare presets",
      });
    }
    if (attribute.presetMode !== "none" && attribute.presets.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["attributes", attributeIndex, "presets"],
        message: "Preset mode requires at least one preset",
      });
    }
    if (
      new Set(attribute.presets.map((preset) => preset.value)).size !== attribute.presets.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["attributes", attributeIndex, "presets"],
        message: "Preset values must be unique",
      });
    }

    const rules = new Set<string>();
    for (const [ruleIndex, rule] of attribute.requirementRules.entries()) {
      const key = JSON.stringify(rule);
      if (rules.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["attributes", attributeIndex, "requirementRules", ruleIndex],
          message: "Duplicate requirement rule",
        });
      }
      rules.add(key);
    }
  }

  for (const [attributeIndex, attribute] of definition.attributes.entries()) {
    for (const [ruleIndex, rule] of attribute.requirementRules.entries()) {
      if (rule.when === null) continue;
      const trigger = attributes.get(rule.when.attributeId);
      if (!trigger) {
        context.addIssue({
          code: "custom",
          path: [
            "attributes",
            attributeIndex,
            "requirementRules",
            ruleIndex,
            "when",
            "attributeId",
          ],
          message: `Unknown condition attribute ${rule.when.attributeId}`,
        });
        continue;
      }
      if (!conditionIsCompatible(trigger, rule.when)) {
        context.addIssue({
          code: "custom",
          path: ["attributes", attributeIndex, "requirementRules", ruleIndex, "when"],
          message: `Condition is incompatible with trigger ${trigger.id}`,
        });
      }
    }
  }
}

function conditionIsCompatible(
  trigger: CategoryAttributeDefinition,
  condition: AttributeCondition,
): boolean {
  if (condition.operator === "includes") {
    return (
      typeof condition.value === "string" &&
      (trigger.valueType === "string_list" || trigger.valueType === "enum_list")
    );
  }
  if (typeof condition.value === "boolean") return trigger.valueType === "boolean";
  return ["string", "date", "enum"].includes(trigger.valueType);
}

export interface ProductReadinessReason {
  code: string;
  attributeId?: string;
  triggerAttributeId?: string;
  schemaVersionId?: string;
}

export interface ProductReadinessDimensionResult {
  dimension: ReadinessDimension;
  state: ReadinessState;
  reasons: ProductReadinessReason[];
  recommendations: ProductReadinessReason[];
}
