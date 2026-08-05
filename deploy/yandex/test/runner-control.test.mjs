import assert from "node:assert/strict";
import test from "node:test";

import {
  deploymentRunnerLabel,
  selectCleanupRunners,
  startRunner,
  waitForRunner,
  withRunner,
} from "../runner-control.mjs";

const DEPLOYMENT_ID = "deploy-123456789";
const INSTANCE_ID = "fv4runner123";

function fixture({ instanceStates = ["STOPPED", "RUNNING"], runners = [] } = {}) {
  const calls = [];
  const cleanupErrors = [];
  let now = 0;
  let stateIndex = 0;
  let runnerIndex = 0;
  const dependencies = {
    deploymentId: DEPLOYMENT_ID,
    instanceId: INSTANCE_ID,
    timeoutMs: 1_000,
    pollIntervalMs: 100,
    yandex: {
      async getInstanceStatus(id) {
        calls.push(`status:${id}`);
        return instanceStates[Math.min(stateIndex++, instanceStates.length - 1)];
      },
      async startInstance(id) {
        calls.push(`start:${id}`);
      },
      async stopInstance(id) {
        calls.push(`stop:${id}`);
      },
    },
    github: {
      async listRunners() {
        calls.push("list");
        const value = runners[Math.min(runnerIndex++, runners.length - 1)];
        return value || [];
      },
      async deleteRunner(id) {
        calls.push(`deregister:${id}`);
      },
    },
    clock: {
      now: () => now,
      async sleep(milliseconds) {
        calls.push(`sleep:${milliseconds}`);
        now += milliseconds;
      },
    },
    reportCleanupError(error) {
      cleanupErrors.push(error.message);
    },
  };
  return { dependencies, calls, cleanupErrors };
}

test("cleanup finds the sole deployment runner when controller outputs were never written", () => {
  const unrelated = { ...jitRunner(1), labels: [{ name: "ordinary-runner" }] };

  assert.deepEqual(
    selectCleanupRunners([unrelated, jitRunner(71)]).map(({ id }) => id),
    [71],
  );
  assert.throws(
    () => selectCleanupRunners([jitRunner(71), { ...jitRunner(72), id: 72 }]),
    /cannot safely identify/,
  );
});

function jitRunner(id = 71) {
  return {
    id,
    name: `markiro-${DEPLOYMENT_ID}`,
    status: "online",
    busy: false,
    labels: [
      { name: "self-hosted" },
      { name: "linux" },
      { name: deploymentRunnerLabel(DEPLOYMENT_ID) },
    ],
  };
}

test("startRunner starts only a stopped VM with no registered deployment runner", async () => {
  const { dependencies, calls } = fixture({ runners: [[]] });

  await startRunner(dependencies);

  assert.deepEqual(calls, [`status:${INSTANCE_ID}`, "list", `start:${INSTANCE_ID}`]);
});

test("startRunner rejects an already-running VM and never starts it", async () => {
  const { dependencies, calls } = fixture({ instanceStates: ["RUNNING"] });

  await assert.rejects(startRunner(dependencies), /runner VM must be STOPPED/);

  assert.equal(calls.includes(`start:${INSTANCE_ID}`), false);
});

test("startRunner rejects an unrelated or stale deployment runner", async () => {
  const stale = { ...jitRunner(), labels: [{ name: "markiro-deployment-other" }] };
  const { dependencies, calls } = fixture({ runners: [[stale]] });

  await assert.rejects(startRunner(dependencies), /registered deployment runner already exists/);

  assert.equal(calls.includes(`start:${INSTANCE_ID}`), false);
});

test("waitForRunner waits for RUNNING and one idle online runner with the exact JIT label", async () => {
  const { dependencies } = fixture({
    instanceStates: ["STARTING", "RUNNING"],
    runners: [[], [jitRunner()]],
  });

  const runner = await waitForRunner(dependencies);

  assert.equal(runner.id, 71);
});

test("waitForRunner fails closed on duplicate or busy exact-label runners", async () => {
  const duplicate = fixture({
    instanceStates: ["RUNNING"],
    runners: [[jitRunner(1), jitRunner(2)]],
  });
  await assert.rejects(waitForRunner(duplicate.dependencies), /exactly one JIT runner/);

  const busy = fixture({
    instanceStates: ["RUNNING"],
    runners: [[{ ...jitRunner(), busy: true }]],
  });
  await assert.rejects(waitForRunner(busy.dependencies), /runner is already busy/);
});

test("waitForRunner has a bounded deadline", async () => {
  const { dependencies } = fixture({ instanceStates: ["STARTING"], runners: [[]] });

  await assert.rejects(waitForRunner(dependencies), /timed out/);
});

test("withRunner deregisters and stops after exactly one successful callback", async () => {
  const { dependencies, calls } = fixture({ runners: [[], [jitRunner()]] });
  let jobs = 0;

  const result = await withRunner(dependencies, async (runner) => {
    jobs += 1;
    calls.push(`job:${runner.id}`);
    return "healthy";
  });

  assert.equal(result, "healthy");
  assert.equal(jobs, 1);
  assert.deepEqual(calls.slice(-3), ["job:71", "deregister:71", `stop:${INSTANCE_ID}`]);
});

test("withRunner cleanup never masks the primary deployment failure", async () => {
  const { dependencies, calls, cleanupErrors } = fixture({ runners: [[], [jitRunner()]] });
  dependencies.github.deleteRunner = async (id) => {
    calls.push(`deregister:${id}`);
    throw new Error("deregister failed");
  };
  dependencies.yandex.stopInstance = async (id) => {
    calls.push(`stop:${id}`);
    throw new Error("stop failed");
  };

  await assert.rejects(
    withRunner(dependencies, async () => {
      throw new Error("deploy failed");
    }),
    /deploy failed/,
  );

  assert.deepEqual(calls.slice(-2), ["deregister:71", `stop:${INSTANCE_ID}`]);
  assert.deepEqual(cleanupErrors, ["deregister failed", "stop failed"]);
});
