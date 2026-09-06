import { DomainError, isTraceabilityCivilDate, parseTraceabilityQuantity } from "@markiro/domain";
import { z } from "zod";

export const traceabilityCivilDateSchema = z
  .string()
  .refine(isTraceabilityCivilDate, "Expected a valid calendar date (YYYY-MM-DD)");

/** Entry boundary only; never coerce JSON numbers or round fractional digits. */
export const traceabilityQuantitySchema = z.string().transform((value, context) => {
  try {
    return parseTraceabilityQuantity(value);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    context.addIssue({ code: "custom", message: error.code });
    return z.NEVER;
  }
});
