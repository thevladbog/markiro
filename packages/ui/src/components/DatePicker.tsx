import * as RadixPopover from "@radix-ui/react-popover";
import { useEffect, useId, useState, type CSSProperties } from "react";

import { cn } from "../cn.js";

const MONTHS_NOMINATIVE = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
] as const;

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
] as const;

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

interface DatePickerBaseProps {
  value?: string;
  onValueChange?: (value: string | undefined) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  name?: string;
  id?: string;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  "aria-labelledby"?: string;
}

type DatePickerAccessibleName =
  { label: string; "aria-label"?: string } | { label?: undefined; "aria-label": string };

export type DatePickerProps = DatePickerBaseProps & DatePickerAccessibleName;

function createLocalDate(year: number, month: number, day: number) {
  return new Date(year, month, day);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** Parses only real calendar dates expressed by the public ISO contract. */
export function parseIsoDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = createLocalDate(year, month - 1, day);

  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : undefined;
}

/** Formats a local calendar date without converting it through UTC. */
export function formatIsoDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Returns a six-week Monday-first calendar grid for the given month. */
export function getCalendarDays(month: Date) {
  const firstDay = createLocalDate(month.getFullYear(), month.getMonth(), 1);
  const mondayFirstOffset = (firstDay.getDay() + 6) % 7;
  const firstGridDay = createLocalDate(
    firstDay.getFullYear(),
    firstDay.getMonth(),
    firstDay.getDate() - mondayFirstOffset,
  );

  return Array.from({ length: 42 }, (_, index) =>
    createLocalDate(
      firstGridDay.getFullYear(),
      firstGridDay.getMonth(),
      firstGridDay.getDate() + index,
    ),
  );
}

export function formatRussianDate(date: Date) {
  return `${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]} ${date.getFullYear()}`;
}

function formatRussianMonth(date: Date) {
  return `${MONTHS_NOMINATIVE[date.getMonth()]} ${date.getFullYear()}`;
}

function startOfMonth(date: Date) {
  return createLocalDate(date.getFullYear(), date.getMonth(), 1);
}

function moveMonth(month: Date, amount: number) {
  return createLocalDate(month.getFullYear(), month.getMonth() + amount, 1);
}

export function DatePicker({
  value,
  onValueChange,
  label,
  hint,
  error,
  disabled = false,
  name,
  id,
  placeholder = "Выберите дату",
  className,
  style,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: DatePickerProps) {
  const autoId = useId();
  const datePickerId = id ?? `mk-date-picker-${autoId}`;
  const labelId = label ? `${datePickerId}-label` : undefined;
  const hintId = hint ? `${datePickerId}-hint` : undefined;
  const errorId = error ? `${datePickerId}-error` : undefined;
  const selectedDate = parseIsoDate(value);
  const [open, setOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() =>
    startOfMonth(selectedDate ?? new Date()),
  );

  useEffect(() => {
    const nextSelectedDate = parseIsoDate(value);
    if (nextSelectedDate) setCalendarMonth(startOfMonth(nextSelectedDate));
  }, [value]);

  const selectDate = (date: Date) => {
    onValueChange?.(formatIsoDate(date));
    setOpen(false);
  };

  return (
    <div
      className={cn("mk-field", "mk-date-picker", className)}
      style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}
    >
      {label && (
        <label
          id={labelId}
          htmlFor={datePickerId}
          style={{ font: "var(--text-caption)", color: "var(--fg-2)" }}
        >
          {label}
        </label>
      )}
      <RadixPopover.Root open={open} onOpenChange={setOpen}>
        <RadixPopover.Trigger asChild>
          <button
            id={datePickerId}
            type="button"
            disabled={disabled}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy ?? (ariaLabel ? undefined : labelId)}
            aria-invalid={error ? true : undefined}
            aria-describedby={errorId ?? hintId}
            className="mk-date-picker__trigger"
            style={{
              appearance: "none",
              width: "100%",
              height: "var(--control-md)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "0 12px",
              borderRadius: "var(--r-2)",
              background: "var(--surface-card)",
              color: selectedDate ? "var(--fg-1)" : "var(--fg-3)",
              border: `1px solid ${error ? "var(--err-solid)" : "var(--line-strong)"}`,
              font: "var(--text-body)",
              textAlign: "left",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.45 : 1,
            }}
          >
            <span>{selectedDate ? formatRussianDate(selectedDate) : placeholder}</span>
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M16 3v4M8 3v4M3 10h18" />
            </svg>
          </button>
        </RadixPopover.Trigger>
        {name && (
          <input
            type="hidden"
            name={name}
            value={selectedDate ? formatIsoDate(selectedDate) : ""}
          />
        )}
        <RadixPopover.Portal>
          <RadixPopover.Content
            role="dialog"
            aria-label="Календарь"
            sideOffset={6}
            className="mk-date-picker__popover"
            style={{
              zIndex: 1000,
              width: 304,
              padding: 12,
              border: "1px solid var(--line-strong)",
              borderRadius: "var(--r-2)",
              background: "var(--surface-card)",
              color: "var(--fg-1)",
              boxShadow: "var(--shadow-3)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 12,
              }}
            >
              <button
                type="button"
                aria-label="Предыдущий месяц"
                className="mk-date-picker__navigation"
                onClick={() => setCalendarMonth((month) => moveMonth(month, -1))}
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <h2
                id={`${datePickerId}-month`}
                style={{ margin: 0, font: "var(--text-h3)", color: "var(--fg-1)" }}
              >
                {formatRussianMonth(calendarMonth)}
              </h2>
              <button
                type="button"
                aria-label="Следующий месяц"
                className="mk-date-picker__navigation"
                onClick={() => setCalendarMonth((month) => moveMonth(month, 1))}
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </div>
            <div role="grid" aria-labelledby={`${datePickerId}-month`}>
              <div
                role="row"
                style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 4 }}
              >
                {WEEKDAYS.map((weekday) => (
                  <span
                    key={weekday}
                    role="columnheader"
                    aria-label={weekday}
                    style={{
                      textAlign: "center",
                      font: "var(--text-caption)",
                      color: "var(--fg-3)",
                    }}
                  >
                    {weekday}
                  </span>
                ))}
              </div>
              {Array.from({ length: 6 }, (_, weekIndex) => (
                <div
                  key={weekIndex}
                  role="row"
                  style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}
                >
                  {getCalendarDays(calendarMonth)
                    .slice(weekIndex * 7, weekIndex * 7 + 7)
                    .map((day) => {
                      const outsideMonth = day.getMonth() !== calendarMonth.getMonth();
                      const isSelected = selectedDate
                        ? formatIsoDate(day) === formatIsoDate(selectedDate)
                        : false;

                      return (
                        <span key={formatIsoDate(day)} role="gridcell">
                          <button
                            type="button"
                            aria-label={formatRussianDate(day)}
                            aria-pressed={isSelected}
                            className="mk-date-picker__day"
                            data-outside-month={outsideMonth ? "true" : undefined}
                            data-selected={isSelected ? "true" : undefined}
                            onClick={() => selectDate(day)}
                          >
                            {day.getDate()}
                          </button>
                        </span>
                      );
                    })}
                </div>
              ))}
            </div>
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>
      {(error || hint) && (
        <span
          id={error ? errorId : hintId}
          style={{ font: "var(--text-body-sm)", color: error ? "var(--err-fg)" : "var(--fg-3)" }}
        >
          {error || hint}
        </span>
      )}
      <style>{`
        .mk-date-picker__trigger:focus-visible,
        .mk-date-picker__navigation:focus-visible,
        .mk-date-picker__day:focus-visible {
          outline: 2px solid var(--focus-ring);
          outline-offset: 2px;
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent);
        }
        .mk-date-picker__navigation {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: var(--control-sm);
          height: var(--control-sm);
          padding: 0;
          border: 1px solid var(--line-strong);
          border-radius: var(--r-1);
          background: var(--surface-card);
          color: var(--fg-1);
          cursor: pointer;
        }
        .mk-date-picker__navigation:hover {
          background: var(--surface-panel);
        }
        .mk-date-picker__day {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          aspect-ratio: 1;
          min-height: var(--control-sm);
          padding: 0;
          border: 1px solid transparent;
          border-radius: var(--r-1);
          background: transparent;
          color: var(--fg-1);
          font: var(--text-body-sm);
          cursor: pointer;
        }
        .mk-date-picker__day:hover {
          background: var(--surface-panel);
        }
        .mk-date-picker__day[data-outside-month="true"] {
          color: var(--fg-disabled);
        }
        .mk-date-picker__day[data-selected="true"] {
          background: var(--surface-inverse);
          color: var(--fg-on-inverse);
        }
      `}</style>
    </div>
  );
}
