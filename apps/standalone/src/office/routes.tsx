import { Navigate, type RouteObject } from "react-router";

import { BackupsPage } from "./backups/BackupsPage.js";
import { BoxCardPage } from "./codes/BoxCardPage.js";
import { BoxesTab } from "./codes/BoxesTab.js";
import { CodeSearchPage } from "./codes/CodeSearchPage.js";
import { CodesSection } from "./codes/CodesSection.js";
import { PalletCardPage } from "./codes/PalletCardPage.js";
import { PalletsTab } from "./codes/PalletsTab.js";
import { ConflictsPage } from "./conflicts/ConflictsPage.js";
import { CounterpartiesPage } from "./counterparties/CounterpartiesPage.js";
import { DevicesPage } from "./devices/DevicesPage.js";
import { DisaggregationDocumentPage } from "./disaggregation/DisaggregationDocumentPage.js";
import { DisaggregationPage } from "./disaggregation/DisaggregationPage.js";
import { DisaggregationReasonsPage } from "./disaggregation/DisaggregationReasonsPage.js";
import { AboutPage } from "./info/AboutPage.js";
import { CloudImportPage } from "./import/CloudImportPage.js";
import { LinesPage } from "./lines/LinesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
import { OperatorsPage } from "./operators/OperatorsPage.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";
import { PalletSheetsPage } from "./sheets/PalletSheetsPage.js";
import { ProductsPage } from "./products/ProductsPage.js";
import { RequireRole } from "./RequireRole.js";
import { ShiftCardRedirect } from "./shifts/ShiftCardRedirect.js";
import { ShiftsPage } from "./shifts/ShiftsPage.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
import {
  CopyTemplatePage,
  EditTemplatePage,
  NewTemplatePage,
} from "./templates/TemplateEditorPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
import { TemplatesSection } from "./templates/TemplatesSection.js";
import { OfficeUsersPage } from "./users/OfficeUsersPage.js";

/** Office routes; paths match `OFFICE_NAV`. */
export const officeRoutes: RouteObject[] = [
  {
    path: "/",
    element: <OfficeShell />,
    children: [
      { index: true, element: <OfficeOverview /> },
      { path: "org", element: <OrgProfilePage /> },
      { path: "sscc", element: <SsccPage /> },
      { path: "counterparties", element: <CounterpartiesPage /> },
      { path: "lines", element: <LinesPage /> },
      { path: "shifts", element: <ShiftsPage /> },
      { path: "shifts/:id", element: <ShiftCardRedirect /> },
      { path: "disaggregation", element: <DisaggregationPage /> },
      // A static segment ranks above `:id`, so «reasons» is never a document.
      { path: "disaggregation/reasons", element: <DisaggregationReasonsPage /> },
      { path: "disaggregation/:id", element: <DisaggregationDocumentPage /> },
      { path: "conflicts", element: <ConflictsPage /> },
      // «Поиск кодов» is one section: the codes, the boxes and the pallets, and the cards of the last two.
      {
        path: "codes",
        element: <CodesSection />,
        children: [
          { index: true, element: <CodeSearchPage /> },
          { path: "boxes", element: <BoxesTab /> },
          { path: "pallets", element: <PalletsTab /> },
          { path: "box/:id", element: <BoxCardPage /> },
          { path: "pallet/:id", element: <PalletCardPage /> },
        ],
      },
      {
        path: "operators",
        element: (
          <RequireRole roles={["admin"]}>
            <OperatorsPage />
          </RequireRole>
        ),
      },
      {
        path: "devices",
        element: (
          <RequireRole roles={["admin"]}>
            <DevicesPage />
          </RequireRole>
        ),
      },
      { path: "products", element: <ProductsPage /> },
      // «Шаблоны» is one section: labels, A4 sheets and the defaults of both.
      {
        path: "templates",
        element: <TemplatesSection />,
        children: [
          { index: true, element: <TemplatesPage /> },
          { path: "a4", element: <PalletSheetsPage /> },
          { path: "defaults", element: <TemplateDefaultsPage /> },
        ],
      },
      { path: "templates/new", element: <NewTemplatePage /> },
      { path: "templates/:id", element: <EditTemplatePage /> },
      { path: "templates/:id/copy", element: <CopyTemplatePage /> },
      // The sheets and the defaults had menu items of their own before.
      { path: "template-defaults", element: <Navigate to="/templates/defaults" replace /> },
      { path: "pallet-sheets", element: <Navigate to="/templates/a4" replace /> },
      {
        path: "users",
        element: (
          <RequireRole roles={["admin"]}>
            <OfficeUsersPage />
          </RequireRole>
        ),
      },
      { path: "backups", element: <BackupsPage /> },
      { path: "about", element: <AboutPage /> },
      {
        path: "import",
        element: (
          <RequireRole roles={["admin"]}>
            <CloudImportPage />
          </RequireRole>
        ),
      },
    ],
  },
];
