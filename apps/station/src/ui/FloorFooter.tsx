import type { ReactNode } from "react";

export interface FloorFooterProps {
  ariaLabel: string;
  children: ReactNode;
}

/** Fixed floor action row. It never owns screen content or a scroll region. */
export function FloorFooter({ ariaLabel, children }: FloorFooterProps) {
  return (
    <footer className="station-floor-footer" aria-label={ariaLabel}>
      {children}
    </footer>
  );
}
