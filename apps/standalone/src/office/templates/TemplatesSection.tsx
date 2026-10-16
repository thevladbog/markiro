import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";

import { DataTabs } from "@markiro/ui";

/** The section's parts: the label templates, the A4 sheets and the defaults of both. */
export const TEMPLATE_TABS = [
  { to: "/templates", labelKey: "office.templatesSection.labels" },
  { to: "/templates/a4", labelKey: "office.templatesSection.sheets" },
  { to: "/templates/defaults", labelKey: "office.templatesSection.defaults" },
] as const;

type TemplateTab = (typeof TEMPLATE_TABS)[number]["to"];

/** The part whose address the page is at (the labels' own pages, `/templates/…`, are «Этикетки»). */
function tabOf(pathname: string): TemplateTab {
  const path = pathname.replace(/\/+$/, "");
  if (path === "/templates/a4") return "/templates/a4";
  if (path === "/templates/defaults") return "/templates/defaults";
  return "/templates";
}

/**
 * «Шаблоны» as one section (beta feedback): the label templates, the A4
 * pallet sheets and the templates chosen by default, labels and sheets
 * alike, as tabs over one menu item: the office's one tab bar (`DataTabs`,
 * a tablist of tabs with the open part in a tabpanel). A part is a page of
 * its own, so choosing a tab goes to its address, and the focus the menu
 * gives a new page is given back to the tab, so the arrow keys go on. The old
 * addresses of the sheets and the defaults lead here.
 */
export function TemplatesSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const active = tabOf(pathname);
  // The shell moves the focus to the page on every navigation; this waits for it to be done.
  useEffect(() => {
    if (!refocus.current) return;
    const timer = setTimeout(() => {
      refocus.current = false;
      wrapper.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [pathname]);
  const activeLabel = TEMPLATE_TABS.find((tab) => tab.to === active)?.labelKey ?? "";
  return (
    <>
      <div ref={wrapper}>
        <DataTabs
          label={t("office.templatesSection.label")}
          items={TEMPLATE_TABS.map((tab) => ({
            id: tab.to,
            label: t(tab.labelKey),
            panelId,
          }))}
          activeId={active}
          onChange={(to) => {
            if (to === active) return;
            refocus.current = true;
            void navigate(to);
          }}
        />
      </div>
      <div id={panelId} role="tabpanel" aria-label={t(activeLabel)} className="office-stack">
        <Outlet />
      </div>
    </>
  );
}
