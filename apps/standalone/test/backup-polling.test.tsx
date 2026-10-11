import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_IDLE_POLL_MS,
  BACKUP_POLL_MS,
  pollDelay,
  useBackupPolling,
} from "../src/office/backups/backup-polling.js";

describe("pollDelay", () => {
  it("polls a running copy every second, then slows down", () => {
    expect(pollDelay(true, 0, 0)).toBe(BACKUP_POLL_MS);
    expect(pollDelay(true, 9, 0)).toBe(1000);
    expect(pollDelay(true, 10, 0)).toBe(2000);
    expect(pollDelay(true, 29, 0)).toBe(2000);
    expect(pollDelay(true, 30, 0)).toBe(5000);
    expect(pollDelay(true, 500, 0)).toBe(5000);
  });

  it("reads an idle page once a minute", () => {
    expect(pollDelay(false, 0, 0)).toBe(BACKUP_IDLE_POLL_MS);
    expect(pollDelay(false, 40, 0)).toBe(60_000);
  });

  it("doubles the wait after every failed read, up to half a minute, and never below the usual one", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((failures) => pollDelay(true, 0, failures))).toEqual([
      2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(pollDelay(true, 40, 1)).toBe(5000);
    expect(pollDelay(false, 0, 3)).toBe(60_000);
  });
});

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useBackupPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
    vi.useRealTimers();
  });

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("reads a running copy again each second and an idle page each minute", async () => {
    const poll = vi.fn(async () => true);
    const { rerender } = renderHook(
      ({ running }) => useBackupPolling(poll, { enabled: true, running }),
      { initialProps: { running: true } },
    );
    await advance(999);
    expect(poll).not.toHaveBeenCalled();
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(1);
    await advance(3000);
    expect(poll).toHaveBeenCalledTimes(4);
    rerender({ running: false });
    await advance(59_999);
    expect(poll).toHaveBeenCalledTimes(4);
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(5);
  });

  it("waits for a read to end before it schedules the next, and backs off after failures", async () => {
    const answers: Array<(ok: boolean) => void> = [];
    const poll = vi.fn(() => new Promise<boolean>((resolve) => answers.push(resolve)));
    renderHook(() => useBackupPolling(poll, { enabled: true, running: true }));
    await advance(10_000);
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => {
      answers[0]?.(false);
    });
    await advance(1999);
    expect(poll).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(2);
    await act(async () => {
      answers[1]?.(false);
    });
    await advance(3999);
    expect(poll).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(3);
    await act(async () => {
      answers[2]?.(true);
    });
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("treats a read that throws as a failed one", async () => {
    const poll = vi.fn(async () => {
      throw new Error("down");
    });
    renderHook(() => useBackupPolling(poll, { enabled: true, running: true }));
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await advance(1999);
    expect(poll).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("does not read while the window is hidden, and reads at once when it is back", async () => {
    const poll = vi.fn(async () => true);
    renderHook(() => useBackupPolling(poll, { enabled: true, running: true }));
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => {
      setVisibility("hidden");
    });
    await advance(120_000);
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => {
      setVisibility("visible");
    });
    expect(poll).toHaveBeenCalledTimes(2);
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("schedules nothing after a read that ends while the window is hidden, and reads when it is back", async () => {
    const answers: Array<(ok: boolean) => void> = [];
    const poll = vi.fn(() => new Promise<boolean>((resolve) => answers.push(resolve)));
    renderHook(() => useBackupPolling(poll, { enabled: true, running: true }));
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => {
      setVisibility("hidden");
    });
    await act(async () => {
      answers[0]?.(true);
    });
    await advance(120_000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      setVisibility("visible");
    });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("does not start a second read when the window returns during one", async () => {
    const answers: Array<(ok: boolean) => void> = [];
    const poll = vi.fn(() => new Promise<boolean>((resolve) => answers.push(resolve)));
    renderHook(() => useBackupPolling(poll, { enabled: true, running: true }));
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => {
      setVisibility("hidden");
      setVisibility("visible");
    });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => {
      answers[0]?.(true);
    });
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("starts nothing while it is not enabled", async () => {
    const poll = vi.fn(async () => true);
    const { rerender } = renderHook(
      ({ enabled }) => useBackupPolling(poll, { enabled, running: true }),
      { initialProps: { enabled: false } },
    );
    await advance(120_000);
    expect(poll).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("stops for good when the page unmounts, even with a read in flight", async () => {
    const answers: Array<(ok: boolean) => void> = [];
    const poll = vi.fn(() => new Promise<boolean>((resolve) => answers.push(resolve)));
    const { unmount } = renderHook(() => useBackupPolling(poll, { enabled: true, running: true }));
    await advance(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      answers[0]?.(true);
    });
    await advance(120_000);
    expect(poll).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    setVisibility("visible");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("clears a waiting read when the page unmounts", async () => {
    const poll = vi.fn(async () => true);
    const { unmount } = renderHook(() => useBackupPolling(poll, { enabled: true, running: true }));
    unmount();
    await advance(120_000);
    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
