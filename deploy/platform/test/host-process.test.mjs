import assert from "node:assert/strict";
import { chmod, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  hostChildEnvironment,
  snapshotHostConfig,
  snapshotMigrationConfig,
} from "../host/config.mjs";
import { runHostProcess } from "../host/process.mjs";
import { privateFixture } from "./host-fixtures.mjs";

const secret = "PRIVATE-CHILD-OUTPUT";
const options = (f, source, overrides = {}) => ({
  executable: process.execPath,
  args: ["-e", source],
  cwd: f.root,
  env: {},
  timeoutMs: 5000,
  outputLimitBytes: 1024,
  ...overrides,
});
const treeOptions = (f, observer, mode, overrides = {}) =>
  options(f, "", {
    args: [
      fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url)),
      mode,
      observer.path,
    ],
    ...overrides,
  });
const safeError =
  (reason, confirmed = true) =>
  (error) => {
    assert.equal(error.code, "ERR_HOST_PROCESS");
    assert.equal(error.reason, reason);
    assert.equal(error.terminationConfirmed, confirmed);
    assert.deepEqual(Object.keys(error).sort(), ["code", "reason", "terminationConfirmed"]);
    assert.doesNotMatch(error.message, /PRIVATE-CHILD|markiro-host-|ENOENT|\/private\//u);
    assert.equal(error.cause, undefined);
    return true;
  };

// IPC readiness and socket close events witness live processes and their termination.
// PID/group probes after settlement additionally prove they have been reaped.
async function observeTree(t, f, count) {
  const path = join(f.root, "ipc-quote'-$().sock");
  const pids = [];
  const sockets = [];
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  let closedResolve;
  const closed = new Promise((resolve) => {
    closedResolve = resolve;
  });
  let closeCount = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    let data = "";
    socket.on("data", (bytes) => {
      data += bytes;
      if (data.endsWith("\n")) {
        pids.push(Number(data.trim()));
        if (pids.length === count) readyResolve();
      }
    });
    socket.on("close", () => {
      if (++closeCount === count) closedResolve();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  t.after(async () => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { pids, ready, closed, path };
}

test("passes shell metacharacters literally and returns separate binary output", async (t) => {
  const f = await privateFixture(t);
  const literal = "$(echo bad); `echo bad` & * > file | \\ $HOME";
  const result = await runHostProcess(
    options(
      f,
      "process.stdout.write(process.argv[1]); process.stderr.write(Buffer.from([0,255,1]));",
      {
        args: [
          "-e",
          "process.stdout.write(process.argv[1]); process.stderr.write(Buffer.from([0,255,1]));",
          literal,
        ],
      },
    ),
  );
  assert.deepEqual(result, { stdout: Buffer.from(literal), stderr: Buffer.from([0, 255, 1]) });
});

test("does not inherit ambient credentials or configuration", async (t) => {
  const f = await privateFixture(t);
  const key = "MARKIRO_PROCESS_TEST_AMBIENT";
  const previous = process.env[key];
  process.env[key] = secret;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  const result = await runHostProcess(
    options(f, "process.stdout.write(JSON.stringify(process.env))", {
      env: { EXPLICIT: "literal" },
    }),
  );
  const received = JSON.parse(result.stdout);
  assert.equal(received.EXPLICIT, "literal");
  for (const absent of [
    key,
    "HOME",
    "PATH",
    "AWS_SECRET_ACCESS_KEY",
    "DOCKER_HOST",
    "HTTP_PROXY",
    "NODE_OPTIONS",
  ])
    assert.equal(received[absent], undefined);
  // Node on Darwin supplies this OS encoding setting even with an explicit env.
  if (process.platform === "darwin") delete received.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(received, { EXPLICIT: "literal" });
});

test("accepts the existing validated host environment without weakening its checks", async (t) => {
  const f = await privateFixture(t);
  const snapshot = await snapshotHostConfig({ ...f });
  const url = new URL(f.env.DATABASE_URL);
  url.username = "markiro_migrator";
  const input = join(f.root, "migration-input.env");
  await writeFile(input, `DATABASE_URL=${url.href}\n`, { mode: 0o600 });
  const migration = await snapshotMigrationConfig({
    ...f,
    envFile: input,
    runtimeSnapshot: snapshot,
  });
  snapshot.interpolation = {
    ...snapshot.interpolation,
    MARKIRO_PLATFORM_MIGRATION_ENV_FILE: migration.path,
  };
  const env = hostChildEnvironment({
    interpolation: snapshot.interpolation,
    dockerConfig: f.dockerConfig,
    ambient: {},
  });
  const result = await runHostProcess(
    options(f, "process.stdout.write(process.env.COMPOSE_DISABLE_ENV_FILE)", { env }),
  );
  assert.equal(result.stdout.toString(), "1");
  assert.throws(() =>
    hostChildEnvironment({
      interpolation: snapshot.interpolation,
      dockerConfig: f.dockerConfig,
      ambient: { DOCKER_HOST: "forbidden" },
    }),
  );
});

test("redacts nonzero exit and spawn failures", async (t) => {
  const f = await privateFixture(t);
  await assert.rejects(
    runHostProcess(options(f, `console.error('${secret}'); process.exit(9)`)),
    safeError("exit"),
  );
  await assert.rejects(
    runHostProcess(options(f, "", { executable: join(f.root, secret) })),
    safeError("spawn"),
  );
});

test("signal termination is distinct from a completed nonzero child exit", async (t) => {
  const f = await privateFixture(t);
  await assert.rejects(
    runHostProcess(options(f, "process.kill(process.pid, 'SIGTERM')")),
    safeError("signal"),
  );
});

for (const stream of ["stdout", "stderr"]) {
  test(`bounds ${stream} bytes and terminates overflow`, async (t) => {
    const f = await privateFixture(t);
    await assert.rejects(
      runHostProcess(
        options(f, `process.${stream}.write(Buffer.alloc(1025)); setInterval(() => {}, 1000);`),
      ),
      safeError("output-limit"),
    );
    const result = await runHostProcess(options(f, `process.${stream}.write(Buffer.alloc(1024))`));
    assert.equal(result[stream].length, 1024);
  });
}

test("already-aborted signals never spawn", async (t) => {
  const f = await privateFixture(t);
  await assert.rejects(
    runHostProcess(
      options(f, "", { executable: join(f.root, "missing"), signal: AbortSignal.abort(secret) }),
    ),
    safeError("aborted"),
  );
});

test("rejects unsafe process inputs before spawn with redacted errors", async (t) => {
  const f = await privateFixture(t);
  const getterEnv = Object.defineProperty({}, "SECRET", {
    enumerable: true,
    get() {
      throw new Error(secret);
    },
  });
  for (const invalid of [
    { executable: "node" },
    { args: "-e" },
    { args: [1] },
    { args: ["a\0b"] },
    { env: undefined },
    { env: Object.create({ SECRET: secret }) },
    { env: getterEnv },
    { env: { [Symbol("secret")]: secret } },
    { env: { A: undefined } },
    { env: { "A=B": "x" } },
    { env: { A: "x\0y" } },
    { cwd: "relative" },
    { cwd: `${f.root}/` },
    ...[0, -1, NaN, Infinity, 1.5, 3600001].map((timeoutMs) => ({ timeoutMs })),
    ...[0, -1, NaN, Infinity, 1.5, 1048577].map((outputLimitBytes) => ({ outputLimitBytes })),
  ])
    await assert.rejects(runHostProcess(options(f, "", invalid)), safeError("spawn"));
  await symlink(f.root, join(f.root, "alias"));
  await assert.rejects(
    runHostProcess(options(f, "", { cwd: join(f.root, "alias") })),
    safeError("spawn"),
  );
  await chmod(f.root, 0o750);
  await assert.rejects(runHostProcess(options(f, "")), safeError("spawn"));
});

test("timeout terminates and reaps a real process", { timeout: 12000 }, async (t) => {
  const f = await privateFixture(t);
  const observer = await observeTree(t, f, 1);
  const result = runHostProcess(treeOptions(f, observer, "wait", { timeoutMs: 1000 }));
  const rejected = assert.rejects(result, safeError("timeout"));
  await observer.ready;
  await rejected;
  await observer.closed;
  assert.throws(() => process.kill(observer.pids[0], 0), { code: "ESRCH" });
});

test(
  "abort kills and reaps a TERM-ignoring process tree before rejecting",
  { timeout: 15000 },
  async (t) => {
    const f = await privateFixture(t);
    const observer = await observeTree(t, f, 2);
    const controller = new AbortController();
    const result = runHostProcess(treeOptions(f, observer, "tree", { signal: controller.signal }));
    const rejected = assert.rejects(result, safeError("aborted"));
    await observer.ready;
    controller.abort(secret);
    await rejected;
    await observer.closed;
    for (const pid of observer.pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);

test("redacts malformed option objects and rejects unsupported platforms", async (t) => {
  for (const input of [
    null,
    {
      get executable() {
        throw new Error(secret);
      },
    },
  ])
    await assert.rejects(runHostProcess(input), safeError("spawn"));
  const f = await privateFixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await assert.rejects(runHostProcess(options(f, "")), safeError("spawn"));
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test(
  "does not return success while an exited parent's descendant remains alive",
  { timeout: 15000 },
  async (t) => {
    const f = await privateFixture(t);
    const observer = await observeTree(t, f, 1);
    // A child-to-parent IPC handshake holds root exit until the descendant is live.
    const result = runHostProcess(treeOptions(f, observer, "exiting-parent"));
    const rejected = assert.rejects(result, safeError("termination"));
    await observer.ready;
    await rejected;
    await observer.closed;
    for (const pid of observer.pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);

test(
  "bounds unconfirmed KILL/reap and preserves unresolved termination",
  { timeout: 15000 },
  async (t) => {
    const f = await privateFixture(t);
    const observer = await observeTree(t, f, 1);
    const controller = new AbortController();
    const originalKill = process.kill;
    t.mock.method(process, "kill", (pid, signal) => {
      if (pid === -observer.pids[0] && signal === "SIGKILL") {
        const error = new Error(secret);
        error.code = "EPERM";
        throw error;
      }
      return originalKill.call(process, pid, signal);
    });
    const result = runHostProcess(
      treeOptions(f, observer, "ignore-term", { signal: controller.signal }),
    );
    const rejected = assert.rejects(result, safeError("termination", false));
    await observer.ready;
    controller.abort();
    await rejected;
    assert.equal(originalKill.call(process, observer.pids[0], 0), true);
    originalKill.call(process, observer.pids[0], "SIGKILL");
    await observer.closed;
  },
);
