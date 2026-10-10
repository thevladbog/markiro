import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import { OfficeFilesProvider, TAURI_OFFICE_FILES } from "./exports/office-files-context.js";
import type { OfficeFilesApi } from "./exports/office-files.js";
import { OfficeLinkProvider } from "./office-link.js";
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";
import {
  BROWSER_LABEL_RENDERING,
  LabelRenderingProvider,
  type LabelRendering,
} from "./templates/label-rendering.js";
import { ThisDeviceProvider } from "./this-device.js";
import { WindowModeProvider, type WindowMode } from "./window-mode.js";

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
  /**
   * The device this office runs on (`DeviceStatus.deviceId`): «Устройства»
   * marks its row and asks more before it revokes itself. `null` outside
   * the app.
   */
  deviceId?: string | null;
  /**
   * How the office draws labels (the template editor's preview): the
   * webview's canvas and fonts by default; a test passes its own.
   */
  labels?: LabelRendering;
  /**
   * Where the office saves its files (exports, plan ЧЗ): the shell's
   * commands by default; a test passes its own.
   */
  files?: OfficeFilesApi;
  /**
   * Kiosk mode, for the administrator's «Оконный режим» in the header;
   * `null` (the default) shows no such control.
   */
  windowMode?: WindowMode | null;
}

/**
 * The office: an in-memory router (a desktop window has no address bar) and
 * a query cache, both living exactly as long as one session — `App` mounts
 * `Office` with the session token as its key.
 */
export function Office({
  session,
  link = null,
  sync = null,
  hostRevision = null,
  deviceId = null,
  labels = BROWSER_LABEL_RENDERING,
  files = TAURI_OFFICE_FILES,
  windowMode = null,
}: OfficeProps) {
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
          <ThisDeviceProvider deviceId={deviceId}>
            <LabelRenderingProvider value={labels}>
              <OfficeFilesProvider value={files}>
                <WindowModeProvider value={windowMode}>
                  <RouterProvider router={router} />
                </WindowModeProvider>
              </OfficeFilesProvider>
            </LabelRenderingProvider>
          </ThisDeviceProvider>
        </OfficeLinkProvider>
      </OfficeSessionProvider>
    </QueryClientProvider>
  );
}
