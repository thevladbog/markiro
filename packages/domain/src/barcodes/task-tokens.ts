/**
 * Frozen v1 namespace for the printed shift task form's Data Matrix.
 *
 * The prefix lives in the domain rather than beside the API's shift DTOs
 * because three implementations read it: the API renders it, the Station
 * parses it locally against its loaded shift list, and the handheld repeats
 * the rule in Kotlin. A second copy of the literal is how the three drift.
 */
export const SHIFT_TASK_BARCODE_PREFIX = "markiro:shift:v1:";

/**
 * The shift id rule, matched against the lowercased payload: an 8-4-4-4-12
 * hex UUID with a version nibble of 1-8 and a variant nibble of 8/9/a/b, or
 * the nil UUID (00000000-0000-0000-0000-000000000000) or the max UUID
 * (ffffffff-ffff-ffff-ffff-ffffffffffff) explicitly, in any case. Input is
 * case-insensitive; the returned id is always lowercase, so one shift has one
 * identity.
 *
 * This is an explicit, self-contained rule -- not delegated to a validation
 * library -- because it must match `ShiftTaskToken` in the handheld's Kotlin
 * (`core/barcode/ShiftTaskToken.kt`) case for case. Change both or neither.
 */
const SHIFT_ID_PATTERN =
  /^(?:00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

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
  const candidate = barcode.slice(SHIFT_TASK_BARCODE_PREFIX.length).toLowerCase();
  return SHIFT_ID_PATTERN.test(candidate) ? candidate : null;
}
