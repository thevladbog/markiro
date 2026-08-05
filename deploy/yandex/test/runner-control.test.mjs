import assert from "node:assert/strict";
import test from "node:test";

import * as runnerControl from "../runner-control.mjs";

const {
  createJitRegistration,
  deploymentRunnerLabel,
  parseSerialHostKeys,
  selectCleanupRunners,
  startRunner,
  waitForRunner,
  withRunner,
} = runnerControl;

const DEPLOYMENT_ID = "deploy-123456789";
const INSTANCE_ID = "fv4runner123";

test("controller generates one-use JIT config and delivers only it through instance metadata", async () => {
  const calls = [];
  const result = await createJitRegistration({
    deploymentId: DEPLOYMENT_ID,
    instanceId: INSTANCE_ID,
    github: {
      async generateJitConfig(request) {
        calls.push(["github", request]);
        return {
          runner: { name: request.name, labels: request.labels.map((name) => ({ name })) },
          encoded_jit_config: "one-use-encoded-config",
        };
      },
    },
    yandex: {
      async updateMetadata(id, update) {
        calls.push(["metadata", id, update]);
      },
    },
  });

  assert.deepEqual(result, {
    deploymentId: DEPLOYMENT_ID,
    label: deploymentRunnerLabel(DEPLOYMENT_ID),
  });
  assert.deepEqual(calls, [
    [
      "github",
      {
        name: `markiro-${DEPLOYMENT_ID}`,
        runner_group_id: 1,
        labels: ["self-hosted", "linux", deploymentRunnerLabel(DEPLOYMENT_ID)],
        work_folder: "_work",
      },
    ],
    ["metadata", INSTANCE_ID, { upsert: { "markiro-runner-jit": "one-use-encoded-config" } }],
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /admin.token|GITHUB_RUNNER_ADMIN_TOKEN/i);
});

test("controller rejects mismatched JIT responses and never writes metadata", async () => {
  let writes = 0;
  await assert.rejects(
    createJitRegistration({
      deploymentId: DEPLOYMENT_ID,
      instanceId: INSTANCE_ID,
      github: {
        async generateJitConfig() {
          return { runner: { name: "wrong", labels: [] }, encoded_jit_config: "config" };
        },
      },
      yandex: {
        async updateMetadata() {
          writes += 1;
        },
      },
    }),
    /invalid JIT registration response/,
  );
  assert.equal(writes, 0);
});

test("metadata operations poll to bounded success and reject provider failure or malformed state", async () => {
  assert.equal(typeof runnerControl.waitForOperation, "function");
  let now = 0;
  const calls = [];
  const operation = await runnerControl.waitForOperation(
    { id: "operation-123", done: false },
    {
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      clock: {
        now: () => now,
        async sleep(milliseconds) {
          calls.push(`sleep:${milliseconds}`);
          now += milliseconds;
        },
      },
      async getOperation(id) {
        calls.push(`get:${id}`);
        return calls.filter((value) => value.startsWith("get:")).length === 1
          ? { id, done: false }
          : { id, done: true, response: {} };
      },
    },
  );
  assert.deepEqual(operation, { id: "operation-123", done: true, response: {} });
  assert.deepEqual(calls, ["sleep:100", "get:operation-123", "sleep:100", "get:operation-123"]);

  await assert.rejects(
    runnerControl.waitForOperation(
      { id: "operation-error", done: true, error: { code: 7, message: "sensitive" } },
      { getOperation: async () => assert.fail("completed operations must not poll") },
    ),
    /^Error: Yandex operation failed$/,
  );
  for (const malformed of [
    {},
    { id: "", done: false },
    { id: "operation-malformed" },
    { id: "operation-malformed", done: "true" },
    { id: "operation-malformed", done: true, error: "bad" },
  ])
    await assert.rejects(
      runnerControl.waitForOperation(malformed, { getOperation: async () => ({}) }),
      /invalid Yandex operation response/,
    );
});

test("metadata operation timeout prevents runner start", async () => {
  assert.equal(typeof runnerControl.prepareAndStartRunner, "function");
  let now = 0;
  const calls = [];
  const dependencies = {
    deploymentId: DEPLOYMENT_ID,
    instanceId: INSTANCE_ID,
    github: {
      async generateJitConfig(request) {
        return {
          runner: { name: request.name, labels: request.labels.map((name) => ({ name })) },
          encoded_jit_config: "one-use-encoded-config",
        };
      },
      async listRunners() {
        calls.push("list");
        return [];
      },
      async deleteRunner() {},
    },
    yandex: {
      async updateMetadata() {
        calls.push("metadata");
        await runnerControl.waitForOperation(
          { id: "operation-timeout", done: false },
          {
            timeoutMs: 200,
            pollIntervalMs: 100,
            clock: {
              now: () => now,
              async sleep(milliseconds) {
                now += milliseconds;
              },
            },
            async getOperation() {
              calls.push("operation");
              return { id: "operation-timeout", done: false };
            },
          },
        );
      },
      async getInstanceStatus() {
        calls.push("status");
        return "STOPPED";
      },
      async startInstance() {
        calls.push("start");
      },
      async stopInstance() {},
    },
  };

  await assert.rejects(
    runnerControl.prepareAndStartRunner(dependencies),
    /Yandex operation timed out/,
  );
  assert.deepEqual(calls, ["metadata", "operation", "operation"]);
  assert.equal(calls.includes("start"), false);
});

function sshField(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function publicKey(algorithm, seed = 1) {
  const blob =
    algorithm === "ssh-ed25519"
      ? Buffer.concat([sshField(algorithm), sshField(Buffer.alloc(32, seed))])
      : Buffer.concat([
          sshField(algorithm),
          sshField(Buffer.from([1, 0, 1])),
          sshField(Buffer.alloc(64, seed)),
        ]);
  return `${algorithm} ${blob.toString("base64")}`;
}

const ED25519_KEY = publicKey("ssh-ed25519");
const RSA_KEY = publicKey("ssh-rsa");

function marker(key) {
  return `MARKIRO_SSH_HOST_KEY_V1 ${key}`;
}

test("serial host-key parser requires the exact V1 pair and canonicalizes algorithm order", () => {
  const output = ["ordinary boot output", marker(RSA_KEY), marker(ED25519_KEY)].join("\n");

  assert.equal(
    Buffer.from(parseSerialHostKeys(output), "base64").toString("utf8"),
    `${ED25519_KEY}\n${RSA_KEY}`,
  );
});

for (const [name, output] of [
  ["missing markers", "boot complete"],
  [
    "extra third marker",
    `${marker(ED25519_KEY)}\n${marker(RSA_KEY)}\n${marker(publicKey("ssh-ed25519", 2))}`,
  ],
  [
    "distinct duplicate algorithm",
    `${marker(publicKey("ssh-ed25519", 2))}\n${marker(ED25519_KEY)}`,
  ],
  ["unknown algorithm", `${marker(ED25519_KEY)}\nMARKIRO_SSH_HOST_KEY_V1 ssh-dss AAAA`],
  ["malformed base64", `${marker(ED25519_KEY)}\nMARKIRO_SSH_HOST_KEY_V1 ssh-rsa !!!!`],
  ["malformed SSH payload", `${marker(ED25519_KEY)}\nMARKIRO_SSH_HOST_KEY_V1 ssh-rsa AA==`],
  ["old unversioned marker", `${marker(ED25519_KEY)}\nMARKIRO_SSH_HOST_KEY ${RSA_KEY}`],
  ["marker-like prefix noise", `${marker(ED25519_KEY)}\nprefix ${marker(RSA_KEY)}`],
])
  test(`serial host-key parser rejects ${name}`, () => {
    assert.throws(() => parseSerialHostKeys(output), /authenticated SSH host keys/);
  });

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
