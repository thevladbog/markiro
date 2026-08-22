import type { CSSProperties, ReactNode } from "react";

import { cn } from "../cn.js";

export interface OperationalRailItem {
  id: string;
  label: ReactNode;
  to: string;
  active?: boolean;
  badge?: ReactNode;
  icon?: ReactNode;
}

export interface OperationalRailGroup {
  id: string;
  label: ReactNode;
  items: readonly OperationalRailItem[];
}

export interface OperationalRailLinkProps {
  className: string;
  "aria-current"?: "page";
}

export interface OperationalRailProps {
  brand: ReactNode;
  groups: readonly OperationalRailGroup[];
  navLabel: string;
  renderLink?: (
    item: OperationalRailItem,
    content: ReactNode,
    linkProps: OperationalRailLinkProps,
  ) => ReactNode;
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function OperationalRail({
  brand,
  groups,
  navLabel,
  renderLink,
  footer,
  className,
  style,
}: OperationalRailProps) {
  return (
    <aside className={cn("mk-operational-rail", "mk-motion-safe", className)} style={style}>
      <div className="mk-operational-rail__brand">{brand}</div>
      <nav className="mk-operational-rail__nav" aria-label={navLabel}>
        {groups.map((group) => (
          <section className="mk-operational-rail__group" key={group.id}>
            <h2 className="mk-operational-rail__group-label">{group.label}</h2>
            <ul className="mk-operational-rail__items">
              {group.items.map((item) => {
                const className = cn(
                  "mk-operational-rail__link",
                  item.active && "mk-operational-rail__link--active",
                );
                const linkProps: OperationalRailLinkProps = {
                  className,
                  ...(item.active ? { "aria-current": "page" as const } : {}),
                };
                const content = (
                  <>
                    {item.icon ? (
                      <span className="mk-operational-rail__icon" aria-hidden="true">
                        {item.icon}
                      </span>
                    ) : null}
                    <span className="mk-operational-rail__label">{item.label}</span>
                    {item.badge !== undefined ? (
                      <span className="mk-operational-rail__badge">{item.badge}</span>
                    ) : null}
                  </>
                );
                return (
                  <li key={item.id}>
                    {renderLink ? (
                      renderLink(item, content, linkProps)
                    ) : (
                      <a href={item.to} {...linkProps}>
                        {content}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
      {footer ? <div className="mk-operational-rail__footer">{footer}</div> : null}
    </aside>
  );
}
