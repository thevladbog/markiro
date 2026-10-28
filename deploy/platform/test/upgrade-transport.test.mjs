import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  upgradeSshArguments,
  upgradeOutcome,
  receiveUpgradeBundle,
  validateBundle,
} from "../upgrade-transport.mjs";
import { upgradeCommandFixture } from "./upgrade-command-fixture.mjs";
const id = "11111111-1111-4111-8111-111111111111",
  sha = "a".repeat(40),
  dispatch = { toolingSha: sha, runId: "12", runAttempt: "1" };
const target = {
  host: "example.com",
  port: "22",
  user: "root",
  identityFile: "/tmp/private/key",
  knownHostsFile: "/tmp/private/hosts",
};
for (const phase of [
  "prepare",
  "activate",
  "return-old",
  "post-migration-prepare",
  "post-migration-activate",
])
  test(`upgrade ${phase} uses only fixed receiver and exact outcome`, () => {
    const args = upgradeSshArguments(target, "execute", id, phase, sha, dispatch);
    assert.ok(
      args
        .at(-1)
        .endsWith(
          `/upgrade-bootstrap/${sha}/deploy/platform/upgrade-transport.mjs execute ${id} ${phase} ${sha} ${sha} 12 1`,
        ),
    );
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    const status = {
      prepare: "backup-verified",
      activate: "healthy",
      "return-old": "returned-old",
      "post-migration-prepare": "backup-verified",
      "post-migration-activate": "healthy",
    }[phase];
    const result = {
      exitCode: 0,
      stdout: Buffer.from(`Platform upgrade ${phase} ${status}.\n`),
      stderr: Buffer.alloc(0),
    };
    assert.equal(upgradeOutcome(result, phase), status);
    for (const patch of [
      { exitCode: 1 },
      { exitCode: undefined },
      { stderr: Buffer.from("warning") },
      { stdout: Buffer.from("healthy\n") },
    ])
      assert.throws(() => upgradeOutcome({ ...result, ...patch }, phase));
  });
test("fixed SSH denies injection, stale attempt, wrong tooling or historical recovery phase", () => {
  for (const phase of ["resume", "prepare;id", ""])
    assert.throws(() => upgradeSshArguments(target, "execute", id, phase, sha, dispatch));
  for (const patch of [{ host: "example.com;id" }, { identityFile: "/tmp/a b" }, { port: "0" }])
    assert.throws(() =>
      upgradeSshArguments({ ...target, ...patch }, "execute", id, "prepare", sha, dispatch),
    );
  for (const patch of [{ runAttempt: "2" }, { toolingSha: "b".repeat(40) }])
    assert.throws(() =>
      upgradeSshArguments(target, "execute", id, "prepare", sha, { ...dispatch, ...patch }),
    );
});
async function bundle(f) {
  const original = f.input.identity.admission;
  const files = {};
  for (const p of Object.keys(f.receipt.files))
    files[p] = (await readFile(join(f.installed, p))).toString("base64");
  return {
    version: 1,
    kind: "platform-upgrade-source-transfer",
    selection: {
      executorSha: f.input.identity.executorSha,
      executorCiRunId: f.input.executorCi.runId,
      executorCiRunAttempt: f.input.executorCi.runAttempt,
      operationId: f.input.identity.operationId,
      sourceSha: original.manifest.sourceSha,
      workflowRunId: original.publisher.runId,
      workflowRunAttempt: original.publisher.runAttempt,
      artifactId: original.artifact.id,
    },
    files,
  };
}
test("receiver verifies whole installed closure and creates delivery once without replacing sources", async (t) => {
  const f = await upgradeCommandFixture(t),
    b = await bundle(f);
  const bytes = Buffer.from(
    JSON.stringify({ bundle: b, phase: "prepare", dispatch: f.input.dispatch }),
  );
  assert.equal(
    await receiveUpgradeBundle(
      f.input.identity.operationId,
      "prepare",
      f.input.identity.executorSha,
      f.input.dispatch,
      bytes,
      f.options,
    ),
    "Platform upgrade executor bundle received.\n",
  );
  await assert.rejects(
    receiveUpgradeBundle(
      f.input.identity.operationId,
      "prepare",
      f.input.identity.executorSha,
      f.input.dispatch,
      bytes,
      f.options,
    ),
  );
  assert.ok(await readFile(join(f.directory, "delivery.json")));
  for (const patch of [
    (b) => {
      delete b.files[Object.keys(b.files)[0]];
    },
    (b) => {
      b.files[Object.keys(b.files)[0]] = "YQ==";
    },
    (b) => {
      b.selection.executorCiRunId = "999";
    },
    (b) => {
      b.selection.operationId = id;
    },
  ]) {
    const changed = structuredClone(b);
    patch(changed);
    assert.throws(() => validateBundle(changed, f.receipt));
  }
});
function approvedRequest(f, patch = {}) {
  const actor = { id: 11, login: "publisher", type: "User" };
  const run = {
    id: Number(f.input.dispatch.runId),
    run_attempt: 1,
    head_sha: f.input.identity.executorSha,
    head_branch: "main",
    event: "workflow_dispatch",
    path: ".github/workflows/upgrade-platform.yml",
    repository: { full_name: "thevladbog/markiro" },
    head_repository: { full_name: "thevladbog/markiro" },
    status: "in_progress",
    conclusion: null,
    actor,
    triggering_actor: actor,
    ...patch,
  };
  return async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith("/approvals")
        ? [
            {
              state: "approved",
              user: { id: 12, login: "reviewer", type: "User" },
              environments: [{ id: 44, name: "production-deploy" }],
            },
          ]
        : run,
  });
}
for (const executionPhase of ["prepare", "post-migration-prepare"])
  for (const scenario of ["success", "unconfirmed", "wrong approval", "missing delivery"])
    test(`host execution ${executionPhase} ${scenario} cannot replay or expose token in argv`, async (t) => {
      const { executeUpgradeHost } = await import("../upgrade-transport.mjs");
      const f =
          executionPhase === "prepare"
            ? await upgradeCommandFixture(t)
            : await forwardCommandFixture(t),
        b = await bundle(f);
      if (executionPhase !== "prepare") await unlink(join(f.directory, "github-token"));
      if (scenario !== "missing delivery")
        await receiveUpgradeBundle(
          f.input.identity.operationId,
          executionPhase,
          f.input.identity.executorSha,
          f.input.dispatch,
          Buffer.from(
            JSON.stringify({ bundle: b, phase: executionPhase, dispatch: f.input.dispatch }),
          ),
          f.options,
        );
      let runs = 0;
      const options = {
        ...f.options,
        request: approvedRequest(
          f,
          scenario === "wrong approval"
            ? { triggering_actor: { id: 12, login: "reviewer", type: "User" } }
            : {},
        ),
        runProcess: async (request) => {
          runs++;
          assert.equal(request.executable, "/usr/bin/node");
          assert.equal(
            request.timeoutMs,
            executionPhase === "post-migration-prepare" ? 6840000 : 2940000,
          );
          assert.ok(!JSON.stringify(request).includes("test-secret-token"));
          assert.equal(request.env.HOME, "/nonexistent");
          if (scenario === "unconfirmed")
            throw Object.assign(new Error("unknown exit"), { terminationConfirmed: false });
          return {
            stdout: Buffer.from(`Platform upgrade ${executionPhase} backup-verified.\n`),
            stderr: Buffer.alloc(0),
            exitCode: 0,
          };
        },
      };
      const execute = () =>
        executeUpgradeHost(
          f.input.identity.operationId,
          executionPhase,
          f.input.identity.executorSha,
          f.input.dispatch,
          Buffer.from("test-secret-token"),
          options,
        );
      if (scenario === "success") await execute();
      else await assert.rejects(execute());
      if (scenario === "wrong approval" || scenario === "missing delivery") {
        assert.equal(runs, 0);
        await assert.rejects(readFile(join(f.directory, "execution-fence.json")));
      } else {
        assert.equal(runs, 1);
        assert.ok(await readFile(join(f.directory, "execution-fence.json")));
        await assert.rejects(execute());
        assert.equal(runs, 1);
      }
    });
test("Git source builder selects exact commit blobs and complete upgrade closure", async (t) => {
  const { buildSourceBundle } = await import("../upgrade-transport.mjs");
  const { mkdtemp, chmod, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const f = await upgradeCommandFixture(t),
    b = await bundle(f),
    commands = [];
  const work = await realpath(await mkdtemp(join(tmpdir(), "upgrade-source-test-")));
  await chmod(work, 0o700);
  t.after(() => rm(work, { recursive: true }));
  const built = await buildSourceBundle(b.selection, "/fixed/repository", work, f.input.dispatch, {
    runProcess: async (request) => {
      commands.push(request);
      assert.equal(request.executable, "/usr/bin/git");
      assert.deepEqual(request.args.slice(0, 3), ["-C", "/fixed/repository", "show"]);
      assert.ok(request.args[3].startsWith(f.input.identity.executorSha + ":"));
      return { stdout: Buffer.from(b.files[request.args[3].slice(41)], "base64") };
    },
  });
  assert.deepEqual(built.bundle, b);
  assert.equal(commands.length, Object.keys(b.files).length);
  assert.ok(Buffer.byteLength(JSON.stringify(built.bundle)) < 1048576);
});

import { forwardCommandFixture } from "./forward-command-fixture.mjs";
import { unlink } from "node:fs/promises";
test("forward receive consumes the same create-only delivery marker without token, extraction or application action", async (t) => {
  const f = await forwardCommandFixture(t);
  await unlink(join(f.directory, "github-token"));
  const bytes = Buffer.from(
    JSON.stringify({ bundle: await bundle(f), phase: f.record.phase, dispatch: f.input.dispatch }),
  );
  const args = [
    f.input.identity.operationId,
    f.record.phase,
    f.input.identity.executorSha,
    f.input.dispatch,
    bytes,
    f.options,
  ];
  assert.equal(await receiveUpgradeBundle(...args), "Platform upgrade executor bundle received.\n");
  await assert.rejects(receiveUpgradeBundle(...args));
  assert.deepEqual(f.commands, []);
  const marker = JSON.parse(await readFile(join(f.directory, "delivery.json")));
  assert.equal(marker.phase, "post-migration-prepare");
  assert.deepEqual(marker.dispatch, f.input.dispatch);
});
test("forward phases remain in the existing protected workflow with no rerun or concurrent cancellation", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/upgrade-platform.yml", import.meta.url),
    "utf8",
  );
  for (const phase of ["post-migration-prepare", "post-migration-activate"])
    assert.ok(workflow.includes(phase));
  assert.match(workflow, /environment: production-deploy/u);
  assert.match(workflow, /group: timeweb-platform-production/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /github.run_attempt == 1/u);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /upgrade-transport.mjs run/u);
});

for (const kind of ["node", "ssh"])
  test(`protected forward ${kind} coordinator accepts its resource budget beyond one hour`, async (t) => {
    const { privateFixture } = await import("./host-fixtures.mjs");
    const { runHostProcess } = await import("../host/process.mjs");
    const transport = await import("../upgrade-transport.mjs");
    const run = transport.upgradeTransportProcess ?? runHostProcess;
    const f = await privateFixture(t);
    const controller = new AbortController();
    controller.abort();
    const phase = "post-migration-activate";
    const request = {
      executable: kind === "node" ? "/usr/bin/node" : "/usr/bin/ssh",
      args:
        kind === "node"
          ? [
              `/opt/markiro-platform/upgrade-bootstrap/${sha}/deploy/platform/upgrade-transport.mjs`,
              "host-command",
              id,
              phase,
              sha,
              sha,
              "12",
              "1",
            ]
          : upgradeSshArguments(target, "execute", id, phase, sha, dispatch),
      cwd: f.root,
      env: {},
      timeoutMs: 6840000,
      outputLimitBytes: 1024,
      signal: controller.signal,
    };
    // Already-aborted valid input proves validation accepted the coordinator
    // budget without spawning a process or waiting for the long timeout.
    await assert.rejects(
      run(request),
      (error) =>
        error.code === "ERR_HOST_PROCESS" &&
        error.reason === "aborted" &&
        error.terminationConfirmed === true,
    );
    await assert.rejects(
      runHostProcess(request),
      (error) => error.code === "ERR_HOST_PROCESS" && error.reason === "spawn",
    );
  });

test("larger coordinator budget rejects alternate commands, SSH options and wider I/O", async (t) => {
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { upgradeTransportProcess } = await import("../upgrade-transport.mjs");
  const f = await privateFixture(t),
    controller = new AbortController();
  controller.abort();
  const node = {
    executable: "/usr/bin/node",
    args: [
      `/opt/markiro-platform/upgrade-bootstrap/${sha}/deploy/platform/upgrade-transport.mjs`,
      "host-command",
      id,
      "post-migration-activate",
      sha,
      sha,
      "12",
      "1",
    ],
    cwd: f.root,
    env: {},
    timeoutMs: 6840000,
    outputLimitBytes: 1024,
    signal: controller.signal,
  };
  const ssh = {
    ...node,
    executable: "/usr/bin/ssh",
    args: upgradeSshArguments(target, "execute", id, "post-migration-activate", sha, dispatch),
  };
  const cases = [
    { ...node, executable: "/usr/bin/docker" },
    { ...node, args: [...node.args, "--extra"] },
    { ...node, args: ["-e", "process.exit(0)"] },
    { ...node, args: node.args.map((v, i) => (i === 3 ? "activate" : v)) },
    { ...node, args: node.args.map((v, i) => (i === 5 ? "b".repeat(40) : v)) },
    { ...node, args: node.args.map((v, i) => (i === 7 ? "2" : v)) },
    { ...node, timeoutMs: 7200001 },
    { ...node, outputLimitBytes: 1048577 },
    { ...node, input: Buffer.alloc(1048577) },
    { ...ssh, args: ["-o", "ProxyCommand=unsafe", ...ssh.args] },
    { ...ssh, args: ssh.args.map((v) => (v === "/dev/null" ? "/tmp/custom-ssh-config" : v)) },
    {
      ...ssh,
      args: ssh.args.map((v) =>
        v === "StrictHostKeyChecking=yes" ? "StrictHostKeyChecking=no" : v,
      ),
    },
    {
      ...ssh,
      args: ssh.args.map((v, i) =>
        i === ssh.args.length - 1 ? v.replace(" execute ", " receive ") : v,
      ),
    },
  ];
  for (const request of cases)
    await assert.rejects(upgradeTransportProcess(request), (error) => error.reason !== "aborted");
});
