import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet } from "react-router";

import { AdminPage, PageHeader, Spinner } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { CABINET_CAPABILITY } from "@markiro/domain";
import "./billing.css";

const BILLING_TABS = [
  { to: "/billing", key: "pages.billing.tabs.overview", end: true },
  { to: "/billing/subscription", key: "pages.billing.tabs.subscription", end: false },
  { to: "/billing/invoices", key: "pages.billing.tabs.invoices", end: false },
  { to: "/billing/documents", key: "pages.billing.tabs.documents", end: false },
  { to: "/billing/requests", key: "pages.billing.tabs.requests", end: false },
] as const;

/** Shared tenant billing heading, navigation, and route outlet. */
export function BillingLayout() {
  const { t } = useTranslation();
  const canCreateRequest = useCan(CABINET_CAPABILITY.BILLING_REQUEST);

  return (
    <AdminPage className="mk-billing-page" data-testid="billing-page">
      <div className="mk-billing-page__heading">
        <PageHeader
          title={t("pages.billing.title")}
          actions={
            canCreateRequest ? (
              <Link className="mk-billing-page__create-request" to="/billing/requests/new">
                {t("pages.billing.createRequest")}
              </Link>
            ) : undefined
          }
        />
        <p>{t("pages.billing.description")}</p>
      </div>

      <nav className="mk-billing-tabs" aria-label={t("pages.billing.tabs.label")}>
        {BILLING_TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end}>
            {t(tab.key)}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </AdminPage>
  );
}

/**
 * Temporary child-route contract: later billing tasks replace this with each
 * route's data-aware page without changing the shared shell or tab semantics.
 */
export function BillingRoutePlaceholder() {
  const { t } = useTranslation();

  return (
    <section className="mk-billing-route-placeholder" aria-label={t("pages.billing.loading")}>
      <Spinner label={t("pages.billing.loading")} />
    </section>
  );
}
