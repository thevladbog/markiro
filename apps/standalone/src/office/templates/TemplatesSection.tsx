import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";

/** The section's parts: the label templates, the A4 sheets and the defaults of both. */
export const TEMPLATE_TABS = [
  { to: "/templates", end: true, labelKey: "office.templatesSection.labels" },
  { to: "/templates/a4", end: false, labelKey: "office.templatesSection.sheets" },
  { to: "/templates/defaults", end: false, labelKey: "office.templatesSection.defaults" },
] as const;

/**
 * «Шаблоны» as one section (beta feedback): the label templates, the A4
 * pallet sheets and the templates chosen by default, labels and sheets
 * alike, as tabs over one menu item. The tabs are links (`aria-current` on
 * the open one) drawn as `@markiro/ui`'s data tabs: a part is a page of its
 * own, so the menu's focus move to the page applies to them as it does to a
 * menu item. The old addresses of the sheets and the defaults lead here.
 */
export function TemplatesSection() {
  const { t } = useTranslation();
  return (
    <>
      <nav className="mk-data-tabs" aria-label={t("office.templatesSection.label")}>
        {TEMPLATE_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              isActive ? "mk-data-tabs__tab mk-data-tabs__tab--active" : "mk-data-tabs__tab"
            }
          >
            <span>{t(tab.labelKey)}</span>
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
