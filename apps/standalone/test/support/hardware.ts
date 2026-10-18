import { vi } from "vitest";

import type {
  HardwareApi,
  PrintResult,
  PrintTarget,
  ScannerSnapshot,
} from "../../src/hardware/hardware.js";

/** One send the fake printer took: where, and the bytes as text (labels are latin1). */
export interface FakeSend {
  target: PrintTarget;
  text: string;
}

/**
 * The shell's hardware for tests: every send is recorded and answered by
 * `answer` (`{ sent: true }` by default); `holdSends()` keeps the next sends
 * waiting until `releaseSend(result)` — the printer that does not answer yet.
 * Scanners and power are plain mocks.
 */
export function fakeHardware(answer: () => Promise<PrintResult> = async () => ({ sent: true })) {
  const sends: FakeSend[] = [];
  const held: ((result: PrintResult) => void)[] = [];
  let holding = false;
  let snapshotListener: ((snapshot: ScannerSnapshot) => void) | null = null;
  const hardware: HardwareApi = {
    printBytes: vi.fn<HardwareApi["printBytes"]>(async (target, bytes) => {
      let text = "";
      for (const byte of bytes) text += String.fromCharCode(byte);
      sends.push({ target, text });
      if (holding) {
        return new Promise<PrintResult>((resolve) => {
          held.push(resolve);
        });
      }
      return answer();
    }),
    listUsbPrinters: vi.fn<HardwareApi["listUsbPrinters"]>(async () => []),
    listSerialPorts: vi.fn<HardwareApi["listSerialPorts"]>(async () => []),
    configureScanners: vi.fn<HardwareApi["configureScanners"]>(async () => undefined),
    closeScanners: vi.fn<HardwareApi["closeScanners"]>(async () => undefined),
    watchScanners: vi.fn<HardwareApi["watchScanners"]>(async (onSnapshot) => {
      snapshotListener = onSnapshot;
      onSnapshot({ revision: 0, scanners: [] });
      return () => {
        snapshotListener = null;
      };
    }),
    onScan: vi.fn<HardwareApi["onScan"]>(async () => () => undefined),
    setSystemAwake: vi.fn<HardwareApi["setSystemAwake"]>(async () => undefined),
  };
  return {
    hardware,
    sends,
    /** The next sends wait until `releaseSend`. */
    holdSends: () => {
      holding = true;
    },
    /** How many sends wait for an answer. */
    heldSends: () => held.length,
    /** Answers the oldest waiting send; later sends are answered by `answer` again once none wait. */
    releaseSend: (result: PrintResult) => {
      const resolve = held.shift();
      if (held.length === 0) holding = false;
      resolve?.(result);
    },
    /** Tells the watcher of the scanners a new snapshot. */
    scannerStatus: (snapshot: ScannerSnapshot) => snapshotListener?.(snapshot),
  };
}
