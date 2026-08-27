import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

import {
  INVENTORY_DOCUMENT_MIME_TYPE_PATTERN,
  INVENTORY_DOCUMENT_SOURCE_CATEGORIES,
  inventoryDocumentFormatDescriptorSchema,
} from "@markiro/domain";

export const availableInventoryDocumentFormatSchema = inventoryDocumentFormatDescriptorSchema
  .extend({ availability: z.literal("available") })
  .strict();

export const inventoryDocumentFormatsResponseSchema = z.strictObject({
  items: z.array(availableInventoryDocumentFormatSchema),
});

export type InventoryDocumentFormatDto = z.infer<typeof availableInventoryDocumentFormatSchema>;
export type InventoryDocumentFormatsResponseDto = z.infer<
  typeof inventoryDocumentFormatsResponseSchema
>;

export const inventoryDocumentFormatOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "version",
    "label",
    "extension",
    "mimeType",
    "requiredSourceCategories",
    "supportsParts",
    "availability",
  ],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$", maxLength: 64 },
    version: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
    label: { type: "string", minLength: 1, maxLength: 200 },
    extension: { type: "string", pattern: "^[a-z0-9]{1,16}$", maxLength: 16 },
    mimeType: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: INVENTORY_DOCUMENT_MIME_TYPE_PATTERN,
    },
    requiredSourceCategories: {
      type: "array",
      minItems: 1,
      maxItems: INVENTORY_DOCUMENT_SOURCE_CATEGORIES.length,
      uniqueItems: true,
      items: { type: "string", enum: [...INVENTORY_DOCUMENT_SOURCE_CATEGORIES] },
    },
    supportsParts: { type: "boolean" },
    availability: { type: "string", enum: ["available"] },
  },
};

export const inventoryDocumentFormatsResponseOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: { type: "array", items: inventoryDocumentFormatOpenApiSchema },
  },
};
