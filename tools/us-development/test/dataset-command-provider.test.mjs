import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startDatasetProviderObservation } from "./support/dataset-command-provider.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function fixture(handler) {
  const upstream = http.createServer(handler);
  const upstreamPort = await listen(upstream);
  try {
    const port = await freePort();
    const observer = await startDatasetProviderObservation({ port, upstreamPort });
    return {
      observer,
      port,
      async close() {
        await observer.close();
        await new Promise((resolve) => upstream.close(resolve));
      },
    };
  } catch (error) {
    await new Promise((resolve) => upstream.close(resolve));
    throw error;
  }
}
function request(port, method = "GET", body = Buffer.alloc(0), headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: "/bucket/a%20b?partNumber=2&x=a%2Fb",
        headers,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            trailers: res.trailers,
            bytes: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
test(
  "observer preserves signed Host, raw path/query, headers, streaming body and response",
  { timeout: 5000 },
  async () => {
    const body = Buffer.alloc(512 * 1024, 147);
    let actual;
    const f = await fixture(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      actual = {
        method: req.method,
        url: req.url,
        host: req.headers.host,
        auth: req.headers.authorization,
        bytes: Buffer.concat(chunks),
      };
      res.writeHead(201, {
        "x-provider-value": "unchanged",
        "content-type": "application/octet-stream",
        trailer: "x-provider-tail",
      });
      res.addTrailers({ "x-provider-tail": "checksum-unmodified" });
      res.end(Buffer.from([0, 255, 4, 19]));
    });
    try {
      const value = await request(f.port, "PUT", body, {
        host: "signed-host:19000",
        authorization: "private-test-signature",
        "content-length": body.length,
      });
      assert.deepEqual(actual, {
        method: "PUT",
        url: "/bucket/a%20b?partNumber=2&x=a%2Fb",
        host: "signed-host:19000",
        auth: "private-test-signature",
        bytes: body,
      });
      assert.equal(value.status, 201);
      assert.equal(value.headers["x-provider-value"], "unchanged");
      assert.deepEqual(value.trailers, { "x-provider-tail": "checksum-unmodified" });
      assert.deepEqual(value.bytes, Buffer.from([0, 255, 4, 19]));
      assert.deepEqual(f.observer.counts(), { reads: 0, mutations: 1, failures: 0, active: 0 });
      assert.ok(!JSON.stringify(f.observer.counts()).includes("private-test-signature"));
    } finally {
      await f.close();
    }
  },
);
test(
  "observer counts GET/HEAD reads and every other method mutation including HTTP failures",
  { timeout: 5000 },
  async () => {
    const f = await fixture((req, res) => {
      res.writeHead(req.method === "DELETE" ? 403 : 200);
      res.end("real upstream");
    });
    try {
      for (const method of ["GET", "HEAD", "PUT", "POST", "DELETE"]) await request(f.port, method);
      assert.deepEqual(f.observer.counts(), { reads: 2, mutations: 3, failures: 1, active: 0 });
    } finally {
      await f.close();
    }
  },
);
test(
  "observer reports refused upstream and settles the downstream request",
  { timeout: 5000 },
  async () => {
    const port = await freePort();
    let upstreamPort;
    do {
      upstreamPort = await freePort();
    } while (upstreamPort === port);
    // The port is deliberately separately owned and no upstream listener is started.
    const active = await startDatasetProviderObservation({ port, upstreamPort });
    try {
      await assert.rejects(request(port));
      assert.deepEqual(active.counts(), { reads: 1, mutations: 0, failures: 1, active: 0 });
    } finally {
      await active.close();
    }
  },
);
test(
  "observer propagates aborted requests and waits for upstream socket closure",
  { timeout: 5000 },
  async () => {
    let saw;
    const arrived = new Promise((resolve) => {
      saw = resolve;
    });
    let closed;
    const upstreamClosed = new Promise((resolve) => {
      closed = resolve;
    });
    const f = await fixture((req) => {
      req.on("close", closed);
      saw();
    });
    const req = http.request({ hostname: "127.0.0.1", port: f.port, method: "PUT", agent: false });
    req.on("error", () => {});
    req.write("partial");
    await arrived;
    req.destroy();
    await upstreamClosed;
    await f.close();
    assert.deepEqual(f.observer.counts(), { reads: 0, mutations: 1, failures: 1, active: 0 });
  },
);
test(
  "observer close awaits active real response and normal listener cleanup",
  { timeout: 5000 },
  async () => {
    let release, arrived;
    const received = new Promise((resolve) => {
      arrived = resolve;
    });
    const f = await fixture((req, res) => {
      release = () => res.end("finished");
      arrived();
    });
    const pending = request(f.port);
    await received;
    let settled = false;
    const closing = f.observer.close().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.observer.counts().active, 1);
    release();
    assert.equal((await pending).bytes.toString(), "finished");
    await closing;
    assert.equal(f.observer.counts().active, 0);
    await assert.rejects(request(f.port));
    await f.close();
  },
);
test(
  "observer refuses malformed trusted ports before opening a listener",
  { timeout: 5000 },
  async () => {
    for (const port of [0, -1, 65536, 1.5, "19000"])
      await assert.rejects(startDatasetProviderObservation({ port, upstreamPort: 19002 }), /port/);
  },
);
test(
  "observer close is idempotent and counter DTO cannot mutate observations",
  { timeout: 5000 },
  async () => {
    const f = await fixture((req, res) => res.end("ok"));
    try {
      const copy = f.observer.counts();
      copy.reads = 400;
      await request(f.port);
      await Promise.all([f.observer.close(), f.observer.close()]);
      assert.deepEqual(f.observer.counts(), { reads: 1, mutations: 0, failures: 0, active: 0 });
    } finally {
      await f.close();
    }
  },
);
