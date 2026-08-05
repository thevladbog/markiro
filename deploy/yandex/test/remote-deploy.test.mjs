import assert from "node:assert/strict";
import test from "node:test";

import { deployRelease, runRemoteDeployment } from "../remote-deploy.mjs";

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

function orchestrationFixture({ failAt } = {}) {
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
      prepare: () => phase("remote prepare", CANDIDATE),
      verifyAlb: () => phase("ALB healthy"),
      smoke: () => phase("external smoke"),
      finalize: () => phase("remote finalize", { ...CANDIDATE, state: "healthy" }),
      rollback: () => phase("remote rollback", { ...CANDIDATE, state: "failed" }),
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

function response(body, ok = true) {
  return {
    ok,
    async json() {
      return body;
    },
  };
}

function cliFixture({ smokeFails = false } = {}) {
  const events = [];
  const commands = [];
  const environment = {
    RELEASE_MANIFEST_PATH: "/runner/release-manifest.json",
    EXPECTED_RELEASE_RUN_ID: RUN_ID,
    EXPECTED_RELEASE_SHA: COMMIT,
    YC_APP_INSTANCE_ID: "fv4app123",
    YC_OS_LOGIN: "deployer",
    YC_ORGANIZATION_ID: "bpforganization",
    YC_LOAD_BALANCER_ID: "ds7loadbalancer",
    YC_BACKEND_GROUP_ID: "ds7backend",
    YC_TARGET_GROUP_ID: "ds7target",
    MARKIRO_DOMAIN: "markiro.example",
    APP_SSH_HOST_KEYS_B64: Buffer.from(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixedAuthenticatedKey",
    ).toString("base64"),
  };
  const system = {
    async readFile() {
      return MANIFEST;
    },
    async metadataIamToken() {
      return "runner-iam-token";
    },
    async fetch(url) {
      if (String(url).includes("/targetStates/")) {
        events.push("ALB healthy");
        return response({ targetStates: [{ status: { zoneStatuses: [{ status: "HEALTHY" }] } }] });
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
      assert.equal(value, "10.20.0.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixedAuthenticatedKey\n");
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
        return `${JSON.stringify(CANDIDATE)}\n`;
      }
      if (args.includes("finalize")) {
        events.push("remote finalize");
        assert.deepEqual(JSON.parse(options.input), CANDIDATE);
        return `${JSON.stringify({ ...CANDIDATE, state: "healthy" })}\n`;
      }
      if (args.includes("rollback")) {
        events.push("remote rollback");
        assert.deepEqual(JSON.parse(options.input), CANDIDATE);
        return `${JSON.stringify({ ...CANDIDATE, state: "failed" })}\n`;
      }
      return "";
    },
    async smoke() {
      events.push("external smoke");
      if (smokeFails) throw new Error("external smoke failed");
    },
  };
  return { commands, environment, events, system };
}

test("real CLI adapter stages remote prepare, ALB, runner smoke, and remote finalize", async () => {
  const { environment, events, system } = cliFixture();

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
});

test("real CLI adapter rolls back remotely when runner external smoke fails", async () => {
  const { environment, events, system } = cliFixture({ smokeFails: true });

  await assert.rejects(runRemoteDeployment(environment, system), /external smoke failed/);

  assert.ok(events.indexOf("remote rollback") > events.indexOf("external smoke"));
  assert.equal(events.includes("remote finalize"), false);
});
