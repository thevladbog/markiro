/** Stable reasons accepted when a station closes a shift with a plan mismatch. */
export const SHIFT_CLOSE_REASON_CODES = [
  "production_defect",
  "material_shortage",
  "equipment_stop",
  "production_order_changed",
  "planned_quantity_error",
  "other_production_deviation",
] as const;

export type ShiftCloseReasonCode = (typeof SHIFT_CLOSE_REASON_CODES)[number];

export function shiftCloseReasonRequired(plannedQty: number | null, actualQty: number): boolean {
  return plannedQty !== null && plannedQty !== actualQty;
}

export function isShiftCloseReasonCode(value: unknown): value is ShiftCloseReasonCode {
  return (
    typeof value === "string" && (SHIFT_CLOSE_REASON_CODES as readonly string[]).includes(value)
  );
}
