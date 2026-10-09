import type { TFunction } from "i18next";

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
