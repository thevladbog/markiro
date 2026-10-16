import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, DatePicker } from "@markiro/ui";

import { OfficeIcon } from "../OfficeIcon.js";
import { datePickerTexts } from "../shifts/shift-text.js";

/**
 * The one layer (L1) of a list page: the filters, the table with its pinned heading and the pagination
 * bar pinned under it share one hairline card. It is as tall as its rows up to the room the window
 * leaves, and past that the rows scroll inside it, so the heading and the pagination stay in view
 * (the pinned layout contract: `.office-list-card` shrinks and bounds its table).
 */
export function ListCard({ children }: { children: ReactNode }) {
  return <section className="office-list-card">{children}</section>;
}

export interface ListFiltersProps {
  /** The group's accessible name. */
  label: string;
  /** «Найдено: 12 из 214», in a live region. */
  resultSummary?: ReactNode;
  /** The «Сбросить» button, shown only when there is something to reset. */
  onReset?: (() => void) | undefined;
  resetLabel?: string;
  children: ReactNode;
}

/**
 * The filter row inside a list card: fields with their label above, and at the right the count of
 * what was found and «Сбросить». Date ranges sit on one line (`DateRange`).
 */
export function ListFilters({
  label,
  resultSummary,
  onReset,
  resetLabel,
  children,
}: ListFiltersProps) {
  const { t } = useTranslation();
  return (
    <div className="office-list-filters" role="group" aria-label={label}>
      <div className="office-list-filters__fields">{children}</div>
      <div className="office-list-filters__aside">
        <p className="office-list-filters__found" aria-live="polite">
          {resultSummary}
        </p>
        {onReset !== undefined && (
          <Button
            variant="secondary"
            icon={<OfficeIcon name="reset" size={20} />}
            onClick={onReset}
          >
            {resetLabel ?? t("office.common.reset")}
          </Button>
        )}
      </div>
    </div>
  );
}

export interface DateRangeProps {
  /** The group's visible name above the two fields: «Дата производства». */
  label: string;
  /** The accessible names of the two fields: «Дата производства с», «Дата производства по». */
  fromLabel: string;
  toLabel: string;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  /** The range's error, shown under the pair (on the «по» field). */
  error?: string | undefined;
}

/**
 * A period as one group on one line: «с — по». The pickers keep their full accessible names; the
 * placeholders say «с» and «по», and the group's label says what the period is of. Each field is
 * wide enough for «10 октября 2026» (the date never wraps).
 */
export function DateRange({
  label,
  fromLabel,
  toLabel,
  from,
  to,
  onFrom,
  onTo,
  error,
}: DateRangeProps) {
  const { t } = useTranslation();
  const texts = datePickerTexts(t);
  return (
    <div className="office-range" role="group" aria-label={label}>
      <span className="office-range__label" aria-hidden="true">
        {label}
      </span>
      <div className="office-range__row">
        <DatePicker
          aria-label={fromLabel}
          {...texts}
          placeholder={t("office.common.range.from")}
          {...(from === "" ? {} : { value: from })}
          onValueChange={(value) => onFrom(value ?? "")}
        />
        <span className="office-range__dash" aria-hidden="true">
          —
        </span>
        <DatePicker
          aria-label={toLabel}
          {...texts}
          placeholder={t("office.common.range.to")}
          {...(to === "" ? {} : { value: to })}
          {...(error === undefined ? {} : { error })}
          onValueChange={(value) => onTo(value ?? "")}
        />
      </div>
    </div>
  );
}
