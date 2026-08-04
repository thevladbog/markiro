import assert from "node:assert/strict";
import test from "node:test";

import { ROUTE_CHECKS, runSmoke } from "../smoke.mjs";

const csp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";
const shell =
  '<html><head><title>Markiro</title><script type="module" src="/assets/main.js"></script></head><body></body></html>';

function response({ status = 200, body = "{}", headers = {} } = {}) {
  return {
    status,
    headers: new Headers({
      "content-security-policy": csp,
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "strict-origin-when-cross-origin",
      ...headers,
    }),
    text: async () => body,
  };
}

function smokeClient() {
  const requests = [];
  return {
    requests,
    async request(url, init) {
      requests.push({ url, init });
      const path = new URL(url).pathname;
      if (path === "/" || path === "/team/deep-link")
        return response({
          body: shell,
          headers: { "cache-control": "no-cache", "content-type": "text/html" },
        });
      if (path === "/assets/main.js")
        return response({
          body: "console.log('ok')",
          headers: { "cache-control": "public, max-age=31536000, immutable" },
        });
      if (path === "/health/ready" || path === "/api/health/ready")
        return response({
          body: '{"status":"degraded"}',
          headers: { "content-type": "application/json" },
        });
      if (path === "/docs")
        return response({
          body: "<html><title>API docs</title></html>",
          headers: { "content-type": "text/html" },
        });
      if (path === "/unknown")
        return response({
          status: 404,
          body: "not found",
          headers: { "content-type": "text/plain" },
        });
      return response({
        status: path === "/1c_exchange" ? 401 : 200,
        body: '{"status":"ok"}',
        headers: { "content-type": "application/json" },
      });
    },
  };
}

test("defines the complete immutable public-route smoke contract", () => {
  assert.ok(Object.isFrozen(ROUTE_CHECKS));
  assert.deepEqual(
    ROUTE_CHECKS.map(({ method, path, kind }) => [method, path, kind]),
    [
      ["GET", "/", "admin-shell"],
      ["GET", "/assets/${assetName}", "asset"],
      ["GET", "/team/deep-link", "admin-shell"],
      ["GET", "/api/auth/get-session", "proxy"],
      ["GET", "/api/health/live", "json"],
      ["GET", "/api/health/ready", "ready-json"],
      ["GET", "/station/bootstrap", "proxy"],
      ["GET", "/kiosk/bootstrap", "proxy"],
      ["POST", "/1c_exchange", "commerce-ml"],
      ["GET", "/health/live", "json"],
      ["GET", "/health/ready", "ready-json"],
      ["GET", "/openapi.json", "json"],
      ["GET", "/docs", "proxy-html"],
      ["POST", "/unknown", "not-found"],
    ],
  );
  for (const check of ROUTE_CHECKS) assert.ok(Object.isFrozen(check));
});

test("smokes public routing, headers, and unprivileged runtime without accepting a proxied SPA", async () => {
  const client = smokeClient();
  const dockerCalls = [];
  const docker = {
    async run(command, args) {
      dockerCalls.push([command, args]);
      if (args.includes("port")) return { code: 1, stdout: "", stderr: "" };
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  };

  await runSmoke(
    { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
    client,
    docker,
  );

  assert.equal(client.requests.length, ROUTE_CHECKS.length);
  const commerceMl = client.requests.find(({ url }) => new URL(url).pathname === "/1c_exchange");
  assert.equal(commerceMl.init.body, "type=catalog&mode=checkauth");
  assert.equal(commerceMl.init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(
    dockerCalls.map(([command, args]) => [command, args.slice(-4)]),
    [
      ["docker", ["compose.production.yml", "port", "api", "3000"]],
      ["docker", ["-T", "api", "id", "-u"]],
      ["docker", ["api", "test", "-w", "/"]],
    ],
  );
});

test("rejects an admin shell on an API response", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = async (url, init) => {
    if (new URL(url).pathname === "/api/auth/get-session")
      return response({ body: shell, headers: { "content-type": "text/html" } });
    return original(url, init);
  };
  const docker = { run: async () => ({ code: 1, stdout: "", stderr: "" }) };

  await assert.rejects(
    runSmoke(
      { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
      client,
      docker,
    ),
    /admin shell/,
  );
});

test("rejects an external origin in the built root", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = async (url, init) => {
    if (new URL(url).pathname === "/") {
      return response({
        body: shell.replace(
          "</head>",
          '<link rel="stylesheet" href="https://cdn.example/style.css"></head>',
        ),
        headers: { "cache-control": "no-cache", "content-type": "text/html" },
      });
    }
    return original(url, init);
  };
  const docker = { run: async () => ({ code: 1, stdout: "", stderr: "" }) };

  await assert.rejects(
    runSmoke(
      { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
      client,
      docker,
    ),
    /external origin/,
  );
});
