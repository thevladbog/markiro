import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../healthcheck.mjs", import.meta.url));

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}/health/ready`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function execute(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, HEALTHCHECK_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function assertResult(result, expectedCode) {
  assert.equal(result.code, expectedCode);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

for (const status of ["ok", "degraded"]) {
  test(`healthcheck succeeds for a 200 ${status} readiness response`, async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status }));
      },
      async (url) => assertResult(await execute(url), 0),
    );
  });
}

for (const [name, handler] of [
  [
    "unavailable readiness response",
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "unavailable" }));
    },
  ],
  [
    "non-JSON response",
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    },
  ],
  [
    "HTTP 503 response",
    (_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    },
  ],
  [
    "response delayed beyond two seconds",
    (_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
      }, 2_100);
    },
  ],
]) {
  test(`healthcheck fails for ${name}`, async () => {
    await withServer(handler, async (url) => assertResult(await execute(url), 1));
  });
}

test("healthcheck fails for a refused connection", async () => {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");

  assertResult(await execute(`http://127.0.0.1:${port}/health/ready`), 1);
});
