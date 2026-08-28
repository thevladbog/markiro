import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";

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

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

export const conflictOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "codeHash",
    "losingShiftId",
    "losingTerminalId",
    "losingScannedAt",
    "winningShiftId",
    "winningTerminalId",
    "winningScannedAt",
    "detectedAt",
    "reviewedAt",
  ],
  properties: {
    id: uuidSchema,
    codeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    losingShiftId: uuidSchema,
    losingTerminalId: { ...uuidSchema, nullable: true },
    losingScannedAt: dateTimeSchema,
    winningShiftId: uuidSchema,
    winningTerminalId: { ...uuidSchema, nullable: true },
    winningScannedAt: dateTimeSchema,
    detectedAt: dateTimeSchema,
    reviewedAt: { ...dateTimeSchema, nullable: true },
  },
};

export const listConflictsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: conflictOpenApiSchema } },
};
