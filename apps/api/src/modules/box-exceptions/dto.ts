import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

import type { ExceptionDto } from "../station-scans/box-exceptions";

/**
 * GET /box-exceptions query schema. Same reasoning as boxes/dto.ts's
 * `listBoxesQuerySchema`: the audit trail only ever makes sense scoped to
 * one shift, so `shiftId` is required.
 */
export const listBoxExceptionsQuerySchema = z.object({
  shiftId: z.string().uuid(),
});
export type ListBoxExceptionsQueryDto = z.infer<typeof listBoxExceptionsQuerySchema>;

/**
 * Mirrors one `box_exceptions` row (Task 1's schema, written by every
 * undo/clear/disassemble/reprint branch in
 * StationScansService.applyExceptions, Tasks 4-7). `codeHash` is set only
 * for `undo` (a single-code action); `reason` is set for reprint and
 * disassemble -- see box_exceptions' own schema comment
 * (packages/db/src/schema/platform.ts) for why.
 */
export interface BoxExceptionDto {
  id: string;
  kind: ExceptionDto["kind"];
  boxId: string;
  codeHash: string | null;
  targetScannedAt: Date | null;
  terminalId: string | null;
  operatorId: string | null;
  reason: string | null;
  occurredAt: Date;
  recordedAt: Date;
}

/** GET /box-exceptions response. */
export interface ListBoxExceptionsResponseDto {
  items: BoxExceptionDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

// Mirrors ExceptionDto["kind"] (station-scans/box-exceptions.ts).
const BOX_EXCEPTION_KINDS = [
  "undo",
  "clear",
  "disassemble",
  "reprint",
] as const satisfies readonly ExceptionDto["kind"][];

export const boxExceptionOpenApiSchema: SchemaObject = {
  type: "object",
  required: [
    "id",
    "kind",
    "boxId",
    "codeHash",
    "targetScannedAt",
    "terminalId",
    "operatorId",
    "reason",
    "occurredAt",
    "recordedAt",
  ],
  properties: {
    id: uuidSchema,
    kind: { type: "string", enum: [...BOX_EXCEPTION_KINDS] },
    boxId: uuidSchema,
    codeHash: {
      type: "string",
      nullable: true,
      description: "Set only for `undo` (a single-code action).",
    },
    targetScannedAt: { ...dateTimeSchema, nullable: true },
    terminalId: { type: "string", nullable: true },
    operatorId: { type: "string", nullable: true },
    reason: {
      type: "string",
      nullable: true,
      description: "Set for reprint and disassemble.",
    },
    occurredAt: dateTimeSchema,
    recordedAt: dateTimeSchema,
  },
};

export const listBoxExceptionsOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: boxExceptionOpenApiSchema } },
};
