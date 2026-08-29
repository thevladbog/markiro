import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import {
  createRoutesFromElements,
  type Location,
  Navigate,
  Outlet,
  Route,
  useLocation,
  useParams,
} from "react-router";

import { Spinner } from "@markiro/ui";

import { PlatformAuthBoundary } from "./auth/PlatformAuthBoundary.js";
import { AppShell } from "./layout/AppShell.js";
const ActivatePlatformUser = lazy(() =>
  import("./pages/auth/ActivatePlatformUser.js").then((module) => ({
    default: module.ActivatePlatformUser,
  })),
);
const Login = lazy(() =>
  import("./pages/auth/Login.js").then((module) => ({ default: module.Login })),
);
const Recovery = lazy(() =>
  import("./pages/auth/Recovery.js").then((module) => ({ default: module.Recovery })),
);
const TwoFactor = lazy(() =>
  import("./pages/auth/TwoFactor.js").then((module) => ({ default: module.TwoFactor })),
);
const CatalogPage = lazy(() =>
  import("./pages/catalog/CatalogPage.js").then((module) => ({ default: module.CatalogPage })),
);
const OverviewPage = lazy(() =>
  import("./pages/overview/OverviewPage.js").then((module) => ({ default: module.OverviewPage })),
);
const MonitoringPage = lazy(() =>
  import("./pages/overview/MonitoringPage.js").then((module) => ({
    default: module.MonitoringPage,
  })),
);
const TenantsPage = lazy(() =>
  import("./pages/tenants/TenantsPage.js").then((module) => ({ default: module.TenantsPage })),
);
const CreateTenantPanel = lazy(() =>
  import("./pages/tenants/CreateTenantPanel.js").then((module) => ({
    default: module.CreateTenantPanel,
  })),
);
const TenantPage = lazy(() =>
  import("./pages/tenants/TenantPage.js").then((module) => ({ default: module.TenantPage })),
);
const OffersPage = lazy(() =>
  import("./pages/offers/OffersPage.js").then((module) => ({ default: module.OffersPage })),
);
const BillingPage = lazy(() =>
  import("./pages/billing/BillingPage.js").then((module) => ({ default: module.BillingPage })),
);
const PaymentsPage = lazy(() =>
  import("./pages/payments/PaymentsPage.js").then((module) => ({ default: module.PaymentsPage })),
);
const BillingRequestsPage = lazy(() =>
  import("./pages/billing-requests/BillingRequestsPage.js").then((module) => ({
    default: module.BillingRequestsPage,
  })),
);
const CreateBillingActPage = lazy(() =>
  import("./pages/billing-acts/CreateBillingActPage.js").then((module) => ({
    default: module.CreateBillingActPage,
  })),
);
const CreateInvoicePage = lazy(() =>
  import("./pages/billing/CreateInvoicePage.js").then((module) => ({
    default: module.CreateInvoicePage,
  })),
);
const InvoiceDetailPage = lazy(() =>
  import("./pages/billing/InvoiceDetailPage.js").then((module) => ({
    default: module.InvoiceDetailPage,
  })),
);
const CreateOfferPage = lazy(() =>
  import("./pages/offers/CreateOfferPage.js").then((module) => ({
    default: module.CreateOfferPage,
  })),
);
const TeamPage = lazy(() =>
  import("./pages/team/TeamPage.js").then((module) => ({ default: module.TeamPage })),
);
const AuditPage = lazy(() =>
  import("./pages/audit/AuditPage.js").then((module) => ({ default: module.AuditPage })),
);
const OrganizationPage = lazy(() =>
  import("./pages/settings/OrganizationPage.js").then((module) => ({
    default: module.OrganizationPage,
  })),
);

function RouteLoading() {
  const { t } = useTranslation();

  return (
    <main className="route-loading">
      <Spinner label={t("shell.routeLoading")} />
    </main>
  );
}

function SuspenseBoundary() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Outlet />
    </Suspense>
  );
}

function LegacyBillingRedirect({ target }: { target: "index" | "new" | "detail" }) {
  const location: Location<unknown> = useLocation();
  const { invoiceId } = useParams();
  const pathname =
    target === "index"
      ? "/invoices"
      : target === "new"
        ? "/invoices/new"
        : `/invoices/${invoiceId ?? ""}`;
  return <Navigate to={{ pathname, search: location.search }} replace state={location.state} />;
}

export const appRoutes = createRoutesFromElements(
  <Route element={<SuspenseBoundary />}>
    <Route path="/login" element={<Login />} />
    <Route path="/activate" element={<ActivatePlatformUser />} />
    <Route path="/two-factor" element={<TwoFactor />} />
    <Route path="/recovery" element={<Recovery />} />
    <Route element={<PlatformAuthBoundary />}>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/offers" element={<OffersPage />} />
        <Route path="/offers/new" element={<CreateOfferPage />} />
        <Route path="/billing-requests/:requestId/offers/new" element={<CreateOfferPage />} />
        <Route path="/invoices" element={<BillingPage />} />
        <Route path="/invoices/new" element={<CreateInvoicePage />} />
        <Route path="/invoices/:invoiceId" element={<InvoiceDetailPage />} />
        <Route path="/billing" element={<LegacyBillingRedirect target="index" />} />
        <Route path="/payments" element={<PaymentsPage />} />
        <Route path="/billing-requests" element={<BillingRequestsPage />} />
        <Route path="/billing-requests/:requestId" element={<BillingRequestsPage />} />
        <Route path="/billing-acts/new" element={<CreateBillingActPage />} />
        <Route path="/billing/new" element={<LegacyBillingRedirect target="new" />} />
        <Route path="/billing/:invoiceId" element={<LegacyBillingRedirect target="detail" />} />
        <Route path="/monitoring" element={<MonitoringPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/settings/organization" element={<OrganizationPage />} />
        <Route path="/tenants" element={<TenantsPage />} />
        <Route path="/tenants/new" element={<CreateTenantPanel />} />
        <Route path="/tenants/:tenantId" element={<TenantPage />} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route>,
);
