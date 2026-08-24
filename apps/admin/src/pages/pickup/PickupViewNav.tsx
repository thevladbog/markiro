import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";

import { AdminPage, PageHeader } from "@markiro/ui";

export type PickupViewPath = "/pickup" | "/pickup/rejections" | "/pickup/reasons";

export interface PickupViewNavProps {
  navigationBusy?: boolean;
  onViewNavigate?: (to: PickupViewPath) => void;
}

/** Tab strip shared by the «Выбытие» views (orders, rejected scans, reasons). */
export function PickupViewNav({
  navigationBusy = false,
  onViewNavigate,
}: PickupViewNavProps): ReactElement {
  const { t } = useTranslation();
  const handleClick = (to: PickupViewPath) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!onViewNavigate) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    if (navigationBusy) return;
    onViewNavigate(to);
  };

  return (
    <nav className="mk-kiosks-view-nav" aria-label={t("pages.pickup.views.label")}>
      <NavLink
        end
        to="/pickup"
        aria-disabled={navigationBusy || undefined}
        onClick={handleClick("/pickup")}
      >
        {t("pages.pickup.views.orders")}
      </NavLink>
      <NavLink
        to="/pickup/rejections"
        aria-disabled={navigationBusy || undefined}
        onClick={handleClick("/pickup/rejections")}
      >
        {t("pages.pickup.views.rejections")}
      </NavLink>
      <NavLink
        to="/pickup/reasons"
        aria-disabled={navigationBusy || undefined}
        onClick={handleClick("/pickup/reasons")}
      >
        {t("pages.pickup.views.reasons")}
      </NavLink>
    </nav>
  );
}

export interface PickupViewLayoutProps extends PickupViewNavProps {
  actions?: ReactNode;
  children: ReactNode;
}

/** Shared «Выбытие» heading + view tabs, mirroring the retired KiosksLayout. */
export function PickupViewLayout({
  actions,
  children,
  navigationBusy = false,
  onViewNavigate,
}: PickupViewLayoutProps): ReactElement {
  const { t } = useTranslation();

  return (
    <AdminPage className="mk-kiosks-page">
      <PageHeader title={t("pages.pickup.title")} actions={actions} />
      <PickupViewNav
        navigationBusy={navigationBusy}
        {...(onViewNavigate ? { onViewNavigate } : {})}
      />
      {children}
    </AdminPage>
  );
}
