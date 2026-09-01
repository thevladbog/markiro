import type { SchemaObject } from "@nestjs/swagger";
import { productAttributeValueSchema } from "@markiro/domain";
import { z } from "zod";

export const updateRegulatoryAttributesSchema = z
  .object({
    baseRevision: z.number().int().positive(),
    values: z
      .array(
        z
          .object({
            attributeId: z.string().trim().min(1),
            value: productAttributeValueSchema.nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export type UpdateRegulatoryAttributesDto = z.infer<typeof updateRegulatoryAttributesSchema>;

export const categoryChangePreviewSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    targetSchemaVersionId: z.string().uuid(),
    tnVedCode: z.string().trim().min(1).nullable(),
    okpd2Code: z.string().trim().min(1).nullable(),
    mappingConfirmed: z.boolean().default(false),
  })
  .strict();
export type CategoryChangePreviewDto = z.infer<typeof categoryChangePreviewSchema>;

export const applyRegulatoryProposalSchema = z
  .object({
    acceptedEntryIds: z
      .array(z.string().uuid())
      .max(200)
      .superRefine((ids, context) => {
        if (new Set(ids).size !== ids.length) {
          context.addIssue({ code: "custom", message: "Duplicate accepted proposal entry ID" });
        }
      }),
  })
  .strict();
export type ApplyRegulatoryProposalDto = z.infer<typeof applyRegulatoryProposalSchema>;

export const egaisCodesBodySchema = z
  .object({
    baseRevision: z.number().int().positive(),
    codes: z
      .array(z.string().regex(/^\d{19}$/))
      .max(20)
      .superRefine((codes, context) => {
        if (new Set(codes).size !== codes.length) {
          context.addIssue({ code: "custom", message: "Duplicate EGAIS code" });
        }
      }),
    primaryCode: z
      .string()
      .regex(/^\d{19}$/)
      .nullable(),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.codes.length > 0 && (!body.primaryCode || !body.codes.includes(body.primaryCode))) {
      context.addIssue({
        code: "custom",
        path: ["primaryCode"],
        message: "Primary EGAIS code must be selected",
      });
    }
    if (body.codes.length === 0 && body.primaryCode !== null) {
      context.addIssue({
        code: "custom",
        path: ["primaryCode"],
        message: "Primary EGAIS code requires a code",
      });
    }
  });
export type EgaisCodesBodyDto = z.infer<typeof egaisCodesBodySchema>;

const readinessReasonOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string" },
    attributeId: { type: "string" },
    triggerAttributeId: { type: "string" },
    schemaVersionId: { type: "string", format: "uuid" },
  },
};

const productAttributeValueOpenApiSchema: SchemaObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "value"],
      properties: { type: { type: "string", enum: ["string"] }, value: { type: "string" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "value"],
      properties: {
        type: { type: "string", enum: ["string_list", "enum_list"] },
        value: { type: "array", items: { type: "string" } },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "value", "unit"],
      properties: {
        type: { type: "string", enum: ["decimal"] },
        value: { type: "string" },
        unit: { type: "string", nullable: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "value"],
      properties: {
        type: { type: "string", enum: ["boolean"] },
        value: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "value"],
      properties: {
        type: { type: "string", enum: ["date", "enum"] },
        value: { type: "string" },
      },
    },
  ],
};

export const productReadinessOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["productId", "dimensions"],
  properties: {
    productId: { type: "string", format: "uuid" },
    dimensions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimension", "state", "reasons", "recommendations"],
        properties: {
          dimension: {
            type: "string",
            enum: ["production", "code_ordering", "circulation", "egais"],
          },
          state: { type: "string", enum: ["ready", "not_ready", "not_applicable", "stale"] },
          reasons: { type: "array", items: readinessReasonOpenApiSchema },
          recommendations: { type: "array", items: readinessReasonOpenApiSchema },
        },
      },
    },
  },
};

export const regulatoryProfileOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["productId", "binding", "values", "egaisCodes", "pendingProposalCount"],
  properties: {
    productId: { type: "string", format: "uuid" },
    binding: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["revision", "categoryId", "categoryName", "schemaVersionId", "source"],
      properties: {
        tenantId: { type: "string" },
        productId: { type: "string", format: "uuid" },
        revision: { type: "integer", minimum: 1 },
        categoryId: { type: "string" },
        categoryName: { type: "string" },
        tnVedCode: { type: "string", nullable: true },
        okpd2Code: { type: "string", nullable: true },
        schemaVersionId: { type: "string", format: "uuid" },
        source: { type: "string", enum: ["manual", "1c", "national_catalog", "migration"] },
        confirmedBy: { type: "string", nullable: true },
        confirmedAt: { type: "string", format: "date-time" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
    values: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entryId", "attributeId", "value", "source", "observedAt", "appliedAt"],
        properties: {
          entryId: { type: "string", format: "uuid" },
          attributeId: { type: "string" },
          value: productAttributeValueOpenApiSchema,
          source: { type: "string", enum: ["manual", "1c", "national_catalog", "migration"] },
          observedAt: { type: "string", format: "date-time", nullable: true },
          appliedAt: { type: "string", format: "date-time" },
        },
      },
    },
    egaisCodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "isPrimary", "source", "observedAt", "appliedAt"],
        properties: {
          code: { type: "string", pattern: "^[0-9]{19}$" },
          isPrimary: { type: "boolean" },
          source: { type: "string", enum: ["manual", "1c", "national_catalog", "migration"] },
          observedAt: { type: "string", format: "date-time", nullable: true },
          appliedAt: { type: "string", format: "date-time" },
        },
      },
    },
    pendingProposalCount: { type: "integer", minimum: 0 },
  },
};

export const regulatoryCategoryOptionsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["schemaVersionId", "categoryId", "categoryName", "selectors", "mappingState"],
        properties: {
          schemaVersionId: { type: "string", format: "uuid" },
          categoryId: { type: "string" },
          categoryName: { type: "string" },
          selectors: { type: "object", additionalProperties: true },
          mappingState: { type: "string", enum: ["exact", "ambiguous", "unmapped"] },
        },
      },
    },
  },
};

const targetBindingOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersionId", "categoryId", "categoryName", "tnVedCode", "okpd2Code"],
  properties: {
    schemaVersionId: { type: "string", format: "uuid" },
    categoryId: { type: "string" },
    categoryName: { type: "string" },
    tnVedCode: { type: "string", nullable: true },
    okpd2Code: { type: "string", nullable: true },
  },
};

const proposalEntryOpenApiSchema: SchemaObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "entryId",
        "target",
        "targetSchemaVersionId",
        "targetAttributeId",
        "disposition",
        "currentValue",
        "proposedValue",
      ],
      properties: {
        entryId: { type: "string", format: "uuid" },
        target: { type: "string", enum: ["attribute"] },
        targetSchemaVersionId: { type: "string", format: "uuid" },
        targetAttributeId: { type: "string" },
        disposition: {
          type: "string",
          enum: ["transferable", "convertible", "inapplicable", "conflict"],
        },
        currentValue: { ...productAttributeValueOpenApiSchema, nullable: true },
        proposedValue: { ...productAttributeValueOpenApiSchema, nullable: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["entryId", "target", "current", "proposed"],
      properties: {
        entryId: { type: "string", format: "uuid" },
        target: { type: "string", enum: ["egais_codes"] },
        current: egaisCollectionOpenApiSchema(),
        proposed: egaisCollectionOpenApiSchema(),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "entryId",
        "target",
        "targetField",
        "mappingId",
        "mappingVersion",
        "conversion",
        "currentValue",
        "proposedValue",
      ],
      properties: {
        entryId: { type: "string", format: "uuid" },
        target: { type: "string", enum: ["stable_field"] },
        targetField: { type: "string", enum: ["name", "print_name", "shelf_life_days"] },
        mappingId: { type: "string", format: "uuid" },
        mappingVersion: { type: "integer", minimum: 1 },
        conversion: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: {
              type: "string",
              enum: ["identity", "string_trim", "positive_integer"],
            },
          },
        },
        currentValue: {
          oneOf: [{ type: "string" }, { type: "integer", minimum: 1 }],
          nullable: true,
        },
        proposedValue: {
          oneOf: [{ type: "string" }, { type: "integer", minimum: 1 }],
          nullable: true,
        },
      },
    },
  ],
};

const categoryProposalDiffProperties = {
  version: { type: "integer", enum: [1] } as SchemaObject,
  kind: { type: "string", enum: ["category_binding", "category_change"] } as SchemaObject,
  target: targetBindingOpenApiSchema,
  entries: { type: "array", maxItems: 200, items: proposalEntryOpenApiSchema } as SchemaObject,
};

export const regulatoryProposalDiffOpenApiSchema: SchemaObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["version", "kind", "target", "entries"],
      properties: categoryProposalDiffProperties,
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["version", "kind", "entries"],
      properties: {
        version: { type: "integer", enum: [1] },
        kind: { type: "string", enum: ["national_catalog_import"] },
        entries: { type: "array", maxItems: 200, items: proposalEntryOpenApiSchema },
      },
    },
  ],
};

export const regulatoryProposalPreviewOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["proposalId", "baseRevision", "diff"],
  properties: {
    proposalId: { type: "string", format: "uuid" },
    baseRevision: { type: "integer", minimum: 0 },
    diff: regulatoryProposalDiffOpenApiSchema,
  },
};

export const regulatoryProposalOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "kind",
    "source",
    "sourceRef",
    "snapshotId",
    "baseRevision",
    "diff",
    "status",
    "expiresAt",
    "terminalReason",
    "createdAt",
    "appliedAt",
    "rejectedAt",
    "staleAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    kind: {
      type: "string",
      enum: ["category_binding", "category_change", "national_catalog_import"],
    },
    source: { type: "string", enum: ["manual", "1c", "national_catalog", "migration"] },
    sourceRef: { type: "string", nullable: true },
    snapshotId: { type: "string", format: "uuid", nullable: true },
    baseRevision: { type: "integer", minimum: 0 },
    diff: regulatoryProposalDiffOpenApiSchema,
    status: { type: "string", enum: ["preview", "applied", "rejected", "stale"] },
    expiresAt: { type: "string", format: "date-time" },
    terminalReason: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    appliedAt: { type: "string", format: "date-time", nullable: true },
    rejectedAt: { type: "string", format: "date-time", nullable: true },
    staleAt: { type: "string", format: "date-time", nullable: true },
  },
};

export const regulatoryProposalRejectionOpenApiSchema = regulatoryProposalOpenApiSchema;

function egaisCollectionOpenApiSchema(): SchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["codes", "primaryCode"],
    properties: {
      codes: { type: "array", maxItems: 20, items: { type: "string", pattern: "^[0-9]{19}$" } },
      primaryCode: { type: "string", pattern: "^[0-9]{19}$", nullable: true },
    },
  };
}
