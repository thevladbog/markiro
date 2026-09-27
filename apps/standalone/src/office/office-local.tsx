import { createContext, useContext, type ReactNode } from "react";

import type { LocalExecutor } from "../local/executor.js";

const OfficeLocalContext = createContext<LocalExecutor | null>(null);

/** This installation's local copies of the host's reference data, for office screens. */
export function OfficeLocalProvider({
  value,
  children,
}: {
  value: LocalExecutor | null;
  children: ReactNode;
}) {
  return <OfficeLocalContext.Provider value={value}>{children}</OfficeLocalContext.Provider>;
}

/** `null` outside the app, as in office tests that do not pass one. */
export function useOfficeLocal(): LocalExecutor | null {
  return useContext(OfficeLocalContext);
}
