import { describe, expect, it, vi } from "vitest";
import { createScanQueue, type ScanOutcome } from "../src/lib/scan-queue.js";

function outcome(raw: string): ScanOutcome {
  return { raw, verdict: { status: "ok", key: raw }, firstSeen: null };
}

describe("scan queue", () => {
  it("processes scans strictly one at a time, in order", async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = createScanQueue({
      process: async (raw) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        order.push(raw);
        return outcome(raw);
      },
      onOutcome: () => {},
    });

    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    await queue.idle();

    expect(order).toEqual(["a", "b", "c"]);
    expect(maxInFlight).toBe(1);
  });

  it("buffers scans that arrive while one is in flight instead of dropping them", async () => {
    const seen: string[] = [];
    const queue = createScanQueue({
      process: async (raw) => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(raw);
        return outcome(raw);
      },
      onOutcome: () => {},
    });

    queue.enqueue("first");
    queue.enqueue("second"); // arrives mid-flight
    expect(queue.pending()).toBeGreaterThan(0);
    await queue.idle();

    expect(seen).toEqual(["first", "second"]);
  });

  it("runs side-channel jobs in strict order with scans, never concurrently", async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = createScanQueue({
      process: async (raw) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`scan:${raw}`);
        inFlight -= 1;
        return outcome(raw);
      },
      onOutcome: () => {},
    });

    queue.enqueue("a");
    queue.enqueueJob(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push("job");
      inFlight -= 1;
    });
    queue.enqueue("b");
    await queue.idle();

    expect(order).toEqual(["scan:a", "job", "scan:b"]);
    expect(maxInFlight).toBe(1);
  });

  it("reports every outcome to onOutcome in order", async () => {
    const outcomes: string[] = [];
    const queue = createScanQueue({
      process: async (raw) => outcome(raw),
      onOutcome: (o) => outcomes.push(o.raw),
    });
    queue.enqueue("x");
    queue.enqueue("y");
    await queue.idle();
    expect(outcomes).toEqual(["x", "y"]);
  });

  it("keeps draining after a failing scan", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const done: string[] = [];
    const queue = createScanQueue({
      process: async (raw) => {
        if (raw === "boom") throw new Error("processing failed");
        return outcome(raw);
      },
      onOutcome: (o) => done.push(o.raw),
    });

    queue.enqueue("boom");
    queue.enqueue("after");
    await queue.idle();

    expect(done).toEqual(["after"]); // the failure did not stall the queue
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("calls onError with the raw scan and the thrown error, and keeps draining", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const done: string[] = [];
    const errors: Array<{ raw: string; err: unknown }> = [];
    const boom = new Error("journal write failed");
    const queue = createScanQueue({
      process: async (raw) => {
        if (raw === "boom") throw boom;
        return outcome(raw);
      },
      onOutcome: (o) => done.push(o.raw),
      onError: (raw, err) => errors.push({ raw, err }),
    });

    queue.enqueue("boom");
    queue.enqueue("after");
    await queue.idle();

    expect(errors).toEqual([{ raw: "boom", err: boom }]);
    expect(done).toEqual(["after"]);
    consoleError.mockRestore();
  });

  it("reports a failing ordered job and keeps draining", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onJobError = vi.fn();
    const done: string[] = [];
    const queue = createScanQueue({
      process: async (raw) => outcome(raw),
      onOutcome: (o) => done.push(o.raw),
      onJobError,
    });
    const failure = new Error("correction failed");

    queue.enqueueJob(async () => {
      throw failure;
    });
    queue.enqueue("after");
    await queue.idle();

    expect(onJobError).toHaveBeenCalledWith(failure);
    expect(done).toEqual(["after"]);
    consoleError.mockRestore();
  });
});
