import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  scannerIndicator,
  signInScannerState,
  useScannerIndicator,
} from "../src/floor/scanner-indicator.js";
import type { ScannerSnapshot } from "../src/hardware/hardware.js";

function snapshot(...statuses: Array<"connected" | "disconnected">): ScannerSnapshot {
  return {
    revision: 1,
    scanners: statuses.map((status, index) => ({ port: `COM${index + 3}`, baud: 9600, status })),
  };
}

describe("what the floor may honestly say about its scanner", () => {
  it("says «keyboard» without the shell's COM scanners: the wedge works but cannot be seen", () => {
    expect(scannerIndicator({ kind: "none" })).toBe("keyboard");
    // Before the shell's first snapshot only the wedge is certain.
    expect(scannerIndicator({ kind: "watching", snapshot: null })).toBe("keyboard");
    // No COM scanner configured: the wedge again.
    expect(scannerIndicator({ kind: "watching", snapshot: snapshot() })).toBe("keyboard");
  });

  it("follows the configured COM scanners' connection", () => {
    expect(scannerIndicator({ kind: "watching", snapshot: snapshot("connected") })).toBe(
      "connected",
    );
    expect(
      scannerIndicator({ kind: "watching", snapshot: snapshot("connected", "connected") }),
    ).toBe("connected");
    expect(
      scannerIndicator({ kind: "watching", snapshot: snapshot("connected", "disconnected") }),
    ).toBe("partial");
    expect(scannerIndicator({ kind: "watching", snapshot: snapshot("disconnected") })).toBe(
      "disconnected",
    );
  });

  it("says it does not know when the shell could not be asked", () => {
    expect(scannerIndicator({ kind: "failed" })).toBe("unknown");
  });
});

describe("the sign-in screen's scanner chip", () => {
  it("is ready for the wedge and for connected COM scanners", () => {
    expect(signInScannerState("keyboard", false)).toEqual({ tone: "ok", key: "ready" });
    expect(signInScannerState("connected", false)).toEqual({ tone: "ok", key: "ready" });
  });

  it("warns of a part of the scanners, an unknown state, and a scanner off the link", () => {
    expect(signInScannerState("partial", false)).toEqual({ tone: "warn", key: "partial" });
    expect(signInScannerState("unknown", false)).toEqual({ tone: "warn", key: "unknown" });
    expect(signInScannerState("disconnected", false)).toEqual({
      tone: "error",
      key: "disconnected",
    });
  });

  it("says the sign-in is paused while the station is locked out, whatever the scanner", () => {
    for (const indicator of [
      "keyboard",
      "connected",
      "partial",
      "disconnected",
      "unknown",
    ] as const) {
      expect(signInScannerState(indicator, true)).toEqual({ tone: "error", key: "locked" });
    }
  });
});

describe("useScannerIndicator", () => {
  it("is «keyboard» with no shell to watch", () => {
    const { result } = renderHook(() => useScannerIndicator(undefined));
    expect(result.current).toBe("keyboard");
  });

  it("follows every snapshot and stops watching when it goes", async () => {
    let push: (next: ScannerSnapshot) => void = () => undefined;
    const stop = vi.fn();
    const watch = vi.fn((onSnapshot: (next: ScannerSnapshot) => void) => {
      push = onSnapshot;
      return Promise.resolve(stop);
    });
    const { result, unmount } = renderHook(() => useScannerIndicator(watch));
    await waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    act(() => push(snapshot("disconnected")));
    expect(result.current).toBe("disconnected");
    act(() => push(snapshot("connected")));
    expect(result.current).toBe("connected");
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("is «unknown» when the shell refuses the watch", async () => {
    const watch = vi.fn(() => Promise.reject(new Error("no shell")));
    const { result } = renderHook(() => useScannerIndicator(watch));
    await waitFor(() => expect(result.current).toBe("unknown"));
  });

  it("survives a watch that throws or answers with no stop", async () => {
    const throwing = vi.fn(() => {
      throw new Error("no shell");
    });
    const first = renderHook(() => useScannerIndicator(throwing));
    await waitFor(() => expect(first.result.current).toBe("unknown"));
    first.unmount();
    const silent = vi.fn(() => undefined as unknown as Promise<() => void>);
    const second = renderHook(() => useScannerIndicator(silent));
    await act(async () => {
      await Promise.resolve();
    });
    expect(second.result.current).toBe("keyboard");
    second.unmount();
  });

  it("stops a watch that answers after it went", async () => {
    let answer: (stop: () => void) => void = () => undefined;
    const stop = vi.fn();
    const watch = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          answer = resolve;
        }),
    );
    const { unmount } = renderHook(() => useScannerIndicator(watch));
    unmount();
    await act(async () => {
      answer(stop);
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
