import { useMemo } from "react";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Route,
  RouterProvider,
  useLocation,
  useParams,
} from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { RequireCapability } from "./access/context.js";
import { AuthQueryBoundary } from "./query/AuthQueryBoundary.js";
import { CreateOrgPage } from "./pages/auth/CreateOrg.js";
import { ActivateOwnerPage } from "./pages/auth/ActivateOwner.js";
import { LoginPage } from "./pages/auth/Login.js";
import { RegisterPage } from "./pages/auth/Register.js";
import { ResetPasswordPage } from "./pages/auth/ResetPassword.js";
import { SelectOrgPage } from "./pages/auth/SelectOrg.js";
import { BoxesPage } from "./pages/boxes/index.js";
import { SellBoxPage } from "./pages/boxes/SellBoxPage.js";
import { CatalogPage } from "./pages/catalog/index.js";
import { ProductPanelRoute } from "./pages/catalog/ProductPanelRoute.js";
import { ConflictsPage } from "./pages/conflicts/index.js";
import { CounterpartiesPage } from "./pages/counterparties/index.js";
import { CounterpartyPanelRoute } from "./pages/counterparties/CounterpartyPanelRoute.js";
import { DashboardPage } from "./pages/dashboard/index.js";
import { DevicesPage } from "./pages/devices/index.js";
import { DisaggregationDocumentPage } from "./pages/disaggregation/DocumentDetail.js";
import { DisaggregationPage } from "./pages/disaggregation/index.js";
import { DisaggregationReasonsPage } from "./pages/disaggregation/ReasonsPage.js";
import { EmployeesPage } from "./pages/employees/index.js";
import {
  EmployeeCreatePanelRoute,
  EmployeeEditPanelRoute,
} from "./pages/employees/EmployeePanelRoute.js";
import { BoxCardPage } from "./pages/code-search/BoxCard.js";
import { CodeCardPage } from "./pages/code-search/CodeCard.js";
import { CodeSearchPage } from "./pages/code-search/index.js";
import { ChannelPage } from "./pages/integrations/ChannelPage.js";
import { IntegrationsPage } from "./pages/integrations/index.js";
import { InvitationPage } from "./pages/invitations/InvitationPage.js";
/** Preserves deep links (and their panel-origin state) from the retired /kiosks section. */
function KioskPathRedirect({ suffix }: { suffix?: "edit" | "pair" }) {
  const { kioskId } = useParams();
  const location = useLocation();
  const state: unknown = location.state;
  const to = suffix ? `/devices/kiosks/${kioskId}/${suffix}` : "/devices/kiosks/new";
  return <Navigate to={to} replace state={state} />;
}
import { KioskPairingPanelRoute } from "./pages/kiosks/KioskPairingPanelRoute.js";
import { KioskCreatePanelRoute, KioskEditPanelRoute } from "./pages/kiosks/KioskPanelRoute.js";
import { ReasonsPage } from "./pages/pickup/ReasonsPage.js";
import { LabelEditorPage } from "./pages/labels/editor/index.js";
import { LabelTemplatesPage } from "./pages/labels/index.js";
import { LinesPage } from "./pages/lines/index.js";
import { LinePanelRoute } from "./pages/lines/LinePanelRoute.js";
import { InventoryPage } from "./pages/inventory/index.js";
import { InventoryCreatePage } from "./pages/inventory/InventoryCreatePage.js";
import { InventoryCorrections } from "./pages/inventory/InventoryCorrections.js";
import { InventoryDetailPage } from "./pages/inventory/InventoryDetailPage.js";
import { OrderDetailPage } from "./pages/pickup/OrderDetail.js";
import { RejectionsPage } from "./pages/pickup/Rejections.js";
import { PickupPage } from "./pages/pickup/index.js";
import { ProfilePage } from "./pages/profile/ProfilePage.js";
import { SettingsPage } from "./pages/settings/index.js";
import { SubscriptionPage } from "./pages/settings/SubscriptionPage.js";
import { ShiftsPage } from "./pages/shifts/index.js";
import { ShiftPanelRoute } from "./pages/shifts/ShiftPanelRoute.js";
import { ShellPage } from "./pages/Shell.js";
import { TeamPage } from "./pages/team/TeamPage.js";
import { InvoiceDetailPage, InvoicesPage } from "./pages/billing/InvoicesPage.js";

/**
 * The data router is used even though route data is fetched through React
 * Query: it provides navigation blocking for unsaved work in route-backed
 * panels. Tests use the exported route objects with createMemoryRouter.
 */
const C = CABINET_CAPABILITY;

function appRouteElements() {
  return (
    <>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/activate-owner" element={<ActivateOwnerPage />} />
      <Route path="/invitations/:id" element={<InvitationPage />} />
      <Route path="/profile" element={<ProfilePage />} />
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
        >
          <Route
            path="new"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <ProductPanelRoute mode="create" />
              </RequireCapability>
            }
          />
          <Route
            path=":productId/edit"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <ProductPanelRoute mode="edit" />
              </RequireCapability>
            }
          />
        </Route>
        <Route
          path="shifts"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <ShiftsPage />
            </RequireCapability>
          }
        >
          <Route
            path="new"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <ShiftPanelRoute mode="create" />
              </RequireCapability>
            }
          />
          <Route
            path=":shiftId/edit"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <ShiftPanelRoute mode="edit" />
              </RequireCapability>
            }
          />
        </Route>
        <Route
          path="lines"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <LinesPage />
            </RequireCapability>
          }
        >
          <Route
            path="new"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <LinePanelRoute mode="create" />
              </RequireCapability>
            }
          />
          <Route
            path=":lineId/edit"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <LinePanelRoute mode="edit" />
              </RequireCapability>
            }
          />
        </Route>
        <Route path="inventory">
          <Route
            index
            element={
              <RequireCapability capability={C.OPERATIONS_READ}>
                <InventoryPage />
              </RequireCapability>
            }
          />
          <Route
            path="new"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <InventoryCreatePage />
              </RequireCapability>
            }
          />
          <Route
            path=":inventoryId"
            element={
              <RequireCapability capability={C.OPERATIONS_READ}>
                <InventoryDetailPage />
              </RequireCapability>
            }
          />
          <Route
            path=":inventoryId/corrections"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <InventoryCorrections />
              </RequireCapability>
            }
          />
        </Route>
        <Route
          path="boxes"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <BoxesPage />
            </RequireCapability>
          }
        />
        <Route
          path="boxes/sell"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <SellBoxPage />
            </RequireCapability>
          }
        />
        <Route
          path="codes"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <CodeSearchPage />
            </RequireCapability>
          }
        />
        <Route
          path="codes/km/:codeHash"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <CodeCardPage />
            </RequireCapability>
          }
        />
        <Route
          path="codes/box/:boxId"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <BoxCardPage />
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
        >
          <Route
            path="new"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <CounterpartyPanelRoute mode="create" />
              </RequireCapability>
            }
          />
          <Route
            path=":counterpartyId/edit"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <CounterpartyPanelRoute mode="edit" />
              </RequireCapability>
            }
          />
        </Route>
        <Route
          path="employees"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <EmployeesPage />
            </RequireCapability>
          }
        >
          <Route
            path="new"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <EmployeeCreatePanelRoute />
              </RequireCapability>
            }
          />
          <Route
            path=":employeeId/edit"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <EmployeeEditPanelRoute />
              </RequireCapability>
            }
          />
        </Route>
        <Route
          path="devices"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <DevicesPage />
            </RequireCapability>
          }
        >
          <Route
            path="kiosks/new"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <KioskCreatePanelRoute />
              </RequireCapability>
            }
          />
          <Route
            path="kiosks/:kioskId/edit"
            element={
              <RequireCapability capability={C.OPERATIONS_WRITE}>
                <KioskEditPanelRoute />
              </RequireCapability>
            }
          />
          <Route
            path="kiosks/:kioskId/pair"
            element={
              <RequireCapability capability={C.CREDENTIALS_MANAGE}>
                <KioskPairingPanelRoute />
              </RequireCapability>
            }
          />
        </Route>
        <Route path="kiosks">
          <Route index element={<Navigate to="/devices?type=kiosk" replace />} />
          <Route path="reasons" element={<Navigate to="/pickup/reasons" replace />} />
          <Route path="new" element={<KioskPathRedirect />} />
          <Route path=":kioskId/edit" element={<KioskPathRedirect suffix="edit" />} />
          <Route path=":kioskId/pair" element={<KioskPathRedirect suffix="pair" />} />
        </Route>
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
          path="pickup/reasons"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <ReasonsPage />
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
          path="disaggregation"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <DisaggregationPage />
            </RequireCapability>
          }
        />
        <Route
          path="disaggregation/reasons"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <DisaggregationReasonsPage />
            </RequireCapability>
          }
        />
        <Route
          path="disaggregation/:id"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <DisaggregationDocumentPage />
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
        <Route
          path="settings/subscription"
          element={
            <RequireCapability capability={C.TENANT_SETTINGS_MANAGE}>
              <SubscriptionPage />
            </RequireCapability>
          }
        />
        <Route
          path="team"
          element={
            <RequireCapability capability={C.MEMBERS_MANAGE}>
              <TeamPage />
            </RequireCapability>
          }
        />
        <Route path="billing/invoices" element={<InvoicesPage />} />
        <Route path="billing/invoices/:id" element={<InvoiceDetailPage />} />
      </Route>
    </>
  );
}

export const appRoutes = createRoutesFromElements(appRouteElements());

export function createAppRouter() {
  return createBrowserRouter(appRoutes);
}

export function App() {
  const router = useMemo(createAppRouter, []);

  return (
    <AuthQueryBoundary>
      <RouterProvider router={router} />
    </AuthQueryBoundary>
  );
}
