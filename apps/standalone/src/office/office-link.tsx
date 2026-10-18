import { createContext, useContext, type ReactNode } from "react";

import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";

/** The link to the host and the reference sync as the shell reports them, for the office header. */
export interface OfficeLink {
  /** `null` before the shell's first status and outside the app. */
  status: HostStatus | null;
  /** `null` outside the app. */
  sync: SyncState | null;
}

const OfficeLinkContext = createContext<OfficeLink>({ status: null, sync: null });

export function OfficeLinkProvider({
  value,
  children,
}: {
  value: OfficeLink;
  children: ReactNode;
}) {
  return <OfficeLinkContext.Provider value={value}>{children}</OfficeLinkContext.Provider>;
}

export function useOfficeLink(): OfficeLink {
  return useContext(OfficeLinkContext);
}
