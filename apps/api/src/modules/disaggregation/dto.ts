import { z } from "zod";

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
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type ListDocumentsQueryDto = z.infer<typeof listDocumentsQuerySchema>;

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
  createdAt: Date;
  appliedAt: Date | null;
  appliedByUserId: string | null;
  cancelledAt: Date | null;
}

export type DocumentListItemDto = DocumentDto;

export interface DocumentDetailDto extends DocumentDto {
  lines: LineDto[];
}
