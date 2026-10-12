import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsRequestWorkerResult } from "../src/modules/traceability/requests/us-request-worker";
import {
  UsRequestWorkerLoop as Loop,
  type UsWorkerProcessEvent,
} from "../src/deployment/us-request-worker-loop";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise is not initialized");
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error("deferred promise is not initialized");
  };
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const scope = Object.freeze({ tenantId: "synthetic-tenant", runId: "synthetic-run" });
const results: UsRequestWorkerResult[] = [
  { kind: "idle" },
  { kind: "storage_unavailable" },
  { kind: "ready", scope },
  { kind: "retry_scheduled", scope },
  { kind: "failed", scope, code: "us_request_worker_database_retryable" },
  { kind: "lease_lost", scope },
  { kind: "outcome_unresolved", scope },
];

describe("serial US request worker polling and cooperative drain", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a single active invocation and shares the run lifetime", async () => {
    const first = deferred<UsRequestWorkerResult>();
    const second = deferred<UsRequestWorkerResult>();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const loop = new Loop({
      runOne: () => {
        calls++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        return (calls === 1 ? first.promise : second.promise).finally(() => active--);
      },
      emit: () => {},
    });
    const running = loop.run();
    expect(loop.run()).toBe(running);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    first.resolve({ kind: "idle" });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    const stopping = loop.stop();
    expect(loop.stop()).toBe(stopping);
    second.resolve({ kind: "idle" });
    await expect(stopping).resolves.toEqual({ kind: "graceful" });
    await running;
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
    expect(loop.run()).toBe(running);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(results)(
    "polls $kind after one second and emits only allowlisted fields",
    async (result) => {
      const saved = Object.freeze({
        ...result,
        nextRetryAt: "synthetic-persisted-retry",
        attempt: 2,
      });
      const events: UsWorkerProcessEvent[] = [];
      const waits: number[] = [];
      let calls = 0;
      const loop = new Loop({
        runOne: async () => {
          calls++;
          return saved;
        },
        emit: (event) => events.push(event),
        wait: (milliseconds, signal) => {
          waits.push(milliseconds);
          return new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      });
      const running = loop.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(waits).toEqual([1000]);
      expect(events).toEqual([
        { event: "started", completedIterations: 0 },
        { event: "result", kind: result.kind, completedIterations: 1 },
      ]);
      await expect(loop.stop()).resolves.toEqual({ kind: "graceful" });
      await running;
      expect(events).toEqual([
        { event: "started", completedIterations: 0 },
        { event: "result", kind: result.kind, completedIterations: 1 },
        { event: "stopping", completedIterations: 1 },
        { event: "stopped", completedIterations: 1 },
      ]);
      expect(calls).toBe(1);
      expect(saved).toEqual({ ...result, nextRetryAt: "synthetic-persisted-retry", attempt: 2 });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["throw", "reject"])(
    "delays a %s infrastructure failure for five seconds without exposing the error",
    async (failure) => {
      const events: UsWorkerProcessEvent[] = [];
      let calls = 0;
      const loop = new Loop({
        runOne: () => {
          calls++;
          if (calls > 1) return Promise.resolve({ kind: "idle" });
          const error = new Error("synthetic-private-provider-SQL-token");
          if (failure === "throw") throw error;
          return Promise.reject(error);
        },
        emit: (event) => events.push(event),
      });
      const running = loop.run();
      await vi.advanceTimersByTimeAsync(4999);
      expect(calls).toBe(1);
      expect(events).toEqual([
        { event: "started", completedIterations: 0 },
        { event: "iteration_failed", completedIterations: 1 },
      ]);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      expect(events[2]).toEqual({ event: "result", kind: "idle", completedIterations: 2 });
      await expect(loop.stop()).resolves.toEqual({ kind: "graceful" });
      await running;
      expect(JSON.stringify(events)).not.toContain("synthetic-private");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not turn diagnostic-emitter exceptions into worker failures or raw console output", async () => {
    const output = [
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "log"),
    ];
    let calls = 0;
    const events: UsWorkerProcessEvent[] = [];
    const loop = new Loop({
      runOne: async () => {
        calls++;
        if (calls === 1) throw new Error("synthetic-private-invocation");
        return { kind: "idle" };
      },
      emit: (event) => {
        events.push(event);
        throw new Error("synthetic-private-emitter");
      },
    });
    const running = loop.run();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(3);
    await expect(loop.stop()).resolves.toEqual({ kind: "graceful" });
    await running;
    expect(events.map((event) => event.event)).toEqual([
      "started",
      "iteration_failed",
      "result",
      "result",
      "stopping",
      "stopped",
    ]);
    for (const spy of output) expect(spy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops before run without a claim and shares all later run and stop promises", async () => {
    const events: UsWorkerProcessEvent[] = [];
    let calls = 0;
    const loop = new Loop({
      runOne: async () => {
        calls++;
        return { kind: "idle" };
      },
      emit: (event) => events.push(event),
    });
    const stopping = loop.stop();
    expect(loop.stop()).toBe(stopping);
    const running = loop.run();
    expect(loop.run()).toBe(running);
    await expect(stopping).resolves.toEqual({ kind: "graceful" });
    await running;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(0);
    expect(loop.stop()).toBe(stopping);
    expect(events).toEqual([
      { event: "stopping", completedIterations: 0 },
      { event: "stopped", completedIterations: 0 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interrupts the default idle wait immediately", async () => {
    let calls = 0;
    const loop = new Loop({
      runOne: async () => {
        calls++;
        return { kind: "idle" };
      },
      emit: () => {},
    });
    const running = loop.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await expect(loop.stop()).resolves.toEqual({ kind: "graceful" });
    await running;
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("inhibits claims synchronously when stop races an invocation resolution", async () => {
    const active = deferred<UsRequestWorkerResult>();
    const events: UsWorkerProcessEvent[] = [];
    let calls = 0;
    let waitCalls = 0;
    const loop = new Loop({
      runOne: () => {
        calls++;
        return active.promise;
      },
      emit: (event) => events.push(event),
      wait: async () => {
        waitCalls++;
      },
    });
    const running = loop.run();
    active.resolve({ kind: "ready", scope });
    const stopping = loop.stop();
    expect(loop.run()).toBe(running);
    await expect(stopping).resolves.toEqual({ kind: "graceful" });
    await running;
    expect(calls).toBe(1);
    expect(waitCalls).toBe(0);
    expect(events).toEqual([
      { event: "started", completedIterations: 0 },
      { event: "stopping", completedIterations: 0 },
      { event: "result", kind: "ready", completedIterations: 1 },
      { event: "stopped", completedIterations: 1 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prevents a first claim when the started emitter synchronously requests stop", async () => {
    let calls = 0;
    let stopping: Promise<unknown> | undefined;
    const loop = new Loop({
      runOne: async () => {
        calls++;
        return { kind: "idle" };
      },
      emit: (event) => {
        if (event.event === "started") stopping = loop.stop();
      },
    });
    const running = loop.run();
    await running;
    await expect(stopping).resolves.toEqual({ kind: "graceful" });
    expect(calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns force_exit after 30 seconds while keeping an active invocation and its lifetime unsettled", async () => {
    const active = deferred<UsRequestWorkerResult>();
    const events: UsWorkerProcessEvent[] = [];
    let calls = 0;
    let lifetimeSettled = false;
    let drainSettled = false;
    const loop = new Loop({
      runOne: () => {
        calls++;
        return active.promise;
      },
      emit: (event) => events.push(event),
    });
    const running = loop.run();
    void running.then(() => {
      lifetimeSettled = true;
    });
    const stopping = loop.stop();
    void stopping.then(() => {
      drainSettled = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(drainSettled).toBe(false);
    expect(lifetimeSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopping).resolves.toEqual({ kind: "force_exit" });
    expect(lifetimeSettled).toBe(false);
    expect(loop.stop()).toBe(stopping);
    expect(loop.run()).toBe(running);
    expect(events).toEqual([
      { event: "started", completedIterations: 0 },
      { event: "stopping", completedIterations: 0 },
    ]);
    active.resolve({ kind: "ready", scope });
    await running;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lifetimeSettled).toBe(true);
    expect(calls).toBe(1);
    await expect(loop.stop()).resolves.toEqual({ kind: "force_exit" });
    expect(events.slice(2)).toEqual([
      { event: "result", kind: "ready", completedIterations: 1 },
      { event: "stopped", completedIterations: 1 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("joins a late rejected invocation after force_exit without restarting or leaking its rejection", async () => {
    const active = deferred<UsRequestWorkerResult>();
    const events: UsWorkerProcessEvent[] = [];
    let calls = 0;
    const loop = new Loop({
      runOne: () => {
        calls++;
        return active.promise;
      },
      emit: (event) => events.push(event),
    });
    const running = loop.run();
    const stopping = loop.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(stopping).resolves.toEqual({ kind: "force_exit" });
    active.reject(new Error("synthetic-private-late-rejection"));
    await running;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    expect(events.slice(2)).toEqual([
      { event: "iteration_failed", completedIterations: 1 },
      { event: "stopped", completedIterations: 1 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares lifecycle promises with reentrant lifecycle emitters", async () => {
    const active = deferred<UsRequestWorkerResult>();
    let nestedRunning: Promise<void> | undefined;
    let nestedStopping: ReturnType<Loop["stop"]> | undefined;
    let calls = 0;
    const loop = new Loop({
      runOne: () => {
        calls++;
        return active.promise;
      },
      emit: (event) => {
        if (event.event === "started") nestedRunning = loop.run();
        if (event.event === "stopping") nestedStopping = loop.stop();
      },
    });
    const running = loop.run();
    expect(nestedRunning).toBe(running);
    const stopping = loop.stop();
    expect(nestedStopping).toBe(stopping);
    active.resolve({ kind: "idle" });
    await expect(stopping).resolves.toEqual({ kind: "graceful" });
    await running;
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an injected wait's abort rejection without a false infrastructure failure", async () => {
    const events: UsWorkerProcessEvent[] = [];
    let calls = 0;
    const loop = new Loop({
      runOne: async () => {
        calls++;
        return { kind: "idle" };
      },
      emit: (event) => events.push(event),
      wait: (_milliseconds, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("synthetic-private-abort")), {
            once: true,
          });
        }),
    });
    const running = loop.run();
    await vi.advanceTimersByTimeAsync(0);
    await expect(loop.stop()).resolves.toEqual({ kind: "graceful" });
    await running;
    expect(calls).toBe(1);
    expect(events.map((event) => event.event)).toEqual([
      "started",
      "result",
      "stopping",
      "stopped",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes an injected scheduler failure and throttles its next invocation", async () => {
    const events: UsWorkerProcessEvent[] = [];
    let calls = 0;
    const loop = new Loop({
      runOne: async () => {
        calls++;
        return { kind: "idle" };
      },
      emit: (event) => events.push(event),
      wait: async () => {
        throw new Error("synthetic-private-scheduler");
      },
    });
    const running = loop.run();
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toBe(1);
    expect(events).toEqual([
      { event: "started", completedIterations: 0 },
      { event: "result", kind: "idle", completedIterations: 1 },
      { event: "iteration_failed", completedIterations: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await expect(loop.stop()).resolves.toEqual({ kind: "graceful" });
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not emit an unexpected runtime result kind as a diagnostic category", async () => {
    const events: UsWorkerProcessEvent[] = [];
    const result: UsRequestWorkerResult = { kind: "idle" };
    Object.defineProperty(result, "kind", { value: "synthetic-private-unexpected-kind" });
    const loop = new Loop({
      runOne: async () => result,
      emit: (event) => events.push(event),
    });
    const running = loop.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([
      { event: "started", completedIterations: 0 },
      { event: "iteration_failed", completedIterations: 1 },
    ]);
    await expect(loop.stop()).resolves.toEqual({ kind: "graceful" });
    await running;
    expect(JSON.stringify(events)).not.toContain("synthetic-private");
    expect(vi.getTimerCount()).toBe(0);
  });
});
