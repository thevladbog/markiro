import { z } from "zod";
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
