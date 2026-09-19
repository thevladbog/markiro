import { z } from "zod";

/**
 * Frozen v1 namespace for the printed shift task form's Data Matrix.
 *
 * The prefix lives in the domain rather than beside the API's shift DTOs
 * because three implementations read it: the API renders it, the Station
 * parses it locally against its loaded shift list, and the handheld repeats
 * the rule in Kotlin. A second copy of the literal is how the three drift.
 */
export const SHIFT_TASK_BARCODE_PREFIX = "markiro:shift:v1:";

const shiftIdSchema = z.uuid().toLowerCase();

export function formatShiftTaskBarcode(shiftId: string): string {
  return `${SHIFT_TASK_BARCODE_PREFIX}${shiftId}`;
}

/**
 * The shift id carried by a task-form barcode, or null when this scan is not
 * one. Null is the answer for every non-shift scan a terminal sees, so it is
 * a return value and not an exception.
 */
export function parseShiftTaskBarcode(barcode: string): string | null {
  if (!barcode.startsWith(SHIFT_TASK_BARCODE_PREFIX)) return null;
  const parsed = shiftIdSchema.safeParse(barcode.slice(SHIFT_TASK_BARCODE_PREFIX.length));
  return parsed.success ? parsed.data : null;
}
