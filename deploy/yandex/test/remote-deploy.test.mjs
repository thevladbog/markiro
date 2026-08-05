import assert from "node:assert/strict";
import test from "node:test";

import { runPreflight } from "../../production/preflight.mjs";
import {
  deployRelease,
  runRemoteDeployment,
  runRemoteDeploymentWithReporting,
  waitForAlbTarget,
} from "../remote-deploy.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "987654321";
const API = `ghcr.io/thevladbog/markiro-api@sha256:${"a".repeat(64)}`;
const EDGE = `ghcr.io/thevladbog/markiro-edge@sha256:${"b".repeat(64)}`;
const MANIFEST = JSON.stringify({
  api: API,
  commit: COMMIT,
  createdAt: "2026-08-05T10:00:00.000Z",
  edge: EDGE,
  workflowRunId: RUN_ID,
});
const CANDIDATE = {
  tag: COMMIT,
  previousTag: "f".repeat(40),
  apiDigest: API,
  edgeDigest: EDGE,
  state: "pending",
  createdAt: "2026-08-05T10:20:30.000Z",
};
const FIRST_CANDIDATE = { ...CANDIDATE, previousTag: null };

test("ALB target gate waits for the exact application target through transitional states", async () => {
  const responses = [
    {
      targetStates: [
        { target: { address: "10.20.0.7" }, status: { zoneStatuses: [{ status: "UNHEALTHY" }] } },
      ],
    },
    {
      targetStates: [
        { target: { address: "10.20.0.7" }, status: { zoneStatuses: [{ status: "HEALTHY" }] } },
      ],
    },
  ];
  const sleeps = [];
  let now = 0;

  await waitForAlbTarget({
    expectedAddress: "10.20.0.7",
    fetchTargetStates: async () => responses.shift(),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    monotonicNow: () => now,
    timeoutMs: 1_000,
    initialBackoffMs: 100,
    maxBackoffMs: 200,
  });

  assert.deepEqual(sleeps, [100]);
});

test("ALB target gate rejects a stale healthy target and reports only a bounded sanitized cause", async () => {
  let now = 0;
  await assert.rejects(
    waitForAlbTarget({
      expectedAddress: "10.20.0.7",
      fetchTargetStates: async () => ({
        targetStates: [
          { target: { address: "10.20.0.8" }, status: { zoneStatuses: [{ status: "HEALTHY" }] } },
        ],
      }),
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      monotonicNow: () => now,
      timeoutMs: 250,
      initialBackoffMs: 100,
      maxBackoffMs: 100,
    }),
    /production ALB gate failed after 250ms \(last cause: expected target unavailable\)/,
  );
});

test("ALB target gate abort-bounds malformed provider responses without exposing them", async () => {
  let now = 0;
  let signal;
  await assert.rejects(
    waitForAlbTarget({
      expectedAddress: "10.20.0.7",
      fetchTargetStates: async (options) => {
        signal = options.signal;
        return { targetStates: [{ target: { address: "10.20.0.7" }, status: {} }] };
      },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      monotonicNow: () => now,
      timeoutMs: 100,
      initialBackoffMs: 100,
      maxBackoffMs: 100,
    }),
    /production ALB gate failed after 100ms \(last cause: malformed target response\)/,
  );
  assert.ok(signal instanceof AbortSignal);
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

function orchestrationFixture({ candidate = CANDIDATE, failAt } = {}) {
  const events = [];
  const phase = async (name, result) => {
    events.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
    return result;
  };
  return {
    events,
    dependencies: {
      expectedWorkflowRunId: RUN_ID,
      expectedCommit: COMMIT,
      transferBundle: () => phase("transfer immutable bundle"),
      refreshRuntime: () => phase("runtime refresh"),
      prepare: () => phase("remote prepare", candidate),
      verifyAlb: () => phase("ALB healthy"),
      smoke: () => phase("external smoke"),
      finalize: () => phase("remote finalize", { ...candidate, state: "healthy" }),
      rollback: () => phase("remote rollback", { ...candidate, state: "failed" }),
    },
  };
}

test("deployRelease uses the staged boundary in exact ALB, external smoke, finalize order", async () => {
  const { dependencies, events } = orchestrationFixture();

  const record = await deployRelease(dependencies, MANIFEST);

  assert.deepEqual(events, [
    "transfer immutable bundle",
    "runtime refresh",
    "remote prepare",
    "ALB healthy",
    "external smoke",
    "remote finalize",
  ]);
  assert.equal(record.state, "healthy");
});

test("first deployment runs the ALB pre-DNS probe and never uses public DNS smoke", async () => {
  const { dependencies, events } = orchestrationFixture({ candidate: FIRST_CANDIDATE });
  dependencies.deploymentPhase = "first";
  delete dependencies.smoke;
  dependencies.preDnsSmoke = () => {
    events.push("pre-DNS ALB smoke");
  };

  const record = await deployRelease(dependencies, MANIFEST);

  assert.equal(record.state, "healthy");
  assert.deepEqual(events, [
    "transfer immutable bundle",
    "runtime refresh",
    "remote prepare",
    "ALB healthy",
    "pre-DNS ALB smoke",
    "remote finalize",
  ]);
});

test("separately selected first-release rehearsal stops the running candidate before finalize", async () => {
  const { dependencies, events } = orchestrationFixture({ candidate: FIRST_CANDIDATE });
  dependencies.deploymentPhase = "first";
  dependencies.rollbackRehearsal = true;
  delete dependencies.smoke;
  dependencies.preDnsSmoke = () => events.push("pre-DNS ALB smoke");

  const record = await deployRelease(dependencies, MANIFEST);

  assert.deepEqual(record, { state: "rehearsed", tag: COMMIT });
  assert.deepEqual(events, [
    "transfer immutable bundle",
    "runtime refresh",
    "remote prepare",
    "ALB healthy",
    "pre-DNS ALB smoke",
    "remote rollback",
  ]);
});

test("rollback rehearsal never retries a failed first-release stop", async () => {
  const { dependencies, events } = orchestrationFixture({ candidate: FIRST_CANDIDATE });
  dependencies.deploymentPhase = "first";
  dependencies.rollbackRehearsal = true;
  delete dependencies.smoke;
  dependencies.preDnsSmoke = () => events.push("pre-DNS ALB smoke");
  dependencies.rollback = async () => {
    events.push("remote rollback");
    throw new Error("first deployment recovery failed");
  };

  await assert.rejects(deployRelease(dependencies, MANIFEST), /first deployment recovery failed/);

  assert.equal(events.filter((event) => event === "remote rollback").length, 1);
});

test("repeat deployment rejects a missing previous healthy release before public smoke", async () => {
  const { dependencies, events } = orchestrationFixture({ candidate: FIRST_CANDIDATE });
  dependencies.deploymentPhase = "repeat";

  await assert.rejects(deployRelease(dependencies, MANIFEST), /previous healthy release/);

  assert.equal(events.includes("external smoke"), false);
  assert.equal(events.includes("remote finalize"), false);
});

test("prepare failure relies on remote local recovery and never invokes a second rollback", async () => {
  const { dependencies, events } = orchestrationFixture({ failAt: "remote prepare" });

  await assert.rejects(deployRelease(dependencies, MANIFEST), /remote prepare failed/);

  assert.equal(events.includes("remote rollback"), false);
  assert.equal(events.includes("ALB healthy"), false);
});

for (const failAt of ["ALB healthy", "external smoke", "remote finalize"]) {
  test(`${failAt} failure rolls back the exact prepared candidate`, async () => {
    const { dependencies, events } = orchestrationFixture({ failAt });

    await assert.rejects(deployRelease(dependencies, MANIFEST), new RegExp(`${failAt} failed`));

    assert.ok(events.indexOf("remote rollback") > events.indexOf(failAt));
    assert.equal(events.filter((event) => event === "remote rollback").length, 1);
  });
}

test("rollback cleanup failure is surfaced alongside the primary deployment failure", async () => {
  const { dependencies } = orchestrationFixture({
    candidate: FIRST_CANDIDATE,
    failAt: "ALB healthy",
  });
  dependencies.deploymentPhase = "first";
  dependencies.preDnsSmoke = () => undefined;
  dependencies.rollback = async () => {
    throw new Error("first deployment recovery failed");
  };

  let error;
  try {
    await deployRelease(dependencies, MANIFEST);
    assert.fail("deployment unexpectedly succeeded");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof AggregateError);
  assert.deepEqual(
    error.errors.map(({ message }) => message),
    ["ALB healthy failed", "first deployment recovery failed"],
  );
  assert.equal(error.cause.message, "ALB healthy failed");
});

test("deployment wrapper emits the exact success or failure metric without masking the primary error", async () => {
  for (const failure of [undefined, new Error("deploy failed")]) {
    const writes = [];
    const environment = { MARKIRO_FOLDER_ID: "folder-1", YC_APP_INSTANCE_ID: "app-1" };
    const reporting = {
      runDeployment: async () => {
        if (failure) throw failure;
        return "healthy";
      },
      metadataIamToken: async () => "iam-token",
      writeMetrics: async (request) => writes.push(request),
    };
    if (failure)
      await assert.rejects(
        runRemoteDeploymentWithReporting(environment, {}, reporting),
        /deploy failed/,
      );
    else
      assert.equal(await runRemoteDeploymentWithReporting(environment, {}, reporting), "healthy");
    assert.deepEqual(writes[0].metrics, [
      {
        name: "markiro.deployment.failure",
        labels: { resource_id: "app-1" },
        type: "DGAUGE",
        value: failure ? 1 : 0,
      },
    ]);
  }
});

function response(body, ok = true) {
  return {
    ok,
    async json() {
      return body;
    },
  };
}

function cliFixture({ candidate = CANDIDATE, failAt } = {}) {
  const events = [];
  const commands = [];
  let monotonicTime = 0;
  const environment = {
    RELEASE_MANIFEST_PATH: "/runner/release-manifest.json",
    EXPECTED_RELEASE_RUN_ID: RUN_ID,
    EXPECTED_RELEASE_SHA: COMMIT,
    YC_APP_INSTANCE_ID: "fv4app123",
    YC_REGISTRY_SECRET_ID: "e6qregistry123",
    YC_OS_LOGIN: "deployer",
    YC_ORGANIZATION_ID: "bpforganization",
    YC_LOAD_BALANCER_ID: "ds7loadbalancer",
    YC_BACKEND_GROUP_ID: "ds7backend",
    YC_TARGET_GROUP_ID: "ds7target",
    MARKIRO_DOMAIN: "markiro.example",
    MARKIRO_DEPLOYMENT_PHASE: candidate.previousTag === null ? "first" : "repeat",
    YC_LOAD_BALANCER_ADDRESS: "203.0.113.42",
    APP_SSH_HOST_KEYS_B64: Buffer.from(`${ED25519_KEY}\n${RSA_KEY}`).toString("base64"),
  };
  const system = {
    monotonicNow: () => monotonicTime,
    sleep: async (milliseconds) => {
      monotonicTime += milliseconds;
    },
    async readFile() {
      return MANIFEST;
    },
    async metadataIamToken() {
      return "runner-iam-token";
    },
    async fetch(url) {
      if (String(url).includes("payload.lockbox"))
        return response({
          entries: [
            { key: "GHCR_USERNAME", textValue: "deployer" },
            { key: "GHCR_TOKEN", textValue: "registry-token" },
          ],
        });
      if (String(url).includes("/targetStates/")) {
        events.push("ALB healthy");
        if (failAt === "ALB healthy") return response({ targetStates: [] });
        return response({
          targetStates: [
            {
              target: { address: "10.20.0.7" },
              status: { zoneStatuses: [{ status: "HEALTHY" }] },
            },
          ],
        });
      }
      return response({
        status: "RUNNING",
        networkInterfaces: [{ primaryV4Address: { address: "10.20.0.7" } }],
      });
    },
    async mkdtemp(prefix) {
      return prefix.includes("os-login") ? "/tmp/os-login" : "/tmp/manifest";
    },
    async readdir() {
      return ["id_ed25519", "id_ed25519-cert.pub"];
    },
    async copyFile() {
      events.push("copy manifest");
    },
    async writeFile(path, value, options) {
      events.push("write known hosts");
      assert.equal(options.mode, 0o600);
      assert.equal(value, `10.20.0.7 ${ED25519_KEY}\n10.20.0.7 ${RSA_KEY}\n`);
    },
    async rm() {
      events.push("cleanup local material");
    },
    async streamArchive(_tar, ssh) {
      events.push("transfer immutable bundle");
      assert.ok(ssh.includes("StrictHostKeyChecking=yes"));
      assert.equal(
        ssh.some((value) => value.includes("accept-new")),
        false,
      );
    },
    async run(command, args, options = {}) {
      commands.push({ command, args, options });
      if (command === "yc") return "";
      if (args.includes("markiro-runtime-env.service")) {
        events.push("runtime refresh");
        return "";
      }
      if (args.includes("prepare")) {
        events.push("remote prepare");
        assert.ok(args.some((value) => value.includes("registry-auth.mjs run-stdin")));
        return `${JSON.stringify(candidate)}\n`;
      }
      if (args.includes("finalize")) {
        events.push("remote finalize");
        assert.deepEqual(JSON.parse(JSON.parse(options.input).commandInput), candidate);
        if (failAt === "remote finalize") throw new Error("remote finalize failed");
        return `${JSON.stringify({ ...candidate, state: "healthy" })}\n`;
      }
      if (args.includes("rollback")) {
        events.push("remote rollback");
        assert.deepEqual(JSON.parse(JSON.parse(options.input).commandInput), candidate);
        return `${JSON.stringify({ ...candidate, state: "failed" })}\n`;
      }
      if (args.includes("--dump-header"))
        return `HTTP/1.1 200 OK\r\nx-markiro-release-sha: ${COMMIT}\r\n\r\n`;
      return "";
    },
    async smoke({ expectedReleaseSha }) {
      events.push("external smoke");
      assert.equal(expectedReleaseSha, COMMIT);
      if (failAt === "external smoke") throw new Error("external smoke failed");
    },
  };
  return { commands, environment, events, system };
}

test("real CLI adapter stages remote prepare, ALB, runner smoke, and remote finalize", async () => {
  const { commands, environment, events, system } = cliFixture();

  await runRemoteDeployment(environment, system);

  assert.deepEqual(
    events.filter(
      (event) =>
        !event.startsWith("cleanup") && event !== "copy manifest" && event !== "write known hosts",
    ),
    [
      "transfer immutable bundle",
      "runtime refresh",
      "remote prepare",
      "ALB healthy",
      "external smoke",
      "remote finalize",
    ],
  );
  assert.ok(
    commands.some(
      ({ command, args }) =>
        command === "ssh" &&
        args.includes("prepare") &&
        args.includes("MARKIRO_REQUIRE_PREVIOUS_HEALTHY=1"),
    ),
  );
  const expectedRemoteEnvironment = [
    `MARKIRO_IMAGE_TAG=${COMMIT}`,
    `MARKIRO_API_IMAGE_DIGEST=sha256:${"a".repeat(64)}`,
    `MARKIRO_EDGE_IMAGE_DIGEST=sha256:${"b".repeat(64)}`,
    "MARKIRO_COMPOSE_PROJECT=markiro-production",
    "MARKIRO_DOMAIN=markiro.example",
    "MARKIRO_EDGE_MODE=behind-alb",
    "MARKIRO_REQUIRE_PREVIOUS_HEALTHY=1",
    "MARKIRO_ENV_FILE=/etc/markiro/production.env",
    "MARKIRO_RELEASE_DIRECTORY=/var/lib/markiro/releases",
  ];
  const successfulStages = commands.filter(
    ({ command, args }) =>
      command === "ssh" && (args.includes("prepare") || args.includes("finalize")),
  );
  assert.equal(successfulStages.length, 2);
  for (const { args } of successfulStages)
    for (const variable of expectedRemoteEnvironment) assert.ok(args.includes(variable));
  const activeRelease = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("markiro-active-release"),
  );
  assert.ok(activeRelease);
  assert.ok(activeRelease.args.includes("/opt/markiro/active-release"));
  assert.ok(activeRelease.args.some((value) => value.includes("mv -Tf")));
});

test("actual remote prepare argv satisfies the real app-side preflight environment boundary", async () => {
  const { commands, environment, system } = cliFixture();

  await runRemoteDeployment(environment, system);

  const prepare = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("prepare"),
  );
  const envStart = prepare.args.indexOf("env") + 1;
  const envEnd = prepare.args.indexOf("/usr/bin/bash");
  const remoteEnvironment = Object.fromEntries(
    prepare.args.slice(envStart, envEnd).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  let composeEnvironment;

  const preflight = await runPreflight(remoteEnvironment, {
    mode: async () => 0o600,
    composeQuiet: async (value) => {
      composeEnvironment = value;
    },
  });

  assert.deepEqual(preflight, {
    imageTag: COMMIT,
    apiImageDigest: `sha256:${"a".repeat(64)}`,
    edgeImageDigest: `sha256:${"b".repeat(64)}`,
    domain: "markiro.example",
    acmeEmail: undefined,
    envFile: "/etc/markiro/production.env",
    edgeMode: "behind-alb",
  });
  assert.equal(composeEnvironment.MARKIRO_DOMAIN, "markiro.example");
});

test("runner rejects a malformed production domain before transferring the release", async () => {
  const { environment, events, system } = cliFixture();
  environment.MARKIRO_DOMAIN = "https://markiro.example/path";

  await assert.rejects(runRemoteDeployment(environment, system), /MARKIRO_DOMAIN is invalid/);

  assert.equal(events.includes("transfer immutable bundle"), false);
});

test("real CLI adapter keeps first deployment pre-DNS and probes loopback plus the reserved ALB address", async () => {
  const { commands, environment, events, system } = cliFixture({ candidate: FIRST_CANDIDATE });

  await runRemoteDeployment(environment, system);

  const localProbe = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("http://127.0.0.1:8080/health/ready"),
  );
  const albProbe = commands.find(
    ({ command, args }) =>
      command === "curl" && args.includes("https://markiro.example/health/ready"),
  );
  const prepare = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("prepare"),
  );
  assert.ok(localProbe);
  assert.ok(localProbe.args.includes("Host: markiro.example"));
  assert.ok(localProbe.args.includes("--dump-header"));
  assert.ok(albProbe);
  assert.ok(albProbe.args.includes("markiro.example:443:203.0.113.42"));
  assert.ok(albProbe.args.includes("--dump-header"));
  assert.ok(prepare.args.includes("MARKIRO_REQUIRE_PREVIOUS_HEALTHY=0"));
  assert.equal(events.includes("external smoke"), false);
});

test("first deployment rejects a stale 200 release header before finalization", async () => {
  const { environment, events, system } = cliFixture({ candidate: FIRST_CANDIDATE });
  const run = system.run;
  system.run = async (command, args, options) => {
    if (args.includes("--dump-header"))
      return `HTTP/1.1 200 OK\r\nx-markiro-release-sha: ${"f".repeat(40)}\r\n\r\n`;
    return run(command, args, options);
  };

  await assert.rejects(
    runRemoteDeployment(environment, system),
    /live release identity does not match the expected release/,
  );

  assert.equal(events.includes("remote finalize"), false);
  assert.equal(events.includes("remote rollback"), true);
});

test("real CLI adapter rejects a noncanonical authenticated host-key bundle before writing trust", async () => {
  const { environment, events, system } = cliFixture();
  environment.APP_SSH_HOST_KEYS_B64 = Buffer.from(
    `${ED25519_KEY}\n${RSA_KEY}\n${publicKey("ssh-ed25519", 2)}`,
  ).toString("base64");

  await assert.rejects(runRemoteDeployment(environment, system), /authenticated SSH host keys/);

  assert.equal(events.includes("write known hosts"), false);
  assert.equal(events.includes("transfer immutable bundle"), false);
});

test("real CLI adapter rolls back remotely when runner external smoke fails", async () => {
  const { commands, environment, events, system } = cliFixture({ failAt: "external smoke" });

  await assert.rejects(runRemoteDeployment(environment, system), /external smoke failed/);

  assert.ok(events.indexOf("remote rollback") > events.indexOf("external smoke"));
  assert.equal(events.includes("remote finalize"), false);
  const rollback = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("rollback"),
  );
  assert.ok(rollback.args.includes("MARKIRO_DOMAIN=markiro.example"));
});

for (const failAt of ["ALB healthy", "remote finalize"]) {
  test(`real CLI adapter terminalizes a first deployment after ${failAt} failure`, async () => {
    const { environment, events, system } = cliFixture({
      candidate: FIRST_CANDIDATE,
      failAt,
    });

    await assert.rejects(runRemoteDeployment(environment, system));

    assert.ok(events.indexOf("remote rollback") > events.indexOf(failAt));
    assert.equal(events.filter((event) => event === "remote rollback").length, 1);
    assert.equal(events.includes("remote finalize"), failAt === "remote finalize");
  });
}
