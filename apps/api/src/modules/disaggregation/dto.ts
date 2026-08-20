import { z } from "zod";
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
