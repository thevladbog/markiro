import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";

export interface OfficeProps {
  session: OfficeSessionValue;
}

/**
 * The office: an in-memory router (a desktop window has no address bar) and
 * a query cache, both living exactly as long as one session — `App` mounts
 * `Office` with the session token as its key.
 */
export function Office({ session }: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  const [queryClient] = useState(createOfficeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <OfficeSessionProvider value={session}>
        <RouterProvider router={router} />
      </OfficeSessionProvider>
    </QueryClientProvider>
  );
}
