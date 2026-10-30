import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRehearsalFilesystemReader, createRehearsalShell } from "../rehearsal-filesystem.mjs";
const id = "a".repeat(64),
  exec = "b".repeat(64);
function frame(stream, text) {
  const bytes = Buffer.from(text),
    header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(await realpath("/tmp"), "mk-fs-"));
  const socket = join(root, "socket"),
    seen = [];
  let runs = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (b) => chunks.push(b));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      seen.push({ method: req.method, path: req.url, body });
      if (options.handler) return options.handler(req, res, body, seen);
      if (req.url.endsWith("/exec")) {
        runs++;
        res.writeHead(201);
        res.end(JSON.stringify({ Id: exec }));
      } else if (req.url.endsWith("/start")) {
        res.end(
          Buffer.concat([
            frame(1, options.stdout ?? `fresh-${runs}\n`),
            frame(2, options.stderr ?? ""),
          ]),
        );
      } else
        res.end(
          JSON.stringify({
            ID: exec,
            ContainerID: id,
            Running: false,
            Pid: 0,
            ExitCode: options.exitCode ?? 0,
          }),
        );
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true });
  });
  const settings = { endpoint: `unix://${socket}`, containerId: id, root };
  return { root, seen, settings, reader: createRehearsalFilesystemReader(settings) };
}
test("fixed filesystem forms select only canonical owned paths", async (t) => {
  const f = await fixture(t),
    path = join(f.root, "file");
  for (const args of [
    ["mkdir", "-p", path],
    ["mkdir", "-p", "-m", "700", path],
    ["chmod", "700", path],
    ["chown", "70:70", path, join(f.root, "other")],
    ["sha256sum", path],
    ...["%a:%F", "%a:%s", "%u:%g:%a:%s"].map((format) => ["stat", "-c", format, path]),
  ])
    assert.equal(f.reader.supports(args), true, args.join(" "));
  for (const args of [
    [],
    ["sh", "-c", "PRIVATE"],
    ["rm", "-rf", path],
    ["chmod", "777", path],
    ["chown", "root:root", path],
    ["chown", "0:0", ...Array(9).fill(path)],
    ["sha256sum", "/etc/passwd"],
    ["sha256sum", `${f.root}-other/file`],
    ["sha256sum", `${f.root}/../outside`],
    ["sha256sum", `${f.root}//file`],
    ["sha256sum", `${path}\n`],
    ["sha256sum", `${path}\0`],
    ["stat", "-c", "%s", path],
  ])
    assert.equal(f.reader.supports(args), false);
  assert.equal(f.seen.length, 0);
});
test("each run creates a fresh exact command and preserves both streams", async (t) => {
  const f = await fixture(t, { stderr: "warning\n" }),
    args = ["stat", "-c", "%a:%s", join(f.root, "file")];
  assert.deepEqual(await f.reader.run(args), { stdout: "fresh-1\n", stderr: "warning\n" });
  assert.deepEqual(await f.reader.run(args), { stdout: "fresh-2\n", stderr: "warning\n" });
  assert.equal(f.seen.length, 6);
  for (const offset of [0, 3]) {
    assert.equal(f.seen[offset].path, `/v1.41/containers/${id}/exec`);
    assert.deepEqual(f.seen[offset].body, {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Privileged: false,
      Cmd: args,
    });
    assert.deepEqual(f.seen[offset + 1].body, { Detach: false, Tty: false });
    assert.equal(f.seen[offset + 2].method, "GET");
  }
});
test("exited Docker exec retains its historical PID without implying a running process", async (t) => {
  const f = await fixture(t, {
    handler(req, res) {
      if (req.url.endsWith("/exec")) {
        res.writeHead(201);
        res.end(JSON.stringify({ Id: exec }));
      } else if (req.url.endsWith("/start")) res.end(frame(1, "done"));
      else
        res.end(
          JSON.stringify({ ID: exec, ContainerID: id, Running: false, Pid: 321, ExitCode: 0 }),
        );
    },
  });
  assert.deepEqual(await f.reader.run(["stat", "-c", "%a:%s", join(f.root, "file")]), {
    stdout: "done",
    stderr: "",
  });
});

test("validated arguments are copied before asynchronous execution", async (t) => {
  const f = await fixture(t),
    args = ["sha256sum", join(f.root, "file")],
    original = [...args];
  const pending = f.reader.run(args);
  args[1] = "/etc/passwd";
  await pending;
  assert.deepEqual(f.seen[0].body.Cmd, original);
});
test("confirmed nonzero exit retains code and streams without exposing them in message", async (t) => {
  const f = await fixture(t, { exitCode: 7, stdout: "out", stderr: "PRIVATE failure" });
  await assert.rejects(f.reader.run(["sha256sum", join(f.root, "file")]), (error) => {
    assert.equal(error.code, 7);
    assert.equal(error.stdout, "out");
    assert.equal(error.stderr, "PRIVATE failure");
    assert.equal(error.terminationConfirmed, true);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  await assert.rejects(f.reader.run(["sha256sum", join(f.root, "file")]));
  assert.equal(f.seen.length, 3);
});
for (const fault of [
  "status",
  "redirect",
  "exec-id",
  "framing",
  "reserved",
  "size",
  "running",
  "identity",
  "container",
  "exit-code",
  "disconnect",
])
  test(`filesystem exec fails closed for ${fault}`, async (t) => {
    const f = await fixture(t, {
      handler(req, res) {
        if (req.url.endsWith("/exec")) {
          res.writeHead(fault === "status" ? 500 : fault === "redirect" ? 302 : 201);
          res.end(JSON.stringify({ Id: fault === "exec-id" ? "PRIVATE" : exec }));
        } else if (req.url.endsWith("/start")) {
          if (fault === "disconnect") return req.socket.destroy();
          let bytes = frame(1, "out");
          if (fault === "framing") bytes = bytes.subarray(0, 9);
          if (fault === "reserved") bytes[1] = 1;
          if (fault === "size") bytes = Buffer.alloc(4 * 1048576 + 1);
          res.end(bytes);
        } else
          res.end(
            JSON.stringify({
              ID: fault === "identity" ? "c".repeat(64) : exec,
              ContainerID: fault === "container" ? "c".repeat(64) : id,
              Running: fault === "running",
              Pid: 0,
              ExitCode: fault === "exit-code" ? "0" : 0,
            }),
          );
      },
    });
    await assert.rejects(f.reader.run(["stat", "-c", "%a:%s", join(f.root, "file")]), (error) => {
      assert.equal(error.code, "ERR_REHEARSAL_ENGINE_READ");
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    const count = f.seen.length;
    await assert.rejects(f.reader.run(["stat", "-c", "%a:%s", join(f.root, "file")]));
    assert.equal(f.seen.length, count);
  });
test("whole-command deadline includes preceding create/start phases and poisons uncertain exec", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const f = await fixture(t, {
    handler(req, res) {
      if (req.url.endsWith("/exec")) {
        clock = 70000;
        res.writeHead(201);
        res.end(JSON.stringify({ Id: exec }));
      } else {
        clock = 120001;
        res.end(frame(1, "partial"));
      }
    },
  });
  await assert.rejects(f.reader.run(["sha256sum", join(f.root, "file")]), (error) => {
    assert.equal(error.terminationConfirmed, false);
    return error.code === "ERR_REHEARSAL_ENGINE_READ";
  });
  await assert.rejects(f.reader.run(["sha256sum", join(f.root, "file")]));
  assert.equal(f.seen.length, 2);
});
test("ordinary and unsupported dispatch retain CLI; selected errors never replay", async (t) => {
  const f = await fixture(t, { exitCode: 5 }),
    calls = [];
  const runCli = async (args) => {
    calls.push([...args]);
    return { stdout: "cli", stderr: "" };
  };
  const ordinary = createRehearsalShell({ ...f.settings, forward: false, runCli });
  const selected = createRehearsalShell({ ...f.settings, forward: true, runCli });
  const fs = ["mkdir", "-p", f.root],
    other = ["sh", "-ceu", "PRIVATE"];
  assert.equal((await ordinary(fs)).stdout, "cli");
  assert.equal((await selected(other)).stdout, "cli");
  await assert.rejects(selected(fs), (error) => {
    assert.equal(error.code, 5);
    assert.equal(error.rehearsalExecutable, "docker");
    assert.equal(error.rehearsalCommand, "docker exec");
    return true;
  });
  assert.deepEqual(calls, [fs, other]);
  assert.equal(f.seen.length, 3);
});

test("uncertain filesystem failure prevents every later dispatch including CLI-only commands", async (t) => {
  const f = await fixture(t, {
    handler(req, res) {
      if (req.url.endsWith("/exec")) {
        res.writeHead(201);
        res.end(JSON.stringify({ Id: exec }));
      } else req.socket.destroy();
    },
  });
  let cli = 0;
  const shell = createRehearsalShell({
    ...f.settings,
    forward: true,
    runCli: async () => {
      cli++;
      return { stdout: "", stderr: "" };
    },
  });
  await assert.rejects(
    shell(["mkdir", "-p", f.root]),
    (error) => error.terminationConfirmed === false,
  );
  await assert.rejects(shell(["sh", "-ceu", "PRIVATE"]));
  assert.equal(cli, 0);
  assert.equal(f.seen.length, 2);
});
