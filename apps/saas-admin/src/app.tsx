import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { createRoutesFromElements, Navigate, Outlet, Route } from "react-router";

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

export const appRoutes = createRoutesFromElements(
  <Route element={<SuspenseBoundary />}>
    <Route path="/login" element={<Login />} />
    <Route path="/activate" element={<ActivatePlatformUser />} />
    <Route path="/two-factor" element={<TwoFactor />} />
    <Route path="/recovery" element={<Recovery />} />
    <Route element={<PlatformAuthBoundary />}>
      <Route element={<AppShell />}>
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/offers" element={<OffersPage />} />
        <Route path="/tenants" element={<TenantsPage />} />
        <Route path="/tenants/new" element={<CreateTenantPanel />} />
        <Route path="/tenants/:tenantId" element={<TenantPage />} />
        <Route index element={<Navigate to="/catalog" replace />} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/catalog" replace />} />
  </Route>,
);
