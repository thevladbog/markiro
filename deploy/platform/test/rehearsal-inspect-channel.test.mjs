import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createRehearsalInspectReader,
  rehearsalInspectPath,
} from "../rehearsal-inspect-channel.mjs";
const id = "a".repeat(64);
const request = (args = ["container", "inspect", id]) => ({
  args,
  timeoutMs: 2000,
  outputLimitBytes: 1048576,
});
async function fixture(t, handler) {
  const root = await mkdtemp(join(await realpath("/tmp"), "mk-inspect-"));
  const path = join(root, "s");
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(path, r));
  let opens = 0,
    closes = 0;
  const reader = createRehearsalInspectReader(() => {
    opens++;
    const socket = net.connect(path);
    const stopped = new Promise((r) => socket.once("close", r));
    return {
      socket,
      close: async () => {
        socket.destroy();
        await stopped;
        closes++;
      },
    };
  });
  t.after(async () => {
    await reader.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true });
  });
  return { reader, counts: () => ({ opens, closes }) };
}
test("only exact single container/network/volume inspections have a read-only route", () => {
  assert.equal(rehearsalInspectPath(["container", "inspect", id]), `/v1.51/containers/${id}/json`);
  assert.equal(rehearsalInspectPath(["network", "inspect", id]), `/v1.51/networks/${id}`);
  assert.equal(
    rehearsalInspectPath(["volume", "inspect", "markiro-platform_postgres-data"]),
    "/v1.51/volumes/markiro-platform_postgres-data",
  );
  for (const args of [
    ["image", "inspect", id],
    ["container", "inspect", "name"],
    ["container", "inspect", id, id],
    ["container", "rm", id],
    ["network", "inspect", "../bad"],
    ["volume", "inspect", "foreign"],
    ["container", "inspect", id, "--format", "json"],
  ])
    assert.equal(rehearsalInspectPath(args), null);
});
test("pinned image identities use the same API version as the pinned Docker CLI", () => {
  for (const key of [
    `sha256:${id}`,
    `postgres:17-alpine@sha256:${id}`,
    `ghcr.io/thevladbog/markiro-api@sha256:${id}`,
    `ghcr.io/thevladbog/markiro-platform-edge@sha256:${id}`,
  ])
    assert.equal(
      rehearsalInspectPath(["image", "inspect", key]),
      `/v1.51/images/${encodeURIComponent(key)}/json`,
    );
  for (const key of [
    id,
    "postgres:17-alpine",
    "ghcr.io/thevladbog/markiro-api:latest",
    `other.invalid/image@sha256:${id}`,
    `../image@sha256:${id}`,
    `ghcr.io/thevladbog/markiro-api@sha256:${id}?x=1`,
    `ghcr.io/thevladbog/markiro-api@sha256:${id}#x`,
    `ghcr.io/thevladbog/markiro-api@sha256:${id}%2f..`,
    `sha256:${id.toUpperCase()}`,
    `sha256:${id}\n`,
  ])
    assert.equal(rehearsalInspectPath(["image", "inspect", key]), null);
});
test("image reads preserve the complete fresh Config including absent and null Cmd", async (t) => {
  const seen = [];
  const configs = [
    { Entrypoint: ["/entrypoint"] },
    { Entrypoint: ["/entrypoint"], Cmd: null },
    { Entrypoint: ["/entrypoint"], Cmd: ["changed"] },
  ];
  const f = await fixture(t, (req, res) => {
    seen.push(req.url);
    res.end(
      JSON.stringify({
        Id: `sha256:${id}`,
        Config: configs[seen.length - 1],
        Unknown: { retained: true },
      }),
    );
  });
  const key = `ghcr.io/thevladbog/markiro-platform-edge@sha256:${id}`;
  for (const Config of configs) {
    const result = await f.reader.read(request(["image", "inspect", key]));
    assert.deepEqual(JSON.parse(result.stdout), [
      { Id: `sha256:${id}`, Config, Unknown: { retained: true } },
    ]);
  }
  assert.deepEqual(
    seen,
    configs.map(() => `/v1.51/images/${encodeURIComponent(key)}/json`),
  );
  assert.equal(f.counts().opens, 1);
});
test("reuses transport but reads every complete object afresh in request order", async (t) => {
  let n = 0;
  const seen = [];
  const f = await fixture(t, (req, res) => {
    seen.push([req.method, req.url]);
    res.end(
      JSON.stringify({
        Id: id,
        Generation: ++n,
        Config: { Env: ["PRIVATE"] },
        Extra: { retained: true },
      }),
    );
  });
  for (let i = 1; i <= 4; i++) {
    const result = await f.reader.read(request());
    assert.deepEqual(JSON.parse(result.stdout), [
      { Id: id, Generation: i, Config: { Env: ["PRIVATE"] }, Extra: { retained: true } },
    ]);
    assert.equal(result.stderr.length, 0);
  }
  assert.equal(f.counts().opens, 1);
  assert.deepEqual(
    seen,
    Array.from({ length: 4 }, () => ["GET", `/v1.51/containers/${id}/json`]),
  );
  await f.reader.close();
  assert.equal(f.counts().closes, 1);
  await assert.rejects(f.reader.read(request()));
  assert.equal(f.counts().opens, 1);
});
for (const fault of ["status", "redirect", "json", "utf8", "array", "size", "disconnect"])
  test(`refuses ${fault}, drains and poisons the channel without retry or private output`, async (t) => {
    let reads = 0;
    const f = await fixture(t, (req, res) => {
      reads++;
      if (fault === "status" || fault === "redirect") {
        res.writeHead(fault === "status" ? 500 : 302, { Location: "https://private.invalid" });
        res.end("PRIVATE");
      } else if (fault === "json") res.end("PRIVATE");
      else if (fault === "utf8") res.end(Buffer.from([0xff]));
      else if (fault === "array") res.end("[]");
      else if (fault === "size") res.end(JSON.stringify({ private: "x".repeat(1048576) }));
      else req.socket.destroy();
    });
    await assert.rejects(f.reader.read(request()), (e) => {
      assert.equal(e.code, "ERR_REHEARSAL_ENGINE_READ");
      assert.equal(/PRIVATE|\/tmp|private.invalid/.test(e.message), false);
      return true;
    });
    assert.deepEqual(f.counts(), { opens: 1, closes: 1 });
    await assert.rejects(f.reader.read(request()));
    assert.equal(reads, 1);
  });
test("total deadline covers an unfinished response and closes before rejection", async (t) => {
  const f = await fixture(t, (req, res) => res.write('{"waiting":'));
  const r = request();
  r.timeoutMs = 30;
  await assert.rejects(f.reader.read(r));
  assert.equal(f.counts().closes, 1);
});
test("abort drains the current read and prevents any later request", async (t) => {
  let arrived;
  const ready = new Promise((r) => (arrived = r));
  const f = await fixture(t, (req, res) => {
    res.write('{"waiting":');
    arrived();
  });
  const controller = new AbortController();
  const pending = f.reader.read({ ...request(), signal: controller.signal });
  const rejected = assert.rejects(pending);
  await ready;
  controller.abort();
  await rejected;
  assert.equal(f.counts().closes, 1);
  await assert.rejects(f.reader.read(request()));
});
test("refuses concurrent reads rather than queueing stale observations", async (t) => {
  let finish, arrived;
  const ready = new Promise((r) => (arrived = r));
  const f = await fixture(t, (req, res) => {
    finish = () => res.end("{}");
    arrived();
  });
  const first = f.reader.read(request());
  await ready;
  await assert.rejects(f.reader.read(request()));
  finish();
  await first;
  assert.equal(f.counts().opens, 1);
});

test(
  "owned stdio child closes after normal EOF and after an unresponsive child is killed",
  { timeout: 12000 },
  async (t) => {
    const { createDockerInspectChannel } = await import("../rehearsal-inspect-channel.mjs");
    const { privateFixture } = await import("./host-fixtures.mjs");
    const { writeFile, readFile } = await import("node:fs/promises");
    for (const mode of ["reply", "stall"]) {
      const { root } = await privateFixture(t);
      const executable = join(root, "cli");
      await writeFile(
        executable,
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync('pid',String(process.pid),{mode:0o600});\nif(process.env.FIXTURE_MODE==='stall'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdin.resume();}else{process.stdin.on('data',()=>process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: keep-alive\\r\\n\\r\\n{}'));process.stdin.on('end',()=>process.exit(0));}\n`,
        { mode: 0o700 },
      );
      const reader = createDockerInspectChannel({
        executable,
        endpoint: "unix:///unused.sock",
        containerId: id,
        cwd: root,
        env: { FIXTURE_MODE: mode },
      });
      const action = reader.read({ ...request(), timeoutMs: mode === "stall" ? 250 : 2000 });
      if (mode === "stall") await assert.rejects(action);
      else assert.deepEqual(JSON.parse((await action).stdout), [{}]);
      await reader.close();
      const pid = Number(await readFile(join(root, "pid"), "utf8"));
      assert.throws(
        () => process.kill(-pid, 0),
        (e) => e.code === "ESRCH",
      );
    }
  },
);
test("failed child spawn is bounded, private and never retried", async (t) => {
  const { createDockerInspectChannel } = await import("../rehearsal-inspect-channel.mjs");
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { root } = await privateFixture(t);
  const reader = createDockerInspectChannel({
    executable: join(root, "absent"),
    endpoint: "unix:///unused.sock",
    containerId: id,
    cwd: root,
    env: {},
  });
  await assert.rejects(
    reader.read(request()),
    (e) => e.code === "ERR_REHEARSAL_ENGINE_READ" && !e.message.includes(root),
  );
  await reader.close();
  await assert.rejects(reader.read(request()));
});

test("formatted output preserves raw escaping and numeric tokens with the CLI byte ceiling", async (t) => {
  const raw =
    '{"number":9007199254740993,"exponent":1e+30,"text":"\\u003c\\u003e\\u0026\\u2028\\u2029Ж😺","empty":{},"array":[{},[]]}';
  const expected =
    '[\n    {\n        "number": 9007199254740993,\n        "exponent": 1e+30,\n        "text": "\\u003c\\u003e\\u0026\\u2028\\u2029Ж😺",\n        "empty": {},\n        "array": [\n            {},\n            []\n        ]\n    }\n]\n';
  const f = await fixture(t, (_req, res) => res.end(raw));
  const limit = Buffer.byteLength(expected);
  const actual = await f.reader.read({ ...request(), outputLimitBytes: limit });
  assert.equal(String(actual.stdout), expected);
  const smaller = await fixture(t, (_req, res) => res.end(raw));
  await assert.rejects(smaller.reader.read({ ...request(), outputLimitBytes: limit - 1 }));
});
test("a failed drain preserves the initiating safe HTTP refusal and records uncertainty", async (t) => {
  const { rehearsalEngineReadReason } = await import("../rehearsal-isolation-readers.mjs");
  const root = await mkdtemp(join(await realpath("/tmp"), "mk-drain-"));
  const path = join(root, "s");
  const server = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end("PRIVATE");
  });
  await new Promise((r) => server.listen(path, r));
  let stopped;
  const reader = createRehearsalInspectReader(() => {
    const socket = net.connect(path);
    stopped = new Promise((r) => socket.once("close", r));
    return {
      socket,
      close: async () => {
        socket.destroy();
        await stopped;
        throw Error("PRIVATE drain");
      },
    };
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true });
  });
  await assert.rejects(reader.read(request()), (e) => {
    assert.equal(rehearsalEngineReadReason(e), "engine-http-status");
    assert.equal(e.terminationConfirmed, false);
    assert.equal(e.message.includes("PRIVATE"), false);
    return true;
  });
  await assert.rejects(reader.close());
  await assert.rejects(reader.read(request()));
});
