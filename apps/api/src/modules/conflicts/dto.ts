import { z } from "zod";

/**
 * GET /conflicts query schema. `reviewed` arrives as a query string, so it is
 * accepted as the literal strings "true"/"false" and converted to a real
 * boolean here rather than left for callers to parse ad hoc.
 */
export const listConflictsQuerySchema = z.object({
  shiftId: z.string().uuid().optional(),
  reviewed: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type ListConflictsQueryDto = z.infer<typeof listConflictsQuerySchema>;

/**
 * Mirrors `code_conflicts` (Task 1): one row per losing scan, carrying both
 * the losing and winning (shift, terminal, scannedAt) triples plus detection
 * and review timestamps.
 */
export interface ConflictDto {
  id: string;
  codeHash: string;
  losingShiftId: string;
  losingTerminalId: string | null;
  losingScannedAt: Date;
  winningShiftId: string;
  winningTerminalId: string | null;
  winningScannedAt: Date;
  detectedAt: Date;
  reviewedAt: Date | null;
}

/** GET /conflicts response. */
export interface ListConflictsResponseDto {
  items: ConflictDto[];
}
