import { describe, expect, it } from "vitest";

import { createWorkGate } from "../src/floor/work-gate.js";

/** A promise the test settles. */
function held<T>() {
  let settle: { resolve: (value: T) => void; reject: (error: unknown) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

/** Whether `promise` has settled after every pending microtask ran. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe("the work gate of a shift's screen", () => {
  it("lets a leave through at once when nothing runs", async () => {
    const gate = createWorkGate();
    expect(await settled(gate.drain())).toBe(true);
    expect(gate.pending()).toBe(0);
  });

  it("holds a leave until the tracked work settles, and hands the work back unchanged", async () => {
    const gate = createWorkGate();
    const work = held<string>();
    const tracked = gate.track(work.promise);
    expect(tracked).toBe(work.promise);
    expect(gate.pending()).toBe(1);
    const drained = gate.drain();
    expect(await settled(drained)).toBe(false);
    work.resolve("box closed");
    expect(await settled(drained)).toBe(true);
    await expect(tracked).resolves.toBe("box closed");
    expect(gate.pending()).toBe(0);
  });

  it("is not held for good by work that fails, and does not fail itself", async () => {
    const gate = createWorkGate();
    const work = held<never>();
    const tracked = gate.track(work.promise);
    const drained = gate.drain();
    work.reject(new Error("disk"));
    await expect(tracked).rejects.toThrow("disk");
    await expect(drained).resolves.toBeUndefined();
  });

  it("forgets work as soon as it settles, whether or not anyone waits for it", async () => {
    const gate = createWorkGate();
    const done = held<string>();
    const failed = held<never>();
    const first = gate.track(done.promise);
    const second = gate.track(failed.promise);
    expect(gate.pending()).toBe(2);
    done.resolve("ok");
    await first;
    await settled(first);
    expect(gate.pending()).toBe(1);
    failed.reject(new Error("disk"));
    await expect(second).rejects.toThrow("disk");
    await settled(second);
    expect(gate.pending()).toBe(0);
  });

  it("waits for work tracked while it already waits", async () => {
    const gate = createWorkGate();
    const first = held<void>();
    const second = held<void>();
    gate.track(first.promise);
    const drained = gate.drain();
    gate.track(second.promise);
    first.resolve();
    expect(await settled(drained)).toBe(false);
    second.resolve();
    expect(await settled(drained)).toBe(true);
  });
});
