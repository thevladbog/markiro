import { createContext, useContext, type ReactNode } from "react";

import type { OfficeUser } from "../host/protocol.js";

/**
 * The open office session, provided by the shell to every office screen.
 *
 * Every member is a function-typed property rather than a TS method
 * (`leave(): void` etc.): `@typescript-eslint/unbound-method` flags a method
 * shorthand member when it is passed around unbound, e.g. `onClick={session.leave}`.
 */
export interface OfficeSessionValue {
  user: OfficeUser;
  /**
   * Runs a host call with the session token. An ended session or a rejected
   * device is routed to the shell before the error is rethrown.
   */
  call: <T>(operation: (token: string) => Promise<T>) => Promise<T>;
  /** Back to the floor; the session stays open until the host expires it. */
  leave: () => void;
  /** Ends the session on the host and returns to the floor. */
  logout: () => Promise<void>;
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
