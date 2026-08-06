import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn.js";

export interface AdminPageProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function AdminPage({ children, className, ...props }: AdminPageProps) {
  return (
    <div className={cn("mk-admin-page", className)} {...props}>
      {children}
    </div>
  );
}
