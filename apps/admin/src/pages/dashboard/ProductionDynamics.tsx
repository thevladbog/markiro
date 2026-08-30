import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { DashboardOverviewDto, DashboardPeriod } from "./api.js";
import { resolveDateTimeLocale } from "../../lib/datetime.js";

/* eslint-disable no-restricted-syntax -- The approved dashboard specification requires native aria-pressed segmented buttons. */

type DashboardMetric = "rate" | "output";

interface ProductionDynamicsProps {
  overview: DashboardOverviewDto;
  period: DashboardPeriod;
  onPeriodChange: (period: DashboardPeriod) => void;
  refreshing: boolean;
}

interface SeriesPoint {
  label: string;
  accessibleLabel: string;
  showLabel: boolean;
  value: number | null;
  hasOutput: boolean;
}

interface BucketLabel {
  compact: string;
  complete: string;
  show: boolean;
}

interface SeriesDefinition {
  key: string;
  label: string;
  unit: string;
  points: SeriesPoint[];
  currentValue: number | null;
  comparisonValue: number | null;
  emptyText?: string;
}

interface BarTooltipState {
  owner: string;
  index: number;
  text: string;
  left: number;
  top: number;
}

interface BarTooltipProps {
  tooltip: BarTooltipState | null;
  tooltipId: string;
  onTooltipShow: (owner: string, index: number, text: string, target: HTMLElement) => void;
  onTooltipHide: (owner: string) => void;
  onTooltipDismiss: (owner: string) => void;
}

const PERIODS: DashboardPeriod[] = ["today", "7d", "30d", "12w"];

export function ProductionDynamics({
  overview,
  period,
  onPeriodChange,
  refreshing,
}: ProductionDynamicsProps) {
  const { t, i18n } = useTranslation();
  const [metric, setMetric] = useState<DashboardMetric>("rate");
  const [barTooltip, setBarTooltip] = useState<BarTooltipState | null>(null);
  const tooltipHideTimer = useRef<number | undefined>(undefined);
  const barTooltipId = useId();
  const dynamics = overview.dynamics;
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const metricLabel = t(`pages.dashboard.dynamics.${metric}`);
  const bucketLabels = formatBucketLabels(
    dynamics.buckets,
    dynamics.grain,
    overview.timeZone,
    i18n.language,
  );
  const validationSeries = getValidationSeries(overview, metric, bucketLabels, t);
  const aggregationSeries = getAggregationSeries(overview, metric, bucketLabels, t);

  useEffect(
    () => () => {
      if (tooltipHideTimer.current !== undefined) {
        window.clearTimeout(tooltipHideTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (barTooltip === null) return;

    function dismissTooltipOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (tooltipHideTimer.current !== undefined) {
        window.clearTimeout(tooltipHideTimer.current);
        tooltipHideTimer.current = undefined;
      }
      setBarTooltip(null);
    }

    document.addEventListener("keydown", dismissTooltipOnEscape);
    return () => document.removeEventListener("keydown", dismissTooltipOnEscape);
  }, [barTooltip]);

  function keepBarTooltipOpen() {
    if (tooltipHideTimer.current !== undefined) {
      window.clearTimeout(tooltipHideTimer.current);
      tooltipHideTimer.current = undefined;
    }
  }

  function showBarTooltip(owner: string, index: number, text: string, target: HTMLElement) {
    keepBarTooltipOpen();
    const bounds = target.getBoundingClientRect();
    const tooltipHalfWidth = Math.min(140, Math.max(80, window.innerWidth / 2 - 12));
    const left = Math.min(
      Math.max(bounds.left + bounds.width / 2, tooltipHalfWidth + 12),
      window.innerWidth - tooltipHalfWidth - 12,
    );
    setBarTooltip({
      owner,
      index,
      text,
      left,
      top: Math.max(12, bounds.top - 8),
    });
  }

  function dismissBarTooltip(owner: string) {
    keepBarTooltipOpen();
    setBarTooltip((current) => (current?.owner === owner ? null : current));
  }

  function hideBarTooltip(owner: string) {
    keepBarTooltipOpen();
    tooltipHideTimer.current = window.setTimeout(() => {
      tooltipHideTimer.current = undefined;
      setBarTooltip((current) => (current?.owner === owner ? null : current));
    }, 120);
  }

  return (
    <section aria-labelledby="dashboard-dynamics-title" className="mk-dashboard-dynamics">
      <div className="mk-dashboard-panel-header mk-dashboard-dynamics__header">
        <div>
          <h2 id="dashboard-dynamics-title">{t("pages.dashboard.dynamics.title")}</h2>
          <p>{t("pages.dashboard.dynamics.shiftHourNote")}</p>
        </div>
        <div className="mk-dashboard-dynamics__controls">
          <span className="mk-dashboard-dynamics__refresh-slot">
            {refreshing ? (
              <span
                className="mk-dashboard-refreshing"
                role="status"
                aria-label={t("pages.dashboard.refreshing.title")}
                title={t("pages.dashboard.refreshing.hint")}
              />
            ) : null}
          </span>
          <div
            className="mk-dashboard-segmented"
            role="group"
            aria-label={t("pages.dashboard.dynamics.metricControl")}
          >
            {(["rate", "output"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={metric === value}
                onClick={() => setMetric(value)}
              >
                {t(`pages.dashboard.dynamics.${value}`)}
              </button>
            ))}
          </div>
          <div
            className="mk-dashboard-segmented"
            role="group"
            aria-label={t("pages.dashboard.dynamics.periodControl")}
          >
            {PERIODS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={period === value}
                onClick={() => onPeriodChange(value)}
              >
                {t(`pages.dashboard.dynamics.period.${value}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mk-dashboard-dynamics__charts">
        <ModeChart
          title={t("pages.dashboard.dynamics.validation")}
          regionLabel={t("pages.dashboard.dynamics.regionLabel", {
            mode: t("pages.dashboard.dynamics.validation"),
            metric: metricLabel.toLocaleLowerCase(i18n.language),
          })}
          series={[validationSeries]}
          number={number}
          refreshing={refreshing}
          tooltip={barTooltip}
          tooltipId={barTooltipId}
          onTooltipShow={showBarTooltip}
          onTooltipHide={hideBarTooltip}
          onTooltipDismiss={dismissBarTooltip}
          missingRate={
            metric === "rate" &&
            validationSeries.points.some((point) => point.value === null && point.hasOutput)
          }
        />
        <ModeChart
          title={t("pages.dashboard.dynamics.aggregation")}
          regionLabel={t("pages.dashboard.dynamics.regionLabel", {
            mode: t("pages.dashboard.dynamics.aggregation"),
            metric: metricLabel.toLocaleLowerCase(i18n.language),
          })}
          series={aggregationSeries}
          number={number}
          refreshing={refreshing}
          tooltip={barTooltip}
          tooltipId={barTooltipId}
          onTooltipShow={showBarTooltip}
          onTooltipHide={hideBarTooltip}
          onTooltipDismiss={dismissBarTooltip}
          missingRate={
            metric === "rate" &&
            aggregationSeries.some((series) =>
              series.points.some((point) => point.value === null && point.hasOutput),
            )
          }
        />
      </div>

      <p className="mk-dashboard-dynamics__provenance">
        {t("pages.dashboard.dynamics.provenance", {
          version: overview.metricVersion,
          sources: dynamics.quality.sources.join(", "),
        })}
      </p>
      {barTooltip && typeof document !== "undefined"
        ? createPortal(
            <span
              id={barTooltipId}
              className="mk-dashboard-bar-tooltip"
              role="tooltip"
              style={{ left: barTooltip.left, top: barTooltip.top }}
              onMouseEnter={keepBarTooltipOpen}
              onMouseLeave={() => hideBarTooltip(barTooltip.owner)}
            >
              {barTooltip.text}
            </span>,
            document.body,
          )
        : null}
    </section>
  );
}

function getValidationSeries(
  overview: DashboardOverviewDto,
  metric: DashboardMetric,
  bucketLabels: BucketLabel[],
  t: ReturnType<typeof useTranslation>["t"],
): SeriesDefinition {
  const dynamics = overview.dynamics;
  return {
    key: "validation-units",
    label: t("pages.dashboard.dynamics.series.acceptedUnits"),
    unit: t(
      metric === "rate"
        ? "pages.dashboard.dynamics.units.unitsPerShiftHour"
        : "pages.dashboard.dynamics.units.units",
    ),
    points: dynamics.buckets.map((bucket, index) => ({
      ...pointLabel(bucket.label, bucketLabels[index]),
      value:
        metric === "rate" ? bucket.validation.unitsPerShiftHour : bucket.validation.acceptedUnits,
      hasOutput: bucket.validation.acceptedUnits > 0,
    })),
    currentValue:
      metric === "rate"
        ? dynamics.currentWindow.validation.unitsPerShiftHour
        : dynamics.currentWindow.validation.acceptedUnits,
    comparisonValue:
      metric === "rate"
        ? dynamics.comparisonWindow.validation.unitsPerShiftHour
        : dynamics.comparisonWindow.validation.acceptedUnits,
    emptyText: t("pages.dashboard.dynamics.empty.validation"),
  };
}

function getAggregationSeries(
  overview: DashboardOverviewDto,
  metric: DashboardMetric,
  bucketLabels: BucketLabel[],
  t: ReturnType<typeof useTranslation>["t"],
): SeriesDefinition[] {
  const dynamics = overview.dynamics;
  return [
    {
      key: "aggregation-boxes",
      label: t("pages.dashboard.dynamics.series.closedBoxes"),
      unit: t(
        metric === "rate"
          ? "pages.dashboard.dynamics.units.boxesPerShiftHour"
          : "pages.dashboard.dynamics.units.boxes",
      ),
      points: dynamics.buckets.map((bucket, index) => ({
        ...pointLabel(bucket.label, bucketLabels[index]),
        value:
          metric === "rate" ? bucket.aggregation.boxesPerShiftHour : bucket.aggregation.closedBoxes,
        hasOutput: bucket.aggregation.closedBoxes > 0,
      })),
      currentValue:
        metric === "rate"
          ? dynamics.currentWindow.aggregation.boxesPerShiftHour
          : dynamics.currentWindow.aggregation.closedBoxes,
      comparisonValue:
        metric === "rate"
          ? dynamics.comparisonWindow.aggregation.boxesPerShiftHour
          : dynamics.comparisonWindow.aggregation.closedBoxes,
      emptyText: t("pages.dashboard.dynamics.empty.aggregation"),
    },
    {
      key: "aggregation-units",
      label: t("pages.dashboard.dynamics.series.containedUnits"),
      unit: t(
        metric === "rate"
          ? "pages.dashboard.dynamics.units.unitsPerShiftHour"
          : "pages.dashboard.dynamics.units.units",
      ),
      points: dynamics.buckets.map((bucket, index) => ({
        ...pointLabel(bucket.label, bucketLabels[index]),
        value:
          metric === "rate"
            ? bucket.aggregation.containedUnitsPerShiftHour
            : bucket.aggregation.containedUnits,
        hasOutput: bucket.aggregation.containedUnits > 0,
      })),
      currentValue:
        metric === "rate"
          ? dynamics.currentWindow.aggregation.containedUnitsPerShiftHour
          : dynamics.currentWindow.aggregation.containedUnits,
      comparisonValue:
        metric === "rate"
          ? dynamics.comparisonWindow.aggregation.containedUnitsPerShiftHour
          : dynamics.comparisonWindow.aggregation.containedUnits,
      emptyText: t("pages.dashboard.dynamics.empty.containedUnits"),
    },
  ];
}

function ModeChart({
  title,
  regionLabel,
  series,
  number,
  refreshing,
  tooltip,
  tooltipId,
  onTooltipShow,
  onTooltipHide,
  onTooltipDismiss,
  missingRate,
}: {
  title: string;
  regionLabel: string;
  series: SeriesDefinition[];
  number: Intl.NumberFormat;
  refreshing: boolean;
  missingRate: boolean;
} & BarTooltipProps) {
  const { t } = useTranslation();

  return (
    <section
      className="mk-dashboard-mode-chart"
      role="region"
      aria-label={regionLabel}
      aria-busy={refreshing}
    >
      <h3>{title}</h3>
      <div className="mk-dashboard-mode-chart__series">
        {series.map((item) => (
          <SeriesChart
            key={item.key}
            series={item}
            number={number}
            tooltip={tooltip}
            tooltipId={tooltipId}
            onTooltipShow={onTooltipShow}
            onTooltipHide={onTooltipHide}
            onTooltipDismiss={onTooltipDismiss}
          />
        ))}
      </div>
      {missingRate ? (
        <p className="mk-dashboard-mode-chart__notice">
          {t("pages.dashboard.dynamics.missingRate")}
        </p>
      ) : null}
    </section>
  );
}

function SeriesChart({
  series,
  number,
  tooltip,
  tooltipId,
  onTooltipShow,
  onTooltipHide,
  onTooltipDismiss,
}: { series: SeriesDefinition; number: Intl.NumberFormat } & BarTooltipProps) {
  const { t } = useTranslation();
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const numericValues = series.points.flatMap((point) =>
    point.value === null ? [] : [point.value],
  );
  const maximum = Math.max(0, ...numericValues);
  const hasProduction = series.points.some((point) => point.hasOutput);
  const showStaticValues = series.points.length <= 7;
  const activeKeyboardIndex = Math.min(keyboardIndex, Math.max(0, series.points.length - 1));

  function moveKeyboardFocus(event: ReactKeyboardEvent<HTMLElement>, index: number) {
    if (event.key === "Escape") {
      event.preventDefault();
      onTooltipDismiss(series.key);
      return;
    }

    const lastIndex = series.points.length - 1;
    let nextIndex: number | undefined;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = index === lastIndex ? 0 : index + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = index === 0 ? lastIndex : index - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex === undefined || nextIndex < 0) return;
    event.preventDefault();
    setKeyboardIndex(nextIndex);
    barRefs.current[nextIndex]?.focus();
  }

  return (
    <div className="mk-dashboard-series">
      <div className="mk-dashboard-series__heading">
        <span>{series.label}</span>
        <Comparison
          current={series.currentValue}
          previous={series.comparisonValue}
          unit={series.unit}
          number={number}
        />
      </div>
      <div className="mk-dashboard-series__scroll" aria-label={series.label}>
        <ol
          className="mk-dashboard-bars"
          style={
            {
              "--mk-dashboard-point-count": Math.max(1, series.points.length),
            } as CSSProperties
          }
        >
          {series.points.map((point, index) => {
            const formattedValue = formatValue(point.value, number);
            const ratio = point.value === null || maximum === 0 ? 0 : point.value / maximum;
            const style = {
              "--mk-dashboard-bar-scale": Math.max(0, Math.min(1, ratio)),
            } as CSSProperties;
            const ariaLabel = t("pages.dashboard.dynamics.barLabel", {
              label: point.accessibleLabel,
              value: formattedValue,
              unit: series.unit,
            });

            return (
              <li key={`${point.label}-${index}`}>
                {showStaticValues ? (
                  <span className="mk-dashboard-bars__value">{formattedValue}</span>
                ) : null}
                <span
                  ref={(element) => {
                    barRefs.current[index] = element;
                  }}
                  className={`mk-dashboard-bars__track${point.value === null ? " mk-dashboard-bars__track--missing" : ""}`}
                  role="img"
                  aria-label={ariaLabel}
                  aria-describedby={
                    tooltip?.owner === series.key && tooltip.index === index ? tooltipId : undefined
                  }
                  tabIndex={index === activeKeyboardIndex ? 0 : -1}
                  onMouseEnter={(event) =>
                    onTooltipShow(series.key, index, ariaLabel, event.currentTarget)
                  }
                  onMouseLeave={(event) => {
                    if (document.activeElement !== event.currentTarget) {
                      onTooltipHide(series.key);
                    }
                  }}
                  onFocus={(event) => {
                    setKeyboardIndex(index);
                    onTooltipShow(series.key, index, ariaLabel, event.currentTarget);
                  }}
                  onBlur={() => onTooltipDismiss(series.key)}
                  onKeyDown={(event) => moveKeyboardFocus(event, index)}
                >
                  <span className="mk-dashboard-bars__bar" style={style} />
                </span>
                <span
                  className={`mk-dashboard-bars__label${point.showLabel ? "" : " mk-dashboard-bars__label--hidden"}`}
                  title={point.accessibleLabel}
                  aria-hidden="true"
                >
                  {point.label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <ul className="mk-dashboard-sr-only">
        {series.points.map((point, index) => (
          <li key={`${point.label}-text-${index}`}>
            {t("pages.dashboard.dynamics.barLabel", {
              label: point.accessibleLabel,
              value: formatValue(point.value, number),
              unit: series.unit,
            })}
          </li>
        ))}
      </ul>
      {!hasProduction ? <p className="mk-dashboard-series__empty">{series.emptyText}</p> : null}
    </div>
  );
}

function Comparison({
  current,
  previous,
  unit,
  number,
}: {
  current: number | null;
  previous: number | null;
  unit: string;
  number: Intl.NumberFormat;
}) {
  const { t } = useTranslation();
  const comparison = getComparison(current, previous);

  return (
    <div className="mk-dashboard-comparison">
      <span>
        {t("pages.dashboard.dynamics.current")}: {formatValue(current, number)} {unit}
      </span>
      <span
        className={`mk-dashboard-comparison__delta mk-dashboard-comparison__delta--${comparison.direction}`}
      >
        {t(`pages.dashboard.dynamics.comparison.${comparison.direction}`, {
          value: comparison.percentage === null ? undefined : number.format(comparison.percentage),
        })}
      </span>
    </div>
  );
}

function getComparison(
  current: number | null,
  previous: number | null,
): { direction: "up" | "down" | "same" | "unavailable"; percentage: number | null } {
  if (current === null || previous === null || previous === 0) {
    return { direction: "unavailable", percentage: null };
  }

  const percentage = Math.abs(((current - previous) / previous) * 100);
  if (Math.abs(current - previous) < Number.EPSILON) {
    return { direction: "same", percentage: 0 };
  }
  return { direction: current > previous ? "up" : "down", percentage };
}

function formatValue(value: number | null, number: Intl.NumberFormat): string {
  return value === null ? "—" : number.format(value);
}

function pointLabel(
  fallback: string,
  formatted?: BucketLabel,
): Pick<SeriesPoint, "label" | "accessibleLabel" | "showLabel"> {
  return formatted
    ? { label: formatted.compact, accessibleLabel: formatted.complete, showLabel: formatted.show }
    : { label: fallback, accessibleLabel: fallback, showLabel: true };
}

function formatBucketLabels(
  buckets: DashboardOverviewDto["dynamics"]["buckets"],
  grain: DashboardOverviewDto["dynamics"]["grain"],
  timeZone: string,
  language: string,
): BucketLabel[] {
  const locale = resolveDateTimeLocale(language);
  const dates = buckets.map((bucket) => new Date(bucket.start));
  const calendarFormatter = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  });
  const calendarParts = dates.map((date) => dateParts(calendarFormatter, date));
  const years = new Set(calendarParts.map((parts) => parts.year));
  const months = new Set(calendarParts.map((parts) => `${parts.year}-${parts.month}`));
  const sameYear = years.size === 1;
  const sameMonth = months.size === 1;
  const compactFormatter =
    grain === "hour"
      ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone })
      : new Intl.DateTimeFormat(locale, {
          day: "2-digit",
          ...(sameMonth ? {} : { month: "2-digit" as const }),
          timeZone,
        });
  const compactYearFormatter = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  });
  const completeFormatter = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(grain === "hour" ? { hour: "2-digit" as const, minute: "2-digit" as const } : {}),
    timeZone,
  });
  const labelStride = Math.max(1, Math.ceil((buckets.length - 1) / 6));
  const lastIndex = buckets.length - 1;
  const denseLabels = buckets.length > 7 || (!sameYear && buckets.length > 2);
  const visibleLabelIndexes = new Set<number>();

  if (lastIndex >= 0) {
    visibleLabelIndexes.add(0);
    visibleLabelIndexes.add(lastIndex);
  }

  if (denseLabels) {
    calendarParts.forEach((current, index) => {
      const previous = calendarParts[index - 1];
      const startsNewMonth =
        previous !== undefined &&
        current !== undefined &&
        (previous.year !== current.year || previous.month !== current.month);
      if (startsNewMonth && index >= 2 && lastIndex - index >= 2) {
        visibleLabelIndexes.add(index);
      }
    });

    for (let index = 0; index <= lastIndex; index += labelStride) {
      if ([...visibleLabelIndexes].every((visibleIndex) => Math.abs(visibleIndex - index) >= 2)) {
        visibleLabelIndexes.add(index);
      }
    }
  }

  return dates.map((date, index) => {
    const previous = calendarParts[index - 1];
    const current = calendarParts[index];
    const startsNewYear =
      previous !== undefined && current !== undefined && previous.year !== current.year;
    const includesContextualYear =
      grain !== "hour" && !sameYear && (index === 0 || index === lastIndex || startsNewYear);

    return {
      compact: (includesContextualYear ? compactYearFormatter : compactFormatter).format(date),
      complete: completeFormatter.format(date),
      show: !denseLabels || visibleLabelIndexes.has(index),
    };
  });
}

function dateParts(
  formatter: Intl.DateTimeFormat,
  date: Date,
): { year: string; month: string; day: string } {
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
      .map((part) => [part.type, part.value]),
  );
  return { year: values.year ?? "", month: values.month ?? "", day: values.day ?? "" };
}
