import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";
import type { DateBound } from "../../lib/date-range";

/** `^YYYY-MM-DD$`; must be checked against the RAW query string, not the coerced `Date` -- see `date-range.ts`. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dateBoundSchema = z.string().transform((raw, ctx) => {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
    return z.NEVER;
  }
  return { date, dateOnly: DATE_ONLY_RE.test(raw) } satisfies DateBound;
});

/** POST /disaggregation schema. */
export const createDocumentSchema = z.object({
  reasonId: z.string().uuid().optional(),
  comment: z.string().trim().max(500).optional(),
});
export type CreateDocumentDto = z.infer<typeof createDocumentSchema>;

/** PATCH /disaggregation/:id schema. */
export const updateDocumentSchema = z.object({
  reasonId: z.string().uuid().nullable().optional(),
  comment: z.string().trim().max(500).nullable().optional(),
});
export type UpdateDocumentDto = z.infer<typeof updateDocumentSchema>;

/** GET /disaggregation query schema. */
export const listDocumentsQuerySchema = z.object({
  status: z.enum(["draft", "applied", "cancelled"]).optional(),
  reasonId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: dateBoundSchema.optional(),
  docNo: z.string().trim().min(1).max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type ListDocumentsQueryDto = z.infer<typeof listDocumentsQuerySchema>;

/** GET /disaggregation/:id/report query schema. */
export const reportQuerySchema = z.object({
  variant: z.enum(["boxes", "full"]).default("boxes"),
});
export type ReportQueryDto = z.infer<typeof reportQuerySchema>;

/** POST /disaggregation/:id/lines schema. */
export const addLinesSchema = z.object({
  ssccs: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
});
export type AddLinesDto = z.infer<typeof addLinesSchema>;

export type LineStatus =
  | "ok"
  | "not_found"
  | "not_closed"
  | "shift_open"
  | "already_disassembled"
  | "written_off"
  | "duplicate";

export interface LineDto {
  id: string;
  ssccInput: string;
  sscc: string | null; // 20-digit AI form or null
  boxId: string | null;
  status: LineStatus;
  productId: string | null;
  productName: string | null;
  codeCount: number;
  validatedAt: Date;
}

export interface DocumentDto {
  id: string;
  docNo: string;
  status: "draft" | "applied" | "cancelled";
  reasonId: string | null;
  reasonName: string | null;
  comment: string | null;
  source: "manual" | "import";
  lineCount: number;
  codeCount: number;
  createdByUserId: string;
  createdByName: string | null;
  createdAt: Date;
  appliedAt: Date | null;
  appliedByUserId: string | null;
  cancelledAt: Date | null;
}

export type DocumentListItemDto = DocumentDto;

export interface DocumentDetailDto extends DocumentDto {
  lines: LineDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

export const disaggregationLineOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "ssccInput",
    "sscc",
    "boxId",
    "status",
    "productId",
    "productName",
    "codeCount",
    "validatedAt",
  ],
  properties: {
    id: uuidSchema,
    ssccInput: { type: "string" },
    sscc: {
      type: "string",
      pattern: "^[0-9]{20}$",
      nullable: true,
      description: '20-digit GS1 AI "00" form; null for unparseable input or duplicate markers.',
    },
    boxId: { ...uuidSchema, nullable: true },
    status: {
      type: "string",
      enum: [
        "ok",
        "not_found",
        "not_closed",
        "shift_open",
        "already_disassembled",
        "written_off",
        "duplicate",
      ],
    },
    productId: { ...uuidSchema, nullable: true },
    productName: { type: "string", nullable: true },
    codeCount: { type: "integer", minimum: 0 },
    validatedAt: dateTimeSchema,
  },
};

export const disaggregationDocumentOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "docNo",
    "status",
    "reasonId",
    "reasonName",
    "comment",
    "source",
    "lineCount",
    "codeCount",
    "createdByUserId",
    "createdByName",
    "createdAt",
    "appliedAt",
    "appliedByUserId",
    "cancelledAt",
  ],
  properties: {
    id: uuidSchema,
    docNo: { type: "string" },
    status: { type: "string", enum: ["draft", "applied", "cancelled"] },
    reasonId: { ...uuidSchema, nullable: true },
    reasonName: { type: "string", nullable: true },
    comment: { type: "string", nullable: true },
    source: { type: "string", enum: ["manual", "import"] },
    lineCount: { type: "integer", minimum: 0 },
    codeCount: { type: "integer", minimum: 0 },
    createdByUserId: { type: "string" },
    createdByName: { type: "string", nullable: true },
    createdAt: dateTimeSchema,
    appliedAt: { ...dateTimeSchema, nullable: true },
    appliedByUserId: { type: "string", nullable: true },
    cancelledAt: { ...dateTimeSchema, nullable: true },
  },
};

export const disaggregationDocumentDetailOpenApiSchema: SchemaObject = {
  ...disaggregationDocumentOpenApiSchema,
  required: [...(disaggregationDocumentOpenApiSchema.required ?? []), "lines"],
  properties: {
    ...disaggregationDocumentOpenApiSchema.properties,
    lines: { type: "array", items: disaggregationLineOpenApiSchema },
  },
};

export const listDisaggregationDocumentsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items", "page", "pageCount", "total"],
  properties: {
    items: { type: "array", items: disaggregationDocumentOpenApiSchema },
    page: { type: "integer", minimum: 1 },
    pageCount: { type: "integer", minimum: 1 },
    total: { type: "integer", minimum: 0 },
  },
};

export const disaggregationLinesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: { lines: { type: "array", items: disaggregationLineOpenApiSchema } },
};

export const disaggregationNotDraftConflictOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", enum: ["not_draft"] },
    message: { type: "string" },
  },
};

export const disaggregationApplyConflictOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", enum: ["not_draft", "reason_required", "no_lines", "invalid_lines"] },
    message: { type: "string" },
    lines: {
      type: "array",
      items: disaggregationLineOpenApiSchema,
      description:
        'Present only for code "invalid_lines": every line with its freshly revalidated status.',
    },
  },
};

export const disaggregationImportFileOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["file"],
  properties: {
    file: {
      type: "string",
      format: "binary",
      description:
        "Text file (max 1 MiB, up to 10000 tokens) with SSCCs separated by newlines, commas, or semicolons.",
    },
  },
};

export const disaggregationImportErrorOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", enum: ["file_required", "file_empty", "too_many_lines"] },
    max: {
      type: "integer",
      description: 'Present only for code "too_many_lines": the accepted token ceiling.',
    },
  },
};
