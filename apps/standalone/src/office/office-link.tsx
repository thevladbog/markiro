import { createContext, useContext, type ReactNode } from "react";

import type { HostStatus } from "../host/protocol.js";

const OfficeLinkContext = createContext<HostStatus | null>(null);

/** The link to the host as the shell reports it, for the office header. */
export function OfficeLinkProvider({
  value,
  children,
}: {
  value: HostStatus | null;
  children: ReactNode;
}) {
  return <OfficeLinkContext.Provider value={value}>{children}</OfficeLinkContext.Provider>;
}

/** `null` before the shell's first status and outside the office. */
export function useOfficeLink(): HostStatus | null {
  return useContext(OfficeLinkContext);
}
