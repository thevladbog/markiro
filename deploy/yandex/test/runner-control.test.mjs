import assert from "node:assert/strict";
import test from "node:test";

import { parseSerialHostKeys } from "../hosted-deploy-context.mjs";
import * as runnerControl from "../runner-control.mjs";

const {
  createJitRegistration,
  deploymentRunnerLabel,
  selectCleanupRunners,
  startRunner,
  waitForRunnerCleanup,
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

test("controller starts the VM when GitHub already lists its newly generated offline JIT runner", async () => {
  const calls = [];
  const label = deploymentRunnerLabel(DEPLOYMENT_ID);
  const generatedRunner = {
    id: 71,
    name: `markiro-${DEPLOYMENT_ID}`,
    status: "offline",
    busy: false,
    labels: ["self-hosted", "linux", label].map((name) => ({ name })),
  };
  const dependencies = {
    deploymentId: DEPLOYMENT_ID,
    instanceId: INSTANCE_ID,
    github: {
      async generateJitConfig() {
        calls.push("generate");
        return { runner: generatedRunner, encoded_jit_config: "one-use-encoded-config" };
      },
      async listRunners() {
        calls.push("list");
        return [generatedRunner];
      },
      async deleteRunner() {},
    },
    yandex: {
      async updateMetadata() {
        calls.push("metadata");
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

  await runnerControl.prepareAndStartRunner(dependencies);

  assert.deepEqual(calls, ["generate", "metadata", "status", "list", "start"]);
});

const CONTROLLER_GATE_ENVIRONMENT = {
  MARKIRO_DEPLOYMENT_PHASE: "repeat",
  YC_APP_INSTANCE_ID: "fv4app123",
  YC_POSTGRES_CLUSTER_ID: "c9qpostgres123",
  YC_LOAD_BALANCER_ID: "ds7loadbalancer123",
  YC_BACKEND_GROUP_ID: "ds7backend123",
  YC_TARGET_GROUP_ID: "ds7target123",
};
const FIRST_CONTROLLER_GATE_ENVIRONMENT = {
  ...CONTROLLER_GATE_ENVIRONMENT,
  MARKIRO_DEPLOYMENT_PHASE: "first",
};
const APP_ADDRESS = "10.20.0.7";
const HEALTHY_TARGET = {
  target: { ipAddress: APP_ADDRESS, subnetId: "e2lsubnet123" },
  status: {
    zoneStatuses: [{ failedActiveHc: false, status: "HEALTHY", zoneId: "ru-central1-a" }],
  },
};
const UNHEALTHY_TARGET = {
  target: { ipAddress: APP_ADDRESS, subnetId: "e2lsubnet123" },
  status: {
    zoneStatuses: [{ failedActiveHc: true, status: "UNHEALTHY", zoneId: "ru-central1-a" }],
  },
};

function controllerGateProvider({ app = {}, targetStates = [HEALTHY_TARGET] } = {}) {
  const requests = [];
  const request = async (url, options = {}) => {
    requests.push(url);
    assert.equal(options.headers.Authorization, "Bearer test-gate-token");
    if (url.includes("/compute/v1/instances/"))
      return {
        id: "fv4app123",
        folderId: "b1gfolder123",
        status: "RUNNING",
        networkInterfaces: [
          {
            index: "0",
            macAddress: "d0:0d:00:00:00:01",
            subnetId: "e2lsubnet123",
            primaryV4Address: { address: APP_ADDRESS },
          },
        ],
        ...app,
      };
    if (url.endsWith("/backups"))
      return {
        backups: [
          {
            createdAt: "2026-08-05T09:00:00.000Z",
            id: "mdbbackup123",
            sourceClusterId: "c9qpostgres123",
          },
        ],
      };
    if (url.includes("/targetStates/")) return { targetStates };
    assert.fail(`unexpected provider request: ${url}`);
  };
  return { request, requests };
}

test("repeat controller gate accepts exactly one healthy target for the validated private app address", async () => {
  assert.equal(typeof runnerControl.verifyControllerGates, "function");
  const provider = controllerGateProvider();

  await runnerControl.verifyControllerGates("test-gate-token", {
    environment: CONTROLLER_GATE_ENVIRONMENT,
    now: () => Date.parse("2026-08-05T10:00:00.000Z"),
    request: provider.request,
  });

  assert.equal(provider.requests.length, 3);
});

test("first controller gate rejects a foreign target before host-key or JIT mutation can start", async () => {
  const provider = controllerGateProvider({
    targetStates: [
      {
        target: { ipAddress: "10.20.0.8", subnetId: "e2lsubnet123" },
        status: {
          zoneStatuses: [{ failedActiveHc: false, status: "HEALTHY", zoneId: "ru-central1-a" }],
        },
      },
    ],
  });

  await assert.rejects(
    runnerControl.verifyControllerGates("test-gate-token", {
      environment: FIRST_CONTROLLER_GATE_ENVIRONMENT,
      now: () => Date.parse("2026-08-05T10:00:00.000Z"),
      request: provider.request,
    }),
    /production ALB target inventory failed/,
  );
  assert.equal(provider.requests.length, 3);
});

test("first controller gate accepts the exact target while it is UNHEALTHY before service start", async () => {
  const provider = controllerGateProvider({ targetStates: [UNHEALTHY_TARGET] });

  await runnerControl.verifyControllerGates("test-gate-token", {
    environment: FIRST_CONTROLLER_GATE_ENVIRONMENT,
    now: () => Date.parse("2026-08-05T10:00:00.000Z"),
    request: provider.request,
  });

  assert.equal(provider.requests.length, 3);
});

test("first controller gate accepts the exact target while health checks are in TIMEOUT", async () => {
  const timeoutTarget = {
    ...UNHEALTHY_TARGET,
    status: {
      zoneStatuses: [{ failedActiveHc: false, status: "TIMEOUT", zoneId: "ru-central1-a" }],
    },
  };
  const provider = controllerGateProvider({ targetStates: [timeoutTarget] });

  await runnerControl.verifyControllerGates("test-gate-token", {
    environment: FIRST_CONTROLLER_GATE_ENVIRONMENT,
    now: () => Date.parse("2026-08-05T10:00:00.000Z"),
    request: provider.request,
  });

  assert.equal(provider.requests.length, 3);
});

test("first controller gate rejects absent, duplicate, draining, and malformed exact-target states", async () => {
  for (const [name, targetStates] of [
    ["absent", []],
    ["duplicate", [UNHEALTHY_TARGET, structuredClone(UNHEALTHY_TARGET)]],
    [
      "duplicate mixed-status zone identity",
      [
        {
          ...UNHEALTHY_TARGET,
          status: {
            zoneStatuses: [
              { failedActiveHc: true, status: "UNHEALTHY", zoneId: "ru-central1-a" },
              { failedActiveHc: false, status: "TIMEOUT", zoneId: "ru-central1-a" },
            ],
          },
        },
      ],
    ],
    [
      "legacy-only address",
      [{ ...UNHEALTHY_TARGET, target: { address: APP_ADDRESS, subnetId: "e2lsubnet123" } }],
    ],
    [
      "draining",
      [
        {
          ...UNHEALTHY_TARGET,
          status: {
            zoneStatuses: [{ failedActiveHc: false, status: "DRAINING", zoneId: "ru-central1-a" }],
          },
        },
      ],
    ],
    ["missing zones", [{ ...UNHEALTHY_TARGET, status: {} }]],
    ["empty zones", [{ ...UNHEALTHY_TARGET, status: { zoneStatuses: [] } }]],
    [
      "unknown status",
      [
        {
          ...UNHEALTHY_TARGET,
          status: { zoneStatuses: [{ status: "STARTING", zoneId: "ru-central1-a" }] },
        },
      ],
    ],
    [
      "missing zone identity",
      [
        {
          ...UNHEALTHY_TARGET,
          status: { zoneStatuses: [{ status: "TIMEOUT" }] },
        },
      ],
    ],
    [
      "malformed health-check flag",
      [
        {
          ...UNHEALTHY_TARGET,
          status: {
            zoneStatuses: [{ failedActiveHc: "false", status: "TIMEOUT", zoneId: "ru-central1-a" }],
          },
        },
      ],
    ],
  ]) {
    const provider = controllerGateProvider({ targetStates });
    await assert.rejects(
      runnerControl.verifyControllerGates("test-gate-token", {
        environment: FIRST_CONTROLLER_GATE_ENVIRONMENT,
        now: () => Date.parse("2026-08-05T10:00:00.000Z"),
        request: provider.request,
      }),
      /production ALB target inventory failed|production first ALB gate failed/,
      name,
    );
  }
});

test("repeat controller gate rejects stale, absent, unhealthy, duplicate, unexpected, and malformed target inventories", async () => {
  const unrelatedHealthy = {
    target: { ipAddress: "10.20.0.8", subnetId: "e2lsubnet123" },
    status: {
      zoneStatuses: [{ failedActiveHc: false, status: "HEALTHY", zoneId: "ru-central1-a" }],
    },
  };
  for (const [name, targetStates] of [
    ["unrelated healthy and exact unhealthy", [unrelatedHealthy, UNHEALTHY_TARGET]],
    ["exact absent", [unrelatedHealthy]],
    ["exact unhealthy", [UNHEALTHY_TARGET]],
    ["duplicate exact", [HEALTHY_TARGET, structuredClone(HEALTHY_TARGET)]],
    [
      "duplicate healthy zone identity",
      [
        {
          ...HEALTHY_TARGET,
          status: {
            zoneStatuses: [
              { failedActiveHc: false, status: "HEALTHY", zoneId: "ru-central1-a" },
              { failedActiveHc: false, status: "HEALTHY", zoneId: "ru-central1-a" },
            ],
          },
        },
      ],
    ],
    ["unexpected extra", [HEALTHY_TARGET, unrelatedHealthy]],
    ["malformed address", [{ ...HEALTHY_TARGET, target: { ipAddress: "999.20.0.7" } }]],
    ["malformed status", [{ ...HEALTHY_TARGET, status: { zoneStatuses: [{}] } }]],
    ["malformed root", null],
  ]) {
    const provider = controllerGateProvider({ targetStates });
    await assert.rejects(
      runnerControl.verifyControllerGates("test-gate-token", {
        environment: CONTROLLER_GATE_ENVIRONMENT,
        now: () => Date.parse("2026-08-05T10:00:00.000Z"),
        request: provider.request,
      }),
      /production ALB target inventory failed|production ALB gate failed/,
      name,
    );
  }
});

test("repeat controller gate rejects ambiguous, public, or malformed app network identity", async () => {
  for (const [name, app] of [
    ["missing interface", { networkInterfaces: [] }],
    [
      "duplicate interfaces",
      {
        networkInterfaces: [
          { index: "0", primaryV4Address: { address: APP_ADDRESS } },
          { index: "1", primaryV4Address: { address: "10.20.0.8" } },
        ],
      },
    ],
    [
      "public NAT",
      {
        networkInterfaces: [
          {
            index: "0",
            primaryV4Address: {
              address: APP_ADDRESS,
              oneToOneNat: { address: "203.0.113.10", ipVersion: "IPV4" },
            },
          },
        ],
      },
    ],
    [
      "public-only address",
      { networkInterfaces: [{ index: "0", primaryV4Address: { address: "203.0.113.10" } }] },
    ],
    [
      "malformed address",
      { networkInterfaces: [{ index: "0", primaryV4Address: { address: "10.20.0.999" } }] },
    ],
  ]) {
    const provider = controllerGateProvider({ app });
    await assert.rejects(
      runnerControl.verifyControllerGates("test-gate-token", {
        environment: CONTROLLER_GATE_ENVIRONMENT,
        now: () => Date.parse("2026-08-05T10:00:00.000Z"),
        request: provider.request,
      }),
      /production infrastructure gate failed/,
      name,
    );
    assert.equal(
      provider.requests.some((url) => url.includes("/targetStates/")),
      false,
      name,
    );
  }
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
    { id: " ", done: false },
    { id: "x".repeat(257), done: false },
    { id: "operation-malformed" },
    { id: "operation-malformed", done: "true" },
    { id: "operation-malformed", done: true, error: "bad" },
    { id: "operation-malformed", done: false, response: {} },
    { id: "operation-malformed", done: false, error: { code: 7 } },
    { id: "operation-malformed", done: true },
    { id: "operation-malformed", done: true, response: {}, error: { code: 7 } },
  ])
    await assert.rejects(
      runnerControl.waitForOperation(malformed, { getOperation: async () => ({}) }),
      /invalid Yandex operation response/,
    );
});

function runnerDependenciesForHttpAdapter({
  initialOperation,
  polledOperations = [],
  operationOptions = {},
}) {
  const calls = [];
  let now = 0;
  let pollIndex = 0;
  const updateUrl = `https://compute.api.cloud.yandex.net/compute/v1/instances/${INSTANCE_ID}/updateMetadata`;
  const instanceUrl = `https://compute.api.cloud.yandex.net/compute/v1/instances/${INSTANCE_ID}`;
  const startUrl = `${instanceUrl}:start`;
  const request = async (url, options = {}) => {
    const method = options.method ?? "GET";
    if (url === updateUrl) {
      calls.push("metadata:POST");
      assert.equal(method, "POST");
      assert.equal(options.headers.Authorization, "Bearer test-yandex-token");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(options.body), {
        upsert: { "markiro-runner-jit": "one-use-encoded-config" },
      });
      return initialOperation;
    }
    if (url.startsWith("https://operation.api.cloud.yandex.net/operations/")) {
      const operationId = decodeURIComponent(url.split("/").at(-1));
      calls.push(`operation:GET:${operationId}`);
      const response =
        typeof polledOperations === "function"
          ? polledOperations(operationId, pollIndex)
          : polledOperations[pollIndex];
      pollIndex += 1;
      assert.notEqual(response, undefined, "unexpected operation poll");
      return response;
    }
    if (url === instanceUrl) {
      calls.push("status:GET");
      assert.equal(method, "GET");
      return { status: "STOPPED" };
    }
    if (url === startUrl) {
      calls.push("start:POST");
      assert.equal(method, "POST");
      return {};
    }
    assert.fail(`unexpected Yandex request: ${method} ${url}`);
  };

  const yandex = runnerControl.createYandexClient({
    token: "test-yandex-token",
    request,
    operation: {
      timeoutMs: 10,
      pollIntervalMs: 1,
      clock: {
        now: () => now,
        async sleep(milliseconds) {
          now += milliseconds;
        },
      },
      ...operationOptions,
    },
  });

  return {
    calls,
    dependencies: {
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
      yandex,
    },
  };
}

test("real Yandex HTTP adapter orders metadata POST, operation polls, status, inventory, and start", async () => {
  assert.equal(typeof runnerControl.createYandexClient, "function");
  const operationId = "operation-delayed";
  const { calls, dependencies } = runnerDependenciesForHttpAdapter({
    initialOperation: { id: operationId, done: false },
    polledOperations: [
      { id: operationId, done: false },
      { id: operationId, done: true, response: { typeUrl: "type.googleapis.com/Instance" } },
    ],
  });

  await runnerControl.prepareAndStartRunner(dependencies);
  assert.deepEqual(calls, [
    "metadata:POST",
    `operation:GET:${operationId}`,
    `operation:GET:${operationId}`,
    "status:GET",
    "list",
    "start:POST",
  ]);
});

test("real Yandex HTTP adapter keeps runner start blocked while operation polling is pending", async () => {
  let releaseSleep;
  let enteredSleep;
  const sleepEntered = new Promise((resolve) => {
    enteredSleep = resolve;
  });
  const operationId = "operation-barrier";
  const { calls, dependencies } = runnerDependenciesForHttpAdapter({
    initialOperation: { id: operationId, done: false },
    polledOperations: [
      { id: operationId, done: true, response: { typeUrl: "type.googleapis.com/Instance" } },
    ],
    operationOptions: {
      clock: {
        now: () => 0,
        sleep() {
          enteredSleep();
          return new Promise((resolve) => {
            releaseSleep = resolve;
          });
        },
      },
    },
  });

  const start = runnerControl.prepareAndStartRunner(dependencies);
  await sleepEntered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["metadata:POST"]);
  assert.equal(calls.includes("start:POST"), false);

  releaseSleep();
  await start;
  assert.deepEqual(calls, [
    "metadata:POST",
    `operation:GET:${operationId}`,
    "status:GET",
    "list",
    "start:POST",
  ]);
});

for (const [name, initialOperation, polledOperations, expectedError] of [
  [
    "completed operation without a result",
    { id: "operation-empty", done: true },
    [],
    /invalid Yandex operation response/,
  ],
  [
    "premature success response",
    { id: "operation-premature", done: false, response: {} },
    [],
    /invalid Yandex operation response/,
  ],
  [
    "operation with both result fields",
    { id: "operation-both", done: true, response: {}, error: { code: 7 } },
    [],
    /invalid Yandex operation response/,
  ],
  [
    "malformed success response",
    { id: "operation-malformed", done: true, response: null },
    [],
    /invalid Yandex operation response/,
  ],
  [
    "provider error",
    { id: "operation-error", done: true, error: { code: 7, message: "sensitive" } },
    [],
    /Yandex operation failed/,
  ],
  [
    "operation ID mismatch",
    { id: "operation-original", done: false },
    [{ id: "operation-different", done: true, response: {} }],
    /invalid Yandex operation response/,
  ],
  [
    "operation timeout",
    { id: "operation-timeout", done: false },
    (id) => ({ id, done: false }),
    /Yandex operation timed out/,
  ],
])
  test(`${name} prevents runner start`, async () => {
    const { calls, dependencies } = runnerDependenciesForHttpAdapter({
      initialOperation,
      polledOperations,
    });

    await assert.rejects(runnerControl.prepareAndStartRunner(dependencies), expectedError);
    assert.equal(calls.includes("status:GET"), false);
    assert.equal(calls.includes("list"), false);
    assert.equal(calls.includes("start:POST"), false);
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

test("serial host-key parser accepts authenticated Yandex CRLF output", () => {
  const output = ["ordinary boot output", marker(RSA_KEY), marker(ED25519_KEY), ""].join("\r\n");

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

test("startRunner JIT allowance remains fail-closed for foreign or duplicate deployment runners", async () => {
  const foreign = {
    ...jitRunner(),
    labels: [{ name: "markiro-deployment-other" }],
  };
  for (const runners of [[foreign], [jitRunner(71), jitRunner(72)]]) {
    const { dependencies, calls } = fixture({ runners: [runners] });

    await assert.rejects(
      startRunner(dependencies, { expectedDeploymentId: DEPLOYMENT_ID }),
      /registered deployment runner already exists/,
    );
    assert.equal(calls.includes(`start:${INSTANCE_ID}`), false);
  }
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

test("cleanup verification waits for both runner deregistration and the stopped VM", async () => {
  const { dependencies, calls } = fixture({
    instanceStates: ["STOPPING", "STOPPED"],
    runners: [[jitRunner()], []],
  });

  await waitForRunnerCleanup(dependencies);

  assert.deepEqual(calls, [
    `status:${INSTANCE_ID}`,
    "list",
    "sleep:100",
    `status:${INSTANCE_ID}`,
    "list",
  ]);
});

test("cleanup verification has a bounded deadline and never accepts STOPPING", async () => {
  const { dependencies } = fixture({ instanceStates: ["STOPPING"], runners: [[]] });

  await assert.rejects(waitForRunnerCleanup(dependencies), /cleanup verification timed out/);
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
