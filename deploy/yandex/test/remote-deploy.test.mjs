import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  DEPLOYMENT_STAGES,
  DeploymentStageError,
  atDeploymentStage,
  deployRelease,
  runCommand,
  runCommandWithStatus,
  runRemoteDeployCli,
  runRemoteDeployment,
  streamArchive,
} from "../remote-deploy.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "987654321";
const API = `ghcr.io/thevladbog/markiro-api@sha256:${"a".repeat(64)}`;
const EDGE = `ghcr.io/thevladbog/markiro-edge@sha256:${"b".repeat(64)}`;
const MANIFEST = JSON.stringify({
  api: API,
  commit: COMMIT,
  createdAt: "2026-08-09T10:00:00.000Z",
  edge: EDGE,
  workflowRunId: RUN_ID,
});
const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAA",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");
const HOST_KEYS = Buffer.from(
  `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}\nssh-rsa ${Buffer.alloc(64, 2).toString("base64")}`,
).toString("base64");
const CANDIDATE = {
  tag: COMMIT,
  previousTag: null,
  apiDigest: API,
  edgeDigest: EDGE,
  state: "pending",
  createdAt: "2026-08-09T10:20:30.000Z",
};

test("deployment diagnostics accept only the closed stage vocabulary", () => {
  assert.deepEqual(DEPLOYMENT_STAGES, [
    "configuration",
    "transfer",
    "reconcile-host",
    "runtime-inventory",
    "runtime-env",
    "prepare",
    "smoke",
    "finalize",
    "rollback",
  ]);
  assert.equal(Object.isFrozen(DEPLOYMENT_STAGES), true);
  for (const stage of DEPLOYMENT_STAGES) {
    const error = new DeploymentStageError(stage);
    assert.equal(error.stage, stage);
    assert.equal(error.message, "remote deployment failed");
  }
  for (const stage of [
    "",
    "unknown",
    " transfer",
    "transfer ",
    "transfer\nGHCR_TOKEN=leaked",
    "LOCKBOX_SECRET_ID=secret-shaped",
    "x".repeat(1_024),
  ]) {
    assert.throws(() => new DeploymentStageError(stage), /deployment stage is invalid/);
  }
});

test("deployment stage errors retain their original cause only in memory", async () => {
  const cause = new Error("remote said token=should-stay-private");
  await assert.rejects(
    atDeploymentStage("transfer", async () => {
      throw cause;
    }),
    (error) => {
      assert.ok(error instanceof DeploymentStageError);
      assert.equal(error.stage, "transfer");
      assert.equal(error.message, "remote deployment failed");
      assert.equal(error.cause, cause);
      assert.equal(JSON.stringify(error).includes("should-stay-private"), false);
      return true;
    },
  );
});

test("deploy CLI emits exactly one bounded line and never serializes private causes", async () => {
  const privateFragments = [
    "registry-token-value",
    "/runner/private-identity",
    "lockbox-id-value",
    "DATABASE_URL=private-value",
    '{"candidate":"private-json"}',
    "remote command said private message",
  ];
  const cause = new Error(privateFragments.join(" | "));
  for (const stage of DEPLOYMENT_STAGES) {
    let stderr = "";
    let calls = 0;
    const exitCode = await runRemoteDeployCli({
      argv: ["run"],
      stderr: { write: (value) => (stderr += value) },
      runDeployment: async () => {
        calls += 1;
        throw new DeploymentStageError(stage, { cause });
      },
    });
    assert.equal(calls, 1);
    assert.equal(exitCode, 1);
    assert.equal(stderr, `MARKIRO_DEPLOY_FAILURE ${stage}\n`);
    for (const fragment of privateFragments) assert.equal(stderr.includes(fragment), false);
  }
});

test("deploy CLI maps invalid invocation and untyped failures to configuration", async () => {
  for (const scenario of [
    { argv: [], runDeployment: async () => assert.fail("must not run") },
    { argv: ["wrong"], runDeployment: async () => assert.fail("must not run") },
    { argv: ["run"], runDeployment: async () => Promise.reject(new Error("private")) },
  ]) {
    let stderr = "";
    const exitCode = await runRemoteDeployCli({
      ...scenario,
      stderr: { write: (value) => (stderr += value) },
    });
    assert.equal(exitCode, 1);
    assert.equal(stderr, "MARKIRO_DEPLOY_FAILURE configuration\n");
    assert.equal(stderr.includes("private"), false);
  }
});

function commandChild() {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    killCalls: 0,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.killCalls += 1;
      return true;
    },
  });
}

test("remote command status preserves bounded stdout for a nonzero diagnostic exit", async () => {
  const child = commandChild();
  const command = runCommandWithStatus("ssh", ["private-host"], { spawn: () => child });
  child.stdout.end("MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS safe\n");
  child.stderr.end("private-token-must-not-surface");
  child.exitCode = 1;
  child.emit("close", 1);

  assert.deepEqual(await command, {
    exitCode: 1,
    stdout: "MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS safe\n",
  });
});

test("ordinary remote commands still reject a nonzero exit without exposing stdout", async () => {
  const child = commandChild();
  const command = runCommand("ssh", ["private-host"], { spawn: () => child });
  child.stdout.end("private-token-must-not-surface");
  child.exitCode = 1;
  child.emit("close", 1);

  await assert.rejects(command, (error) => {
    assert.equal(error.message, "private remote command failed");
    assert.equal(error.message.includes("private-token-must-not-surface"), false);
    return true;
  });
});

test("remote command stdin failure settles once with one fixed private rejection", async () => {
  const child = commandChild();
  const secret = "registry-token-and-/runner/private-key-path";
  let settlements = 0;
  const command = runCommand("ssh", ["private-host"], {
    input: secret,
    spawn: () => child,
  }).then(
    () => {
      settlements += 1;
      assert.fail("stdin failure must reject");
    },
    (error) => {
      settlements += 1;
      assert.equal(error.message, "private remote command failed");
      assert.equal(String(error).includes(secret), false);
    },
  );

  child.stdin.emit("error", new Error(`write EPIPE ${secret}`));
  child.emit("close", 255);
  child.emit("error", new Error(`late child error ${secret}`));
  await command;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settlements, 1);
  assert.equal(child.killCalls, 1);
});

test("stdin error and close race reaches the deploy CLI as one bounded stage line", async () => {
  const child = commandChild();
  const secret = "EPIPE-/runner/private-identity-registry-token";
  let stderr = "";
  const exit = runRemoteDeployCli({
    argv: ["run"],
    stderr: { write: (value) => (stderr += value) },
    runDeployment: () =>
      atDeploymentStage("prepare", () =>
        runCommand("ssh", ["private-host"], {
          input: secret,
          spawn: () => child,
        }),
      ),
  });

  child.stdin.emit("error", new Error(`write EPIPE ${secret}`));
  child.emit("close", 255);
  assert.equal(await exit, 1);
  assert.equal(stderr, "MARKIRO_DEPLOY_FAILURE prepare\n");
  assert.equal(stderr.includes(secret), false);
  assert.equal(stderr.includes("EPIPE"), false);
  assert.equal(stderr.includes("remote-deploy.mjs"), false);
});

test("release transfer terminates tar when SSH exits before consuming the archive", async () => {
  const archive = Object.assign(new EventEmitter(), {
    exitCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killCalled: false,
    kill() {
      this.killCalled = true;
      return true;
    },
  });
  const remote = Object.assign(new EventEmitter(), {
    exitCode: null,
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      return true;
    },
  });
  const children = [archive, remote];
  const diagnostics = [];
  const transfer = streamArchive(["-cf", "-"], ["host", "tar"], {
    spawn: () => children.shift(),
    timeoutMs: 1_000,
    writeDiagnostic: (value) => diagnostics.push(value),
  });
  remote.exitCode = 255;
  remote.emit("close", 255);
  await assert.rejects(transfer, (error) => {
    assert.equal(error.message, "private release transfer failed");
    assert.equal(error.cause?.code, "ssh-exit");
    return true;
  });
  assert.deepEqual(diagnostics, []);
  assert.equal(archive.killCalled, true);
  assert.equal(archive.stdout.destroyed, true);
});

test("release transfer pipes the archive into SSH and completes after both children exit", async () => {
  const archive = Object.assign(new EventEmitter(), {
    exitCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      return true;
    },
  });
  const remote = Object.assign(new EventEmitter(), {
    exitCode: null,
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      return true;
    },
  });
  const received = [];
  remote.stdin.on("data", (chunk) => received.push(chunk));
  remote.stdin.once("finish", () => {
    remote.exitCode = 0;
    remote.emit("close", 0);
  });
  const children = [archive, remote];
  const transfer = streamArchive(["-cf", "-"], ["host", "tar"], {
    spawn: () => children.shift(),
    timeoutMs: 250,
    writeDiagnostic: () => undefined,
  });
  archive.stdout.end("archive payload");
  archive.exitCode = 0;
  archive.emit("close", 0);

  await transfer;
  assert.equal(Buffer.concat(received).toString("utf8"), "archive payload");
});

test("direct deployment transfers, prepares, smokes and finalizes without a cloud control plane", async () => {
  const events = [];
  const result = await deployRelease(
    {
      expectedWorkflowRunId: RUN_ID,
      expectedCommit: COMMIT,
      transferBundle: async () => events.push("transfer"),
      verifyRuntimeInventory: async () => events.push("runtime-inventory"),
      reconcileHost: async () => events.push("host-assets"),
      refreshRuntime: async () => events.push("runtime"),
      prepare: async () => {
        events.push("prepare");
        return CANDIDATE;
      },
      smoke: async () => events.push("smoke"),
      finalize: async () => {
        events.push("finalize");
        return { ...CANDIDATE, state: "healthy" };
      },
      rollback: async () => events.push("rollback"),
    },
    MANIFEST,
  );
  assert.deepEqual(events, [
    "transfer",
    "runtime-inventory",
    "host-assets",
    "runtime",
    "prepare",
    "smoke",
    "finalize",
  ]);
  assert.equal(result.state, "healthy");
});

test("direct deployment rolls back once after a post-prepare failure", async () => {
  const events = [];
  await assert.rejects(
    deployRelease(
      {
        expectedWorkflowRunId: RUN_ID,
        expectedCommit: COMMIT,
        transferBundle: async () => events.push("transfer"),
        verifyRuntimeInventory: async () => events.push("runtime-inventory"),
        reconcileHost: async () => events.push("host-assets"),
        refreshRuntime: async () => events.push("runtime"),
        prepare: async () => CANDIDATE,
        smoke: async () => {
          events.push("smoke");
          throw new Error("smoke failed");
        },
        finalize: async () => events.push("finalize"),
        rollback: async () => events.push("rollback"),
      },
      MANIFEST,
    ),
    (error) => {
      assert.ok(error instanceof DeploymentStageError);
      assert.equal(error.stage, "smoke");
      assert.equal(error.message, "remote deployment failed");
      assert.equal(error.cause?.message, "smoke failed");
      return true;
    },
  );
  assert.deepEqual(events, [
    "transfer",
    "runtime-inventory",
    "host-assets",
    "runtime",
    "smoke",
    "rollback",
  ]);
});

test("runtime inventory mismatch stops before every remote mutation", async () => {
  const events = [];
  const inventoryCause = new Error("private-lockbox-inventory-detail");
  const mutations = [
    "reconcile-host",
    "runtime-env",
    "prepare",
    "smoke",
    "finalize",
    "rollback",
    "active-release",
    "service-command",
  ];
  const mutation = (name) => async () => events.push(name);

  await assert.rejects(
    deployRelease(
      {
        expectedWorkflowRunId: RUN_ID,
        expectedCommit: COMMIT,
        transferBundle: async () => events.push("transfer"),
        verifyRuntimeInventory: async () => {
          events.push("runtime-inventory");
          throw inventoryCause;
        },
        reconcileHost: mutation("reconcile-host"),
        refreshRuntime: mutation("runtime-env"),
        prepare: mutation("prepare"),
        smoke: mutation("smoke"),
        finalize: mutation("finalize"),
        rollback: mutation("rollback"),
      },
      MANIFEST,
    ),
    (error) => {
      assert.ok(error instanceof DeploymentStageError);
      assert.equal(error.stage, "runtime-inventory");
      assert.equal(error.cause, inventoryCause);
      return true;
    },
  );
  assert.deepEqual(events, ["transfer", "runtime-inventory"]);
  assert.equal(
    events.some((event) => mutations.includes(event)),
    false,
  );
});

test("direct deployment preserves the exact failing boundary as a typed stage", async () => {
  const cases = [
    ["transferBundle", "transfer", ["transfer"]],
    ["verifyRuntimeInventory", "runtime-inventory", ["transfer", "runtime-inventory"]],
    ["reconcileHost", "reconcile-host", ["transfer", "runtime-inventory", "reconcile-host"]],
    [
      "refreshRuntime",
      "runtime-env",
      ["transfer", "runtime-inventory", "reconcile-host", "runtime-env"],
    ],
    [
      "prepare",
      "prepare",
      ["transfer", "runtime-inventory", "reconcile-host", "runtime-env", "prepare"],
    ],
    [
      "smoke",
      "smoke",
      [
        "transfer",
        "runtime-inventory",
        "reconcile-host",
        "runtime-env",
        "prepare",
        "smoke",
        "rollback",
      ],
    ],
    [
      "finalize",
      "finalize",
      [
        "transfer",
        "runtime-inventory",
        "reconcile-host",
        "runtime-env",
        "prepare",
        "smoke",
        "finalize",
        "rollback",
      ],
    ],
  ];
  for (const [failingOperation, expectedStage, expectedEvents] of cases) {
    const events = [];
    const secretCause = new Error(`private-${expectedStage}-detail`);
    const dependencies = {
      expectedWorkflowRunId: RUN_ID,
      expectedCommit: COMMIT,
      transferBundle: async () => events.push("transfer"),
      verifyRuntimeInventory: async () => events.push("runtime-inventory"),
      reconcileHost: async () => events.push("reconcile-host"),
      refreshRuntime: async () => events.push("runtime-env"),
      prepare: async () => {
        events.push("prepare");
        return CANDIDATE;
      },
      smoke: async () => events.push("smoke"),
      finalize: async () => {
        events.push("finalize");
        return { ...CANDIDATE, state: "healthy" };
      },
      rollback: async () => events.push("rollback"),
    };
    dependencies[failingOperation] = async () => {
      events.push(expectedStage);
      throw secretCause;
    };
    await assert.rejects(deployRelease(dependencies, MANIFEST), (error) => {
      assert.ok(error instanceof DeploymentStageError);
      assert.equal(error.stage, expectedStage);
      assert.equal(error.cause, secretCause);
      assert.equal(error.message, "remote deployment failed");
      return true;
    });
    assert.deepEqual(events, expectedEvents, failingOperation);
  }
});

test("rollback failure is reported as rollback without exposing either private failure", async () => {
  const smokeCause = new Error("private-smoke-detail");
  const rollbackCause = new Error("private-rollback-detail");
  await assert.rejects(
    deployRelease(
      {
        expectedWorkflowRunId: RUN_ID,
        expectedCommit: COMMIT,
        transferBundle: async () => undefined,
        verifyRuntimeInventory: async () => undefined,
        reconcileHost: async () => undefined,
        refreshRuntime: async () => undefined,
        prepare: async () => CANDIDATE,
        smoke: async () => {
          throw smokeCause;
        },
        finalize: async () => undefined,
        rollback: async () => {
          throw rollbackCause;
        },
      },
      MANIFEST,
    ),
    (error) => {
      assert.ok(error instanceof DeploymentStageError);
      assert.equal(error.stage, "rollback");
      assert.equal(error.cause?.rollbackCause, rollbackCause);
      assert.ok(error.cause?.rollbackFailure instanceof DeploymentStageError);
      assert.equal(error.cause.rollbackFailure.stage, "rollback");
      assert.ok(error.cause?.originalFailure instanceof DeploymentStageError);
      assert.equal(error.cause.originalFailure.stage, "smoke");
      assert.equal(error.cause.originalFailure.cause, smokeCause);
      assert.equal(JSON.stringify(error).includes("private"), false);
      assert.equal(String(error).includes("private"), false);
      return true;
    },
  );
});

function environment(overrides = {}) {
  return {
    RELEASE_MANIFEST_PATH: "/runner/release-manifest.json",
    EXPECTED_RELEASE_RUN_ID: RUN_ID,
    EXPECTED_RELEASE_SHA: COMMIT,
    YC_APP_PUBLIC_ADDRESS: "203.0.113.44",
    YC_APP_DEPLOY_LOGIN: "markiro-deploy",
    YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/markiro-deploy-key",
    APP_SSH_HOST_KEYS_B64: HOST_KEYS,
    GHCR_USERNAME: "github-actions",
    GHCR_TOKEN: "masked-job-token",
    MARKIRO_DOMAIN: "admin.markiro.example",
    MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.example",
    MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
    MARKIRO_LANDING_DOMAIN: "markiro.example",
    MARKIRO_LANDING_DEMO_SUBMISSION_STATE: "disabled",
    ACME_EMAIL: "ops@example.test",
    ...overrides,
  };
}

function systemFixture() {
  const events = [];
  const commands = [];
  return {
    events,
    commands,
    system: {
      readFile: async (path) => (path.endsWith("release-manifest.json") ? MANIFEST : PRIVATE_KEY),
      stat: async () => ({ isFile: () => true, mode: 0o100600, size: PRIVATE_KEY.length }),
      mkdtemp: async (prefix) => (prefix.includes("ssh") ? "/tmp/ssh" : "/tmp/manifest"),
      copyFile: async () => undefined,
      writeFile: async (path, value, options) => {
        events.push({ path, value, options });
      },
      rm: async () => undefined,
      streamArchive: async (tarArguments) => {
        events.push({ transfer: tarArguments });
      },
      smoke: async () => events.push("smoke"),
      run: async (command, args, options = {}) => {
        commands.push({ command, args, input: options.input });
        if (args.includes("prepare")) return JSON.stringify(CANDIDATE);
        if (args.includes("finalize")) return JSON.stringify({ ...CANDIDATE, state: "healthy" });
        if (args.includes("rollback")) return JSON.stringify({ ...CANDIDATE, state: "failed" });
        return "";
      },
    },
  };
}

test("real direct adapter uses pinned SSH and job-scoped registry credentials only", async () => {
  const fixture = systemFixture();
  const result = await runRemoteDeployment(environment(), fixture.system);
  assert.equal(result.state, "healthy");
  const transfer = fixture.events.find((event) => event.transfer);
  assert.ok(transfer.transfer.includes("deploy/yandex/runtime-env.mjs"));
  assert.ok(transfer.transfer.includes("deploy/yandex/registry-auth.mjs"));
  assert.ok(transfer.transfer.includes("deploy/yandex/tmpfiles.d"));
  assert.ok(fixture.events.includes("smoke"));
  const ssh = fixture.commands.find(({ command }) => command === "ssh");
  assert.ok(ssh.args.includes("markiro-deploy@203.0.113.44"));
  assert.ok(ssh.args.includes("StrictHostKeyChecking=yes"));
  assert.ok(ssh.args.includes("/runner/markiro-deploy-key"));
  const inventory = fixture.commands.find(({ args }) => args.includes("verify-inventory"));
  assert.ok(inventory, "candidate runtime inventory must be verified");
  assert.deepEqual(inventory.args.slice(-4), [
    "/usr/bin/node",
    "deploy/yandex/runtime-env.mjs",
    "verify-inventory",
    `/opt/markiro/releases/${COMMIT}/.env.production.example`,
  ]);
  assert.ok(inventory.args.includes("--property=EnvironmentFile=/etc/markiro/runtime-secret-id"));
  assert.ok(inventory.args.includes(`--working-directory=/opt/markiro/releases/${COMMIT}`));
  assert.equal(inventory.args.includes("/usr/bin/bash"), false);
  assert.equal(inventory.args.includes("-c"), false);
  assert.equal(
    inventory.args.some((arg) => arg.includes("production.env")),
    false,
  );
  assert.equal(inventory.input, undefined);
  const prepare = fixture.commands.find(({ args }) => args.includes("prepare"));
  assert.match(prepare.input, /GHCR_USERNAME/);
  assert.match(prepare.input, /GHCR_TOKEN/);
  assert.ok(prepare.args.includes("MARKIRO_EDGE_MODE=direct"));
  assert.ok(prepare.args.includes("MARKIRO_SAAS_ADMIN_DOMAIN=saas-admin.markiro.example"));
  assert.ok(prepare.args.includes("MARKIRO_LANDING_DOMAIN=markiro.example"));
  assert.ok(prepare.args.includes("ACME_EMAIL=ops@example.test"));
  assert.ok(prepare.args.includes(`--working-directory=/opt/markiro/releases/${COMMIT}`));
  assert.deepEqual(prepare.args.slice(-6), [
    "/usr/bin/node",
    "/usr/local/lib/markiro/registry-auth.mjs",
    "run-stdin",
    "/usr/bin/node",
    "deploy/production/deploy.mjs",
    "prepare",
  ]);
  assert.equal(prepare.args.includes("/usr/bin/bash"), false);
  assert.equal(prepare.args.includes("-c"), false);
  const activation = fixture.commands.find(
    ({ args }) => args.includes("/opt/markiro/active-release") && args.includes("mv"),
  );
  assert.ok(activation, "release activation must use a direct argv-safe mv");
  assert.equal(activation.args.includes("/usr/bin/bash"), false);
  assert.equal(activation.args.includes("-c"), false);
  const hostAssets = fixture.commands.find(({ args }) => args.includes("markiro-host-assets"));
  assert.ok(hostAssets);
  const reconcileScript = await readFile(
    path.resolve(import.meta.dirname, "../reconcile-host.sh"),
    "utf8",
  );
  assert.match(reconcileScript, /systemd-tmpfiles --create/);
  assert.ok(
    fixture.commands.indexOf(inventory) < fixture.commands.indexOf(hostAssets),
    "runtime inventory must be verified before host reconciliation",
  );
  assert.ok(
    fixture.commands.indexOf(hostAssets) < fixture.commands.indexOf(prepare),
    "host assets must be reconciled before the first deploy stage",
  );
  assert.equal(
    fixture.commands.some(({ command }) => command === "curl"),
    false,
  );
});

test("direct stages use fresh transient units with explicit runtime environment ordering", async () => {
  const fixture = systemFixture();
  await runRemoteDeployment(environment(), fixture.system);

  const stages = fixture.commands.filter(({ args }) => args.includes("/usr/bin/systemd-run"));
  assert.equal(stages.length, 3);
  const inventory = stages.find(({ args }) => args.includes("verify-inventory"));
  assert.ok(inventory);
  assert.ok(inventory.args.includes("--property=EnvironmentFile=/etc/markiro/runtime-secret-id"));
  assert.equal(inventory.args.includes("--property=Requires=markiro-runtime-env.service"), false);
  assert.equal(inventory.args.includes("--property=After=markiro-runtime-env.service"), false);
  for (const { args } of stages.filter(({ args }) => !args.includes("verify-inventory"))) {
    assert.equal(
      args.some((argument) => argument.startsWith("--unit=")),
      false,
    );
    assert.ok(args.includes("--property=Requires=markiro-runtime-env.service"));
    assert.ok(args.includes("--property=After=markiro-runtime-env.service"));
  }
});

test("real adapter inventory mismatch executes no reconciliation, service, deploy, or activation command", async () => {
  const fixture = systemFixture();
  const originalRun = fixture.system.run;
  let inventoryCalls = 0;
  fixture.system.run = async (command, args, options) => {
    if (args.includes("verify-inventory")) {
      inventoryCalls += 1;
      throw new Error("private-inventory-mismatch");
    }
    return originalRun(command, args, options);
  };

  await assert.rejects(runRemoteDeployment(environment(), fixture.system), (error) => {
    assert.ok(error instanceof DeploymentStageError);
    assert.equal(error.stage, "runtime-inventory");
    return true;
  });
  assert.equal(inventoryCalls, 1);
  const remoteArgs = fixture.commands.flatMap(({ args }) => args);
  assert.equal(remoteArgs.includes("markiro-host-assets"), false);
  assert.equal(remoteArgs.includes("restart"), false);
  assert.equal(remoteArgs.includes("prepare"), false);
  assert.equal(remoteArgs.includes("finalize"), false);
  assert.equal(remoteArgs.includes("rollback"), false);
  assert.equal(remoteArgs.includes("/opt/markiro/active-release"), false);
  assert.equal(fixture.events.includes("smoke"), false);
});

test("direct deployment passes the approved landing submission state to public smoke", async () => {
  const fixture = systemFixture();
  const calls = [];
  fixture.system.smoke = async (options) => calls.push(options);

  await runRemoteDeployment(
    environment({ MARKIRO_LANDING_DEMO_SUBMISSION_STATE: "enabled" }),
    fixture.system,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].landingDemoSubmissionState, "enabled");
});

for (const failingCleanupCalls of [[1], [1, 2]]) {
  test(`cleanup attempts both directories and preserves a transfer failure when removals ${failingCleanupCalls.join(
    " and ",
  )} fail`, async () => {
    const fixture = systemFixture();
    const transferCause = new Error("private-transfer-value");
    fixture.system.streamArchive = async () => {
      throw transferCause;
    };
    const cleanupCalls = [];
    fixture.system.rm = async (path) => {
      cleanupCalls.push(path);
      if (failingCleanupCalls.includes(cleanupCalls.length))
        throw new Error(`private-cleanup-value-${cleanupCalls.length}`);
    };

    await assert.rejects(runRemoteDeployment(environment(), fixture.system), (error) => {
      assert.ok(error instanceof DeploymentStageError);
      assert.equal(error.stage, "transfer");
      assert.equal(error.message, "remote deployment failed");
      assert.equal(error.cause, transferCause);
      return true;
    });
    assert.deepEqual(cleanupCalls, ["/tmp/ssh", "/tmp/manifest"]);
  });
}

test("cleanup attempts the second directory when the first removal throws synchronously", async () => {
  const fixture = systemFixture();
  fixture.system.streamArchive = async () => {
    throw new Error("private-transfer-value");
  };
  const cleanupCalls = [];
  fixture.system.rm = (path) => {
    cleanupCalls.push(path);
    if (cleanupCalls.length === 1) throw new Error("private-synchronous-cleanup-value");
    return Promise.resolve();
  };

  await assert.rejects(runRemoteDeployment(environment(), fixture.system), (error) => {
    assert.ok(error instanceof DeploymentStageError);
    assert.equal(error.stage, "transfer");
    return true;
  });
  assert.deepEqual(cleanupCalls, ["/tmp/ssh", "/tmp/manifest"]);
});

test("cleanup-only failure emits one bounded configuration diagnostic after both attempts", async () => {
  const fixture = systemFixture();
  const cleanupCalls = [];
  fixture.system.rm = async (path) => {
    cleanupCalls.push(path);
    throw new Error(`private-cleanup-value-${cleanupCalls.length}`);
  };
  let stderr = "";

  const exitCode = await runRemoteDeployCli({
    argv: ["run"],
    stderr: { write: (value) => (stderr += value) },
    runDeployment: () => runRemoteDeployment(environment(), fixture.system),
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr, "MARKIRO_DEPLOY_FAILURE configuration\n");
  assert.equal(stderr.includes("private-cleanup-value"), false);
  assert.deepEqual(cleanupCalls, ["/tmp/ssh", "/tmp/manifest"]);
});

for (const [name, overrides] of [
  ["Yandex IAM", { YC_IAM_TOKEN: "must-not-be-required", GHCR_TOKEN: "" }],
  ["dedicated login", { YC_APP_DEPLOY_LOGIN: "root" }],
  ["public address", { YC_APP_PUBLIC_ADDRESS: "not-an-ip" }],
  ["pinned host keys", { APP_SSH_HOST_KEYS_B64: "invalid" }],
  ["ACME email", { ACME_EMAIL: "ops@example.test;touch /tmp/injected" }],
]) {
  test(`direct adapter rejects invalid ${name} configuration before transfer`, async () => {
    const fixture = systemFixture();
    await assert.rejects(runRemoteDeployment(environment(overrides), fixture.system), (error) => {
      assert.ok(error instanceof DeploymentStageError);
      assert.equal(error.stage, "configuration");
      assert.equal(error.message, "remote deployment failed");
      return true;
    });
    assert.equal(fixture.events.includes("transfer"), false);
  });
}
