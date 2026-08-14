import type { ReactNode } from "react";
import { cn } from "@markiro/ui";

export interface FloorFooterProps {
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

/** Fixed floor action row. It never owns screen content or a scroll region. */
export function FloorFooter({ ariaLabel, className, children }: FloorFooterProps) {
  return (
    <footer className={cn("station-floor-footer", className)} aria-label={ariaLabel}>
      {children}
    </footer>
  );
}
