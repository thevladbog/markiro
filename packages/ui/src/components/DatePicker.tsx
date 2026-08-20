import * as RadixPopover from "@radix-ui/react-popover";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { cn } from "../cn.js";
import { IconButton } from "./IconButton.js";
import { useOverlayPortalContainer } from "./OverlayLayer.js";

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

interface DatePickerBaseProps {
  value?: string;
  onValueChange?: (value: string | undefined) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  name?: string;
  id?: string;
  placeholder?: string;
  locale?: string;
  clearLabel?: string;
  calendarLabel?: string;
  previousMonthLabel?: string;
  nextMonthLabel?: string;
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

function capitalize(value: string) {
  return value ? `${value[0]!.toLocaleUpperCase()}${value.slice(1)}` : value;
}

function formatLocalizedDate(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  })
    .format(date)
    .replace(/\sг\.$/u, "");
}

function formatLocalizedMonth(date: Date, locale: string) {
  return capitalize(
    new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" })
      .format(date)
      .replace(/\sг\.$/u, ""),
  );
}

function getLocalizedWeekdays(locale: string) {
  const monday = createLocalDate(2024, 0, 1);
  return Array.from({ length: 7 }, (_, index) =>
    capitalize(
      new Intl.DateTimeFormat(locale, { weekday: "short" })
        .format(moveDateByDays(monday, index))
        .replace(/\.$/u, ""),
    ),
  );
}

function startOfMonth(date: Date) {
  return createLocalDate(date.getFullYear(), date.getMonth(), 1);
}

function moveDateByDays(date: Date, amount: number) {
  return createLocalDate(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function moveDateByMonths(date: Date, amount: number) {
  const targetMonth = createLocalDate(date.getFullYear(), date.getMonth() + amount, 1);
  const lastTargetDay = createLocalDate(
    targetMonth.getFullYear(),
    targetMonth.getMonth() + 1,
    0,
  ).getDate();

  return createLocalDate(
    targetMonth.getFullYear(),
    targetMonth.getMonth(),
    Math.min(date.getDate(), lastTargetDay),
  );
}

function isSameDate(left: Date, right: Date) {
  return formatIsoDate(left) === formatIsoDate(right);
}

export function getEffectivePopoverOpen(open: boolean, disabled: boolean) {
  return disabled ? false : open;
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
  locale = "ru-RU",
  clearLabel = "Очистить дату",
  calendarLabel = "Календарь",
  previousMonthLabel = "Предыдущий месяц",
  nextMonthLabel = "Следующий месяц",
  className,
  style,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: DatePickerProps) {
  const overlayPortalContainer = useOverlayPortalContainer();
  const autoId = useId();
  const datePickerId = id ?? `mk-date-picker-${autoId}`;
  const labelId = label ? `${datePickerId}-label` : undefined;
  const hintId = hint ? `${datePickerId}-hint` : undefined;
  const errorId = error ? `${datePickerId}-error` : undefined;
  const selectedDate = parseIsoDate(value);
  const clearActionLabel = `${clearLabel}${label ? `: ${label}` : ariaLabel ? `: ${ariaLabel}` : ""}`;
  const [open, setOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() =>
    startOfMonth(selectedDate ?? new Date()),
  );
  const [activeDate, setActiveDate] = useState(() => selectedDate ?? new Date());
  const activeDayRef = useRef<HTMLButtonElement>(null);
  const shouldFocusActiveDayRef = useRef(false);
  const calendarDays = useMemo(() => getCalendarDays(calendarMonth), [calendarMonth]);
  const weekdays = useMemo(() => getLocalizedWeekdays(locale), [locale]);

  useEffect(() => {
    const nextSelectedDate = parseIsoDate(value);
    if (nextSelectedDate) {
      setCalendarMonth(startOfMonth(nextSelectedDate));
      setActiveDate(nextSelectedDate);
    }
  }, [value]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open || !shouldFocusActiveDayRef.current || !activeDayRef.current) return;

    activeDayRef.current.focus();
    shouldFocusActiveDayRef.current = false;
  }, [activeDate, calendarMonth, open]);

  const moveActiveDate = (nextDate: Date) => {
    shouldFocusActiveDayRef.current = true;
    setActiveDate(nextDate);
    setCalendarMonth(startOfMonth(nextDate));
  };

  const changeCalendarMonth = (amount: number) => {
    const nextActiveDate = moveDateByMonths(activeDate, amount);
    setActiveDate(nextActiveDate);
    setCalendarMonth(startOfMonth(nextActiveDate));
  };

  const handleDayKeyDown = (event: KeyboardEvent<HTMLButtonElement>, day: Date) => {
    let nextDate: Date | undefined;

    switch (event.key) {
      case "ArrowLeft":
        nextDate = moveDateByDays(day, -1);
        break;
      case "ArrowRight":
        nextDate = moveDateByDays(day, 1);
        break;
      case "ArrowUp":
        nextDate = moveDateByDays(day, -7);
        break;
      case "ArrowDown":
        nextDate = moveDateByDays(day, 7);
        break;
      case "Home":
        nextDate = moveDateByDays(day, -((day.getDay() + 6) % 7));
        break;
      case "End":
        nextDate = moveDateByDays(day, 6 - ((day.getDay() + 6) % 7));
        break;
      case "PageUp":
        nextDate = moveDateByMonths(day, -1);
        break;
      case "PageDown":
        nextDate = moveDateByMonths(day, 1);
        break;
      default:
        return;
    }

    event.preventDefault();
    moveActiveDate(nextDate);
  };

  const selectDate = (date: Date) => {
    if (disabled) return;

    onValueChange?.(formatIsoDate(date));
    setOpen(false);
  };

  const clearDate = () => {
    if (disabled || !selectedDate) return;

    onValueChange?.(undefined);
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
      <RadixPopover.Root
        open={getEffectivePopoverOpen(open, disabled)}
        onOpenChange={(nextOpen) => {
          if (disabled) {
            setOpen(false);
            return;
          }

          if (nextOpen) {
            const nextActiveDate = selectedDate ?? new Date();
            shouldFocusActiveDayRef.current = true;
            setActiveDate(nextActiveDate);
            setCalendarMonth(startOfMonth(nextActiveDate));
          }
          setOpen(nextOpen);
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                flex: 1,
                minWidth: 0,
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
              <span>{selectedDate ? formatLocalizedDate(selectedDate, locale) : placeholder}</span>
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
          {selectedDate && (
            <IconButton
              type="button"
              variant="secondary"
              size="compact"
              aria-label={clearActionLabel}
              icon={<span aria-hidden="true">×</span>}
              disabled={disabled}
              onClick={clearDate}
            />
          )}
        </div>
        {name && (
          <input
            type="hidden"
            name={name}
            value={selectedDate ? formatIsoDate(selectedDate) : ""}
          />
        )}
        <RadixPopover.Portal
          {...(overlayPortalContainer === undefined ? {} : { container: overlayPortalContainer })}
        >
          <RadixPopover.Content
            data-mk-nested-overlay=""
            role="dialog"
            aria-label={calendarLabel}
            sideOffset={6}
            className="mk-date-picker__popover"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              activeDayRef.current?.focus();
              shouldFocusActiveDayRef.current = false;
            }}
            style={{
              zIndex: "var(--z-overlay-popover)",
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
                aria-label={previousMonthLabel}
                className="mk-date-picker__navigation"
                disabled={disabled}
                onClick={() => {
                  if (!disabled) changeCalendarMonth(-1);
                }}
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
                {formatLocalizedMonth(calendarMonth, locale)}
              </h2>
              <button
                type="button"
                aria-label={nextMonthLabel}
                className="mk-date-picker__navigation"
                disabled={disabled}
                onClick={() => {
                  if (!disabled) changeCalendarMonth(1);
                }}
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
                {weekdays.map((weekday) => (
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
                  {calendarDays.slice(weekIndex * 7, weekIndex * 7 + 7).map((day) => {
                    const outsideMonth = day.getMonth() !== calendarMonth.getMonth();
                    const isSelected = selectedDate
                      ? formatIsoDate(day) === formatIsoDate(selectedDate)
                      : false;
                    const isActive = isSameDate(day, activeDate);
                    const isToday = isSameDate(day, new Date());

                    return (
                      <span key={formatIsoDate(day)} role="gridcell" aria-selected={isSelected}>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={formatLocalizedDate(day, locale)}
                          aria-pressed={isSelected}
                          tabIndex={isActive ? 0 : -1}
                          ref={isActive ? activeDayRef : undefined}
                          className="mk-date-picker__day"
                          data-outside-month={outsideMonth ? "true" : undefined}
                          data-selected={isSelected ? "true" : undefined}
                          data-today={isToday ? "true" : undefined}
                          aria-current={isToday ? "date" : undefined}
                          onFocus={() => setActiveDate(day)}
                          onKeyDown={(event) => handleDayKeyDown(event, day)}
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
    </div>
  );
}
