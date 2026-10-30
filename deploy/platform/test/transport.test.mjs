import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { privateFixture } from "./host-fixtures.mjs";
import { runHostProcess } from "../host/process.mjs";
import { PLATFORM_CI_REQUIRED_JOBS } from "../release-evidence.mjs";
import {
  sshArguments,
  validateTransportSelection,
  validateBundle,
  hostOutcome,
} from "../transport.mjs";

const selection = () => ({
  executorSha: "a".repeat(40),
  executorCiRunId: "12",
  executorCiRunAttempt: "2",
  sourceSha: "b".repeat(40),
  workflowRunId: "13",
  workflowRunAttempt: "1",
  artifactId: "14",
  operationId: "11111111-1111-4111-8111-111111111111",
});
const target = () => ({
  host: "platform.example.com",
  port: "2222",
  user: "markiro-platform",
  identityFile: "/private/key",
  knownHostsFile: "/private/hosts",
});
test("SSH has explicit pinned identity, no user config, proxy, agent or TOFU", () => {
  const args = sshArguments(target(), "receive", selection().operationId);
  for (const item of [
    "StrictHostKeyChecking=yes",
    "IdentitiesOnly=yes",
    "IdentityAgent=none",
    "ProxyCommand=none",
    "ProxyJump=none",
    "GlobalKnownHostsFile=/dev/null",
    "UserKnownHostsFile=/private/hosts",
    "BatchMode=yes",
    "ForwardAgent=no",
    "ClearAllForwardings=yes",
  ])
    assert.ok(args.includes(item), item);
  assert.ok(args.includes("-F") && args.includes("/dev/null"));
  assert.match(
    args.at(-1),
    /^exec \/usr\/bin\/env -i PATH=\/usr\/bin:\/bin HOME=\/nonexistent LANG=C \/usr\/bin\/node \/opt\/markiro-platform\/bootstrap\/deploy\/platform\/transport.mjs receive [a-f0-9-]+$/,
  );
});
for (const [key, value] of [
  ["host", "evil;id"],
  ["host", "-oProxyCommand=id"],
  ["host", "host\n"],
  ["user", "root$(id)"],
  ["port", "22 -oBad"],
  ["identityFile", "/key with space"],
  ["knownHostsFile", "/x/../hosts"],
])
  test(`reject SSH injection ${key} ${JSON.stringify(value)}`, () =>
    assert.throws(() =>
      sshArguments({ ...target(), [key]: value }, "receive", selection().operationId),
    ));
test("reject selection ambiguity, path injection and malformed host result", () => {
  validateTransportSelection(selection());
  for (const value of [
    { ...selection(), extra: true },
    { ...selection(), operationId: "../../state" },
    { ...selection(), executorCiRunAttempt: "0" },
  ])
    assert.throws(() => validateTransportSelection(value));
  assert.equal(
    hostOutcome({
      stdout: Buffer.from("Platform host deployment healthy.\n"),
      stderr: Buffer.alloc(0),
    }),
    "healthy",
  );
  for (const stdout of [
    "",
    "Platform host deployment healthy.\nextra",
    '{"terminationConfirmed":null}',
  ])
    assert.throws(() => hostOutcome({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) }));
});
test("bundle requires exact allowlist and independently trusted receipt hashes", () => {
  assert.throws(() => validateBundle({ files: { "../../bad": "YQ==" } }, { files: {} }));
});
for (const mode of ["read", "ignore", "early"])
  test(`bounded stdin real child ${mode}`, async (t) => {
    const f = await privateFixture(t);
    const input = Buffer.alloc(1024 * 1024, 42);
    const options = {
      executable: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/transport-input.mjs", import.meta.url)), mode],
      cwd: f.root,
      env: {},
      timeoutMs: mode === "read" ? 5000 : 100,
      outputLimitBytes: 1024,
      input,
    };
    if (mode === "read")
      assert.equal(
        (await runHostProcess(options)).stdout.toString(),
        createHash("sha256").update(input).digest("hex"),
      );
    else
      await assert.rejects(
        runHostProcess(options),
        (error) =>
          error.code === "ERR_HOST_PROCESS" &&
          error.terminationConfirmed === true &&
          !error.message.includes("*"),
      );
    await assert.rejects(runHostProcess({ ...options, input: Buffer.alloc(1024 * 1024 + 1) }));
    await assert.rejects(runHostProcess({ ...options, input: "SECRET" }));
  });

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { HOST_BUNDLE_FILES } from "../host/command.mjs";
import { receiveBundle, executeHost, runTransport } from "../transport.mjs";
import { operationFixture } from "./host-command-fixture.mjs";
const checkoutRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/u, "");
async function receiverFixture(t) {
  const f = await operationFixture(t);
  for (const dir of ["state", "operations", "bundles"])
    await mkdir(join(f.root, dir), { mode: 0o700 });
  const id = f.identity.operationId;
  const opDir = join(f.root, "operations", id);
  await mkdir(opDir, { mode: 0o700 });
  f.record.deployment.root = join(f.root, "state");
  f.record.installedRoot = join(f.root, "bundles", id);
  await writeFile(join(f.root, "state", "installed-executor.json"), JSON.stringify(f.receipt), {
    mode: 0o600,
  });
  await writeFile(join(opDir, "operation.json"), JSON.stringify(f.record), { mode: 0o600 });
  const a = f.identity.admission;
  const selected = {
    executorSha: f.identity.executorSha,
    executorCiRunId: f.receipt.ci.runId,
    executorCiRunAttempt: f.receipt.ci.runAttempt,
    sourceSha: a.manifest.sourceSha,
    workflowRunId: a.publisher.runId,
    workflowRunAttempt: a.publisher.runAttempt,
    artifactId: a.artifact.id,
    operationId: id,
  };
  const files = Object.fromEntries(
    await Promise.all(
      HOST_BUNDLE_FILES.map(async (p) => [
        p,
        (await readFile(join(f.installed, p))).toString("base64"),
      ]),
    ),
  );
  const bundle = { version: 1, kind: "platform-source-transfer", selection: selected, files };
  return {
    ...f,
    opDir,
    bundle,
    send: () => receiveBundle(id, Buffer.from(JSON.stringify(bundle)), { hostRoot: f.root }),
  };
}
test("private receiver installs exact source once, preserves trusted receipt and operation", async (t) => {
  const f = await receiverFixture(t);
  assert.equal(await f.send(), "Platform executor bundle received.\n");
  for (const p of HOST_BUNDLE_FILES)
    assert.deepEqual(
      await readFile(join(f.record.installedRoot, p)),
      Buffer.from(f.bundle.files[p], "base64"),
    );
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, "state", "installed-executor.json"))),
    f.receipt,
  );
  await assert.rejects(f.send());
  assert.equal(
    await executeHost(f.identity.operationId, Buffer.from("short-job-token"), {
      hostRoot: f.root,
      runProcess: async (options) => {
        assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" });
        assert.equal(options.executable, "/usr/bin/node");
        assert.deepEqual(options.args, [
          join(f.record.installedRoot, "deploy/platform/host/command.mjs"),
          f.opDir,
        ]);
        assert.equal((await readFile(join(f.opDir, "github-token"))).toString(), "short-job-token");
        return {
          stdout: Buffer.from("Platform host deployment healthy.\n"),
          stderr: Buffer.alloc(0),
        };
      },
    }),
    "Platform host deployment healthy.\n",
  );
  await assert.rejects(readFile(join(f.opDir, "github-token")), { code: "ENOENT" });
});
for (const change of [
  "extra",
  "missing",
  "hash",
  "base64",
  "selection",
  "receipt",
  "symlink",
  "active",
])
  test(`receiver rejects ${change} without installing source`, async (t) => {
    const f = await receiverFixture(t);
    const first = HOST_BUNDLE_FILES[0];
    if (change === "extra") f.bundle.files[".env"] = "c2VjcmV0";
    if (change === "missing") delete f.bundle.files[first];
    if (change === "hash") f.bundle.files[first] = Buffer.from("bad-source").toString("base64");
    if (change === "base64") f.bundle.files[first] += "\n";
    if (change === "selection") f.bundle.selection.artifactId = "999";
    if (change === "receipt") {
      f.receipt.executorSha = "f".repeat(40);
      await writeFile(join(f.root, "state", "installed-executor.json"), JSON.stringify(f.receipt));
    }
    if (change === "symlink") {
      await rm(join(f.opDir, "operation.json"));
      await symlink(join(f.root, "operation.json"), join(f.opDir, "operation.json"));
    }
    if (change === "active")
      await writeFile(join(f.root, "state", ".deploy.lock"), "owned-active", { mode: 0o600 });
    await assert.rejects(f.send());
    await assert.rejects(readFile(join(f.record.installedRoot, first)), { code: "ENOENT" });
  });
for (const result of ["nonzero", "lost", "malformed", "stderr", "termination-false", "null"])
  test(`host execution preserves token and forbids retry after ${result}`, async (t) => {
    const f = await receiverFixture(t);
    await f.send();
    let calls = 0;
    const runProcess = async () => {
      calls++;
      if (["nonzero", "lost", "termination-false"].includes(result)) {
        const e = new Error("untrusted detail");
        e.terminationConfirmed = result !== "termination-false";
        throw e;
      }
      return {
        stdout: Buffer.from(
          result === "stderr"
            ? "Platform host deployment healthy.\n"
            : result === "null"
              ? ""
              : "unexpected",
        ),
        stderr: Buffer.from(
          result === "null" ? JSON.stringify({ terminationConfirmed: null }) : "unexpected",
        ),
      };
    };
    await assert.rejects(
      executeHost(f.identity.operationId, Buffer.from("short-job-token"), {
        hostRoot: f.root,
        runProcess,
      }),
    );
    assert.equal((await readFile(join(f.opDir, "github-token"))).toString(), "short-job-token");
    await assert.rejects(
      executeHost(f.identity.operationId, Buffer.from("new-token"), {
        hostRoot: f.root,
        runProcess,
      }),
    );
    assert.equal(calls, 1);
  });
async function senderFixture(t, fault) {
  const f = await privateFixture(t),
    s = selection(),
    calls = [];
  const targetValue = {
    ...target(),
    identityFile: join(f.root, "key"),
    knownHostsFile: join(f.root, "hosts"),
  };
  await writeFile(targetValue.identityFile, "fake-private-key", { mode: 0o600 });
  await writeFile(
    targetValue.knownHostsFile,
    `[platform.example.com]:2222 ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString("base64")}\n`,
    { mode: 0o600 },
  );
  const immutable = Object.fromEntries(
    await Promise.all(
      HOST_BUNDLE_FILES.map(async (p) => [p, await readFile(join(checkoutRoot, p))]),
    ),
  );
  const request = async (url) => {
    const run = {
      id: 12,
      run_attempt: 2,
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      head_sha: s.executorSha,
      status: "completed",
      conclusion: fault === "ci" ? "failure" : "success",
      repository: { full_name: "thevladbog/markiro" },
      head_repository: { full_name: "thevladbog/markiro" },
    };
    const jobs = PLATFORM_CI_REQUIRED_JOBS.map((name, i) => ({
      id: i + 1,
      run_id: 12,
      run_attempt: 2,
      head_sha: s.executorSha,
      name,
      status: "completed",
      conclusion: "success",
    }));
    return new Response(
      JSON.stringify(url.includes("/jobs?") ? { total_count: jobs.length, jobs } : run),
    );
  };
  const runProcess = async (options) => {
    calls.push(options);
    if (options.executable === "/usr/bin/git") {
      const a = options.args.slice(2);
      const stdout =
        a[0] === "rev-parse"
          ? Buffer.from(s.executorSha + "\n")
          : a[0] === "status"
            ? Buffer.from(fault === "dirty" ? " M file" : "")
            : fault === "hash"
              ? Buffer.from("wrong hash")
              : immutable[a[1].slice(41)];
      return { stdout, stderr: Buffer.alloc(0) };
    }
    assert.equal(options.executable, "/usr/bin/ssh");
    const phase = options.args.at(-1).split(" ").at(-2);
    return runHostProcess({
      ...options,
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./fixtures/transport-ssh.mjs", import.meta.url)),
        fault ?? "success",
        phase,
      ],
      env: options.env,
    });
  };
  const admit = async (input, options) => {
    assert.equal(input.artifactId, s.artifactId);
    assert.equal(input.sourceSha, s.sourceSha);
    assert.equal(options.token, "job-token");
    if (fault === "admission") throw new Error("failed admission");
  };
  return {
    calls,
    config: {
      selection: s,
      target: targetValue,
      token: "job-token",
      githubActor: "operator-user",
      checkoutRoot,
      workDirectory: f.root,
    },
    options: { request, runProcess, admit },
  };
}
test("sender gates exact executor CI and source independently of product then uses bounded stdin twice", async (t) => {
  const f = await senderFixture(t);
  await runTransport(f.config, f.options);
  const calls = f.calls.filter((c) => c.executable === "/usr/bin/ssh");
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].input).selection.executorSha, f.config.selection.executorSha);
  assert.equal(calls[1].input.toString(), "job-token");
  for (const c of calls) {
    assert.ok(c.timeoutMs <= 3000000);
    assert.ok(!JSON.stringify(c.args).includes("job-token"));
    assert.ok(!JSON.stringify(c.env).includes("job-token"));
  }
});
for (const fault of [
  "ci",
  "dirty",
  "hash",
  "admission",
  "wrong-key",
  "transfer",
  "command",
  "lost",
])
  test(`sender stops after ${fault} and never retries or cleans host`, async (t) => {
    const f = await senderFixture(t, fault);
    await assert.rejects(
      runTransport(f.config, f.options),
      (error) =>
        error.code === "ERR_PLATFORM_TRANSPORT" &&
        error.recoveryRequired === true &&
        !error.message.includes("job-token"),
    );
    const ssh = f.calls.filter((c) => c.executable === "/usr/bin/ssh");
    assert.equal(
      ssh.length,
      ["ci", "dirty", "hash", "admission"].includes(fault)
        ? 0
        : ["wrong-key", "transfer"].includes(fault)
          ? 1
          : 2,
    );
  });

test("host checks independently pinned bytes before executing any transferred module", async (t) => {
  const f = await receiverFixture(t);
  await f.send();
  await writeFile(join(f.record.installedRoot, HOST_BUNDLE_FILES[0]), "malicious loader");
  let executed = false;
  await assert.rejects(
    executeHost(f.identity.operationId, Buffer.from("token"), {
      hostRoot: f.root,
      runProcess: async () => {
        executed = true;
        return {
          stdout: Buffer.from("Platform host deployment healthy.\n"),
          stderr: Buffer.alloc(0),
        };
      },
    }),
  );
  assert.equal(executed, false);
});

test("receiver rejects duplicate JSON file keys as ambiguous before installation", async (t) => {
  const f = await receiverFixture(t);
  const encoded = JSON.stringify(f.bundle);
  const key = JSON.stringify(HOST_BUNDLE_FILES[0]);
  const ambiguous = encoded.replace(`${key}:`, `${key}:"Yg==",${key}:`);
  await assert.rejects(
    receiveBundle(f.identity.operationId, Buffer.from(ambiguous), { hostRoot: f.root }),
  );
  await assert.rejects(readFile(join(f.record.installedRoot, HOST_BUNDLE_FILES[0])), {
    code: "ENOENT",
  });
});

for (const pin of [
  "",
  "other.example ssh-ed25519 YQ==\n",
  "*.example ssh-ed25519 YQ==\n",
  "@cert-authority platform.example.com ssh-ed25519 YQ==\n",
])
  test(`sender rejects absent or ambiguous host pin ${JSON.stringify(pin)}`, async (t) => {
    const f = await senderFixture(t);
    await writeFile(f.config.target.knownHostsFile, pin);
    await assert.rejects(runTransport(f.config, f.options));
    assert.equal(f.calls.length, 0);
  });

for (const actor of ["", "bad:actor", "evil\n", "../actor", "-actor"])
  test(`private registry actor rejects ${JSON.stringify(actor)} before commands`, async (t) => {
    const f = await senderFixture(t);
    f.config.githubActor = actor;
    await assert.rejects(runTransport(f.config, f.options));
    assert.equal(f.calls.length, 0);
  });
test("private registry auth is exclusive0600 and exposed only to exact manifest reads then removed", async (t) => {
  const f = await senderFixture(t);
  let configPath;
  f.config.githubActor = "operator-user";
  f.options.admit = async (_input, options) => {
    await options.run("docker", [
      "manifest",
      "inspect",
      "--verbose",
      `ghcr.io/thevladbog/markiro-api@sha256:${"1".repeat(64)}`,
    ]);
    await assert.rejects(options.run("docker", ["run", "unexpected"]));
  };
  const original = f.options.runProcess;
  f.options.runProcess = async (options) => {
    if (options.executable !== "/usr/bin/docker") {
      assert.equal(options.env.DOCKER_CONFIG, undefined);
      return original(options);
    }
    configPath = join(options.env.DOCKER_CONFIG, "config.json");
    const { lstat } = await import("node:fs/promises");
    assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
    const value = JSON.parse(await readFile(configPath));
    assert.deepEqual(value, {
      auths: { "ghcr.io": { auth: Buffer.from("operator-user:job-token").toString("base64") } },
    });
    assert.ok(!JSON.stringify(options.args).includes("job-token"));
    assert.ok(!JSON.stringify(options.env).includes("job-token"));
    return { stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
  };
  await runTransport(f.config, f.options);
  await assert.rejects(readFile(configPath), { code: "ENOENT" });
});

test("failed private manifest read removes only owned local auth and emits no credential", async (t) => {
  const f = await senderFixture(t);
  let configPath;
  f.options.admit = async (_input, options) =>
    options.run("docker", [
      "manifest",
      "inspect",
      "--verbose",
      `ghcr.io/thevladbog/markiro-api@sha256:${"1".repeat(64)}`,
    ]);
  const original = f.options.runProcess;
  f.options.runProcess = async (options) => {
    if (options.executable !== "/usr/bin/docker") return original(options);
    configPath = join(options.env.DOCKER_CONFIG, "config.json");
    assert.ok((await readFile(configPath)).length > 0);
    throw new Error("job-token private registry response");
  };
  await assert.rejects(
    runTransport(f.config, f.options),
    (error) => !error.message.includes("job-token") && error.code === "ERR_PLATFORM_TRANSPORT",
  );
  await assert.rejects(readFile(configPath), { code: "ENOENT" });
  assert.equal(f.calls.filter((c) => c.executable === "/usr/bin/ssh").length, 0);
  await mkdir(join(f.config.workDirectory, "docker-auth"), { mode: 0o700 });
  await writeFile(join(f.config.workDirectory, "docker-auth", "existing"), "preserve", {
    mode: 0o600,
  });
  await assert.rejects(runTransport(f.config, f.options));
  assert.equal(
    await readFile(join(f.config.workDirectory, "docker-auth", "existing"), "utf8"),
    "preserve",
  );
});

test("DNS-host pin never adds a resolved-IP pin or weakens strict host verification", () => {
  for (const phase of ["receive", "execute"]) {
    const args = sshArguments(target(), phase, selection().operationId);
    assert.ok(args.includes("CheckHostIP=no"));
    assert.ok(!args.includes("CheckHostIP=yes"));
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes("UpdateHostKeys=no"));
    assert.ok(args.includes("UserKnownHostsFile=/private/hosts"));
  }
});

test("successful receive stdout with SSH warning still prevents execute", async (t) => {
  const f = await senderFixture(t);
  const original = f.options.runProcess;
  f.options.runProcess = async (options) => {
    if (options.executable !== "/usr/bin/ssh") return original(options);
    f.calls.push(options);
    return {
      stdout: Buffer.from("Platform executor bundle received.\n"),
      stderr: Buffer.from("Warning: Permanently added resolved IP to known hosts.\n"),
    };
  };
  await assert.rejects(runTransport(f.config, f.options));
  const ssh = f.calls.filter((c) => c.executable === "/usr/bin/ssh");
  assert.equal(ssh.length, 1);
  assert.match(ssh[0].args.at(-1), / receive /u);
});
