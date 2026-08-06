import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";

import { AdminPage, PageHeader } from "@markiro/ui";

export interface KiosksLayoutProps {
  actions?: ReactNode;
  children: ReactNode;
  navigationBusy?: boolean;
  onViewNavigate?: (to: "/kiosks" | "/kiosks/reasons") => void;
}

/** Shared kiosk-area heading and local navigation for the two sibling views. */
export function KiosksLayout({
  actions,
  children,
  navigationBusy = false,
  onViewNavigate,
}: KiosksLayoutProps): ReactElement {
  const { t } = useTranslation();
  const handleClick =
    (to: "/kiosks" | "/kiosks/reasons") => (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (!onViewNavigate) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      if (navigationBusy) return;
      onViewNavigate(to);
    };

  return (
    <AdminPage className="mk-kiosks-page">
      <PageHeader title={t("pages.kiosks.title")} actions={actions} />
      <nav className="mk-kiosks-view-nav" aria-label={t("pages.kiosks.views.label")}>
        <NavLink
          end
          to="/kiosks"
          aria-disabled={navigationBusy || undefined}
          onClick={handleClick("/kiosks")}
        >
          {t("pages.kiosks.views.kiosks")}
        </NavLink>
        <NavLink
          to="/kiosks/reasons"
          aria-disabled={navigationBusy || undefined}
          onClick={handleClick("/kiosks/reasons")}
        >
          {t("pages.kiosks.views.reasons")}
        </NavLink>
      </nav>
      {children}
    </AdminPage>
  );
}
