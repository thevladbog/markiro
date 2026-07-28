import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ScanSource } from "./scan-source.js";

export type PrintTarget =
  { kind: "serial"; port: string; baud: number } | { kind: "tcp"; host: string; port: number };

/** Whether a configured serial scanner is currently open. */
export type ScannerStatus = "connected" | "disconnected";

/**
 * The station's hardware surface, shaped like the idento agent's contract so
 * an external agent process can later provide it instead of Tauri — without
 * the UI knowing which one is behind it.
 */
export interface HardwareContract {
  listScannerPorts(): Promise<string[]>;
  openScanner(port: string, baud: number): Promise<void>;
  closeScanner(): Promise<void>;
  /** Subscribes to decoded scans; resolves to the unsubscribe function. */
  onScan(listener: (raw: string) => void): Promise<() => void>;
  /** Subscribes to scanner connection changes; resolves to the unsubscribe function. */
  onScannerStatus(listener: (status: ScannerStatus) => void): Promise<() => void>;
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
  openScanner: (port, baud) => invoke<void>("open_scanner", { port, baud }),
  closeScanner: () => invoke<void>("close_scanner"),
  async onScan(listener) {
    return listen<string>("station://scan", (event) => listener(event.payload));
  },
  async onScannerStatus(listener) {
    return listen<ScannerStatus>("station://scanner-status", (event) => listener(event.payload));
  },
  print: (target, bytes) =>
    invoke<void>("print_bytes", { target, payloadBase64: bytesToBase64(bytes) }),
};

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
