import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn.js";

export interface RowActionsProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function RowActions({ children, className, ...props }: RowActionsProps) {
  return (
    <div className={cn("mk-row-actions", className)} {...props}>
      {children}
    </div>
  );
}
