import { createContext, useContext, type ReactNode } from "react";

import type { HostUpdateCheck } from "./use-host-offer.js";

/**
 * What the station's two update entries read — the «Станция» tab's version block and the sign-in's
 * footer: the check (`useHostUpdateCheck` in `App`), whether a shift
 * is in progress here, and how to open the «С хоста» dialog. `null` (a test, a screen outside the
 * app) means no entry is drawn.
 */
export interface FloorUpdateEntry extends HostUpdateCheck {
  /** A shift is in progress on this station: the install is held back. */
  inShift: boolean;
  open: () => void;
}

const FloorUpdateEntryContext = createContext<FloorUpdateEntry | null>(null);

export function FloorUpdateEntryProvider({
  value,
  children,
}: {
  value: FloorUpdateEntry | null;
  children: ReactNode;
}) {
  return <FloorUpdateEntryContext value={value}>{children}</FloorUpdateEntryContext>;
}

export function useFloorUpdateEntry(): FloorUpdateEntry | null {
  return useContext(FloorUpdateEntryContext);
}

/** The same entry with a shift in progress: the setup opened from a shift's screen. */
export function InShiftUpdateEntry({ children }: { children: ReactNode }) {
  const entry = useFloorUpdateEntry();
  return (
    <FloorUpdateEntryProvider value={entry === null ? null : { ...entry, inShift: true }}>
      {children}
    </FloorUpdateEntryProvider>
  );
}

/**
 * The floor's frame (`.floor-frame`) with the entry provided to everything inside it: the sign-in
 * footer and the setup's «Станция». A frame rather than a wrapper so the app's markup keeps its depth.
 */
export function FloorFrameWithUpdateEntry({
  value,
  children,
}: {
  value: FloorUpdateEntry;
  children: ReactNode;
}) {
  return (
    <FloorUpdateEntryProvider value={value}>
      <div className="floor-frame">{children}</div>
    </FloorUpdateEntryProvider>
  );
}
