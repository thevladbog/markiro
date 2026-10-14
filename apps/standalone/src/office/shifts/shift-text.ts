import type { TFunction } from "i18next";

import type { OfficeShift } from "../../host/protocol.js";

/** Counts with the thousands apart by a no-break space, as Russian writes them: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

/**
 * The date pickers' texts in the office's words: `@markiro/ui`'s `DatePicker`
 * has Russian defaults of its own, and every text of the app goes through
 * i18n.
 */
export function datePickerTexts(t: TFunction) {
  return {
    placeholder: t("office.shifts.date.placeholder"),
    clearLabel: t("office.shifts.date.clear"),
    calendarLabel: t("office.shifts.date.calendar"),
    previousMonthLabel: t("office.shifts.date.previousMonth"),
    nextMonthLabel: t("office.shifts.date.nextMonth"),
  };
}

/**
 * «Выпуск» of a shift in the list and on its card: what it put in closed
 * boxes, as the cloud's list shows it, and none of a planned shift. A
 * validation shift (plan РЕЖ, Р11) puts codes in no box: its output is the
 * codes it accepted, never «0 шт · 0 кор.».
 */
export function shiftOutput(
  shift: Pick<OfficeShift, "status" | "mode" | "totals">,
  t: TFunction,
): string {
  if (shift.status === "planned") return t("office.common.none");
  if (shift.mode === "validation") {
    return t("office.shifts.outputUnits", { units: UNITS.format(shift.totals.acceptedUnits) });
  }
  return t("office.shifts.output", {
    units: UNITS.format(shift.totals.unitsInClosedBoxes),
    boxes: UNITS.format(shift.totals.closedBoxes),
  });
}
