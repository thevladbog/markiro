import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Modal } from "@markiro/ui";

import { createGatedScanSource } from "../../floor/gated-scan-source.js";
import {
  WorkstationSetup,
  type WorkstationSetupProps,
} from "../../floor/setup/WorkstationSetup.js";
import type { ScanSource } from "../../floor/scan-source.js";

/** The same device-local scanner and settings used by the floor and pairing screens. */
export type OfficeScanner = Pick<
  WorkstationSetupProps,
  "source" | "local" | "hardware" | "printing"
>;

interface OfficeScannerValue {
  /** No global listener while the scanner settings own the device. */
  source: ScanSource | null;
  canConfigure: boolean;
  settingsOpen: boolean;
  openSettings: () => void;
}

const NO_SCANNER: OfficeScannerValue = {
  source: null,
  canConfigure: false,
  settingsOpen: false,
  openSettings: () => undefined,
};
const OfficeScannerContext = createContext<OfficeScannerValue>(NO_SCANNER);

/** Scanner ownership lasts one Office session; this provider does not subscribe to scans. */
export function OfficeScannerProvider({
  scanner = null,
  children,
}: {
  scanner?: OfficeScanner | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const source = scanner?.source ?? null;
  const gate = useMemo(() => (source === null ? null : createGatedScanSource(source)), [source]);
  // Neither partial wedge input nor a manual-entry lock can cross a session boundary.
  useLayoutEffect(() => {
    gate?.setMuted(false);
    source?.clearPendingInput();
    source?.setManualTextEntryActive(false);
    return () => {
      gate?.setMuted(true);
      source?.clearPendingInput();
      source?.setManualTextEntryActive(false);
    };
  }, [source, gate]);
  const openSettings = useCallback(() => {
    if (source === null) return;
    // Mute synchronously: an existing global callback cannot hear a self-test scan
    // before its React subscription cleanup runs.
    gate?.setMuted(true);
    source.clearPendingInput();
    source.setManualTextEntryActive(false);
    setSettingsOpen(true);
  }, [gate, source]);
  const closeSettings = () => {
    source?.clearPendingInput();
    source?.setManualTextEntryActive(false);
    gate?.setMuted(false);
    setSettingsOpen(false);
  };
  const value = useMemo<OfficeScannerValue>(
    () => ({
      source: settingsOpen ? null : (gate?.source ?? null),
      canConfigure: scanner !== null,
      settingsOpen,
      openSettings,
    }),
    [settingsOpen, gate, scanner, openSettings],
  );
  return (
    <OfficeScannerContext.Provider value={value}>
      {children}
      {settingsOpen && scanner !== null && (
        <Modal
          open
          title={t("floor.signIn.scannerSettings")}
          closeLabel={t("office.common.close")}
          onClose={closeSettings}
          width={1100}
          className="office-scanner-dialog"
          style={{ height: "min(920px, 90dvh)", overflow: "hidden" }}
        >
          <WorkstationSetup
            {...scanner}
            scope="scanners"
            onSaved={() => undefined}
            onBack={closeSettings}
          />
        </Modal>
      )}
    </OfficeScannerContext.Provider>
  );
}

export function useOfficeScanner(): OfficeScannerValue {
  return useContext(OfficeScannerContext);
}
