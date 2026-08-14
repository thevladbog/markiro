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

  it("discards buffered scans when a blocking floor state starts before they run", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    let blocked = false;
    const queue = createScanQueue({
      shouldProcess: () => !blocked,
      process: async (raw) => {
        seen.push(raw);
        if (raw === "closes-box") blocked = true;
        return outcome(raw);
      },
      onOutcome: () => {},
    });

    queue.enqueue("closes-box");
    queue.enqueue("arrived-during-close");
    await queue.idle();

    expect(seen).toEqual(["closes-box"]);
    expect(consoleWarn).toHaveBeenCalledWith("station: scan discarded by floor admission");
    expect(consoleWarn).not.toHaveBeenCalledWith(expect.stringContaining("arrived-during-close"));
    consoleWarn.mockRestore();
  });

  it("can discard scans buffered during a close while preserving ordered jobs", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createScanQueue({
      process: async (raw) => {
        order.push(`scan:${raw}`);
        if (raw === "closing") await gate;
        return outcome(raw);
      },
      onOutcome: () => {},
    });

    queue.enqueue("closing");
    queue.enqueue("buffered");
    queue.enqueueJob(async () => {
      order.push("job");
    });
    queue.discardBufferedScans();
    release();
    await queue.idle();

    expect(order).toEqual(["scan:closing", "job"]);
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

  it("closes intake while draining accepted work and can reopen under StrictMode setup", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createScanQueue({
      async process(raw) {
        if (raw === "accepted") await gate;
        seen.push(raw);
        return outcome(raw);
      },
      onOutcome: () => {},
    });

    queue.enqueue("accepted");
    const closed = queue.close();
    queue.enqueue("after-close");
    release();
    await closed;
    expect(seen).toEqual(["accepted"]);

    queue.open();
    queue.enqueue("after-reopen");
    await queue.idle();
    expect(seen).toEqual(["accepted", "after-reopen"]);
  });
});
