import { describe, expect, it, vi } from "vitest";

import {
  createPrintRuntime,
  PRINT_SEND_LIMIT_MS,
  type StartTimer,
} from "../src/floor/print/print-runtime.js";
import type { HardwareApi, PrintResult, PrintTarget } from "../src/hardware/hardware.js";

const ZEBRA: PrintTarget = { kind: "tcp", host: "192.168.1.50", port: 9100 };
const ZEBRA_AGAIN: PrintTarget = { kind: "tcp", host: "192.168.1.50.", port: 9100 };
const TSC: PrintTarget = { kind: "serial", port: "COM4", baud: 9600 };
const BYTES = new Uint8Array([0x5e, 0x58, 0x41]);

/** Timers the test fires by hand: nothing here waits for real time. */
function manualTimers() {
  const timers: { ms: number; fire: () => void; live: boolean }[] = [];
  const startTimer: StartTimer = (ms, fire) => {
    const timer = { ms, fire, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  return {
    startTimer,
    timers,
    /** Fires every timer still running, as if the limit ran out now. */
    expire: () => {
      for (const timer of timers.filter((candidate) => candidate.live)) {
        timer.live = false;
        timer.fire();
      }
    },
  };
}

/** A shell whose sends wait until the test answers them, in order. */
function heldPrinter() {
  const calls: { target: PrintTarget; answer: (result: PrintResult) => void }[] = [];
  const printBytes = vi.fn<HardwareApi["printBytes"]>(
    (target) =>
      new Promise<PrintResult>((resolve) => {
        calls.push({ target, answer: resolve });
      }),
  );
  return { printBytes, calls };
}

/** Lets the promise callbacks queued so far run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("the printers' runtime", () => {
  it("gives the bytes to the shell and answers with its answer; the job is in flight until then", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const sent = runtime.send("job-1", ZEBRA, BYTES);
    await flush();
    expect(shell.printBytes).toHaveBeenCalledWith(ZEBRA, BYTES);
    expect(runtime.isInFlight("job-1")).toBe(true);
    expect(runtime.inFlight()).toEqual(["job-1"]);
    expect(timers.timers.map((timer) => timer.ms)).toEqual([PRINT_SEND_LIMIT_MS]);
    shell.calls[0]?.answer({ sent: false, code: "not_sent" });
    await expect(sent).resolves.toEqual({
      kind: "answered",
      result: { sent: false, code: "not_sent" },
    });
    await flush();
    expect(runtime.isInFlight("job-1")).toBe(false);
    // The answer stopped the limit: nothing fires later.
    expect(timers.timers[0]?.live).toBe(false);
  });

  it("sends to one address one at a time, and to another address meanwhile", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const first = runtime.send("job-1", ZEBRA, BYTES);
    const second = runtime.send("job-2", ZEBRA_AGAIN, BYTES);
    const other = runtime.send("job-3", TSC, BYTES);
    await flush();
    // The same printer written another way waits; the COM printer does not.
    expect(shell.calls.map((call) => call.target)).toEqual([ZEBRA, TSC]);
    expect(runtime.isInFlight("job-2")).toBe(true);
    shell.calls[0]?.answer({ sent: true });
    await expect(first).resolves.toEqual({ kind: "answered", result: { sent: true } });
    await flush();
    expect(shell.calls.map((call) => call.target)).toEqual([ZEBRA, TSC, ZEBRA_AGAIN]);
    shell.calls[2]?.answer({ sent: true });
    shell.calls[1]?.answer({ sent: true });
    await expect(second).resolves.toEqual({ kind: "answered", result: { sent: true } });
    await expect(other).resolves.toEqual({ kind: "answered", result: { sent: true } });
  });

  it("answers timeout for bytes the shell holds past the limit, and keeps the job in flight", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const stuck = runtime.send("job-1", ZEBRA, BYTES);
    await flush();
    timers.expire();
    await expect(stuck).resolves.toEqual({ kind: "timeout" });
    expect(runtime.isInFlight("job-1")).toBe(true);
    // A late answer changes nothing that was said, and ends the flight.
    shell.calls[0]?.answer({ sent: true });
    await flush();
    expect(runtime.isInFlight("job-1")).toBe(false);
  });

  it("never gives the shell bytes whose limit ran out while an earlier send held the printer", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const stuck = runtime.send("job-1", ZEBRA, BYTES);
    const queued = runtime.send("job-2", ZEBRA, BYTES);
    await flush();
    timers.expire();
    await expect(stuck).resolves.toEqual({ kind: "timeout" });
    await expect(queued).resolves.toEqual({ kind: "busy" });
    // The stuck call settles at last: the queued bytes still do not go.
    shell.calls[0]?.answer({ sent: true });
    await flush();
    expect(shell.printBytes).toHaveBeenCalledTimes(1);
    expect(runtime.inFlight()).toEqual([]);
    // The next send goes at once.
    const next = runtime.send("job-3", ZEBRA, BYTES);
    await flush();
    expect(shell.printBytes).toHaveBeenCalledTimes(2);
    shell.calls[1]?.answer({ sent: true });
    await expect(next).resolves.toEqual({ kind: "answered", result: { sent: true } });
  });

  it("reads a failed IPC call as outcome_unknown and keeps the queue going", async () => {
    const timers = manualTimers();
    const printBytes = vi
      .fn<HardwareApi["printBytes"]>()
      .mockRejectedValueOnce(new Error("ipc gone"))
      .mockResolvedValueOnce({ sent: true });
    const runtime = createPrintRuntime(printBytes, { startTimer: timers.startTimer });
    await expect(runtime.send("job-1", ZEBRA, BYTES)).resolves.toEqual({
      kind: "answered",
      result: { sent: false, code: "outcome_unknown" },
    });
    await expect(runtime.send(null, ZEBRA, BYTES)).resolves.toEqual({
      kind: "answered",
      result: { sent: true },
    });
    expect(runtime.inFlight()).toEqual([]);
  });

  it("waits for a real limit by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shell = heldPrinter();
      const runtime = createPrintRuntime(shell.printBytes, { limitMs: 1_000 });
      const stuck = runtime.send("job-1", ZEBRA, BYTES);
      await vi.advanceTimersByTimeAsync(999);
      const early = await Promise.race([stuck, Promise.resolve("waiting")]);
      expect(early).toBe("waiting");
      await vi.advanceTimersByTimeAsync(1);
      await expect(stuck).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the printers' runtime, beyond a single send", () => {
  it("gives a send 20 seconds", () => {
    expect(PRINT_SEND_LIMIT_MS).toBe(20_000);
  });

  it("makes a third send to an address wait for the second, not only for the first", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const first = runtime.send("job-1", ZEBRA, BYTES);
    const second = runtime.send("job-2", ZEBRA, BYTES);
    await flush();
    shell.calls[0]?.answer({ sent: true });
    await first;
    await flush();
    // The second holds the printer now; the third, asked later, does not slip in beside it.
    const third = runtime.send("job-3", ZEBRA, BYTES);
    await flush();
    expect(shell.calls).toHaveLength(2);
    shell.calls[1]?.answer({ sent: true });
    await second;
    await flush();
    expect(shell.calls).toHaveLength(3);
    shell.calls[2]?.answer({ sent: true });
    await expect(third).resolves.toEqual({ kind: "answered", result: { sent: true } });
    expect(runtime.inFlight()).toEqual([]);
  });

  it("keeps a job in flight until every send of it has really ended", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const stuck = runtime.send("job-1", ZEBRA, BYTES);
    await flush();
    timers.expire();
    await stuck;
    // The same job asked again behind its own stuck call.
    const again = runtime.send("job-1", ZEBRA, BYTES);
    await flush();
    shell.calls[0]?.answer({ sent: true });
    await flush();
    expect(runtime.isInFlight("job-1")).toBe(true);
    shell.calls[1]?.answer({ sent: true });
    await again;
    await flush();
    expect(runtime.isInFlight("job-1")).toBe(false);
  });

  it("does not count a test label as a job in flight", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const label = runtime.send(null, ZEBRA, BYTES);
    await flush();
    expect(shell.calls).toHaveLength(1);
    expect(runtime.inFlight()).toEqual([]);
    shell.calls[0]?.answer({ sent: true });
    await label;
  });

  it("leaves no timer running once the shell has answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const printBytes = vi.fn<HardwareApi["printBytes"]>(async () => ({ sent: true }));
      const runtime = createPrintRuntime(printBytes);
      await expect(runtime.send("job-1", ZEBRA, BYTES)).resolves.toEqual({
        kind: "answered",
        result: { sent: true },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
