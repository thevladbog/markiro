import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes } from "react-router";

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

function RouteLoading() {
  const { t } = useTranslation();

  return (
    <main className="route-loading">
      <Spinner label={t("shell.routeLoading")} />
    </main>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/activate" element={<ActivatePlatformUser />} />
        <Route path="/two-factor" element={<TwoFactor />} />
        <Route path="/recovery" element={<Recovery />} />
        <Route element={<PlatformAuthBoundary />}>
          <Route element={<AppShell />}>
            <Route path="/catalog" element={<CatalogPage />} />
            <Route index element={<Navigate to="/catalog" replace />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/catalog" replace />} />
      </Routes>
    </Suspense>
  );
}
