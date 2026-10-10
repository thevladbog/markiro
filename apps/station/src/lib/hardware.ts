import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SerialScannerConfig } from "./hardware-config.js";
import type { ScanSource } from "./scan-source.js";

export type PrintTarget =
  | { kind: "serial"; port: string; baud: number }
  | { kind: "tcp"; host: string; port: number }
  | { kind: "usb"; printer: string };

/** One installed Windows printer queue available to the current user. */
export interface UsbPrinterInfo {
  name: string;
  port: string;
}

/** Aggregate availability of the configured COM ports. */
export type ScannerStatus = "connected" | "partial" | "disconnected";
export interface ScannerConnection extends SerialScannerConfig {
  status: "connected" | "disconnected";
}
interface ScannerConnectionsSnapshot {
  revision: number;
  scanners: ScannerConnection[];
}

async function subscribeScannerConnections(
  listener: (connections: ScannerConnection[]) => void,
): Promise<() => void> {
  let revision = -1;
  let stopped = false;
  const receive = (snapshot: ScannerConnectionsSnapshot) => {
    if (stopped || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    listener(snapshot.scanners);
  };
  const unlisten = await listen<ScannerConnectionsSnapshot>("station://scanner-status", (event) =>
    receive(event.payload),
  );
  const stop = () => {
    stopped = true;
    unlisten();
  };
  try {
    // Subscribe first, then hydrate: do not miss a connection that opened before mount.
    receive(await invoke<ScannerConnectionsSnapshot>("get_scanner_connections"));
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

function scannerAvailability(connections: ScannerConnection[]): ScannerStatus {
  const connected = connections.filter((connection) => connection.status === "connected").length;
  if (connected === 0) return "disconnected";
  return connected === connections.length ? "connected" : "partial";
}

/**
 * The station's hardware surface, shaped like the idento agent's contract so
 * an external agent process can later provide it instead of Tauri — without
 * the UI knowing which one is behind it.
 */
export interface HardwareContract {
  listScannerPorts(): Promise<string[]>;
  /** Installed Windows printer queues, with USB ports first; empty off Windows. */
  listUsbPrinters(): Promise<UsbPrinterInfo[]>;
  /** Reconciles the complete desired set. Port IO/reconnection runs independently in Rust. */
  configureScanners(scanners: readonly SerialScannerConfig[]): Promise<void>;
  closeScanner(): Promise<void>;
  /** Subscribes to decoded scans; resolves to the unsubscribe function. */
  onScan(listener: (raw: string) => void): Promise<() => void>;
  /** Subscribes to scanner connection changes; resolves to the unsubscribe function. */
  onScannerStatus(listener: (status: ScannerStatus) => void): Promise<() => void>;
  onScannerConnections(listener: (connections: ScannerConnection[]) => void): Promise<() => void>;
  print(target: PrintTarget, bytes: Uint8Array): Promise<void>;
}

/** Tauri's IPC is JSON, so label bytes cross it base64-encoded. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const tauriHardware: HardwareContract = {
  listScannerPorts: () => invoke<string[]>("list_serial_ports"),
  listUsbPrinters: () => invoke<UsbPrinterInfo[]>("list_usb_printers"),
  configureScanners: (scanners) => invoke<void>("configure_scanners", { scanners }),
  closeScanner: () => invoke<void>("close_scanner"),
  async onScan(listener) {
    return listen<string>("station://scan", (event) => listener(event.payload));
  },
  onScannerStatus: (listener) =>
    subscribeScannerConnections((connections) => listener(scannerAvailability(connections))),
  onScannerConnections: subscribeScannerConnections,
  print: (target, bytes) =>
    invoke<void>("print_bytes", { target, payloadBase64: bytesToBase64(bytes) }),
};

/** Only callers that persist unknown delivery may release a stalled USB send. */
export function tauriWarehousePrint(target: PrintTarget, bytes: Uint8Array): Promise<void> {
  return invoke<void>("print_bytes", {
    target,
    payloadBase64: bytesToBase64(bytes),
    deliveryUnknownOnTimeout: true,
  });
}

/**
 * Adapts the hardware contract to the same `ScanSource` seam the keyboard
 * wedge implements, so the work screen is identical either way.
 */
export function createHardwareScanSource(hw: HardwareContract): ScanSource {
  return {
    start(listener) {
      let unsubscribe: (() => void) | null = null;
      let stopped = false;
      void hw
        .onScan(listener)
        .then((fn) => {
          if (stopped) fn();
          else unsubscribe = fn;
        })
        .catch((err: unknown) => {
          // A rejected `listen` (e.g. the Tauri event channel never came up)
          // must not become an unhandled rejection, and must not leave
          // `unsubscribe` silently unset — log it so a scan source that
          // never fires is at least visible in the console instead of
          // failing in total silence.
          console.error("station: failed to subscribe to hardware scans", err);
        });
      return () => {
        stopped = true;
        unsubscribe?.();
      };
    },
  };
}

export interface WindowsPrintReceipt {
  queue: string;
  jobId: number;
  documentName: string;
}
export interface WindowsPrintFailure {
  code:
    | "unsupported_platform"
    | "invalid_artifact"
    | "queue_unavailable"
    | "geometry_mismatch"
    | "driver_failure";
  phase: "before_start" | "delivery_unknown";
  receipt?: WindowsPrintReceipt;
}
export type WindowsPrintResult =
  { ok: true; receipt: WindowsPrintReceipt } | { ok: false; error: WindowsPrintFailure };
export type WindowsPreflight = { ok: true } | { ok: false; error: WindowsPrintFailure };
export type WindowsJobObservation =
  | { state: "present"; statusFlags: number }
  | { state: "absent" | "identity_mismatch" | "unavailable" };
/** Kept separate so old injected scanner/RAW adapters stay source-compatible. */
export interface WindowsPrinting {
  supportsWindowsPrinting(): Promise<boolean>;
  preflightWindowsRaster(queue: string, bytes: Uint8Array): Promise<WindowsPreflight>;
  printWindowsRaster(
    queue: string,
    bytes: Uint8Array,
    documentName: string,
  ): Promise<WindowsPrintResult>;
  getWindowsPrintJob(receipt: WindowsPrintReceipt): Promise<WindowsJobObservation>;
}
export const tauriWindowsPrinting: WindowsPrinting = {
  supportsWindowsPrinting: () => invoke<boolean>("supports_windows_printing"),
  preflightWindowsRaster: (queue, bytes) =>
    invoke<WindowsPreflight>("preflight_windows_raster", {
      queue,
      payloadBase64: bytesToBase64(bytes),
    }),
  printWindowsRaster: (queue, bytes, documentName) =>
    invoke<WindowsPrintResult>("print_windows_raster", {
      queue,
      payloadBase64: bytesToBase64(bytes),
      documentName,
    }),
  getWindowsPrintJob: (receipt) =>
    invoke<WindowsJobObservation>("get_windows_print_job", { receipt }),
};
