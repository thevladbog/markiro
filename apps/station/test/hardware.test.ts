import { describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  createHardwareScanSource,
  type HardwareContract,
} from "../src/lib/hardware.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("bytesToBase64", () => {
  it("encodes bytes above 0x7F without mangling them", () => {
    expect(bytesToBase64(new Uint8Array([0x5e, 0x58, 0x41, 0xa4]))).toBe("XlhBpA==");
  });

  it("encodes an empty payload", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });
});

describe("hardware scan source", () => {
  it("subscribes on start and unsubscribes on stop", async () => {
    const unsubscribe = vi.fn();
    let emit: (raw: string) => void = () => {};
    const hw: HardwareContract = {
      listScannerPorts: async () => [],
      listUsbPrinters: async () => [],
      configureScanners: async () => {},
      closeScanner: async () => {},
      onScan: async (listener) => {
        emit = listener;
        return unsubscribe;
      },
      onScannerConnections: async () => () => {},
      onScannerStatus: async () => () => {},
      print: async () => {},
    };

    const scans: string[] = [];
    const stop = createHardwareScanSource(hw).start((raw) => scans.push(raw));
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));

    emit("0104600000000015");
    expect(scans).toEqual(["0104600000000015"]);

    stop();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled());
  });
});

describe("scanner status subscription", () => {
  it("delivers status updates and unsubscribes on stop", async () => {
    const unsubscribe = vi.fn();
    let emit: (s: "connected" | "disconnected") => void = () => {};
    const hw: HardwareContract = {
      listScannerPorts: async () => [],
      listUsbPrinters: async () => [],
      configureScanners: async () => {},
      closeScanner: async () => {},
      onScan: async () => () => {},
      onScannerConnections: async () => () => {},
      onScannerStatus: async (listener) => {
        emit = listener;
        return unsubscribe;
      },
      print: async () => {},
    };

    const seen: string[] = [];
    const stop = await hw.onScannerStatus((s) => seen.push(s));
    emit("connected");
    emit("disconnected");
    expect(seen).toEqual(["connected", "disconnected"]);

    stop();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("Windows raster IPC", () => {
  it("uses dedicated commands and preserves RAW dispatch", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const spy = vi.mocked(invoke).mockResolvedValue(undefined);
    const { tauriHardware, tauriWindowsPrinting } = await import("../src/lib/hardware.js");
    try {
      const bytes = new Uint8Array([0, 128, 255]);
      await tauriWindowsPrinting.printWindowsRaster("Queue", bytes, "Markiro:attempt");
      expect(invoke).toHaveBeenLastCalledWith("print_windows_raster", {
        queue: "Queue",
        payloadBase64: "AID/",
        documentName: "Markiro:attempt",
      });
      await tauriWindowsPrinting.preflightWindowsRaster("Queue", bytes);
      expect(invoke).toHaveBeenLastCalledWith("preflight_windows_raster", {
        queue: "Queue",
        payloadBase64: "AID/",
      });
      await tauriHardware.print({ kind: "usb", printer: "Queue" }, bytes);
      expect(invoke).toHaveBeenLastCalledWith("print_bytes", {
        target: { kind: "usb", printer: "Queue" },
        payloadBase64: "AID/",
      });
    } finally {
      spy.mockRestore();
    }
  });
});
