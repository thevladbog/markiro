import assert from "node:assert/strict";
import test from "node:test";
import { localDockerEndpoint, summarize, runBoundedPhase, assess } from "../load/core.mjs";
test("rejects remote daemon targets", () => {
  assert.equal(localDockerEndpoint("unix:///tmp/docker.sock"), true);
  for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://remote", "https://example.com", undefined])
    assert.throws(() => localDockerEndpoint(endpoint));
});
test("percentiles and correctness errors retain denominator", () => {
  assert.deepEqual(
    summarize([
      { ms: 10, ok: true, status: 200 },
      { ms: 100, ok: false, status: 200 },
      { ms: 20, ok: true, status: 200 },
    ]),
    { count: 3, failures: 1, p50: 20, p95: 100, p99: 100, statuses: { 200: 3 } },
  );
});
test("bounded phase awaits in-flight requests and respects concurrency", async () => {
  let active = 0,
    max = 0,
    finished = 0;
  await runBoundedPhase({
    durationMs: 35,
    users: 3,
    paceMs: 0,
    operation: async () => {
      max = Math.max(max, ++active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      finished++;
    },
  });
  assert.equal(active, 0);
  assert.equal(max, 3);
  assert.ok(finished >= 3);
  await assert.rejects(runBoundedPhase({ durationMs: 1, users: 11, operation: async () => {} }));
});
test("abort and errors stop the benchmark; failed correctness/latency/restarts reject acceptance", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await runBoundedPhase({
    durationMs: 1000,
    users: 2,
    signal: controller.signal,
    operation: async () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  const good = {
    phases: {
      steady: { interactive: { count: 1, p95: 900, failures: 0 } },
      burst: { interactive: { count: 1, p95: 1800, failures: 0 } },
    },
    reportsComplete: true,
    oom: false,
    restarts: 0,
  };
  assert.deepEqual(assess(good), []);
  assert.ok(assess({ ...good, restarts: 1 }).length);
  assert.ok(assess({ ...good, reportsComplete: false }).length);
  assert.ok(
    assess({
      ...good,
      phases: { ...good.phases, steady: { interactive: { p95: 1100, failures: 1 } } },
    }).length,
  );
});
test("a failing user stops peers and waits for every in-flight request before cleanup", async () => {
  let active = 0;
  await assert.rejects(
    runBoundedPhase({
      durationMs: 1000,
      users: 2,
      paceMs: 0,
      operation: async (user) => {
        active++;
        try {
          await new Promise((r) => setTimeout(r, user === 0 ? 1 : 25));
          if (user === 0) throw new Error("synthetic correctness failure");
        } finally {
          active--;
        }
      },
    }),
  );
  assert.equal(active, 0);
});
test("zero completed requests cannot pass acceptance", () => {
  assert.ok(
    assess({
      phases: { steady: { interactive: { count: 0, failures: 0, p95: 0 } } },
      reportsComplete: true,
      oom: false,
      restarts: 0,
    }).length,
  );
});
