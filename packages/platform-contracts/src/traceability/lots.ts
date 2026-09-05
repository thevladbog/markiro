import {
  DomainError,
  normalizeTlc,
  P0_ASSIGNMENT_BASES,
  TLC_ASSIGNMENT_BASES,
  TRACEABILITY_LOT_STATUSES,
} from "@markiro/domain";
import { z } from "zod";

/** Entry boundary only. The domain owns length, Unicode and control-character rules. */
export const tlcSchema = z.string().transform((value, context) => {
  try {
    return normalizeTlc(value);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    context.addIssue({ code: "custom", message: error.code });
    return z.NEVER;
  }
});

/** Reading an identity must never repair or rewrite its persisted value. */
export const preservedTlcSchema = z.string().refine((value) => {
  const parsed = tlcSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}, "Expected a canonical TLC");

export const tlcAssignmentBasisSchema = z.enum(TLC_ASSIGNMENT_BASES);
export const p0TlcAssignmentBasisSchema = z.enum(P0_ASSIGNMENT_BASES);
export const traceabilityLotStatusSchema = z.enum(TRACEABILITY_LOT_STATUSES);

/**
 * Payload validation only. A future service must authorize QA, read the current
 * status under lock, validate the manual transition and atomically audit it.
 * Client-supplied operation context, actor and tenancy are deliberately absent.
 */
export const changeLotStatusSchema = z
  .object({
    status: traceabilityLotStatusSchema,
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();

export type ChangeLotStatusInput = z.infer<typeof changeLotStatusSchema>;
