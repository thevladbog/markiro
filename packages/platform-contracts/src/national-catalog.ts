import { z } from "zod";

import { platformTenantIdSchema, platformUuidSchema } from "./primitives.js";

export const nationalCatalogSchemaRefreshBodySchema = z
  .object({ sourceTenantId: platformTenantIdSchema })
  .strict();

export const nationalCatalogSchemaRefreshResponseSchema = z
  .object({
    categories: z.number().int().nonnegative(),
    observed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();

const nationalCatalogSchemaBlockReasonSchema = z
  .object({
    code: z.enum([
      "duplicate_attribute_id",
      "unsupported_dependency",
      "unsupported_requirement_type",
      "unsupported_unique_multiplicity",
      "unsupported_value_type",
      "invalid_preset_contract",
    ]),
    attributeId: z.string().min(1),
  })
  .strict();

export const nationalCatalogSchemaListResponseSchema = z
  .object({
    configured: z.boolean(),
    sourceTenantId: platformTenantIdSchema.nullable(),
    versions: z.array(
      z
        .object({
          id: platformUuidSchema,
          categoryId: z.string().min(1),
          categoryName: z.string().min(1),
          status: z.enum(["observed", "validated", "active", "retired"]),
          fetchedAt: z.iso.datetime({ offset: true }),
          activatedAt: z.iso.datetime({ offset: true }).nullable(),
          blockedReasons: z.array(nationalCatalogSchemaBlockReasonSchema),
          mappings: z.array(
            z
              .object({
                chzProductGroupCode: z.number().int().positive(),
                chzProductGroupName: z.string().min(1),
                state: z.enum(["exact", "ambiguous", "unmapped"]),
                reviewedAt: z.iso.datetime({ offset: true }).nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export const nationalCatalogSchemaVersionParamsSchema = z
  .object({ id: platformUuidSchema })
  .strict();

export const nationalCatalogSchemaActivationResponseSchema = z
  .object({
    schemaVersionId: platformUuidSchema,
    priorSchemaVersionId: platformUuidSchema.nullable(),
    alreadyActive: z.boolean(),
  })
  .strict();

export const nationalCatalogGroupMappingReviewBodySchema = z
  .object({
    state: z.enum(["exact", "ambiguous", "unmapped"]),
    schemaVersionIds: z.array(platformUuidSchema).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = value.state === "exact" ? 1 : value.state === "ambiguous" ? 2 : 0;
    const valid =
      value.state !== "unmapped"
        ? value.schemaVersionIds.length >= expected
        : value.schemaVersionIds.length === expected;
    if (!valid || new Set(value.schemaVersionIds).size !== value.schemaVersionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["schemaVersionIds"],
        message: "Invalid reviewed candidates",
      });
    }
  });

export const nationalCatalogGroupMappingReviewResponseSchema = z
  .object({
    chzProductGroupCode: z.number().int().positive(),
    state: z.enum(["exact", "ambiguous", "unmapped"]),
    schemaVersionIds: z.array(platformUuidSchema).max(20),
    reviewedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const nationalCatalogStableFieldConversionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity") }).strict(),
  z.object({ kind: z.literal("string_trim") }).strict(),
  z.object({ kind: z.literal("positive_integer") }).strict(),
]);

export const nationalCatalogAttributeMappingReviewBodySchema = z
  .object({
    mappings: z
      .array(
        z
          .object({
            sourceAttributeId: z.string().trim().min(1),
            targetField: z.enum(["name", "print_name", "shelf_life_days"]),
            conversion: nationalCatalogStableFieldConversionSchema,
            mappingVersion: z.number().int().positive(),
          })
          .strict(),
      )
      .max(3),
  })
  .strict()
  .superRefine((value, context) => {
    const targets = value.mappings.map((mapping) => mapping.targetField);
    if (new Set(targets).size !== targets.length) {
      context.addIssue({
        code: "custom",
        path: ["mappings"],
        message: "Stable target fields must be unique",
      });
    }
  });

export const nationalCatalogAttributeMappingReviewResponseSchema = z
  .object({
    schemaVersionId: platformUuidSchema,
    mappingCount: z.number().int().nonnegative(),
    reviewedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const platformNationalCatalogContracts = {
  listSchemas: {
    response: nationalCatalogSchemaListResponseSchema,
  },
  refresh: {
    body: nationalCatalogSchemaRefreshBodySchema,
    response: nationalCatalogSchemaRefreshResponseSchema,
  },
  activate: {
    params: nationalCatalogSchemaVersionParamsSchema,
    response: nationalCatalogSchemaActivationResponseSchema,
  },
  reviewGroupMapping: {
    body: nationalCatalogGroupMappingReviewBodySchema,
    response: nationalCatalogGroupMappingReviewResponseSchema,
  },
  reviewAttributeMappings: {
    params: nationalCatalogSchemaVersionParamsSchema,
    body: nationalCatalogAttributeMappingReviewBodySchema,
    response: nationalCatalogAttributeMappingReviewResponseSchema,
  },
} as const;
