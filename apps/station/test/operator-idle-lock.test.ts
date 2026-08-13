import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPERATOR_IDLE_TIMEOUT_MS,
  createActivityAwareScanSource,
  createOperatorIdleLock,
} from "../src/lib/operator-idle-lock.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("operator idle lock", () => {
  it("locks once after ten minutes without activity", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const target = window;
    const idleLock = createOperatorIdleLock({ target, onIdle });

    idleLock.start();
    vi.advanceTimersByTime(OPERATOR_IDLE_TIMEOUT_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(OPERATOR_IDLE_TIMEOUT_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it.each(["pointerdown", "keydown", "touchstart"])(
    "restarts the timeout after %s activity",
    (eventName) => {
      vi.useFakeTimers();
      const onIdle = vi.fn();
      const target = window;
      const idleLock = createOperatorIdleLock({ target, onIdle });

      idleLock.start();
      vi.advanceTimersByTime(OPERATOR_IDLE_TIMEOUT_MS - 1);
      target.dispatchEvent(new Event(eventName));
      vi.advanceTimersByTime(OPERATOR_IDLE_TIMEOUT_MS - 1);
      expect(onIdle).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onIdle).toHaveBeenCalledTimes(1);
    },
  );

  it("stops the timer and removes activity listeners", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const target = window;
    const idleLock = createOperatorIdleLock({ target, onIdle });

    idleLock.start();
    idleLock.stop();
    target.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(OPERATOR_IDLE_TIMEOUT_MS * 2);

    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("activity-aware scan source", () => {
  it("records serial scan activity and forwards the scan exactly once", () => {
    let sourceListener: ScanListener = () => {};
    const source: ScanSource = {
      start(listener) {
        sourceListener = listener;
        return () => {};
      },
    };
    const onActivity = vi.fn();
    const listener = vi.fn();

    createActivityAwareScanSource(source, onActivity).start(listener);
    sourceListener("0104600000000015215Ab1");

    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("0104600000000015215Ab1");
  });
});
