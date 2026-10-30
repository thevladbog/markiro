import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import {
  CONFIGURATION_LOADER,
  configurationSshArguments,
  sourceClosure,
} from "../dadata-transport.mjs";
import { verifyConfigurationDispatch, assertNoCatalogPeers } from "../upgrade-dispatch.mjs";

const dispatch = { toolingSha: "a".repeat(40), runId: "123", runAttempt: "1" };
const operationId = "de7a478d-e712-45bb-b36f-40067a62ab1d";
const target = {
  host: "example.com",
  port: "22",
  user: "root",
  identityFile: "/tmp/test-key",
  knownHostsFile: "/tmp/test-hosts",
};
const entry = "deploy/platform/host/dadata-host.mjs";
const secret = "private-input-sentinel";
const hostSource = `import { value } from "./value.mjs"; export async function executeConfigurationOperation(input) { await input.verifySources(); if (input.token !== "${secret}" || value !== 7) throw Error("secret"); return {status:"healthy",operationId:input.operationId,apiId:"container"}; }`;
async function fixture(t, source = hostSource) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dadata-loader-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  for (const directory of ["deploy", "deploy/platform", "deploy/platform/host"])
    await mkdir(join(root, directory), { mode: 0o700 });
  await writeFile(join(root, entry), source, { mode: 0o600 });
  await writeFile(join(root, "deploy/platform/host/value.mjs"), "export const value = 7;", {
    mode: 0o600,
  });
  return root;
}
async function execute(root, sourceFiles, change = {}) {
  const payload = JSON.stringify({
    token: secret,
    actorLogin: "operator",
    sourceFiles,
    operationId,
    planSha256: "b".repeat(64),
    dispatch,
    executorCiRunId: "456",
    executorCiRunAttempt: "1",
    ...change,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        CONFIGURATION_LOADER.replace(
          "/opt/markiro-platform/configuration-executors",
          dirname(root),
        ),
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}

test("SSH executes a fixed source-verifying loader with no private input in argv", () => {
  const args = configurationSshArguments(target, operationId, "b".repeat(64), dispatch);
  assert.ok(args.includes("StrictHostKeyChecking=yes") && args.includes("IdentityAgent=none"));
  assert.match(args.at(-1), /\/usr\/bin\/node --input-type=module --eval '/u);
  assert.ok(!args.join(" ").includes(secret));
  for (const bad of ["../bad", "x; echo forbidden", "$(echo forbidden)"])
    assert.throws(() => configurationSshArguments(target, bad, "b".repeat(64), dispatch));
  assert.throws(() =>
    configurationSshArguments(
      { ...target, host: "evil;echo" },
      operationId,
      "b".repeat(64),
      dispatch,
    ),
  );
  assert.throws(() => configurationSshArguments(target, operationId, "bad", dispatch));
});

test("source closure hashes transitive relative modules and rejects outside/package/dynamic imports", async (t) => {
  const root = await fixture(t);
  const files = await sourceClosure(root);
  assert.deepEqual(
    files.map((file) => file.path),
    [entry, "deploy/platform/host/value.mjs"],
  );
  assert.equal(files[0].sha256, createHash("sha256").update(hostSource).digest("hex"));
  for (const source of [
    'import "package";',
    'import "../../../../outside.mjs";',
    "await import(process.env.MODULE);",
  ]) {
    await writeFile(join(root, entry), source);
    await assert.rejects(sourceClosure(root));
  }
});

test("loader verifies every installed byte before import and returns only safe success", async (t) => {
  const root = await fixture(t);
  const files = await sourceClosure(root);
  // Use a valid SHA directory, retaining the immutable installation layout.
  const installed = join(root, dispatch.toolingSha);
  await mkdir(installed, { mode: 0o700 });
  t.after(() => rm(installed, { recursive: true, force: true }));
  await mkdir(join(installed, "deploy"), { mode: 0o700 });
  await mkdir(join(installed, "deploy/platform"), { mode: 0o700 });
  await mkdir(join(installed, "deploy/platform/host"), { mode: 0o700 });
  for (const file of files)
    await writeFile(join(installed, file.path), await readFile(join(root, file.path)), {
      mode: 0o600,
    });
  const outcome = await execute(installed, files);
  assert.deepEqual(outcome, { code: 0, stdout: '{"configuration":"healthy"}\n', stderr: "" });
  await writeFile(
    join(installed, "deploy/platform/host/value.mjs"),
    'import { writeFileSync } from "node:fs"; writeFileSync(new URL("./executed", import.meta.url), "must never execute"); export const value = 7;',
  );
  const rejected = await execute(installed, files);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.stdout, "");
  await assert.rejects(readFile(join(installed, "deploy/platform/host/executed")));
  assert.ok(!rejected.stderr.includes(secret) && !rejected.stderr.includes("must never execute"));
});

test("loader rejects symlinks, hard links, public modes, missing and extra source entries", async (t) => {
  for (const mutation of ["symlink", "hardlink", "mode", "missing", "extra"]) {
    const root = await fixture(t);
    const files = await sourceClosure(root);
    const installed = join(root, dispatch.toolingSha);
    await mkdir(installed, { mode: 0o700 });
    for (const dir of ["deploy", "deploy/platform", "deploy/platform/host"])
      await mkdir(join(installed, dir), { mode: 0o700 });
    for (const file of files)
      await writeFile(join(installed, file.path), await readFile(join(root, file.path)), {
        mode: 0o600,
      });
    const path = join(installed, "deploy/platform/host/value.mjs");
    if (mutation === "symlink") {
      await rm(path);
      await symlink(join(root, "deploy/platform/host/value.mjs"), path);
    }
    if (mutation === "hardlink") {
      await rm(path);
      await link(join(root, "deploy/platform/host/value.mjs"), path);
    }
    if (mutation === "mode") await chmod(path, 0o644);
    if (mutation === "missing") files.pop();
    if (mutation === "extra")
      files.push({ path: "deploy/platform/host/unexpected.mjs", sha256: "c".repeat(64) });
    const rejected = await execute(installed, files);
    assert.equal(rejected.code, 1, mutation);
    assert.equal(rejected.stdout, "", mutation);
  }
});

test("loader bounds stdin without leaking output", async (t) => {
  const root = await fixture(t);
  const result = await execute(root, [], { token: "z".repeat(1048577) });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.length < 256);
});

test("configuration workflow pins main or the exact SHA tag, native protection and private NUL transport", async () => {
  const workflow = load(
    await readFile(
      new URL("../../../.github/workflows/configure-platform-dadata.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "executor_ci_run_attempt",
    "executor_ci_run_id",
    "operation_id",
    "plan_sha256",
  ]);
  const job = workflow.jobs.configure;
  assert.equal(
    job.if,
    "${{ github.event_name == 'workflow_dispatch' && (github.ref == 'refs/heads/main' || github.ref == format('refs/tags/configuration-dadata-{0}', github.sha)) && github.run_attempt == 1 }}",
  );
  assert.equal(job.environment, "production-deploy");
  assert.deepEqual(workflow.concurrency, {
    group: "timeweb-platform-production",
    "cancel-in-progress": false,
  });
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  assert.equal(job.steps[1].with["node-version"], 24);
  const step = job.steps.find((step) => step.env?.DISPATCH_SHA);
  assert.equal(step.env.EXECUTOR_SHA, "${{ github.sha }}");
  assert.match(step.run, /printf '%s\\0'/u);
  assert.match(step.run, /\/usr\/bin\/env -i/u);
});

test("configuration dispatch requires its protected workflow and independent reviewer", async () => {
  const actor = { type: "User", id: 1, login: "operator" },
    reviewer = { type: "User", id: 2, login: "reviewer" };
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: dispatch.toolingSha,
    head_branch: "main",
    event: "workflow_dispatch",
    path: ".github/workflows/configure-platform-dadata.yml",
    repository: { full_name: "thevladbog/markiro" },
    head_repository: { full_name: "thevladbog/markiro" },
    status: "in_progress",
    conclusion: null,
    actor,
    triggering_actor: actor,
  };
  // Repository identity is taken from the repository's existing protected-dispatch contract.
  const { REPOSITORY } = await import("../admission-github.mjs");
  run.repository.full_name = REPOSITORY;
  run.head_repository.full_name = REPOSITORY;
  let approval = {
    state: "approved",
    user: reviewer,
    environments: [{ name: "production-deploy", id: 3 }],
  };
  const request = async (url) => ({
    ok: true,
    json: async () => (url.endsWith("/approvals") ? [approval] : run),
  });
  assert.equal(
    (await verifyConfigurationDispatch(dispatch, secret, { actorLogin: "operator", request }))
      .reviewerLogin,
    "reviewer",
  );
  approval = { ...approval, user: actor };
  await assert.rejects(
    verifyConfigurationDispatch(dispatch, secret, { actorLogin: "operator", request }),
  );
  approval = { ...approval, user: reviewer };
  run.path = ".github/workflows/upgrade-platform.yml";
  await assert.rejects(
    verifyConfigurationDispatch(dispatch, secret, { actorLogin: "operator", request }),
  );
});

test("peer fencing rejects a competing configuration workflow", async () => {
  await assert.rejects(
    assertNoCatalogPeers(dispatch, secret, async () => ({
      ok: true,
      json: async () => ({
        total_count: 2,
        workflow_runs: [
          {
            id: 123,
            status: "in_progress",
            path: ".github/workflows/configure-platform-dadata.yml",
          },
          {
            id: 456,
            status: "in_progress",
            path: ".github/workflows/configure-platform-dadata.yml",
          },
        ],
      }),
    })),
  );
});

async function githubRequest({
  badCi = false,
  skippedCi = false,
  mismatchedCi = false,
  rerunCi = false,
  peer = false,
  tagged = false,
  movedTag = false,
  staleMain = false,
} = {}) {
  const { REPOSITORY } = await import("../admission-github.mjs");
  const { PLATFORM_CI_REQUIRED_JOBS } = await import("../release-evidence.mjs");
  const actor = { type: "User", id: 1, login: "operator" };
  const active = {
    id: 123,
    run_attempt: 1,
    head_sha: dispatch.toolingSha,
    head_branch: "main",
    event: "workflow_dispatch",
    path: ".github/workflows/configure-platform-dadata.yml",
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    status: "in_progress",
    conclusion: null,
    actor,
    triggering_actor: actor,
  };
  if (tagged) active.head_branch = `configuration-dadata-${dispatch.toolingSha}`;
  const ci = {
    id: 456,
    run_attempt: rerunCi ? 2 : 1,
    name: "CI",
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: mismatchedCi ? "b".repeat(40) : dispatch.toolingSha,
    status: "completed",
    conclusion: badCi ? "failure" : "success",
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
  };
  return async (url) => {
    let data;
    if (url.includes("?status=in_progress"))
      data = {
        total_count: peer ? 2 : 1,
        workflow_runs: peer ? [active, { ...active, id: 789 }] : [active],
      };
    else if (url.endsWith("/approvals"))
      data = [
        {
          state: "approved",
          user: { type: "User", id: 2, login: "reviewer" },
          environments: [{ name: "production-deploy", id: 3 }],
        },
      ];
    else if (url.endsWith("/git/ref/heads/main"))
      data = {
        ref: "refs/heads/main",
        object: { type: "commit", sha: tagged || staleMain ? "b".repeat(40) : dispatch.toolingSha },
      };
    else if (url.includes("/git/ref/heads/configuration-dadata-"))
      return new Response("{}", { status: 404 });
    else if (url.includes("/git/ref/tags/configuration-dadata-"))
      data = {
        ref: `refs/tags/configuration-dadata-${dispatch.toolingSha}`,
        object: { type: "commit", sha: movedTag ? "b".repeat(40) : dispatch.toolingSha },
      };
    else if (url.includes("/compare/"))
      data = {
        base_commit: { sha: dispatch.toolingSha },
        merge_base_commit: { sha: dispatch.toolingSha },
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        commits: [{ sha: "b".repeat(40) }],
      };
    else if (url.includes("/runs/123")) data = active;
    else if (url.includes("/runs/456") && url.includes("/jobs?"))
      data = {
        total_count: PLATFORM_CI_REQUIRED_JOBS.length,
        jobs: PLATFORM_CI_REQUIRED_JOBS.map((name, index) => ({
          id: index + 1,
          run_id: 456,
          run_attempt: ci.run_attempt,
          head_sha: ci.head_sha,
          name,
          status: "completed",
          conclusion: skippedCi && index === 0 ? "skipped" : "success",
        })),
      };
    else if (url.includes("/runs/456")) data = ci;
    else throw Error("unexpected request");
    return new Response(JSON.stringify(data), { status: 200 });
  };
}
const privateValues = [
  target.host,
  target.port,
  target.user,
  "private-key-sentinel",
  "known-hosts-sentinel",
  secret,
  "operator",
  dispatch.toolingSha,
  dispatch.runId,
  "1",
  dispatch.toolingSha,
  "456",
  "1",
  operationId,
  "b".repeat(64),
];

test("runner verifies CI and fencing before SSH, keeps secrets on private stdin and removes its temporary files", async (t) => {
  const { runConfigurationTransport } = await import("../dadata-transport.mjs");
  const root = await fixture(t);
  let working;
  const result = await runConfigurationTransport(privateValues, {
    checkoutRoot: root,
    request: await githubRequest(),
    runProcess: async (options) => {
      working = options.cwd;
      assert.equal(options.executable, "/usr/bin/ssh");
      assert.ok(
        !JSON.stringify(options.args).includes(secret) &&
          !JSON.stringify(options.env).includes(secret),
      );
      assert.equal(JSON.parse(options.input).token, secret);
      assert.equal(await readFile(join(options.cwd, "identity"), "utf8"), "private-key-sentinel\n");
      return { stdout: Buffer.from('{"configuration":"healthy"}\n'), stderr: Buffer.alloc(0) };
    },
  });
  assert.deepEqual(result, { configuration: "healthy" });
  await assert.rejects(readFile(join(working, "identity")));
  for (const guards of [{ badCi: true }, { peer: true }])
    await assert.rejects(
      runConfigurationTransport(privateValues, {
        checkoutRoot: root,
        request: await githubRequest(guards),
        runProcess: async () => assert.fail("must not SSH"),
      }),
    );
});

test("runner retains credentials only while SSH termination is unknown and redacts all child failures", async (t) => {
  const { runConfigurationTransport } = await import("../dadata-transport.mjs");
  const root = await fixture(t);
  for (const terminationConfirmed of [true, false]) {
    let working;
    await assert.rejects(
      runConfigurationTransport(privateValues, {
        checkoutRoot: root,
        request: await githubRequest(),
        runProcess: async (options) => {
          working = options.cwd;
          throw Object.assign(Error(secret), { terminationConfirmed });
        },
      }),
      (error) => !error.message.includes(secret),
    );
    if (terminationConfirmed) await assert.rejects(readFile(join(working, "identity")));
    else {
      assert.equal(await readFile(join(working, "identity"), "utf8"), "private-key-sentinel\n");
      await rm(working, { recursive: true, force: true });
    }
  }
});

test("import hook refuses an unlisted runtime import even when source bytes are approved", async (t) => {
  const root = await fixture(
    t,
    `export async function executeConfigurationOperation(input) { await import(input.actorLogin); return {status:"healthy",operationId:input.operationId,apiId:"container"}; }`,
  );
  const installed = join(root, dispatch.toolingSha);
  await mkdir(installed, { mode: 0o700 });
  for (const dir of ["deploy", "deploy/platform", "deploy/platform/host"])
    await mkdir(join(installed, dir), { mode: 0o700 });
  const bytes = await readFile(join(root, entry));
  await writeFile(join(installed, entry), bytes, { mode: 0o600 });
  const result = await execute(
    installed,
    [{ path: entry, sha256: createHash("sha256").update(bytes).digest("hex") }],
    { actorLogin: "unapproved" },
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
});

test("loader rejects returned-old and rechecks source changes before the host mutation callback", async (t) => {
  for (const [source, dependency] of [
    [
      'export async function executeConfigurationOperation(input) { return {status:"returned-old",operationId:input.operationId,apiId:"old"}; }',
      false,
    ],
    [
      'import { writeFileSync } from "node:fs"; import { value } from "./value.mjs"; export async function executeConfigurationOperation(input) { writeFileSync(new URL("./value.mjs", import.meta.url), "export const value = 9;"); await input.verifySources(); writeFileSync(new URL("./mutated", import.meta.url), String(value)); return {status:"healthy",operationId:input.operationId,apiId:"container"}; }',
      true,
    ],
  ]) {
    const root = await fixture(t, source);
    const files = await sourceClosure(root);
    const installed = join(root, dispatch.toolingSha);
    await mkdir(installed, { mode: 0o700 });
    for (const directory of ["deploy", "deploy/platform", "deploy/platform/host"])
      await mkdir(join(installed, directory), { mode: 0o700 });
    for (const file of files)
      await writeFile(join(installed, file.path), await readFile(join(root, file.path)), {
        mode: 0o600,
      });
    const result = await execute(installed, files);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    if (dependency) await assert.rejects(readFile(join(installed, "deploy/platform/host/mutated")));
  }
});

test("fixed remote shell command preserves the reviewed loader through shell quoting", async (t) => {
  const root = await fixture(t);
  const files = await sourceClosure(root);
  const installed = join(root, dispatch.toolingSha);
  await mkdir(installed, { mode: 0o700 });
  for (const directory of ["deploy", "deploy/platform", "deploy/platform/host"])
    await mkdir(join(installed, directory), { mode: 0o700 });
  for (const file of files)
    await writeFile(join(installed, file.path), await readFile(join(root, file.path)), {
      mode: 0o600,
    });
  const command = configurationSshArguments(target, operationId, "b".repeat(64), dispatch)
    .at(-1)
    .replace("/usr/bin/node", `'${process.execPath.replaceAll("'", "'\\''")}'`)
    .replace("/opt/markiro-platform/configuration-executors", root);
  const result = await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(
      JSON.stringify({
        token: secret,
        actorLogin: "operator",
        sourceFiles: files,
        operationId,
        planSha256: "b".repeat(64),
        dispatch,
        executorCiRunId: "456",
        executorCiRunAttempt: "1",
      }),
    );
  });
  assert.deepEqual(result, { code: 0, stdout: '{"configuration":"healthy"}\n', stderr: "" });
});

test("reviewed host source closure imports in isolation with no checkout dependencies", async (t) => {
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  const files = await sourceClosure(source);
  assert.ok(files.some((file) => file.path === entry));
  const root = await realpath(await mkdtemp(join(tmpdir(), "dadata-closure-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of files) {
    const targetPath = join(root, file.path);
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, await readFile(join(source, file.path)), { mode: 0o600 });
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const host = await import(${JSON.stringify(pathToFileURL(join(root, entry)).href)}); if (typeof host.executeConfigurationOperation !== "function") throw Error();`,
      ],
      {
        cwd: root,
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
});

test("runner admits only exact pinned configuration tag after main advances", async (t) => {
  const { runConfigurationTransport } = await import("../dadata-transport.mjs");
  const root = await fixture(t);
  assert.deepEqual(
    await runConfigurationTransport(privateValues, {
      checkoutRoot: root,
      request: await githubRequest({ tagged: true }),
      runProcess: async () => ({
        stdout: Buffer.from('{"configuration":"healthy"}\n'),
        stderr: Buffer.alloc(0),
      }),
    }),
    { configuration: "healthy" },
  );
  for (const guards of [
    { tagged: true, movedTag: true },
    { staleMain: true },
    { tagged: true, badCi: true },
    { tagged: true, skippedCi: true },
    { tagged: true, mismatchedCi: true },
    { tagged: true, rerunCi: true },
  ])
    await assert.rejects(
      runConfigurationTransport(privateValues, {
        checkoutRoot: root,
        request: await githubRequest(guards),
        runProcess: async () => assert.fail("source failure must not SSH"),
      }),
    );
});
