import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Segmented } from "../list/Segmented.js";
import { BlockError, PanelHead, Skel } from "./blocks.js";
import { chartScale, signedDifference, type DayFigures } from "./dashboard-model.js";
import { civilDayLabel } from "./overview-time.js";
import { Glyph } from "./OverviewIcon.js";
import type { BlockState } from "./use-overview-data.js";

const NUMBER = new Intl.NumberFormat("ru-RU");
type View = "graph" | "table";

export interface OutputChartProps {
  state: BlockState;
  error: unknown;
  onRetry: () => void;
  /** Seven days, oldest first, the last one today. */
  days: readonly DayFigures[];
  /** The wall time of the figures: the organization's now, or the last answer's while the link is down. */
  asOf: string;
  /** A site with nothing yet: a placeholder instead of empty columns. */
  empty: boolean;
}

/**
 * «Выпуск по дням · 7 дней» (phase 1: per-day totals of the shifts, since the host gives no hourly
 * buckets yet). Today is a solid column, past days outlined columns, so the colour is never the
 * only mark; the same figures stand in a real table that is always in the page (hidden from the
 * eye in the chart view, read aloud by a screen reader), and the chart's `role="img"` says the
 * outline in words. Nothing animates.
 */
export function OutputChart({ state, error, onRetry, days, asOf, empty }: OutputChartProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("graph");
  const tableId = useId();
  const title = t("office.overview.chart.title");
  const head = (
    <PanelHead icon={<Glyph name="chart" size={20} />} title={title}>
      {state === "ready" && !empty && (
        <Segmented
          label={t("office.overview.chart.view")}
          value={view}
          onChange={setView}
          options={[
            { id: "graph", label: t("office.overview.chart.graph") },
            { id: "table", label: t("office.overview.chart.table") },
          ]}
        />
      )}
    </PanelHead>
  );
  if (state === "error") {
    return (
      <section className="ov-panel ov-chart" aria-labelledby={`${tableId}-h`}>
        <div className="ov-panel__head ov-panel__head--bare">
          <span className="ov-panel__icon">
            <Glyph name="chart" size={20} />
          </span>
          <h2 className="ov-panel__title" id={`${tableId}-h`}>
            {title}
          </h2>
        </div>
        <BlockError
          layout="center"
          title={t("office.overview.chart.errorTitle")}
          error={error}
          onRetry={onRetry}
        />
      </section>
    );
  }
  if (state === "loading") {
    return (
      <section className="ov-panel ov-chart" aria-busy="true" aria-label={title}>
        <div className="ov-panel__head ov-panel__head--bare">
          <span className="ov-panel__icon">
            <Glyph name="chart" size={20} />
          </span>
          <h2 className="ov-panel__title">{title}</h2>
        </div>
        <div className="ov-chart__skeleton" aria-hidden="true">
          {[40, 80, 55, 90, 62, 100, 70].map((height, index) => (
            <Skel key={index} className="ov-skel--bar" style={{ height: `${height}%` }} />
          ))}
        </div>
      </section>
    );
  }
  const today = days[days.length - 1];
  const yesterday = days[days.length - 2];
  const max = Math.max(0, ...days.map((day) => day.units));
  const scale = chartScale(max);
  const ticks = Array.from(
    { length: scale.top / scale.step + 1 },
    (_, index) => index * scale.step,
  );
  const peak = days.reduce<DayFigures | null>(
    (best, day) => (day.units > (best?.units ?? 0) ? day : best),
    null,
  );
  const dayName = (date: string) => {
    const label = civilDayLabel(date);
    return `${label.weekday} ${label.day}`;
  };
  const summary =
    today === undefined || yesterday === undefined || peak === null
      ? t("office.overview.chart.summaryNone")
      : t("office.overview.chart.summary", {
          today: NUMBER.format(today.units),
          yesterday: NUMBER.format(yesterday.units),
          peak: NUMBER.format(peak.units),
          peakDay: dayName(peak.date),
        });
  const metrics = [
    { id: "units", label: t("office.overview.chart.units"), of: (d: DayFigures) => d.units },
    { id: "boxes", label: t("office.overview.chart.boxes"), of: (d: DayFigures) => d.boxes },
    { id: "pallets", label: t("office.overview.chart.pallets"), of: (d: DayFigures) => d.pallets },
  ] as const;

  if (empty) {
    return (
      <section className="ov-panel ov-chart" aria-label={title}>
        <div className="ov-panel__head ov-panel__head--bare">
          <span className="ov-panel__icon">
            <Glyph name="chart" size={20} />
          </span>
          <h2 className="ov-panel__title">{title}</h2>
        </div>
        <div className="ov-chart__empty">
          <Glyph name="chart" size={28} />
          <strong>{t("office.overview.chart.emptyTitle")}</strong>
          <span>{t("office.overview.chart.emptyHint")}</span>
        </div>
      </section>
    );
  }
  return (
    <section className="ov-panel ov-chart" aria-label={title}>
      {head}
      {view === "graph" && (
        <div className="ov-chart__legend">
          <span className="ov-chart__key">
            <span className="ov-chart__swatch ov-chart__swatch--today" aria-hidden="true" />
            {t("office.overview.chart.legendToday", { time: asOf })}
          </span>
          <span className="ov-chart__key">
            <span className="ov-chart__swatch ov-chart__swatch--past" aria-hidden="true" />
            {t("office.overview.chart.legendPast")}
          </span>
          <span className="ov-chart__asof">{t("office.overview.chart.asOf", { time: asOf })}</span>
        </div>
      )}
      {view === "graph" && (
        <div className="ov-chart__plot" role="img" aria-label={summary} aria-describedby={tableId}>
          <div className="ov-chart__yaxis" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick} style={{ bottom: `${(tick / scale.top) * 100}%` }}>
                {NUMBER.format(tick)}
              </span>
            ))}
          </div>
          <div className="ov-chart__bars" aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick}
                className={tick === 0 ? "ov-chart__grid ov-chart__grid--base" : "ov-chart__grid"}
                style={{ bottom: `${(tick / scale.top) * 100}%` }}
              />
            ))}
            {days.map((day, index) => {
              const isToday = index === days.length - 1;
              const percent = (day.units / scale.top) * 100;
              return (
                <div className="ov-chart__col" key={day.date}>
                  {day.units > 0 && (
                    <span
                      className={isToday ? "ov-chart__bar ov-chart__bar--today" : "ov-chart__bar"}
                      style={{ height: `${percent}%` }}
                    />
                  )}
                  <span
                    className={
                      isToday ? "ov-chart__value ov-chart__value--today" : "ov-chart__value"
                    }
                    style={{ bottom: `calc(${percent}% + 4px)` }}
                  >
                    {NUMBER.format(day.units)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="ov-chart__labels" aria-hidden="true">
            {days.map((day, index) => {
              const label = civilDayLabel(day.date);
              return (
                <span
                  key={day.date}
                  className={
                    index === days.length - 1
                      ? "ov-chart__label ov-chart__label--today"
                      : "ov-chart__label"
                  }
                >
                  {label.weekday} {label.day}
                </span>
              );
            })}
          </div>
        </div>
      )}
      <div className={view === "graph" ? "ov-visually-hidden" : "ov-chart__tablewrap"}>
        <table className="ov-chart__table" id={tableId}>
          <caption className="ov-visually-hidden">
            {t("office.overview.chart.tableCaption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("office.overview.chart.metric")}</th>
              {days.map((day, index) => (
                <th
                  key={day.date}
                  scope="col"
                  aria-current={index === days.length - 1 ? "date" : undefined}
                >
                  {dayName(day.date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => (
              <tr key={metric.id}>
                <th scope="row">{metric.label}</th>
                {days.map((day, index) => (
                  <td
                    key={day.date}
                    className={index === days.length - 1 ? "ov-chart__cell--today" : undefined}
                  >
                    {NUMBER.format(metric.of(day))}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">{t("office.overview.chart.diff")}</th>
              {days.map((day, index) => {
                const before = days[index - 1];
                if (before === undefined) return <td key={day.date}>—</td>;
                const diff = signedDifference(day.units, before.units);
                return (
                  <td key={day.date} className={`ov-chart__diff ov-chart__diff--${diff.direction}`}>
                    {diff.text}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
        {view === "table" && (
          <p className="ov-chart__footnote">
            {t("office.overview.chart.footnote", { time: asOf })}
          </p>
        )}
      </div>
    </section>
  );
}
