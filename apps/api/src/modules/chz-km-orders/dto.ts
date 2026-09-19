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

/** `POST /chz-km-orders/:id/issues` asked for more codes than the order still holds. */
export const CHZ_KM_ISSUE_TOO_MANY_CODE = "CHZ_KM_ISSUE_TOO_MANY" as const;

/**
 * `POST /chz-km-orders/:id/issues` reached an order that is not `completed`.
 * Reported ahead of `CHZ_KM_ISSUE_TOO_MANY` even though such an order also has
 * zero available codes: the office has to wait, not to ask for fewer.
 */
export const CHZ_KM_ORDER_NOT_COMPLETED_CODE = "CHZ_KM_ORDER_NOT_COMPLETED" as const;

/** `GET /chz-km-orders/:id/issues/:issueId/file` reached a print issue, which has no file. */
export const CHZ_KM_ISSUE_NOT_EXPORT_CODE = "CHZ_KM_ISSUE_NOT_EXPORT" as const;

/**
 * The order's `issued_count` disagrees with its codes' statuses, so the range
 * the next issue would claim is not actually free. Unreachable while the row
 * lock holds, and reported apart from `CHZ_KM_ISSUE_TOO_MANY` on purpose: that
 * code tells the office to ask for fewer, which would never clear this state,
 * because the bad sequence number is below every future range's start.
 */
export const CHZ_KM_ISSUE_INCONSISTENT_CODE = "CHZ_KM_ISSUE_INCONSISTENT" as const;

export const createChzKmOrderSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(150_000),
  contactPerson: z.string().trim().min(1).max(128).optional(),
});
export type CreateChzKmOrderDto = z.infer<typeof createChzKmOrderSchema>;

export const chzKmOrderIdSchema = z.uuid();
export const chzKmIssueIdSchema = z.uuid();

/**
 * `print` is capped at 5 000 while `export` carries the order's own ceiling:
 * a browser print job of tens of thousands of pages is not a workable office
 * action, whereas a file of them is exactly what a labelling line wants.
 */
export const issueChzKmCodesSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("export"),
      format: z.enum(["txt", "csv"]),
      count: z.number().int().min(1).max(150_000),
    })
    .strict(),
  z.object({ kind: z.literal("print"), count: z.number().int().min(1).max(5_000) }).strict(),
]);
export type IssueChzKmCodesDto = z.infer<typeof issueChzKmCodesSchema>;

export interface ChzKmIssueCodeDto {
  seq: number;
  code: string;
}

export interface ChzKmIssueCodesDto {
  codes: ChzKmIssueCodeDto[];
}

/** An export issue rendered for download; `bytes` is what the browser receives verbatim. */
export interface ChzKmIssueFileDto {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

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

export const issueChzKmCodesOpenApiSchema: SchemaObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "format", "count"],
      properties: {
        kind: { type: "string", enum: ["export"] },
        format: { type: "string", enum: [...schema.CHZ_KM_ISSUE_FORMATS] },
        count: { type: "integer", minimum: 1, maximum: 150_000 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "count"],
      properties: {
        kind: { type: "string", enum: ["print"] },
        count: { type: "integer", minimum: 1, maximum: 5_000 },
      },
    },
  ],
};

export const chzKmIssueCodesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["codes"],
  properties: {
    codes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seq", "code"],
        properties: {
          seq: { type: "integer" },
          code: { type: "string" },
        },
      },
    },
  },
};

export const chzKmIssueTooManyOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code", "available"],
  properties: {
    code: { type: "string", enum: [CHZ_KM_ISSUE_TOO_MANY_CODE] },
    available: { type: "integer" },
  },
};

export const chzKmOrderNotCompletedOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", enum: [CHZ_KM_ORDER_NOT_COMPLETED_CODE] },
  },
};

export const chzKmIssueNotExportOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", enum: [CHZ_KM_ISSUE_NOT_EXPORT_CODE] },
  },
};

export const chzKmIssueInconsistentOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", enum: [CHZ_KM_ISSUE_INCONSISTENT_CODE] },
  },
};

/** The three ways `POST /chz-km-orders/:id/issues` refuses, documented as one 409. */
export const chzKmIssueConflictOpenApiSchema: SchemaObject = {
  oneOf: [
    chzKmIssueTooManyOpenApiSchema,
    chzKmOrderNotCompletedOpenApiSchema,
    chzKmIssueInconsistentOpenApiSchema,
  ],
};
