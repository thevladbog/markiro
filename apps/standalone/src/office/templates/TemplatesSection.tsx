import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";

import { Segmented } from "../list/Segmented.js";

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

interface SectionValue {
  bar: ReactNode;
  panelId: string;
  panelLabel: string;
}

const SectionContext = createContext<SectionValue | null>(null);

/**
 * The section's parts as a segmented control with tab semantics. A part draws it itself, right under
 * its own heading (the kit puts the heading first, then the parts), so it renders nothing where
 * there is no section around it.
 */
export function TemplateTabsBar() {
  return <>{useContext(SectionContext)?.bar ?? null}</>;
}

/** The open part's content: the tabpanel the bar's tabs control. Plain content outside a section. */
export function TemplateTabPanel({ children }: { children: ReactNode }) {
  const section = useContext(SectionContext);
  if (section === null) return <>{children}</>;
  return (
    <div
      id={section.panelId}
      role="tabpanel"
      aria-label={section.panelLabel}
      className="office-stack"
    >
      {children}
    </div>
  );
}

/**
 * «Шаблоны» as one section (beta feedback): the label templates, the A4 pallet sheets and the
 * templates chosen by default, labels and sheets alike, as the parts of one menu item. A part is a
 * page of its own, so choosing a tab goes to its address, and the focus the menu gives a new page is
 * given back to the tab, so the arrow keys go on. The old addresses of the sheets and the defaults
 * lead here. The section holds the bar and the panel's id; each part renders them under its heading
 * (`TemplateTabsBar`, `TemplateTabPanel`).
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
  const value = useMemo<SectionValue>(
    () => ({
      panelId,
      panelLabel: t(activeLabel),
      bar: (
        <div ref={wrapper}>
          <Segmented
            mode="tabs"
            label={t("office.templatesSection.label")}
            value={active}
            options={TEMPLATE_TABS.map((tab) => ({
              id: tab.to,
              label: t(tab.labelKey),
              panelId,
            }))}
            onChange={(to) => {
              if (to === active) return;
              refocus.current = true;
              void navigate(to);
            }}
          />
        </div>
      ),
    }),
    [active, activeLabel, navigate, panelId, t],
  );
  return (
    <SectionContext.Provider value={value}>
      <Outlet />
    </SectionContext.Provider>
  );
}
