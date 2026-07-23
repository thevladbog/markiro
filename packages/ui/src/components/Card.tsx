import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn.js";

/** Порт `design-system/components/display/Card.jsx` — только офисный режим. */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  /** Кнопки/иконки в правом углу шапки */
  actions?: ReactNode;
  /** Переопределить внутренний отступ (число px или CSS-строка) */
  padding?: number | string;
}

export function Card({ title, actions, children, padding, className, style, ...rest }: CardProps) {
  return (
    <div
      className={cn("mk-card", className)}
      style={{
        background: "var(--surface-card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        boxShadow: "var(--shadow-1)",
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
      {...rest}
    >
      {(title || actions) && (
        <div
          className="mk-card__header"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "14px 20px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <span style={{ font: "var(--text-h3)", color: "var(--fg-1)" }}>{title}</span>
          {actions && <span style={{ display: "flex", gap: 8 }}>{actions}</span>}
        </div>
      )}
      <div className="mk-card__body" style={{ padding: padding ?? 20, flex: 1 }}>
        {children}
      </div>
    </div>
  );
}
