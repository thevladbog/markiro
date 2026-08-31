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

export const categoryAttributeDefinitionSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    valueType: z.enum(["string", "string_list", "decimal", "boolean", "date", "enum", "enum_list"]),
    multiplicity: z.enum(["one", "many"]),
    requiredLayers: z.array(z.enum(["code_ordering", "circulation"])),
    requiredWhen: z.array(attributeConditionSchema),
    presets: z
      .array(
        z
          .object({
            value: nonEmptyStringSchema,
            label: nonEmptyStringSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type CategoryAttributeDefinition = z.infer<typeof categoryAttributeDefinitionSchema>;

export const categorySchemaDefinitionSchema = z
  .object({
    categoryId: nonEmptyStringSchema,
    scopeKey: nonEmptyStringSchema,
    attributes: z.array(categoryAttributeDefinitionSchema),
  })
  .strict()
  .superRefine((schema, context) => {
    const ids = new Set<string>();
    for (const attribute of schema.attributes) {
      if (ids.has(attribute.id)) {
        context.addIssue({
          code: "custom",
          path: ["attributes"],
          message: `Duplicate attribute id ${attribute.id}`,
        });
      }
      ids.add(attribute.id);
    }

    for (const [attributeIndex, attribute] of schema.attributes.entries()) {
      for (const [conditionIndex, condition] of attribute.requiredWhen.entries()) {
        if (!ids.has(condition.attributeId)) {
          context.addIssue({
            code: "custom",
            path: ["attributes", attributeIndex, "requiredWhen", conditionIndex, "attributeId"],
            message: `Unknown condition attribute ${condition.attributeId}`,
          });
        }
      }
    }
  });

export type CategorySchemaDefinition = z.infer<typeof categorySchemaDefinitionSchema>;

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
}
