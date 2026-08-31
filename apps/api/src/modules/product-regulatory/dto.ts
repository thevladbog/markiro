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
        required: ["dimension", "state", "reasons"],
        properties: {
          dimension: {
            type: "string",
            enum: ["production", "code_ordering", "circulation", "egais"],
          },
          state: { type: "string", enum: ["ready", "not_ready", "not_applicable", "stale"] },
          reasons: { type: "array", items: readinessReasonOpenApiSchema },
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
        required: ["attributeId", "value", "source", "observedAt", "appliedAt"],
        properties: {
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
