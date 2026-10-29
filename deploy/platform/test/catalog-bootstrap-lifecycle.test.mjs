import test from "node:test";
import assert from "node:assert/strict";
import { runReadBootstrapLifecycle } from "../catalog-bootstrap-lifecycle.mjs";
function fixture() {
  const calls = [];
  let stopped = false;
  const io = {
    authorize: async () => calls.push("authorize"),
    observe: async (fenced) => {
      calls.push(`observe:${fenced}`);
      assert.equal(stopped, fenced);
    },
    receipt: async (phase) => calls.push(`receipt:${phase}`),
    prepareWorker: async () => calls.push("prepare"),
    abortPreparedWorker: async () => ({ terminationConfirmed: true }),
    stopApi: async () => {
      calls.push("stop");
      stopped = true;
    },
    startApi: async () => {
      calls.push("start");
      stopped = false;
    },
    runWorker: async () => {
      calls.push("worker");
      return {
        terminationConfirmed: true,
        exitCode: 0,
        result: { revision: "1", readable: true, writersMayEnable: false },
      };
    },
  };
  return { io, calls };
}
test("authorizes and observes under caller's deployment lock, stops only API, resumes it after proven worker exit", async () => {
  const f = fixture();
  assert.equal((await runReadBootstrapLifecycle(f.io)).revision, "1");
  assert.deepEqual(f.calls, [
    "authorize",
    "observe:false",
    "receipt:started",
    "prepare",
    "authorize",
    "observe:false",
    "stop",
    "observe:true",
    "receipt:api-stopped",
    "worker",
    "observe:true",
    "receipt:worker-exited",
    "start",
    "observe:false",
    "receipt:api-resumed",
    "receipt:completed",
  ]);
});
for (const stage of ["authorize", "observe", "receipt"])
  test(`failure before stop (${stage}) cannot affect API`, async () => {
    const f = fixture();
    f.io[stage] = async () => {
      throw Error("denied");
    };
    await assert.rejects(runReadBootstrapLifecycle(f.io));
    assert.ok(!f.calls.includes("stop") && !f.calls.includes("start"));
  });
test("known failed worker resumes same API, retains failure and never reports accepted catalog", async () => {
  const f = fixture();
  f.io.runWorker = async () => ({ terminationConfirmed: true, exitCode: 1 });
  await assert.rejects(runReadBootstrapLifecycle(f.io), { code: "ERR_CATALOG_BOOTSTRAP" });
  assert.ok(f.calls.includes("start"));
  assert.ok(!f.calls.includes("receipt:completed"));
});
test("uncertain daemon workload prevents API restart and retains canonical lock", async () => {
  const f = fixture();
  f.io.runWorker = async () => ({ terminationConfirmed: false, exitCode: 1 });
  await assert.rejects(runReadBootstrapLifecycle(f.io), (e) => e.durabilityUncertain === true);
  assert.ok(!f.calls.includes("start"));
});
test("a lost worker invocation response is uncertain, never a cleanup-success guess", async () => {
  const f = fixture();
  f.io.runWorker = async () => {
    throw Error("transport lost");
  };
  await assert.rejects(runReadBootstrapLifecycle(f.io), (e) => e.durabilityUncertain === true);
  assert.ok(!f.calls.includes("start"));
});
test("post-worker source drift prevents restart and keeps lock", async () => {
  const f = fixture(),
    before = f.io.observe;
  let count = 0;
  f.io.observe = async (fenced) => {
    if (fenced && ++count === 2) throw Error("drift");
    return before(fenced);
  };
  await assert.rejects(runReadBootstrapLifecycle(f.io), (e) => e.durabilityUncertain === true);
  assert.ok(!f.calls.includes("start"));
});

test("worker preparation failure occurs while the accepted API is still healthy", async () => {
  const f = fixture();
  f.io.prepareWorker = async () => {
    throw Error("cannot prepare worker");
  };
  await assert.rejects(runReadBootstrapLifecycle(f.io), /cannot prepare worker/);
  assert.ok(!f.calls.includes("stop") && !f.calls.includes("start"));
});

test("revoked approval after read-only worker startup drains only that worker before keeping core API up", async () => {
  const f = fixture();
  let count = 0;
  f.io.authorize = async () => {
    if (++count === 2) throw Error("revoked");
  };
  f.io.abortPreparedWorker = async () => {
    f.calls.push("abort-worker");
    return { terminationConfirmed: true };
  };
  await assert.rejects(runReadBootstrapLifecycle(f.io), /revoked/);
  assert.ok(f.calls.includes("abort-worker"));
  assert.ok(!f.calls.includes("stop") && !f.calls.includes("start"));
});
test("uncertain preflight worker cleanup retains lock while API remains healthy", async () => {
  const f = fixture();
  f.io.prepareWorker = async () => {
    throw Error("lost worker response");
  };
  f.io.abortPreparedWorker = async () => ({ terminationConfirmed: false });
  await assert.rejects(runReadBootstrapLifecycle(f.io), (e) => e.durabilityUncertain === true);
  assert.ok(!f.calls.includes("stop") && !f.calls.includes("start"));
});
