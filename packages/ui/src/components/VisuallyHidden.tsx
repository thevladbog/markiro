import type { ReactNode } from "react";

export interface VisuallyHiddenProps {
  children: ReactNode;
}

export function VisuallyHidden({ children }: VisuallyHiddenProps) {
  return <span className="mk-visually-hidden">{children}</span>;
}
