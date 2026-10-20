import test from "node:test";
import assert from "node:assert/strict";
import { recoverySshArguments, recoveryOutcome } from "../recovery-transport.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(40);
const target = {
  host: "example.com",
  port: "22",
  user: "root",
  identityFile: "/tmp/private/key",
  knownHostsFile: "/tmp/private/hosts",
};
test("fixed receiver binds executor, operation, phase and current dispatch", () => {
  const args = recoverySshArguments(target, "execute", id, "prepare", sha, {
    toolingSha: "b".repeat(40),
    runId: "12",
    runAttempt: "1",
  });
  assert.match(
    args.at(-1),
    new RegExp(
      `/recovery-bootstrap/${sha}/deploy/platform/recovery-transport.mjs execute ${id} prepare ${sha} ${"b".repeat(40)} 12 1$`,
    ),
  );
  assert.throws(() => recoverySshArguments(target, "execute", id, "prepare;id", sha, {}));
  assert.throws(() =>
    recoverySshArguments({ ...target, host: "example.com;id" }, "execute", id, "prepare", sha, {}),
  );
});
test("phase protocol requires exact stdout, empty stderr, confirmed zero", () => {
  const result = {
    stdout: Buffer.from("Platform recovery preparation backup-verified.\n"),
    stderr: Buffer.alloc(0),
    exitCode: 0,
  };
  assert.equal(recoveryOutcome(result, "prepare"), "backup-verified");
  for (const bad of [
    { ...result, exitCode: 1 },
    { ...result, exitCode: undefined },
    { ...result, stderr: Buffer.from("warning") },
    { ...result, stdout: Buffer.from("Platform host deployment healthy.\n") },
  ])
    assert.throws(() => recoveryOutcome(bad, "prepare"));
  assert.throws(() => recoveryOutcome(result, "activate"));
});

test("current dispatch is verified independently of pinned executor CI", async () => {
  const { verifyRecoveryDispatch } = await import("../recovery-transport.mjs");
  const dispatch = { toolingSha: "b".repeat(40), runId: "12", runAttempt: "1" };
  const valid = {
    id: 12,
    run_attempt: 1,
    head_sha: dispatch.toolingSha,
    head_branch: "main",
    event: "workflow_dispatch",
    path: ".github/workflows/recover-platform.yml",
    repository: { full_name: "thevladbog/markiro" },
    head_repository: { full_name: "thevladbog/markiro" },
    status: "in_progress",
  };
  const { REPOSITORY } = await import("../admission-github.mjs");
  valid.repository.full_name = REPOSITORY;
  valid.head_repository.full_name = REPOSITORY;
  let calls = 0;
  await verifyRecoveryDispatch(dispatch, "private-token", async (url, options) => {
    calls++;
    assert.ok(url.startsWith(`https://api.github.com/repos/${REPOSITORY}/actions/runs/12`));
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => valid };
  });
  assert.equal(calls, 2);
  for (const patch of [
    { head_sha: sha },
    { run_attempt: 2 },
    { event: "push" },
    { head_branch: "feature" },
    { path: ".github/workflows/deploy-platform.yml" },
    { status: "completed" },
  ])
    await assert.rejects(
      verifyRecoveryDispatch(dispatch, "private-token", async () => ({
        ok: true,
        json: async () => ({ ...valid, ...patch }),
      })),
    );
});
test("separate protected workflow preserves approval, concurrency and pinned identity", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(
    new URL("../../../.github/workflows/recover-platform.yml", import.meta.url),
    "utf8",
  );
  assert.match(yaml, /environment: production-deploy/u);
  assert.match(yaml, /group: timeweb-platform-production/u);
  assert.match(yaml, /cancel-in-progress: false/u);
  assert.match(yaml, /github.ref == 'refs\/heads\/main'/u);
  assert.match(yaml, /EXECUTOR_SHA: \$\{\{ inputs.executor_sha \}\}/u);
  assert.match(yaml, /DISPATCH_SHA: \$\{\{ github.sha \}\}/u);
  assert.match(yaml, /options: \[prepare, activate\]/u);
  assert.match(yaml, /env -i/u);
  assert.match(yaml, /recovery-transport.mjs run/u);
});

for (const outcome of ["success", "failure", "unknown"]) {
  test(`actual receiver permanently fences ${outcome} execution and token removal cannot replay`, async (t) => {
    const { recoveryDeliveryFixture } = await import("./recovery-delivery-fixture.mjs");
    const { receiveRecoveryBundle, executeRecoveryHost } =
      await import("../recovery-transport.mjs");
    const { readFile, unlink, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { REPOSITORY } = await import("../admission-github.mjs");
    const f = await recoveryDeliveryFixture(t);
    const dispatch = f.record.dispatch;
    const a = f.record.operation.admission.identity.admission;
    const selection = {
      executorSha: f.identity.executorSha,
      executorCiRunId: f.receipt.ci.runId,
      executorCiRunAttempt: f.receipt.ci.runAttempt,
      sourceSha: a.manifest.sourceSha,
      workflowRunId: a.publisher.runId,
      workflowRunAttempt: a.publisher.runAttempt,
      artifactId: a.artifact.id,
      operationId: f.identity.operationId,
    };
    const files = {};
    for (const path of Object.keys(f.receipt.files))
      files[path] = (await readFile(join(f.installed, path))).toString("base64");
    const input = Buffer.from(
      JSON.stringify({
        bundle: { version: 1, kind: "platform-source-transfer", selection, files },
        phase: "prepare",
        dispatch,
      }),
    );
    let calls = 0;
    const options = {
      ...f.options,
      request: async () => ({
        ok: true,
        json: async () => ({
          id: Number(dispatch.runId),
          run_attempt: Number(dispatch.runAttempt),
          head_sha: dispatch.toolingSha,
          head_branch: "main",
          event: "workflow_dispatch",
          path: ".github/workflows/recover-platform.yml",
          repository: { full_name: REPOSITORY },
          head_repository: { full_name: REPOSITORY },
          status: "in_progress",
        }),
      }),
      runProcess: async (request) => {
        calls++;
        assert.equal(request.executable, "/usr/bin/node");
        assert.deepEqual(request.env, { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" });
        assert.ok(!request.args.includes("private-token"));
        if (outcome !== "success") {
          const error = new Error("private detail");
          if (outcome === "unknown") error.terminationConfirmed = false;
          throw error;
        }
        return {
          stdout: Buffer.from("Platform recovery preparation backup-verified.\n"),
          stderr: Buffer.alloc(0),
        };
      },
    };
    assert.equal(
      await receiveRecoveryBundle(
        f.identity.operationId,
        "prepare",
        f.identity.executorSha,
        dispatch,
        input,
        options,
      ),
      "Platform executor bundle received.\n",
    );
    await assert.rejects(
      receiveRecoveryBundle(
        f.identity.operationId,
        "prepare",
        f.identity.executorSha,
        { ...dispatch, runId: "999" },
        input,
        options,
      ),
    );
    if (outcome === "success") {
      const source = join(f.installed, "deploy/platform/host/recovery-command.mjs");
      const original = await readFile(source);
      await writeFile(source, "throw new Error('untrusted source evaluated')", { mode: 0o600 });
      await assert.rejects(
        executeRecoveryHost(
          f.identity.operationId,
          "prepare",
          f.identity.executorSha,
          dispatch,
          Buffer.from("private-token"),
          options,
        ),
      );
      assert.equal(calls, 0);
      await assert.rejects(readFile(join(f.directory, "execution-fence.json")), { code: "ENOENT" });
      await writeFile(source, original, { mode: 0o600 });
    }
    if (outcome === "success")
      assert.equal(
        await executeRecoveryHost(
          f.identity.operationId,
          "prepare",
          f.identity.executorSha,
          dispatch,
          Buffer.from("private-token"),
          options,
        ),
        "Platform recovery preparation backup-verified.\n",
      );
    else
      await assert.rejects(
        executeRecoveryHost(
          f.identity.operationId,
          "prepare",
          f.identity.executorSha,
          dispatch,
          Buffer.from("private-token"),
          options,
        ),
      );
    assert.equal(calls, 1);
    const fence = await readFile(join(f.directory, "execution-fence.json"));
    await unlink(join(f.directory, "github-token"));
    await assert.rejects(
      executeRecoveryHost(
        f.identity.operationId,
        "prepare",
        f.identity.executorSha,
        dispatch,
        Buffer.from("private-token"),
        options,
      ),
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readFile(join(f.directory, "execution-fence.json")), fence);
    await assert.rejects(
      receiveRecoveryBundle(
        f.identity.operationId,
        "prepare",
        f.identity.executorSha,
        dispatch,
        input,
        options,
      ),
    );
  });
}
test("recovery receiver's complete source closure imports in isolation", async (t) => {
  const { recoveryDeliveryFixture } = await import("./recovery-delivery-fixture.mjs");
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");
  const f = await recoveryDeliveryFixture(t);
  const copied = await import(
    pathToFileURL(join(f.installed, "deploy/platform/recovery-transport.mjs")).href
  );
  assert.equal(typeof copied.receiveRecoveryBundle, "function");
});
