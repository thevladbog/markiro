import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createRehearsalMetadataReader,
  rehearsalIsolationReaders,
  parseRehearsalRoutes,
  rehearsalRouteCommand,
} from "../rehearsal-isolation-readers.mjs";
import { verifyRehearsalIsolation } from "../upgrade-ci.mjs";
import { rehearsalFixture } from "./rehearsal-fixture.mjs";
import { captureRehearsalResources } from "../upgrade-ci-guards.mjs";
async function engine(t, handler) {
  const root = await mkdtemp(join(await realpath("/tmp"), "mk-engine-"));
  const socket = join(root, "s");
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true });
  });
  return createRehearsalMetadataReader(`unix://${socket}`);
}
test("metadata uses only exact versioned GETs on the explicit Unix endpoint", async (t) => {
  const f = rehearsalFixture(),
    seen = [];
  const reader = await engine(t, (req, res) => {
    seen.push([req.method, req.url]);
    res.end(JSON.stringify(req.url.includes("/containers/") ? f.container : f.volume));
  });
  assert.deepEqual(await reader.container(f.container.Id), f.container);
  assert.deepEqual(await reader.volume(f.volume.Name), f.volume);
  assert.deepEqual(seen, [
    ["GET", `/v1.41/containers/${f.container.Id}/json`],
    ["GET", `/v1.41/volumes/${f.volume.Name}`],
  ]);
  assert.throws(() => createRehearsalMetadataReader("tcp://201.34.136.19:2375"));
  await assert.rejects(reader.container("../foreign"));
  await assert.rejects(reader.volume("markiro-platform_postgres-data"));
  assert.equal(seen.length, 2);
});
for (const fault of ["redirect", "status", "json", "array", "oversized", "disconnect"])
  test(`metadata rejects ${fault} without exposing body or endpoint`, async (t) => {
    const reader = await engine(t, (req, res) => {
      if (fault === "redirect") {
        res.writeHead(302, { Location: "https://private.invalid" });
        res.end("PRIVATE");
      } else if (fault === "status") {
        res.writeHead(500);
        res.end("PRIVATE");
      } else if (fault === "json") res.end("PRIVATE");
      else if (fault === "array") res.end("[]");
      else if (fault === "oversized") res.end("x".repeat(4 * 1048576 + 1));
      else req.socket.destroy();
    });
    await assert.rejects(reader.container("a".repeat(64)), (e) => {
      assert.equal(e.code, "ERR_REHEARSAL_ENGINE_READ");
      assert.equal(e.message.includes("PRIVATE"), false);
      assert.equal(e.message.includes("/tmp"), false);
      return true;
    });
  });
test("route batch is fixed, frames both families and refuses malformed framing", () => {
  assert.deepEqual(rehearsalRouteCommand.slice(0, 2), ["sh", "-ceu"]);
  assert.deepEqual(parseRehearsalRoutes("\0\0"), { ipv4: "", ipv6: "" });
  for (const text of ["", "\0", "\0\0extra", "\0\0\0"])
    assert.throws(() => parseRehearsalRoutes(text));
  assert.equal(parseRehearsalRoutes("default via synthetic\0\0").ipv4, "default via synthetic");
});
test("every guard gets fresh metadata/routes and drains readers after refusal", async (t) => {
  const f = rehearsalFixture(),
    owned = captureRehearsalResources(f);
  let requests = 0,
    batches = 0,
    active = 0;
  const reader = await engine(t, (req, res) => {
    requests++;
    active++;
    setTimeout(() => {
      res.end(JSON.stringify(req.url.includes("/containers/") ? f.container : f.volume));
      active--;
    }, 5);
  });
  const check = () =>
    verifyRehearsalIsolation(
      f.invocationId,
      rehearsalIsolationReaders({
        container: () => reader.container(f.container.Id),
        volume: () => reader.volume(f.volume.Name),
        routes: async () => {
          batches++;
          return { ipv4: "", ipv6: "" };
        },
      }),
      owned,
    );
  await check();
  await check();
  assert.equal(requests, 4);
  assert.equal(batches, 2);
  assert.equal(active, 0);
  f.volume.Labels = {};
  await assert.rejects(check());
  assert.equal(requests, 6);
  assert.equal(batches, 3);
  assert.equal(active, 0);
});

test("metadata wall deadline also bounds a stalled response body", async (t) => {
  let received;
  const ready = new Promise((r) => (received = r));
  const reader = await engine(t, (req, res) => {
    res.write('{"pending":');
    received();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = reader.container("a".repeat(64));
    const rejected = assert.rejects(pending, (e) => {
      assert.equal(e.code, "ERR_REHEARSAL_ENGINE_READ");
      return true;
    });
    await ready;
    t.mock.timers.tick(120001);
    await rejected;
  } finally {
    t.mock.timers.reset();
  }
});
test("failed HTTP read still drains other metadata and both route subscribers", async (t) => {
  const f = rehearsalFixture(),
    owned = captureRehearsalResources(f);
  let active = 0,
    finished = false;
  const reader = await engine(t, (req, res) => {
    active++;
    if (req.url.includes("/containers/")) {
      res.writeHead(500);
      res.end("PRIVATE");
      active--;
    } else
      setTimeout(() => {
        res.end(JSON.stringify(f.volume));
        active--;
      }, 15);
  });
  await assert.rejects(
    verifyRehearsalIsolation(
      f.invocationId,
      rehearsalIsolationReaders({
        container: () => reader.container(f.container.Id),
        volume: () => reader.volume(f.volume.Name),
        routes: async () => {
          await new Promise((r) => setTimeout(r, 5));
          finished = true;
          return { ipv4: "", ipv6: "" };
        },
      }),
      owned,
    ),
  );
  assert.equal(active, 0);
  assert.equal(finished, true);
});

test("engine error diagnostics admit only trusted finite reasons", async (t) => {
  const { rehearsalFailure } = await import("../upgrade-ci-guards.mjs");
  const { forwardRehearsalFailure } = await import("../forward-ci.mjs");
  const reader = await engine(t, (req, res) => {
    res.writeHead(500);
    res.end("PRIVATE");
  });
  let error;
  try {
    await reader.container("a".repeat(64));
  } catch (value) {
    error = value;
  }
  assert.ok(error);
  const safe = rehearsalFailure("stage isolated daemon", error);
  assert.equal(safe.code, "ERR_REHEARSAL_ENGINE_READ");
  assert.equal(safe.processReason, "engine-http-status");
  assert.deepEqual(forwardRehearsalFailure(safe), safe);
  assert.equal(
    rehearsalFailure("stage isolated daemon", {
      code: "ERR_REHEARSAL_ENGINE_READ",
      reason: "engine-timeout",
    }).processReason,
    null,
  );
});

test("metadata deadline starts before the connection completes", async (t) => {
  const reader = await engine(t, (req, res) => res.end("{}"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = reader.container("a".repeat(64));
    const rejected = assert.rejects(pending, (e) => e.code === "ERR_REHEARSAL_ENGINE_READ");
    t.mock.timers.tick(120001);
    await rejected;
  } finally {
    t.mock.timers.reset();
  }
});
test("ambient Docker endpoint and HTTP proxies cannot replace the explicit Unix endpoint", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const f = rehearsalFixture();
  let calls = 0;
  const root = await mkdtemp(join(await realpath("/tmp"), "mk-engine-proxy-")),
    socket = join(root, "s");
  const server = http.createServer((req, res) => {
    calls++;
    res.end(JSON.stringify(f.container));
  });
  await new Promise((r) => server.listen(socket, r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true });
  });
  const moduleUrl = new URL("../rehearsal-isolation-readers.mjs", import.meta.url).href;
  const script =
    "import{createRehearsalMetadataReader}from" +
    JSON.stringify(moduleUrl) +
    ";const value=await createRehearsalMetadataReader(" +
    JSON.stringify("unix://" + socket) +
    ").container(" +
    JSON.stringify(f.container.Id) +
    ");if(value.Id!==" +
    JSON.stringify(f.container.Id) +
    ')throw Error("wrong endpoint");';
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      PATH: process.env.PATH,
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      DOCKER_HOST: "tcp://127.0.0.1:1",
    },
    timeout: 10000,
  });
  assert.equal(calls, 1);
});

function frame(stream, bytes) {
  const b = Buffer.from(bytes),
    h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(b.length, 4);
  return Buffer.concat([h, b]);
}
test("route reads run the exact fixed command anew and require observed successful termination", async (t) => {
  const id = "a".repeat(64),
    exec = "b".repeat(64),
    seen = [];
  let n = 0;
  const r = await engine(t, (req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      if (req.url.endsWith("/exec")) {
        res.writeHead(201);
        res.end(JSON.stringify({ Id: exec }));
      } else if (req.url.endsWith("/start")) {
        res.end(frame(1, ++n === 1 ? "\0\0" : "default via changed\0\0"));
      } else res.end(JSON.stringify({ ID: exec, ContainerID: id, Running: false, ExitCode: 0 }));
    });
  });
  assert.deepEqual(await r.routes(id), { ipv4: "", ipv6: "" });
  assert.deepEqual(await r.routes(id), { ipv4: "default via changed", ipv6: "" });
  assert.equal(seen.length, 6);
  for (const offset of [0, 3]) {
    assert.equal(seen[offset].method, "POST");
    assert.equal(seen[offset].path, `/v1.41/containers/${id}/exec`);
    assert.deepEqual(seen[offset].body.Cmd, rehearsalRouteCommand);
    assert.equal(seen[offset].body.Tty, false);
    assert.equal(seen[offset].body.Privileged, false);
    assert.deepEqual(seen[offset + 1].body, { Detach: false, Tty: false });
    assert.equal(seen[offset + 2].method, "GET");
    assert.equal(seen[offset + 2].path, `/v1.41/exec/${exec}/json`);
  }
  await assert.rejects(r.routes("../bad"));
  assert.equal(seen.length, 6);
});
for (const fault of ["running", "exit", "identity", "stderr", "framing", "disconnect"])
  test(`route exec rejects ${fault} and never accepts partial output`, async (t) => {
    const id = "a".repeat(64),
      exec = "b".repeat(64);
    const r = await engine(t, (req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url.endsWith("/exec")) {
          res.writeHead(201);
          res.end(JSON.stringify({ Id: exec }));
        } else if (req.url.endsWith("/start")) {
          if (fault === "disconnect") req.socket.destroy();
          else
            res.end(
              fault === "framing"
                ? Buffer.from("PRIVATE")
                : frame(fault === "stderr" ? 2 : 1, fault === "stderr" ? "PRIVATE" : "\0\0"),
            );
        } else
          res.end(
            JSON.stringify({
              ID: exec,
              ContainerID: fault === "identity" ? "c".repeat(64) : id,
              Running: fault === "running",
              ExitCode: fault === "exit" ? 1 : 0,
            }),
          );
      });
    });
    await assert.rejects(r.routes(id), (e) => {
      assert.equal(e.code, "ERR_REHEARSAL_ENGINE_READ");
      assert.doesNotMatch(e.message, /PRIVATE/);
      return true;
    });
  });

test("route timeout bounds the whole command and poisons uncertain execution without retry", async (t) => {
  let ready;
  const started = new Promise((r) => (ready = r));
  let calls = 0;
  const id = "a".repeat(64),
    exec = "b".repeat(64);
  const r = await engine(t, (req, res) => {
    calls++;
    req.resume();
    req.on("end", () => {
      if (calls > 2) {
        res.writeHead(500);
        res.end("PRIVATE");
        return;
      }
      if (req.url.endsWith("/exec")) {
        res.writeHead(201);
        res.end(JSON.stringify({ Id: exec }));
      } else {
        res.write(frame(1, "partial"));
        ready();
      }
    });
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = r.routes(id);
    const rejected = assert.rejects(pending, (e) => {
      assert.equal(e.terminationConfirmed, false);
      return e.code === "ERR_REHEARSAL_ENGINE_READ";
    });
    await started;
    t.mock.timers.tick(120001);
    await rejected;
    await assert.rejects(r.routes(id));
    assert.equal(calls, 2);
  } finally {
    t.mock.timers.reset();
  }
});
