import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/office/list/list.css";
import "../../../src/office/avatar/profile.css";
import "../../../src/floor/floor-kit.css";
import "../../../src/i18n/index.js";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";

import { Office } from "../../../src/office/Office.js";
import type { OfficeSessionValue } from "../../../src/office/office-session.js";
import type { LocalExecutor } from "../../../src/local/executor.js";
import type {
  HardwareApi,
  ScannerConfig,
  ScannerSnapshot,
} from "../../../src/hardware/hardware.js";
import { createPrintRuntime } from "../../../src/floor/print/print-runtime.js";
import {
  createComScanSource,
  createKeyboardWedgeSource,
  mergeScanSources,
} from "../../../src/floor/scan-source.js";
import { api, user } from "./data.js";

// Browser-only demonstration adapters. No real host, local database, printer or COM port is used.
const stored = new Map<string, string>([
  ["scanners", JSON.stringify([{ port: "COM3", baud: 9600 }])],
]);
const local: LocalExecutor = {
  async query(sql, _params, row) {
    if (sql !== "SELECT key, value FROM workstation_settings")
      throw new Error("Unexpected preview query");
    return [...stored].map(([key, value]) => row.parse({ key, value }));
  },
  async transaction(statements) {
    return statements.map((statement) => {
      if (!statement.sql.startsWith("INSERT INTO workstation_settings"))
        throw new Error("Unexpected preview write");
      const [key, value] = statement.values ?? [];
      if (typeof key !== "string" || typeof value !== "string")
        throw new Error("Invalid preview setting");
      stored.set(key, value);
      return 1;
    });
  },
};
let configured: readonly ScannerConfig[] = [{ port: "COM3", baud: 9600 }];
let revision = 1;
const statusListeners = new Set<(snapshot: ScannerSnapshot) => void>();
const scanListeners = new Set<(raw: string) => void>();
const snapshot = (): ScannerSnapshot => ({
  revision,
  scanners: configured.map((scanner) => ({ ...scanner, status: "connected" })),
});
const hardware: HardwareApi = {
  printBytes: async () => ({ sent: false, code: "unsupported" }),
  listUsbPrinters: async () => [],
  listSerialPorts: async () => ["COM3", "COM4", "COM7"],
  configureScanners: async (scanners) => {
    configured = scanners;
    revision += 1;
    for (const listener of statusListeners) listener(snapshot());
  },
  closeScanners: async () => {
    configured = [];
  },
  watchScanners: async (listener) => {
    statusListeners.add(listener);
    listener(snapshot());
    return () => {
      statusListeners.delete(listener);
    };
  },
  onScan: async (listener) => {
    scanListeners.add(listener);
    return () => {
      scanListeners.delete(listener);
    };
  },
  setSystemAwake: async () => undefined,
};
const source = mergeScanSources(createKeyboardWedgeSource(), createComScanSource(hardware.onScan));
declare global {
  interface Window {
    officeReviewEmitScan: (raw: string) => void;
  }
}
window.officeReviewEmitScan = (raw) => {
  for (const listener of scanListeners) listener(raw);
};
const session: OfficeSessionValue = {
  user,
  api,
  call: (operation) => operation("office-preview-session"),
  logout: () => undefined,
  signOut: () => undefined,
  refreshUser: async () => undefined,
};
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const root = document.getElementById("root");
if (root === null) throw new Error("No preview root");
createRoot(root).render(
  <ThemeProvider defaultTheme={theme}>
    <Office
      session={session}
      initialPath={params.get("path") ?? "/"}
      link={{ state: "online", lastContactAt: Date.now(), lastError: null, seq: 1 }}
      sync={{ kind: "done", synced: 10, failure: null, quarantined: 0 }}
      scanner={{ source, local, hardware, printing: createPrintRuntime(hardware.printBytes) }}
    />
  </ThemeProvider>,
);
