import { z } from "zod";

/** `GET /code-search?q=` query. `q` is bounded at 1024 bytes, matching a KM's own `MAX_KM_UTF8_BYTES` ceiling (see `canonicalizeKm`) -- anything longer is unrecognized input, not a DB lookup worth attempting. */
export const classifyQuerySchema = z.object({
  q: z.string().trim().min(1).max(1024),
});
export type ClassifyQueryDto = z.infer<typeof classifyQuerySchema>;

/** `GET /code-search` response: which entity the input resolved to. */
export type ClassifySearchResponseDto =
  | { type: "box"; boxId: string }
  | { type: "code"; codeHash: string };

/** 404 body shape for `/code-search`: distinguishes "not a recognized SSCC/KM shape at all" from "well-formed, but nothing in this tenant matches". */
export interface ClassifyNotFoundDto {
  code: "unrecognized" | "not_found";
}

export const listCodesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  productId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  status: z.enum(["free", "aggregated", "written_off"]).optional(),
});
export type ListCodesQueryDto = z.infer<typeof listCodesQuerySchema>;

export type CodeStatus = "free" | "aggregated" | "written_off";

/**
 * One `code_registry` row (the owner scan of a code), joined to its
 * `codes` detail row, `products` (nullable -- a scanned GTIN need not be a
 * registered product), and its current box (nullable -- a code need not be
 * in an active box).
 */
export interface CodeListItemDto {
  codeHash: string;
  gtin14: string;
  serial: string;
  productId: string | null;
  productName: string | null;
  status: CodeStatus;
  scannedAt: Date;
  boxId: string | null;
  /** 20-значный код с GS1 AI "00" (Chestny ZNAK); в БД хранится голый 18-значный SSCC. */
  boxSscc: string | null;
}

export interface ListCodesResponseDto {
  items: CodeListItemDto[];
  page: number;
  pageCount: number;
  total: number;
}
