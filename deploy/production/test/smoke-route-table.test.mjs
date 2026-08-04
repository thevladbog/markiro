import assert from "node:assert/strict";
import test from "node:test";

import { productionBaseUrl, ROUTE_CHECKS, runSmoke } from "../smoke.mjs";

const csp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";
const shell =
  '<html><head><title>Markiro</title><script type="module" src="/assets/main.js"></script></head><body></body></html>';

test("uses the configured HTTPS port for production-bundle smoke", () => {
  assert.equal(
    productionBaseUrl({ MARKIRO_DOMAIN: "localhost", MARKIRO_HTTPS_PORT: "18443" }),
    "https://localhost:18443",
  );
  assert.equal(productionBaseUrl({ MARKIRO_DOMAIN: "markiro.example" }), "https://markiro.example");
});

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
      if (path === "/1c_exchange")
        return response({ body: "failure\n", headers: { "content-type": "text/plain" } });
      return response({ body: '{"status":"ok"}', headers: { "content-type": "application/json" } });
    },
  };
}

test("defines the complete immutable public-route smoke contract", () => {
  assert.ok(Object.isFrozen(ROUTE_CHECKS));
  assert.deepEqual(
    ROUTE_CHECKS.map(({ method, path, kind, expected }) => [method, path, kind, expected]),
    [
      ["GET", "/", "admin-shell", "200 HTML admin shell"],
      ["GET", "/assets/${assetName}", "asset", "200, immutable cache"],
      ["GET", "/team/deep-link", "admin-shell", "200 admin shell, no-cache"],
      ["GET", "/api/auth/get-session", "proxy", "not SPA; upstream path retains /api/auth/"],
      ["GET", "/api/health/live", "json", "200 JSON from upstream /health/live"],
      ["GET", "/api/health/ready", "ready-json", "200 JSON from upstream /health/ready"],
      ["GET", "/station/bootstrap", "station-proxy", "not SPA"],
      ["GET", "/kiosk/bootstrap", "proxy", "not SPA"],
      ["POST", "/1c_exchange", "commerce-ml", "not SPA and request body reaches API unchanged"],
      ["GET", "/health/live", "json", "200 JSON"],
      ["GET", "/health/ready", "ready-json", "200 JSON ok or degraded"],
      ["GET", "/openapi.json", "json", "200 JSON"],
      ["GET", "/docs", "proxy-html", "upstream HTML, not admin shell"],
      ["POST", "/unknown", "not-found", "404, not HTML"],
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
  const docker = {
    run: async (command, args) =>
      args.includes("id")
        ? { code: 0, stdout: "10001\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
  };

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

test("accepts a Nest JSON 404 only for the absent station bootstrap endpoint", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = async (url, init) =>
    new URL(url).pathname === "/station/bootstrap"
      ? response({
          status: 404,
          body: '{"statusCode":404,"message":"Not Found"}',
          headers: { "content-type": "application/json" },
        })
      : original(url, init);
  const docker = {
    run: async (command, args) =>
      args.includes("id")
        ? { code: 0, stdout: "10001\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
  };

  await runSmoke(
    { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
    client,
    docker,
  );
});

test("rejects an edge 404 for station bootstrap and proxy 404s elsewhere", async () => {
  const docker = {
    run: async (command, args) =>
      args.includes("id")
        ? { code: 0, stdout: "10001\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
  };
  for (const [path, altered, expected] of [
    [
      "/station/bootstrap",
      response({ status: 404, body: "not found", headers: { "content-type": "text/plain" } }),
      /station bootstrap/,
    ],
    [
      "/kiosk/bootstrap",
      response({ status: 404, headers: { "content-type": "application/json" } }),
      /proxy/,
    ],
    [
      "/api/health/live",
      response({ body: "not json", headers: { "content-type": "application/json" } }),
      /JSON/,
    ],
    [
      "/1c_exchange",
      response({ body: '{"status":"failure"}', headers: { "content-type": "application/json" } }),
      /1C exchange/,
    ],
  ]) {
    const client = smokeClient();
    const original = client.request;
    client.request = async (url, init) =>
      new URL(url).pathname === path ? altered : original(url, init);
    await assert.rejects(
      runSmoke(
        { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
        client,
        docker,
      ),
      expected,
    );
  }
});

test(
  "restores API after a failed or timed-out shutdown and rejects false-positive readiness",
  { timeout: 200 },
  async () => {
    for (const stop of [
      async () => ({ code: 1, stdout: "", stderr: "" }),
      async () => ({ code: 0, stdout: "", stderr: "", durationMs: 30_001 }),
      async () => new Promise(() => undefined),
    ]) {
      const calls = [];
      const docker = {
        async run(command, args) {
          calls.push(args);
          if (args.includes("port")) return { code: 1, stdout: "", stderr: "" };
          if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
          if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
          if (args[0] === "stop") return stop();
          return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
        },
      };
      await assert.rejects(
        runSmoke(
          {
            baseUrl: "https://app.markiro.example",
            assetName: "main.js",
            environment: { SMOKE_ASSERT_SHUTDOWN: "1" },
            commandTimeoutMs: 5,
          },
          smokeClient(),
          docker,
        ),
        /stop|timed out|gracefully/,
      );
      assert.ok(calls.some((args) => args.includes("up") && args.at(-1) === "api"));
    }

    const client = smokeClient();
    const docker = {
      restored: false,
      async run(command, args) {
        if (args.includes("port")) return { code: 1, stdout: "", stderr: "" };
        if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
        if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
        if (args[0] === "stop") return { code: 0, stdout: "", stderr: "" };
        if (args.includes("up")) this.restored = true;
        return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
      },
    };
    const original = client.request;
    client.request = async (url, init) =>
      docker.restored && new URL(url).pathname === "/health/ready"
        ? response({ body: shell, headers: { "content-type": "text/html" } })
        : original(url, init);
    await assert.rejects(
      runSmoke(
        {
          baseUrl: "https://app.markiro.example",
          assetName: "main.js",
          environment: { SMOKE_ASSERT_SHUTDOWN: "1" },
          commandTimeoutMs: 5,
          readinessAttempts: 1,
          readinessIntervalMs: 0,
          sleep: async () => undefined,
        },
        client,
        docker,
      ),
      /ready/,
    );
  },
);

test("reports a restore failure after attempting shutdown", async () => {
  const calls = [];
  const docker = {
    async run(command, args) {
      calls.push(args);
      if (args.includes("port")) return { code: 1, stdout: "", stderr: "" };
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "stop") return { code: 0, stdout: "", stderr: "" };
      if (args.includes("up")) return { code: 1, stdout: "", stderr: "" };
      return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
    },
  };

  await assert.rejects(
    runSmoke(
      {
        baseUrl: "https://app.markiro.example",
        assetName: "main.js",
        environment: { SMOKE_ASSERT_SHUTDOWN: "1" },
        commandTimeoutMs: 5,
      },
      smokeClient(),
      docker,
    ),
    /not restored/,
  );
  assert.ok(calls.some((args) => args[0] === "stop"));
  assert.ok(calls.some((args) => args.includes("up") && args.at(-1) === "api"));
});

test("surfaces both sanitized shutdown and restoration failures", async () => {
  const docker = {
    async run(command, args) {
      if (args.includes("port")) return { code: 1, stdout: "", stderr: "" };
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "stop") return { code: 1, stdout: "", stderr: "secret stop stderr" };
      if (args.includes("up")) return { code: 1, stdout: "", stderr: "secret restore stderr" };
      return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
    },
  };

  await assert.rejects(
    runSmoke(
      {
        baseUrl: "https://app.markiro.example",
        assetName: "main.js",
        environment: { SMOKE_ASSERT_SHUTDOWN: "1" },
      },
      smokeClient(),
      docker,
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /gracefully/);
      assert.match(error.message, /not restored/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test("rejects an unknown route with an HTML content type and structurally distinguishes the shell", async () => {
  const docker = {
    run: async (command, args) =>
      args.includes("id")
        ? { code: 0, stdout: "10001\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
  };
  const html404 = smokeClient();
  const original404 = html404.request;
  html404.request = async (url, init) =>
    new URL(url).pathname === "/unknown"
      ? response({ status: 404, body: "not found", headers: { "content-type": "text/html" } })
      : original404(url, init);
  await assert.rejects(
    runSmoke(
      { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
      html404,
      docker,
    ),
    /non-HTML/,
  );

  const structured = smokeClient();
  const originalStructured = structured.request;
  structured.request = async (url, init) =>
    new URL(url).pathname === "/docs"
      ? response({
          body: '<html><title>Markiro</title><script src="/assets/other.js" type="module"></script><p>/assets/main.js</p></html>',
          headers: { "content-type": "text/html" },
        })
      : originalStructured(url, init);
  await runSmoke(
    { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
    structured,
    docker,
  );
});
