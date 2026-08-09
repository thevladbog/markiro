import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { deployRelease, runRemoteDeployment, streamArchive } from "../remote-deploy.mjs";

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
  const transfer = streamArchive(["-cf", "-"], ["host", "tar"], {
    spawn: () => children.shift(),
    timeoutMs: 1_000,
    writeDiagnostic: () => undefined,
  });
  remote.exitCode = 255;
  remote.emit("close", 255);
  await assert.rejects(transfer, /private release transfer failed/);
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
  assert.deepEqual(events, ["transfer", "host-assets", "runtime", "prepare", "smoke", "finalize"]);
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
    /smoke failed/,
  );
  assert.deepEqual(events, ["transfer", "host-assets", "runtime", "smoke", "rollback"]);
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
    MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
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
  const prepare = fixture.commands.find(({ args }) => args.includes("prepare"));
  assert.match(prepare.input, /GHCR_USERNAME/);
  assert.match(prepare.input, /GHCR_TOKEN/);
  assert.ok(prepare.args.includes("MARKIRO_EDGE_MODE=direct"));
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
  const hostAssets = fixture.commands.find(({ args }) => args.includes("markiro-host-assets"));
  assert.ok(hostAssets);
  const reconcileScript = await readFile(
    path.resolve(import.meta.dirname, "../reconcile-host.sh"),
    "utf8",
  );
  assert.match(reconcileScript, /systemd-tmpfiles --create/);
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
  assert.equal(stages.length, 2);
  for (const { args } of stages) {
    assert.equal(
      args.some((argument) => argument.startsWith("--unit=")),
      false,
    );
    assert.ok(args.includes("--property=Requires=markiro-runtime-env.service"));
    assert.ok(args.includes("--property=After=markiro-runtime-env.service"));
  }
});

for (const [name, overrides] of [
  ["Yandex IAM", { YC_IAM_TOKEN: "must-not-be-required", GHCR_TOKEN: "" }],
  ["dedicated login", { YC_APP_DEPLOY_LOGIN: "root" }],
  ["public address", { YC_APP_PUBLIC_ADDRESS: "not-an-ip" }],
  ["pinned host keys", { APP_SSH_HOST_KEYS_B64: "invalid" }],
]) {
  test(`direct adapter rejects invalid ${name} configuration before transfer`, async () => {
    const fixture = systemFixture();
    await assert.rejects(runRemoteDeployment(environment(overrides), fixture.system));
    assert.equal(fixture.events.includes("transfer"), false);
  });
}
