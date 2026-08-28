import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type { DashboardOverviewDto, DashboardPeriod } from "./api.js";
import { resolveDateTimeLocale } from "../../lib/datetime.js";

/* eslint-disable no-restricted-syntax -- The approved dashboard specification requires native aria-pressed segmented buttons. */

type DashboardMetric = "rate" | "output";

interface ProductionDynamicsProps {
  overview: DashboardOverviewDto;
  period: DashboardPeriod;
  onPeriodChange: (period: DashboardPeriod) => void;
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

const PERIODS: DashboardPeriod[] = ["today", "7d", "30d", "12w"];

export function ProductionDynamics({ overview, period, onPeriodChange }: ProductionDynamicsProps) {
  const { t, i18n } = useTranslation();
  const [metric, setMetric] = useState<DashboardMetric>("rate");
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

  return (
    <section aria-labelledby="dashboard-dynamics-title" className="mk-dashboard-dynamics">
      <div className="mk-dashboard-panel-header mk-dashboard-dynamics__header">
        <div>
          <h2 id="dashboard-dynamics-title">{t("pages.dashboard.dynamics.title")}</h2>
          <p>{t("pages.dashboard.dynamics.shiftHourNote")}</p>
        </div>
        <div className="mk-dashboard-dynamics__controls">
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
  missingRate,
}: {
  title: string;
  regionLabel: string;
  series: SeriesDefinition[];
  number: Intl.NumberFormat;
  missingRate: boolean;
}) {
  const { t } = useTranslation();

  return (
    <section className="mk-dashboard-mode-chart" role="region" aria-label={regionLabel}>
      <h3>{title}</h3>
      <div className="mk-dashboard-mode-chart__series">
        {series.map((item) => (
          <SeriesChart key={item.key} series={item} number={number} />
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

function SeriesChart({ series, number }: { series: SeriesDefinition; number: Intl.NumberFormat }) {
  const { t } = useTranslation();
  const numericValues = series.points.flatMap((point) =>
    point.value === null ? [] : [point.value],
  );
  const maximum = Math.max(0, ...numericValues);
  const hasProduction = series.points.some((point) => point.hasOutput);

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
                <span className="mk-dashboard-bars__value">{formattedValue}</span>
                <span
                  className={`mk-dashboard-bars__track${point.value === null ? " mk-dashboard-bars__track--missing" : ""}`}
                  role="img"
                  aria-label={ariaLabel}
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
          ...(sameYear ? {} : { year: "numeric" as const }),
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

  return dates.map((date, index) => {
    const previous = calendarParts[index - 1];
    const current = calendarParts[index];
    const startsNewMonth =
      previous !== undefined &&
      current !== undefined &&
      (previous.year !== current.year || previous.month !== current.month);
    return {
      compact: compactFormatter.format(date),
      complete: completeFormatter.format(date),
      show:
        buckets.length <= 12 ||
        index === 0 ||
        index === buckets.length - 1 ||
        index % labelStride === 0 ||
        startsNewMonth,
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
