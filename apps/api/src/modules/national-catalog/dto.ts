import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";

export const nationalCatalogImportPreviewSchema = z
  .object({ snapshotId: z.string().uuid() })
  .strict();
export type NationalCatalogImportPreviewDto = z.infer<typeof nationalCatalogImportPreviewSchema>;

export const nationalCatalogLookupOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "cards"],
  properties: {
    outcome: {
      type: "string",
      enum: [
        "found",
        "selection_required",
        "empty",
        "token_unconfigured",
        "token_missing",
        "token_expired",
        "token_undecryptable",
        "provider_unauthorized",
        "provider_rate_limited",
        "provider_invalid_response",
        "provider_unavailable",
      ],
    },
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["snapshotId", "cardId", "cardStatus", "sourceMethod", "changed"],
        properties: {
          snapshotId: { type: "string", format: "uuid" },
          cardId: { type: "string" },
          cardStatus: { type: "string" },
          sourceMethod: { type: "string", enum: ["feed_product", "product"] },
          changed: { type: "boolean" },
        },
      },
    },
  },
};

export const nationalCatalogImportPreviewOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["proposalId", "snapshotId", "baseRevision", "diff", "ignored"],
  properties: {
    proposalId: { type: "string", format: "uuid" },
    snapshotId: { type: "string", format: "uuid" },
    baseRevision: { type: "integer", minimum: 1 },
    diff: { type: "object", additionalProperties: true },
    ignored: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attributeId", "reason"],
        properties: {
          attributeId: { type: "string" },
          reason: { type: "string", enum: ["ambiguous", "invalid_value", "unmapped"] },
        },
      },
    },
  },
};
