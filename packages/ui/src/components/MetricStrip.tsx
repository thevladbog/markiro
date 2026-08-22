import type { CSSProperties, ReactNode } from "react";

import { cn } from "../cn.js";

export type MetricStripTone = "neutral" | "positive" | "warning" | "critical";

export interface MetricStripItem {
  id: string;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: MetricStripTone;
}

export interface MetricStripProps {
  items: readonly MetricStripItem[];
  label: string;
  className?: string;
  style?: CSSProperties;
}

export function MetricStrip({ items, label, className, style }: MetricStripProps) {
  return (
    <dl className={cn("mk-metric-strip", className)} aria-label={label} role="group" style={style}>
      {items.map((item) => (
        <div
          className={cn(
            "mk-metric-strip__item",
            `mk-metric-strip__item--${item.tone ?? "neutral"}`,
          )}
          key={item.id}
        >
          <dt className="mk-metric-strip__label">{item.label}</dt>
          <dd className="mk-metric-strip__value">{item.value}</dd>
          {item.hint ? <span className="mk-metric-strip__hint">{item.hint}</span> : null}
        </div>
      ))}
    </dl>
  );
}
