import type { CSSProperties } from "react";

import { cn } from "../cn.js";
import { Button } from "./Button.js";

export interface PagerProps {
  /** One-based active page. Invalid values are clamped to the available range. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  ariaLabel?: string;
  previousLabel?: string;
  nextLabel?: string;
  pageLabel?: (page: number, pageCount: number) => string;
  className?: string;
  style?: CSSProperties;
}

export function Pager({
  page,
  pageCount,
  onPageChange,
  ariaLabel = "Pagination",
  previousLabel = "Previous",
  nextLabel = "Next",
  pageLabel = (current, count) => `Page ${current} of ${count}`,
  className,
  style,
}: PagerProps) {
  const count = Math.max(1, Math.trunc(pageCount));
  const current = Math.min(count, Math.max(1, Math.trunc(page)));

  return (
    <nav
      aria-label={ariaLabel}
      className={cn("mk-pager", className)}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
        alignItems: "center",
        gap: 16,
        ...style,
      }}
    >
      <Button
        size="floor"
        variant="secondary"
        fullWidth
        disabled={current <= 1}
        onClick={() => onPageChange(current - 1)}
      >
        {previousLabel}
      </Button>
      <span
        aria-live="polite"
        style={{
          minWidth: 120,
          color: "var(--fg-2)",
          font: "var(--floor-body-strong)",
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {pageLabel(current, count)}
      </span>
      <Button
        size="floor"
        variant="secondary"
        fullWidth
        disabled={current >= count}
        onClick={() => onPageChange(current + 1)}
      >
        {nextLabel}
      </Button>
    </nav>
  );
}
