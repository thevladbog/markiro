import { describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  createHardwareScanSource,
  type HardwareContract,
} from "../src/lib/hardware.js";

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
      openScanner: async () => {},
      closeScanner: async () => {},
      onScan: async (listener) => {
        emit = listener;
        return unsubscribe;
      },
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
      openScanner: async () => {},
      closeScanner: async () => {},
      onScan: async () => () => {},
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
