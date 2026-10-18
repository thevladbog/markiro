import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";

import { cn } from "@markiro/ui";

import { menuPathFor, type NavGroup } from "./nav-groups.js";
import { OfficeBrandMark } from "./OfficeBrand.js";
import { OfficeIcon } from "./OfficeIcon.js";

export interface OfficeSidebarProps {
  groups: readonly NavGroup[];
  /** Icons only; each entry keeps its name (hidden text, a tooltip on hover and focus). */
  collapsed: boolean;
  id: string;
}

/**
 * The office menu: one style for every entry (an icon and a name, one height from
 * `--menu-item-h`), the active one filled; the groups named in small capitals and the settings
 * block set apart by one hairline rule. Collapsed it is icons only (76 px): the names stay in the
 * document for a screen reader and show as a tooltip. A section stays marked on its sub-pages
 * («Шаблоны» on `/templates/new`); «Обзор» matches only `/`, cloud history belongs to «Смены».
 */
export function OfficeSidebar({ groups, collapsed, id }: OfficeSidebarProps) {
  const { t } = useTranslation();
  const pathname = menuPathFor(useLocation().pathname);
  return (
    <nav
      id={id}
      aria-label={t("office.nav.label")}
      className={cn("office-menu", collapsed && "office-menu--collapsed")}
    >
      <div className="office-menu__brand">
        <OfficeBrandMark size={40} />
        <span className="office-menu__wordmark">{t("office.login.wordmark")}</span>
      </div>
      <ul className="office-menu__list">
        {groups.map((group) => (
          <Fragment key={group.sectionKey}>
            {group.ruleBefore && <li className="office-menu__rule" role="separator" />}
            {group.showLabel && (
              <li className="office-menu__section">
                <span>{t(group.sectionKey)}</span>
              </li>
            )}
            {group.items.map((item) => {
              const active =
                pathname === item.to || (item.to !== "/" && pathname.startsWith(`${item.to}/`));
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    title={collapsed ? t(item.labelKey) : undefined}
                    className={cn("office-menu__link", active && "office-menu__link--active")}
                    aria-current={active ? "page" : undefined}
                  >
                    <OfficeIcon name={item.icon} />
                    <span className="office-menu__label">{t(item.labelKey)}</span>
                  </Link>
                </li>
              );
            })}
          </Fragment>
        ))}
      </ul>
    </nav>
  );
}
