import type { RouteObject } from "react-router";

import { DevicesPage } from "./devices/DevicesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
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
      {
        path: "devices",
        element: (
          <RequireRole roles={["admin"]}>
            <DevicesPage />
          </RequireRole>
        ),
      },
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
