import type { RouteObject } from "react-router";

import { CounterpartiesPage } from "./counterparties/CounterpartiesPage.js";
import { DevicesPage } from "./devices/DevicesPage.js";
import { LinesPage } from "./lines/LinesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
import { OperatorsPage } from "./operators/OperatorsPage.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";
import { ProductsPage } from "./products/ProductsPage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
import {
  CopyTemplatePage,
  EditTemplatePage,
  NewTemplatePage,
} from "./templates/TemplateEditorPage.js";
import { TemplatesPage } from "./templates/TemplatesPage.js";
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
      { path: "templates", element: <TemplatesPage /> },
      { path: "templates/new", element: <NewTemplatePage /> },
      { path: "templates/:id", element: <EditTemplatePage /> },
      { path: "templates/:id/copy", element: <CopyTemplatePage /> },
      { path: "template-defaults", element: <TemplateDefaultsPage /> },
      {
        path: "users",
        element: (
          <RequireRole roles={["admin"]}>
            <OfficeUsersPage />
          </RequireRole>
        ),
      },
    ],
  },
];
