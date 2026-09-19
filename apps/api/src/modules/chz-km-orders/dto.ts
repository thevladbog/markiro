import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";
import { schema } from "@markiro/db";

/**
 * Preflight blockers for `POST /chz-km-orders`, reported all together (not
 * one at a time) so an administrator fixes every condition in one pass
 * instead of discovering the next problem after each fix -- the same
 * decision `ChzExportsService.preflight` already makes.
 */
export const CHZ_KM_ORDER_PREFLIGHT_CODES = [
  "OMS_SETTINGS_MISSING",
  "AGENT_NOT_PAIRED",
  "OMS_TOKEN_UNAVAILABLE",
  "PRODUCT_NOT_FOUND",
  "PRODUCT_ARCHIVED",
  "PRODUCT_GTIN_MISSING",
  "PRODUCT_GROUP_MISSING",
  "PRODUCT_GROUP_UNSUPPORTED",
] as const;
export type ChzKmOrderPreflightCode = (typeof CHZ_KM_ORDER_PREFLIGHT_CODES)[number];

/** `POST /chz-km-orders`'s 422 error surface: named rather than inline. */
export const CHZ_KM_ORDER_PREFLIGHT_FAILED_CODE = "CHZ_KM_ORDER_PREFLIGHT_FAILED" as const;

/** `POST /chz-km-orders/:id/retry`'s 409 error surface: named rather than inline. */
export const CHZ_KM_ORDER_NOT_FAILED_CODE = "CHZ_KM_ORDER_NOT_FAILED" as const;

export const createChzKmOrderSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(150_000),
  contactPerson: z.string().trim().min(1).max(128).optional(),
});
export type CreateChzKmOrderDto = z.infer<typeof createChzKmOrderSchema>;

export const chzKmOrderIdSchema = z.uuid();

export interface ChzKmOrderActorDto {
  id: string;
  name: string;
}

export interface ChzKmIssueDto {
  id: string;
  kind: (typeof schema.CHZ_KM_ISSUE_KINDS)[number];
  format: (typeof schema.CHZ_KM_ISSUE_FORMATS)[number] | null;
  fromSeq: number;
  toSeq: number;
  count: number;
  createdBy: ChzKmOrderActorDto;
  createdAt: string;
}

/**
 * The card list's row shape -- everything the cabinet's order table renders
 * without the operator opening a single order. `ChzKmOrderDto` below adds
 * `issues`, which only the order detail view needs.
 */
export interface ChzKmOrderListItemDto {
  id: string;
  productId: string;
  productName: string;
  gtin14: string;
  productGroupAlias: string;
  templateId: number;
  quantity: number;
  state: (typeof schema.CHZ_KM_ORDER_STATES)[number];
  omsOrderId: string | null;
  bufferStatus: string | null;
  bufferExpiresAt: string | null;
  availableCodes: number | null;
  fetchedCount: number;
  issuedCount: number;
  /** `fetchedCount - issuedCount`: codes already pulled from the buffer but not yet handed to the office. */
  availableForIssue: number;
  rejectionReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  createdBy: ChzKmOrderActorDto;
  createdAt: string;
  updatedAt: string;
}

export interface ChzKmOrderDto extends ChzKmOrderListItemDto {
  issues: ChzKmIssueDto[];
}

export interface ChzKmOrderListDto {
  orders: ChzKmOrderListItemDto[];
}

export const createChzKmOrderOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["productId", "quantity"],
  properties: {
    productId: { type: "string", format: "uuid" },
    quantity: { type: "integer", minimum: 1, maximum: 150_000 },
    contactPerson: { type: "string", minLength: 1, maxLength: 128 },
  },
};

const chzKmOrderActorOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
  },
};

export const chzKmIssueOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "format", "fromSeq", "toSeq", "count", "createdBy", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    kind: { type: "string", enum: [...schema.CHZ_KM_ISSUE_KINDS] },
    format: { type: "string", enum: [...schema.CHZ_KM_ISSUE_FORMATS], nullable: true },
    fromSeq: { type: "integer" },
    toSeq: { type: "integer" },
    count: { type: "integer" },
    createdBy: chzKmOrderActorOpenApiSchema,
    createdAt: { type: "string", format: "date-time" },
  },
};

const CHZ_KM_ORDER_COMMON_REQUIRED = [
  "id",
  "productId",
  "productName",
  "gtin14",
  "productGroupAlias",
  "templateId",
  "quantity",
  "state",
  "omsOrderId",
  "bufferStatus",
  "bufferExpiresAt",
  "availableCodes",
  "fetchedCount",
  "issuedCount",
  "availableForIssue",
  "rejectionReason",
  "errorCode",
  "errorMessage",
  "attempts",
  "createdBy",
  "createdAt",
  "updatedAt",
] as const;

const chzKmOrderCommonProperties: Record<string, SchemaObject> = {
  id: { type: "string", format: "uuid" },
  productId: { type: "string", format: "uuid" },
  productName: { type: "string" },
  gtin14: { type: "string" },
  productGroupAlias: { type: "string" },
  templateId: { type: "integer" },
  quantity: { type: "integer" },
  state: { type: "string", enum: [...schema.CHZ_KM_ORDER_STATES] },
  omsOrderId: { type: "string", format: "uuid", nullable: true },
  bufferStatus: { type: "string", nullable: true },
  bufferExpiresAt: { type: "string", format: "date-time", nullable: true },
  availableCodes: { type: "integer", nullable: true },
  fetchedCount: { type: "integer" },
  issuedCount: { type: "integer" },
  availableForIssue: { type: "integer" },
  rejectionReason: { type: "string", nullable: true },
  errorCode: { type: "string", nullable: true },
  errorMessage: { type: "string", nullable: true },
  attempts: { type: "integer" },
  createdBy: chzKmOrderActorOpenApiSchema,
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
};

export const chzKmOrderListItemOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [...CHZ_KM_ORDER_COMMON_REQUIRED],
  properties: { ...chzKmOrderCommonProperties },
};

export const chzKmOrderOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [...CHZ_KM_ORDER_COMMON_REQUIRED, "issues"],
  properties: {
    ...chzKmOrderCommonProperties,
    issues: { type: "array", items: chzKmIssueOpenApiSchema },
  },
};

export const chzKmOrderListOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["orders"],
  properties: {
    orders: { type: "array", items: chzKmOrderListItemOpenApiSchema },
  },
};

export const chzKmOrderPreflightFailedOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code", "blockedBy"],
  properties: {
    code: { type: "string", enum: [CHZ_KM_ORDER_PREFLIGHT_FAILED_CODE] },
    blockedBy: {
      type: "array",
      items: { type: "string", enum: [...CHZ_KM_ORDER_PREFLIGHT_CODES] },
    },
  },
};

export const chzKmOrderNotFailedOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", enum: [CHZ_KM_ORDER_NOT_FAILED_CODE] },
  },
};
