import { useId } from "react";
import { useTranslation } from "react-i18next";

import { barMax } from "./diagnostics-format.js";

export interface BarSeries {
  key: string;
  label: string;
  /** One value per month; `null` is a month without data and draws no bar. */
  values: readonly (number | null)[];
  tone: "accent" | "muted";
}

const WIDTH = 480;
const HEIGHT = 140;
const PAD_X = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 22;

/**
 * Grouped month bars as inline SVG on the design tokens (the package has no chart component and
 * the spec forbids a chart library). The same numbers are always in the table; this is a shape.
 */
export function DiagnosticsBars({
  title,
  months,
  series,
}: {
  title: string;
  months: readonly string[];
  series: readonly BarSeries[];
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const max = barMax(series);
  const slot = (WIDTH - PAD_X * 2) / Math.max(1, months.length);
  const bar = slot / (series.length + 1);
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const summary = months
    .map((month, at) =>
      [
        month,
        ...series.map((item) => {
          const value = item.values[at];
          return `${item.label} ${value === null || value === undefined ? t("tenants.detail.diagnostics.statistics.noData") : value}`;
        }),
      ].join(": "),
    )
    .join("; ");
  return (
    <figure className="diagnostics-bars__figure">
      <figcaption id={titleId}>{title}</figcaption>
      <svg
        role="img"
        aria-labelledby={titleId}
        aria-description={summary}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="diagnostics-bars__svg"
      >
        <line
          x1={PAD_X}
          x2={WIDTH - PAD_X}
          y1={HEIGHT - PAD_BOTTOM}
          y2={HEIGHT - PAD_BOTTOM}
          className="diagnostics-bars__axis"
        />
        {months.map((month, at) => {
          const x0 = PAD_X + at * slot + bar / 2;
          return (
            <g key={month}>
              {series.map((item, index) => {
                const value = item.values[at];
                if (value === null || value === undefined) return null;
                const height = (value / max) * plotHeight;
                return (
                  <rect
                    key={item.key}
                    x={x0 + index * bar}
                    y={HEIGHT - PAD_BOTTOM - height}
                    width={Math.max(1, bar - 2)}
                    height={height}
                    className={`diagnostics-bars__bar diagnostics-bars__bar--${item.tone}`}
                  />
                );
              })}
              <text
                x={x0 + (series.length * bar) / 2}
                y={HEIGHT - 6}
                className="diagnostics-bars__tick"
              >
                {month.slice(2)}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className="diagnostics-bars__legend">
        {series.map((item) => (
          <li key={item.key}>
            <span
              aria-hidden="true"
              className={`diagnostics-bars__swatch diagnostics-bars__swatch--${item.tone}`}
            />
            {item.label}
          </li>
        ))}
      </ul>
    </figure>
  );
}
