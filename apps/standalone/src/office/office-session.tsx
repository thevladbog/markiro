import { createContext, useContext, type ReactNode } from "react";

import type { OfficeUser, PasswordChange } from "../host/protocol.js";

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
   * Runs a host call with the session token. An ended session or a rejected
   * device is routed to the shell before the error is rethrown.
   */
  call: <T>(operation: (token: string) => Promise<T>) => Promise<T>;
  /**
   * «Выйти в цех»: ends the session at once — back to the floor, the token
   * dropped — and tells the host in the background.
   */
  logout: () => void;
  /** Changes the signed-in user's own password; the host ends their other sessions. */
  changePassword: (request: PasswordChange) => Promise<void>;
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
