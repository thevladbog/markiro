import { describe, expect, it } from "vitest";
import { createUsRequestResourceTestScope } from "./support/us-request-resource-test-scope";

function barrier() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("owned full US request resource test bodies", () => {
  // Registering after body invocation would allow setup to enter during its first continuation.
  it("registers pending work before the body can begin", async () => {
    const scope = createUsRequestResourceTestScope();
    const gate = barrier();
    const effects: string[] = [];
    const pending = scope.phase(async () => {
      effects.push("body");
      scope.assertIdle();
      await gate.pending;
    })();
    const settled = pending.catch((error: unknown) => error);
    try {
      expect(effects).toEqual([]);
      expect(() => scope.assertIdle()).toThrowError("us_request_resource_prior_work_live");
      await nextTurn();
      expect(effects).toEqual(["body"]);
      expect(await settled).toBeInstanceOf(Error);
    } finally {
      gate.release();
      await Promise.allSettled([pending, scope.drain()]);
    }
    expect(() => scope.assertIdle()).not.toThrow();
  });

  // Lost or reordered table arguments would change the real body's selected work.
  it.each([
    ["first", 3],
    ["second", 7],
  ] as const)("preserves table arguments for %s", async (name, quantity) => {
    const scope = createUsRequestResourceTestScope();
    const input = { name, quantity };
    const observed: unknown[] = [];
    const pending = scope.phase(async (record: typeof input, count: number, label: string) => {
      observed.push(record, count, label, `${record.name}:${record.quantity * count}`);
    })(input, 2, "synthetic");
    try {
      await pending;
      expect(observed).toEqual([input, 2, "synthetic", name === "first" ? "first:6" : "second:14"]);
      expect(observed[0]).toBe(input);
      expect(() => scope.assertIdle()).not.toThrow();
    } finally {
      await Promise.allSettled([pending, scope.drain()]);
    }
  });

  // Draining a runner wrapper instead of the full body restores spies before asynchronous finally.
  it("keeps teardown behind body and cleanup after external cancellation", async () => {
    const scope = createUsRequestResourceTestScope();
    const bodyGate = barrier();
    const cleanupGate = barrier();
    const cancel = barrier();
    const timeout = new Error("synthetic runner timeout");
    const effects: string[] = [];
    const pending = scope.phase(async () => {
      effects.push("body");
      try {
        await bodyGate.pending;
      } finally {
        effects.push("cleanup_started");
        await cleanupGate.pending;
        effects.push("cleanup_finished");
      }
    })();
    const runner = Promise.race([
      pending,
      cancel.pending.then(() => {
        throw timeout;
      }),
    ]);
    const runnerResult = runner.catch((error: unknown) => error);
    let teardown: Promise<void> | undefined;
    try {
      await nextTurn();
      cancel.release();
      expect(await runnerResult).toBe(timeout);
      teardown = scope.drain().then(() => {
        effects.push("mocks_restored");
      });
      await nextTurn();
      expect(effects).toEqual(["body"]);
      expect(() => scope.assertIdle()).toThrowError("us_request_resource_prior_work_live");
      bodyGate.release();
      await nextTurn();
      expect(effects).toEqual(["body", "cleanup_started"]);
      expect(() => scope.assertIdle()).toThrowError("us_request_resource_prior_work_live");
      cleanupGate.release();
      await teardown;
      expect(effects).toEqual(["body", "cleanup_started", "cleanup_finished", "mocks_restored"]);
      expect(() => scope.assertIdle()).not.toThrow();
    } finally {
      cancel.release();
      bodyGate.release();
      cleanupGate.release();
      await Promise.allSettled([pending, runnerResult, teardown, scope.drain()]);
    }
  });

  // A rejected bookkeeping continuation must not create an unhandled rejection or replace the error.
  it("retains original rejection identity without an unhandled owned rejection", async () => {
    const scope = createUsRequestResourceTestScope();
    const gate = barrier();
    const original = new Error("synthetic body failure");
    const unhandled: unknown[] = [];
    const observe = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", observe);
    const pending = scope.phase(async () => {
      await gate.pending;
      throw original;
    })();
    try {
      expect(() => scope.assertIdle()).toThrowError("us_request_resource_prior_work_live");
      gate.release();
      await scope.drain();
      await nextTurn();
      expect(unhandled).toEqual([]);
      await expect(pending).rejects.toBe(original);
      expect(() => scope.assertIdle()).not.toThrow();
    } finally {
      gate.release();
      await Promise.allSettled([pending, scope.drain()]);
      process.off("unhandledRejection", observe);
    }
  });

  // A one-shot snapshot misses bodies registered while an earlier drain is waiting.
  it("drains multiple bodies and new work registered during the drain", async () => {
    const scope = createUsRequestResourceTestScope();
    const firstGate = barrier();
    const secondGate = barrier();
    const addedGate = barrier();
    const effects: string[] = [];
    let added: Promise<void> | undefined;
    const first = scope.phase(async () => {
      await firstGate.pending;
      added = scope.phase(async () => {
        await addedGate.pending;
        effects.push("added_finished");
      })();
      effects.push("first_finished");
    })();
    const second = scope.phase(async () => {
      await secondGate.pending;
      effects.push("second_finished");
    })();
    const draining = scope.drain().then(() => {
      effects.push("drained");
    });
    try {
      await nextTurn();
      expect(effects).toEqual([]);
      firstGate.release();
      await first;
      secondGate.release();
      await second;
      await nextTurn();
      expect(effects).toEqual(["first_finished", "second_finished"]);
      expect(() => scope.assertIdle()).toThrowError("us_request_resource_prior_work_live");
      addedGate.release();
      await draining;
      expect(effects).toEqual(["first_finished", "second_finished", "added_finished", "drained"]);
      expect(() => scope.assertIdle()).not.toThrow();
    } finally {
      firstGate.release();
      secondGate.release();
      addedGate.release();
      await Promise.allSettled([first, second, draining]);
      await Promise.allSettled([added, scope.drain()]);
    }
  });

  // A cleanup rejection must not end drain while another owned body remains live.
  it("drains other work when one body's cleanup fails", async () => {
    const scope = createUsRequestResourceTestScope();
    const failedGate = barrier();
    const survivorGate = barrier();
    const cleanupError = new Error("synthetic cleanup failure");
    const effects: string[] = [];
    const cleanup = async () => {
      effects.push("cleanup_failed");
      throw cleanupError;
    };
    const failed = scope.phase(async () => {
      try {
        await failedGate.pending;
      } finally {
        await cleanup();
      }
    })();
    const failure = failed.catch((error: unknown) => error);
    const survivor = scope.phase(async () => {
      await survivorGate.pending;
      effects.push("survivor_finished");
    })();
    const draining = scope.drain().then(() => {
      effects.push("drained");
    });
    try {
      failedGate.release();
      expect(await failure).toBe(cleanupError);
      await nextTurn();
      expect(effects).toEqual(["cleanup_failed"]);
      expect(() => scope.assertIdle()).toThrowError("us_request_resource_prior_work_live");
      survivorGate.release();
      await draining;
      expect(effects).toEqual(["cleanup_failed", "survivor_finished", "drained"]);
      expect(() => scope.assertIdle()).not.toThrow();
    } finally {
      failedGate.release();
      survivorGate.release();
      await Promise.allSettled([failed, survivor, draining, scope.drain()]);
    }
  });

  // Shared module state would block or drain an unrelated suite's instance.
  it("keeps separately created scopes independent", async () => {
    const first = createUsRequestResourceTestScope();
    const second = createUsRequestResourceTestScope();
    const gate = barrier();
    const pending = first.phase(async () => {
      await gate.pending;
    })();
    try {
      expect(() => first.assertIdle()).toThrowError("us_request_resource_prior_work_live");
      expect(() => second.assertIdle()).not.toThrow();
      await second.drain();
      expect(() => first.assertIdle()).toThrowError("us_request_resource_prior_work_live");
      gate.release();
      await first.drain();
      expect(() => first.assertIdle()).not.toThrow();
    } finally {
      gate.release();
      await Promise.allSettled([pending, first.drain(), second.drain()]);
    }
  });
});
