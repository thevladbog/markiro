import { KioskShell } from "./ui/KioskShell.js";

export type KioskView =
  "loading" | "pairing" | "scanner-setup" | "blocked" | "idle" | "cart" | "done";

export interface KioskViewInput {
  paired: boolean;
  cacheStale: boolean;
  scannerSetupRequested: boolean;
  employeeId: string | null;
  submitted: boolean;
  configLoaded: boolean;
}

/**
 * The whole screen-routing decision, extracted so it can be tested without a
 * DOM, IndexedDB or a scanner — the same discipline `nextStationView` follows
 * in apps/station. Ordering is deliberate: scanner setup outranks pairing
 * because the scanner is often what reads the pairing code, and the staleness
 * block outranks work but NOT pairing (a device that cannot pair cannot
 * refresh, so blocking it first would be a dead end).
 */
export function nextKioskView(input: KioskViewInput): KioskView {
  if (!input.configLoaded) return "loading";
  if (input.scannerSetupRequested) return "scanner-setup";
  if (!input.paired) return "pairing";
  if (input.cacheStale) return "blocked";
  if (!input.employeeId) return "idle";
  return input.submitted ? "done" : "cart";
}

/**
 * The composition root, and deliberately nothing else. `nextKioskView` above is
 * the decision; `KioskShell` is the wiring that feeds it and renders what it
 * picks. Keeping the two in separate files is what lets the decision be tested
 * with no DOM, no IndexedDB and no scanner (`test/app-view.test.ts`).
 */
export function App(): React.JSX.Element {
  return <KioskShell />;
}
