import { describe, expect, it, vi } from "vitest";
import { runShiftReconciliationBarrier } from "../src/lib/shift-reconciliation-barrier.js";

describe("shift reconciliation barrier", () => {
  it("persists the full audit request before waiting for the worker", async () => {
    const order: string[] = [];
    const engine = {
      requestFullShiftAudit: vi.fn(async () => {
        order.push("request");
      }),
      reconcileNow: vi.fn(async () => {
        order.push("worker");
      }),
    };
    const result = await runShiftReconciliationBarrier(
      "s1",
      engine,
      async () => {
        order.push("summary");
        return { pending: 0, issues: 0 };
      },
      100,
    );
    expect(order).toEqual(["request", "worker", "summary"]);
    expect(result).toEqual({ complete: true, hardIssues: 0 });
  });

  it("returns after its deadline while a network call remains in flight", async () => {
    vi.useFakeTimers();
    try {
      const engine = {
        requestFullShiftAudit: vi.fn(async () => {}),
        reconcileNow: vi.fn(() => new Promise<void>(() => {})),
      };
      const barrier = runShiftReconciliationBarrier(
        "s1",
        engine,
        async () => ({ pending: 1, issues: 0 }),
        10_000,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await barrier).toEqual({ complete: false, hardIssues: 0 });
      expect(engine.requestFullShiftAudit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave pause waiting forever for the audit intent write", async () => {
    vi.useFakeTimers();
    try {
      const barrier = runShiftReconciliationBarrier(
        "s1",
        {
          requestFullShiftAudit: () => new Promise<void>(() => {}),
          reconcileNow: vi.fn(async () => {}),
        },
        async () => ({ pending: 0, issues: 0 }),
        10_000,
      );
      const rejected = expect(barrier).rejects.toThrow("audit intent");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled summary read after the worker finishes", async () => {
    vi.useFakeTimers();
    try {
      const barrier = runShiftReconciliationBarrier(
        "s1",
        { requestFullShiftAudit: vi.fn(async () => {}), reconcileNow: vi.fn(async () => {}) },
        () => new Promise(() => {}),
        10_000,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await barrier).toEqual({ complete: false, hardIssues: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
