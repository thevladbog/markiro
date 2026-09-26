import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";

export interface OfficeProps {
  session: OfficeSessionValue;
}

/** The office: an in-memory router (a desktop window has no address bar) under the session. */
export function Office({ session }: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  return (
    <OfficeSessionProvider value={session}>
      <RouterProvider router={router} />
    </OfficeSessionProvider>
  );
}
