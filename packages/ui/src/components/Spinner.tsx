import type { HTMLAttributes } from "react";

import { cn } from "../cn.js";

/**
 * Spinner is a Task-3 synthesis — the handoff has no dedicated spinner
 * component (`feedback/Progress.jsx` only covers determinate progress via
 * `ProgressBar`/`RingCounter`, which this package does not port). Reuses the
 * same `mk-spin` rotate keyframe as `Button.tsx`'s inline `loading` ring, but
 * (unlike the currentColor ring inlined there) is drawn with token colors
 * directly — `var(--line)` track, `var(--fg-1)` accent segment — so it reads
 * consistently outside a colored button surface, e.g. a loading placeholder
 * inside a `Card` or `EmptyState`. Carries `role="status"` plus a
 * visually-hidden label, since color/motion alone should never be the only
 * signal (same rule `StatusChip` documents).
 */
export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Диаметр в px */
  size?: number;
  /** Текст для скринридеров (визуально скрыт) */
  label?: string;
}

export function Spinner({
  size = 20,
  label = "Загрузка…",
  className,
  style,
  ...rest
}: SpinnerProps) {
  const borderWidth = Math.max(2, Math.round(size / 8));

  return (
    <span
      role="status"
      className={cn("mk-spinner", className)}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", ...style }}
      {...rest}
    >
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          border: `${borderWidth}px solid var(--line)`,
          borderRightColor: "var(--fg-1)",
          borderRadius: "50%",
          display: "inline-block",
          animation: "mk-spin 700ms linear infinite",
        }}
      />
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {label}
      </span>
      <style>{"@keyframes mk-spin{to{transform:rotate(360deg)}}"}</style>
    </span>
  );
}
