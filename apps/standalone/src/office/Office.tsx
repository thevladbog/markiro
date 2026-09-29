import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import { OfficeLinkProvider } from "./office-link.js";
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";

export interface OfficeProps {
  session: OfficeSessionValue;
  /** The link to the host, shown in the header; `null` before the first status. */
  link?: HostStatus | null;
  /** The reference sync, shown in the header with the link; `null` outside the app. */
  sync?: SyncState | null;
  /**
   * The latest revision the host announced (`null` before the first). When
   * it changes, the signed-in user is read again, so a new name or role
   * shows without a new sign-in. Open pages are not reloaded under the user.
   */
  hostRevision?: number | null;
}

/**
 * The office: an in-memory router (a desktop window has no address bar) and
 * a query cache, both living exactly as long as one session — `App` mounts
 * `Office` with the session token as its key.
 */
export function Office({ session, link = null, sync = null, hostRevision = null }: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  const [queryClient] = useState(createOfficeQueryClient);
  const shownRevision = useRef(hostRevision);
  useEffect(() => {
    if (shownRevision.current === hostRevision) return;
    shownRevision.current = hostRevision;
    // The user's name and role follow the host at once. Pages read fresh
    // data whenever they open (`staleTime` 0); an open page is not reloaded
    // under the user, so a form keeps what was typed and a save over a newer
    // record meets `stale_revision` instead of losing the edits silently.
    void session.refreshUser().catch(() => undefined);
  }, [hostRevision, session]);
  const officeLink = useMemo(() => ({ status: link, sync }), [link, sync]);
  return (
    <QueryClientProvider client={queryClient}>
      <OfficeSessionProvider value={session}>
        <OfficeLinkProvider value={officeLink}>
          <RouterProvider router={router} />
        </OfficeLinkProvider>
      </OfficeSessionProvider>
    </QueryClientProvider>
  );
}
