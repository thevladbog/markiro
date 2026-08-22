import { createElement, type CSSProperties, type ReactNode } from "react";

import { cn } from "../cn.js";

export interface SectionHeaderProps {
  title: ReactNode;
  titleAs?: "h1" | "h2" | "h3";
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  actionsLabel?: string;
  className?: string;
  style?: CSSProperties;
}

export function SectionHeader({
  title,
  titleAs = "h1",
  eyebrow,
  description,
  actions,
  actionsLabel,
  className,
  style,
}: SectionHeaderProps) {
  return (
    <header className={cn("mk-section-header", className)} style={style}>
      <div className="mk-section-header__copy">
        {eyebrow ? <p className="mk-section-header__eyebrow">{eyebrow}</p> : null}
        {createElement(titleAs, { className: "mk-section-header__title" }, title)}
        {description ? <p className="mk-section-header__description">{description}</p> : null}
      </div>
      {actions ? (
        <div
          className="mk-section-header__actions"
          role={actionsLabel ? "group" : undefined}
          aria-label={actionsLabel}
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
