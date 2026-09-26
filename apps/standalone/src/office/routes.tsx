import type { RouteObject } from "react-router";

import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";

/** Office routes; plan 1b3 adds the organization, SSCC and users pages as children. */
export const officeRoutes: RouteObject[] = [
  {
    path: "/",
    element: <OfficeShell />,
    children: [{ index: true, element: <OfficeOverview /> }],
  },
];
