import type { CSSProperties, ReactNode } from "react";

import { cn } from "../cn.js";
import { Badge } from "./Badge.js";

/**
 * Port of `design-system/components/navigation/Sidebar.jsx`, re-shaped
 * around the plan's router-agnostic contract instead of the handoff's
 * `activeId`/`onSelect`/`icon` props:
 *
 * - Width is 224px (the `prototypes/admin-panel.dc.html` value) rather than
 *   the handoff component's 232px.
 * - Items carry `to`/`labelKey`/`badge` instead of `id`/`label`/`icon`/`badge`.
 *   `labelKey` is rendered verbatim as the visible label — this package has
 *   no i18n dependency, so resolving it to translated copy (react-i18next)
 *   is the caller's job (`apps/admin`, Task 9/10); the field is simply named
 *   for that eventual key rather than `label` to signal the contract.
 *   `icon` is dropped — this package does not port the handoff's `<Icon>`
 *   set (see `StatusChip.tsx`).
 * - Item badges reuse the existing `Badge` component (`tone="neutral"`,
 *   its default) rather than re-inlining the pill styling — `Badge`'s own
 *   doc comment notes it was ported from this exact sidebar nav pill.
 * - There is no `onSelect`/active-item logic here: instead of embedding a
 *   specific router, `renderLink(item, content)` receives the pre-built
 *   inner content (label + badge) and returns whatever link element the
 *   caller wants (a react-router `NavLink`, a plain `<a>`, ...). Active-item
 *   styling (`--surface-card` background + inset `--line` border) is
 *   exposed as CSS classes (`mk-sidebar__link`, `mk-sidebar__link--active`)
 *   the caller's `renderLink` applies — e.g. via `NavLink`'s
 *   `className={({isActive}) => ...}` render prop — since only the router
 *   knows which item is active.
 * - `collapsed` is dropped — not requested by the plan.
 */
export interface SidebarItem {
  to: string;
  labelKey: string;
  /** Счётчик справа */
  badge?: number | string;
}

export interface SidebarProps {
  items: SidebarItem[];
  /** Оборачивает `content` (метка + счётчик) в ссылку/NavLink конкретного роутера */
  renderLink: (item: SidebarItem, content: ReactNode) => ReactNode;
  /** Низ сайдбара: профиль, выход */
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** aria-label for the `<nav>` landmark -- this package has no i18n dependency, so a caller in a non-English locale (e.g. `apps/admin`) should pass a translated string. */
  navLabel?: string;
}

const SIDEBAR_LINK_CSS = `
.mk-sidebar__link {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 9px 10px;
  border-radius: var(--r-2);
  border: none;
  cursor: pointer;
  text-align: left;
  text-decoration: none;
  background: transparent;
  box-shadow: none;
  color: var(--fg-2);
  font: 500 14px/20px var(--font-ui);
}
.mk-sidebar__link--active {
  background: var(--surface-card);
  box-shadow: inset 0 0 0 1px var(--line);
  color: var(--fg-1);
}
`;

export function Sidebar({
  items,
  renderLink,
  footer,
  className,
  style,
  navLabel = "Main navigation",
}: SidebarProps) {
  return (
    <nav
      aria-label={navLabel}
      className={cn("mk-sidebar", className)}
      style={{
        width: 224,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--surface-panel)",
        borderRight: "1px solid var(--line)",
        padding: "16px 8px",
        gap: 2,
        height: "100%",
        boxSizing: "border-box",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 10px 16px 10px" }}>
        <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
          <rect x="4" y="4" width="56" height="56" fill="var(--fg-1)" />
          <g fill="var(--surface-page)">
            <rect x="14" y="14" width="8" height="8" />
            <rect x="14" y="26" width="8" height="8" />
            <rect x="14" y="38" width="8" height="8" />
            <rect x="26" y="22" width="8" height="8" />
            <rect x="38" y="14" width="8" height="8" />
            <rect x="38" y="26" width="8" height="8" />
            <rect x="38" y="38" width="8" height="8" />
            <rect x="26" y="42" width="8" height="8" fill="var(--accent-module)" />
          </g>
        </svg>
        <span style={{ font: "600 16px/1 var(--font-mono)", color: "var(--fg-1)" }}>маркиро</span>
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {items.map((item) => (
          <li key={item.to}>
            {renderLink(
              item,
              <span
                className="mk-sidebar__content"
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}
              >
                <span
                  style={{
                    flex: 1,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.labelKey}
                </span>
                {item.badge != null && <Badge>{item.badge}</Badge>}
              </span>,
            )}
          </li>
        ))}
      </ul>
      <div style={{ flex: 1 }} />
      {footer}
      <style>{SIDEBAR_LINK_CSS}</style>
    </nav>
  );
}
