import { createContext, useContext, type ReactNode } from "react";

/**
 * Kiosk mode as the office sees it (plan 1f2): given only to an open
 * session of an administrator in a build that locks its window; `null`
 * otherwise, and nothing is shown.
 */
export interface WindowMode {
  /** The window as the shell last confirmed it. */
  mode: "locked" | "windowed";
  /** Turns kiosk mode off; `true` once the window is an ordinary one again. */
  leave: () => Promise<boolean>;
}

const WindowModeContext = createContext<WindowMode | null>(null);

export function WindowModeProvider({
  value,
  children,
}: {
  value: WindowMode | null;
  children: ReactNode;
}) {
  return <WindowModeContext.Provider value={value}>{children}</WindowModeContext.Provider>;
}

export function useWindowMode(): WindowMode | null {
  return useContext(WindowModeContext);
}
