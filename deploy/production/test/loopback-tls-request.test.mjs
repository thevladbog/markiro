import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { createLoopbackTlsRequest } from "../loopback-tls-request.mjs";

test("loopback TLS keeps the approved authority for certificate verification and routes only the socket locally", async () => {
  let captured;
  const request = createLoopbackTlsRequest((options, onResponse) => {
    captured = options;
    const outgoing = new EventEmitter();
    outgoing.end = (body) => {
      assert.equal(body, "{}");
      const incoming = Readable.from([Buffer.from("ok")]);
      incoming.statusCode = 200;
      incoming.statusMessage = "OK";
      incoming.rawHeaders = ["Content-Type", "text/plain"];
      onResponse(incoming);
    };
    return outgoing;
  });

  const response = await request(
    new URL("https://app.markiro.example/private?candidate=1"),
    {
      method: "POST",
      body: "{}",
      headers: { host: "v-b.tech", "content-type": "application/json" },
      redirect: "manual",
    },
    AbortSignal.timeout(5_000),
  );

  assert.equal(captured.hostname, "app.markiro.example");
  assert.equal(captured.servername, "app.markiro.example");
  assert.equal(captured.port, 443);
  assert.equal(captured.path, "/private?candidate=1");
  assert.equal(captured.rejectUnauthorized, true);
  assert.equal(captured.headers.host, "v-b.tech");
  assert.deepEqual(await lookup(captured, "app.markiro.example"), {
    address: "127.0.0.1",
    family: 4,
  });
  await assert.rejects(() => lookup(captured, "other.example"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(await response.text(), "ok");
});

test("loopback TLS rejects an untrusted target or request shape before opening a socket", async () => {
  let calls = 0;
  const request = createLoopbackTlsRequest(() => {
    calls += 1;
    throw new Error("socket must not open");
  });

  for (const [url, init] of [
    ["http://app.markiro.example/", { method: "GET" }],
    ["https://127.0.0.1/", { method: "GET" }],
    ["https://app.markiro.example:8443/", { method: "GET" }],
    ["https://user:pass@app.markiro.example/", { method: "GET" }],
    ["https://app.markiro.example/#fragment", { method: "GET" }],
    ["https://app.markiro.example/", { method: "GET", redirect: "follow" }],
    ["https://app.markiro.example/", { method: "GET", dispatcher: {} }],
  ])
    await assert.rejects(() => request(url, init), /loopback TLS request is invalid/);

  assert.equal(calls, 0);
});

function lookup(options, hostname) {
  return new Promise((resolve, reject) => {
    options.lookup(hostname, {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}
