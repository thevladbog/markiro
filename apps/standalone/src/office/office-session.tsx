import { createContext, useContext, type ReactNode } from "react";

import type { HostApi } from "../host/api.js";
import type { OfficeUser } from "../host/protocol.js";

/**
 * The open office session, provided by the shell to every office screen.
 *
 * Every member is a function-typed property rather than a TS method
 * (`logout(): void` etc.): `@typescript-eslint/unbound-method` flags a method
 * shorthand member when it is passed around unbound, e.g. `onClick={session.logout}`.
 */
export interface OfficeSessionValue {
  user: OfficeUser;
  /**
   * Host endpoints. Office screens reach them only through `call` — via
   * `useOfficeQuery` and `useOfficeMutation` — never directly.
   */
  api: HostApi;
  /**
   * Runs a host call with the session token. An ended session or a rejected
   * device is routed to the shell before the error is rethrown; `forbidden`
   * also re-reads the user, whose role may have changed on the host.
   */
  call: <T>(operation: (token: string) => Promise<T>) => Promise<T>;
  /**
   * «Выйти в цех»: ends the session at once — back to the floor, the token
   * dropped — and tells the host in the background.
   */
  logout: () => void;
  /** Re-reads the signed-in user (name, role) from the host into the shell. */
  refreshUser: () => Promise<void>;
}

const OfficeSessionContext = createContext<OfficeSessionValue | null>(null);

export function OfficeSessionProvider({
  value,
  children,
}: {
  value: OfficeSessionValue;
  children: ReactNode;
}) {
  return <OfficeSessionContext.Provider value={value}>{children}</OfficeSessionContext.Provider>;
}

export function useOfficeSession(): OfficeSessionValue {
  const value = useContext(OfficeSessionContext);
  if (!value) throw new Error("useOfficeSession must be used inside OfficeSessionProvider");
  return value;
}
