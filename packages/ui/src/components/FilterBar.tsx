import type { ReactNode } from "react";

import { Button } from "./Button.js";

export interface FilterBarProps {
  label: string;
  children: ReactNode;
  resultSummary?: ReactNode;
  resetLabel?: string;
  onReset?: () => void;
}

export function FilterBar({
  label,
  children,
  resultSummary = "",
  resetLabel,
  onReset,
}: FilterBarProps) {
  return (
    <div className="mk-filter-bar">
      <div className="mk-filter-bar__controls" role="group" aria-label={label}>
        {children}
        {resetLabel && onReset ? (
          <Button type="button" size="compact" variant="secondary" onClick={onReset}>
            {resetLabel}
          </Button>
        ) : null}
      </div>
      <p className="mk-filter-bar__result" aria-live="polite">
        {resultSummary}
      </p>
    </div>
  );
}
