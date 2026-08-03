import { BrowserRouter, Route, Routes } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { RequireCapability } from "./access/context.js";
import { AuthQueryBoundary } from "./query/AuthQueryBoundary.js";
import { CreateOrgPage } from "./pages/auth/CreateOrg.js";
import { LoginPage } from "./pages/auth/Login.js";
import { RegisterPage } from "./pages/auth/Register.js";
import { SelectOrgPage } from "./pages/auth/SelectOrg.js";
import { BoxesPage } from "./pages/boxes/index.js";
import { CatalogPage } from "./pages/catalog/index.js";
import { ConflictsPage } from "./pages/conflicts/index.js";
import { CounterpartiesPage } from "./pages/counterparties/index.js";
import { DashboardPage } from "./pages/dashboard/index.js";
import { EmployeesPage } from "./pages/employees/index.js";
import { ChannelPage } from "./pages/integrations/ChannelPage.js";
import { IntegrationsPage } from "./pages/integrations/index.js";
import { KiosksPage } from "./pages/kiosks/index.js";
import { LabelEditorPage } from "./pages/labels/editor/index.js";
import { LabelTemplatesPage } from "./pages/labels/index.js";
import { OrderDetailPage } from "./pages/pickup/OrderDetail.js";
import { RejectionsPage } from "./pages/pickup/Rejections.js";
import { PickupPage } from "./pages/pickup/index.js";
import { SettingsPage } from "./pages/settings/index.js";
import { ShiftsPage } from "./pages/shifts/index.js";
import { ShellPage } from "./pages/Shell.js";

/**
 * Component routing (<BrowserRouter>/<Routes>/<Route>) rather than a data
 * router (createBrowserRouter/RouterProvider): this app has no loaders,
 * actions, or route-level data dependencies yet -- all data fetching so far
 * happens inside components via the auth client / react-query (wired at the
 * root in main.tsx). Component routing also composes more simply with
 * jsdom-based render tests (MemoryRouter drop-in, no router object to
 * construct per test).
 */
const C = CABINET_CAPABILITY;

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/org/create" element={<CreateOrgPage />} />
      <Route path="/org/select" element={<SelectOrgPage />} />
      <Route path="/" element={<ShellPage />}>
        <Route
          index
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <DashboardPage />
            </RequireCapability>
          }
        />
        <Route
          path="catalog"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <CatalogPage />
            </RequireCapability>
          }
        />
        <Route
          path="shifts"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <ShiftsPage />
            </RequireCapability>
          }
        />
        <Route
          path="boxes"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <BoxesPage />
            </RequireCapability>
          }
        />
        <Route
          path="conflicts"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <ConflictsPage />
            </RequireCapability>
          }
        />
        <Route
          path="counterparties"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <CounterpartiesPage />
            </RequireCapability>
          }
        />
        <Route
          path="employees"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <EmployeesPage />
            </RequireCapability>
          }
        />
        <Route
          path="kiosks"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <KiosksPage />
            </RequireCapability>
          }
        />
        <Route
          path="integrations"
          element={
            <RequireCapability capability={C.INTEGRATIONS_READ}>
              <IntegrationsPage />
            </RequireCapability>
          }
        />
        <Route
          path="integrations/:type"
          element={
            <RequireCapability capability={C.INTEGRATIONS_READ}>
              <ChannelPage />
            </RequireCapability>
          }
        />
        <Route
          path="labels"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <LabelTemplatesPage />
            </RequireCapability>
          }
        />
        <Route
          path="labels/new"
          element={
            <RequireCapability capability={C.OPERATIONS_WRITE}>
              <LabelEditorPage />
            </RequireCapability>
          }
        />
        <Route
          path="labels/:id"
          element={
            <RequireCapability capability={C.OPERATIONS_WRITE}>
              <LabelEditorPage />
            </RequireCapability>
          }
        />
        <Route
          path="pickup"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <PickupPage />
            </RequireCapability>
          }
        />
        <Route
          path="pickup/rejections"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <RejectionsPage />
            </RequireCapability>
          }
        />
        <Route
          path="pickup/:id"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <OrderDetailPage />
            </RequireCapability>
          }
        />
        <Route
          path="settings"
          element={
            <RequireCapability capability={C.TENANT_SETTINGS_MANAGE}>
              <SettingsPage />
            </RequireCapability>
          }
        />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthQueryBoundary>
        <AppRoutes />
      </AuthQueryBoundary>
    </BrowserRouter>
  );
}
