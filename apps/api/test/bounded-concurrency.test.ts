import { describe, expect, it } from "vitest";
import { BoundedConcurrencyLimiter } from "../src/modules/profile/bounded-concurrency";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("BoundedConcurrencyLimiter", () => {
  it("never starts more than the configured number of actions", async () => {
    const limiter = new BoundedConcurrencyLimiter(2, 8);
    const gates = Array.from({ length: 6 }, deferred);
    let active = 0;
    let maximum = 0;
    const runs = gates.map((gate) =>
      limiter.run(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate.promise;
        active -= 1;
      }),
    );

    await Promise.resolve();
    expect(active).toBe(2);
    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }
    await Promise.all(runs);
    expect(maximum).toBe(2);
  });

  it("rejects work beyond the bounded waiting queue", async () => {
    const limiter = new BoundedConcurrencyLimiter(1, 1);
    const first = deferred();
    const running = limiter.run(() => first.promise);
    const queued = limiter.run(async () => undefined);

    await expect(limiter.run(async () => undefined)).rejects.toThrow(/queue is full/i);
    first.resolve();
    await Promise.all([running, queued]);
  });
});
