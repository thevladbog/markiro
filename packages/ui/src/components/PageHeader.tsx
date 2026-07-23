import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn.js";

/**
 * PageHeader is a Task-3 synthesis — the handoff has no dedicated component
 * for this, but the pattern repeats verbatim across every screen in
 * `prototypes/admin-panel.dc.html` (Обзор/Каталог/Смены/...): an `<h1>` at
 * `--text-h1` on the left, action buttons flush right, both on one baseline.
 * Ported 1:1 from that recurring markup.
 */
export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, actions, className, style, ...rest }: PageHeaderProps) {
  return (
    <div
      className={cn("mk-page-header", className)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        ...style,
      }}
      {...rest}
    >
      <h1 style={{ margin: 0, font: "var(--text-h1)", color: "var(--fg-1)" }}>{title}</h1>
      {actions && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{actions}</div>}
    </div>
  );
}
