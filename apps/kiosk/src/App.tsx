import { useTranslation } from "react-i18next";

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

export function App(): React.JSX.Element {
  const { t } = useTranslation();
  return <main>{t("app.booting")}</main>;
}
