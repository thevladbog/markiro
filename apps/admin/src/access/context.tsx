import { createContext, useContext, type ReactNode } from "react";
import type { CabinetCapability } from "@markiro/domain";

import type { AccessDocument } from "./api.js";
import { ForbiddenPage } from "./ForbiddenPage.js";

const AccessContext = createContext<AccessDocument | null>(null);

export function AccessProvider({
  value,
  children,
}: {
  value: AccessDocument;
  children: ReactNode;
}) {
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): AccessDocument {
  const access = useContext(AccessContext);
  if (!access) throw new Error("useAccess must be used inside AccessProvider");
  return access;
}

export function useCan(capability: CabinetCapability): boolean {
  return useAccess().capabilities.includes(capability);
}

/** Renders an explicit denial state for a route the active grant cannot read. */
export function RequireCapability({
  capability,
  children,
}: {
  capability: CabinetCapability;
  children: ReactNode;
}) {
  return useCan(capability) ? <>{children}</> : <ForbiddenPage />;
}
