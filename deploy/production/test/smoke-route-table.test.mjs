import assert from "node:assert/strict";
import test from "node:test";

import { productionBaseUrl, ROUTE_CHECKS, runSmoke } from "../smoke.mjs";

const csp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";
const shell =
  '<html><head><title>Markiro</title><script type="module" src="/assets/main.js"></script></head><body></body></html>';
const docsShell =
  '<!doctype html><html><head><title>API docs</title></head><body><div id="app"></div><script src="/docs/scalar.js"></script ><script src="/docs/bootstrap.js"></script   ></body></html>';
const docsBootstrap = `Scalar.createApiReference("#app", {
  url: "/openapi.json",
  telemetry: false,
  withDefaultFonts: false,
  hideClientButton: true,
  hideTestRequestButton: true,
  showDeveloperTools: "never",
  agent: { disabled: true },
  mcp: { disabled: true }
});`;

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
          body: docsShell,
          headers: { "content-type": "text/html" },
        });
      if (path === "/docs/scalar.js")
        return response({
          body: "window.Scalar={createApiReference:()=>{}}",
          headers: { "content-type": "application/javascript" },
        });
      if (path === "/docs/bootstrap.js")
        return response({
          body: docsBootstrap,
          headers: { "content-type": "application/javascript" },
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

const cleanStoppedState = Object.freeze({
  Status: "exited",
  Running: false,
  Paused: false,
  Restarting: false,
  OOMKilled: false,
  Dead: false,
  Pid: 0,
  ExitCode: 0,
  Error: "",
  StartedAt: "2026-08-04T10:00:00.000000000Z",
  FinishedAt: "2026-08-04T10:00:01.000000000Z",
});

function shutdownInspect(args, state = cleanStoppedState) {
  const value = args.includes("{{json .State}}") ? state : {};
  return { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
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
      ["GET", "/docs", "docs", "same-origin executable documentation shell"],
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
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: '{"3000/tcp":null}\n', stderr: "" };
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  };

  await runSmoke(
    { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
    client,
    docker,
  );

  assert.equal(client.requests.length, ROUTE_CHECKS.length + 2);
  assert.deepEqual(
    client.requests
      .map(({ url }) => new URL(url).pathname)
      .filter((path) => path.startsWith("/docs/")),
    ["/docs/scalar.js", "/docs/bootstrap.js"],
  );
  const commerceMl = client.requests.find(({ url }) => new URL(url).pathname === "/1c_exchange");
  assert.equal(commerceMl.init.body, "type=catalog&mode=checkauth");
  assert.equal(commerceMl.init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(
    dockerCalls.map(([command, args]) => [command, args.slice(-4)]),
    [
      ["docker", ["compose.production.yml", "ps", "-q", "api"]],
      ["docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}}", "container-id"]],
      ["docker", ["-T", "api", "id", "-u"]],
      ["docker", ["api", "test", "-w", "/"]],
    ],
  );
});

test("rejects an API container with an actual host port binding", async () => {
  for (const binding of [
    '{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"3000"}]}\n',
    '{"3000/tcp":{"HostIp":"0.0.0.0","HostPort":"3000"}}\n',
  ]) {
    const docker = {
      async run(command, args) {
        if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
        if (args[0] === "inspect") return { code: 0, stdout: binding, stderr: "" };
        if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    };

    await assert.rejects(
      runSmoke(
        { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
        smokeClient(),
        docker,
      ),
      /published/,
    );
  }
});

test("accepts only exact no-binding PortBindings shapes", async (t) => {
  for (const [name, binding] of [
    ["top-level null", "null\n"],
    ["empty object", "{}\n"],
    ["object containing only null values", '{"3000/tcp":null,"3001/tcp":null}\n'],
  ]) {
    await t.test(name, async () => {
      const docker = {
        async run(command, args) {
          if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
          if (args[0] === "inspect") return { code: 0, stdout: binding, stderr: "" };
          if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
          return { code: 1, stdout: "", stderr: "" };
        },
      };

      await runSmoke(
        { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
        smokeClient(),
        docker,
      );
    });
  }
});

test("rejects every non-null PortBindings value, including empty arrays", async (t) => {
  for (const [name, binding] of [
    ["empty array", '{"3000/tcp":[]}\n'],
    ["nonempty binding array", '{"3000/tcp":[{"HostIp":"","HostPort":"3000"}]}\n'],
    ["object", '{"3000/tcp":{}}\n'],
    ["string", '{"3000/tcp":""}\n'],
    ["number", '{"3000/tcp":0}\n'],
    ["boolean", '{"3000/tcp":false}\n'],
  ]) {
    await t.test(name, async () => {
      const docker = {
        async run(command, args) {
          if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
          if (args[0] === "inspect") return { code: 0, stdout: binding, stderr: "" };
          if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
          return { code: 1, stdout: "", stderr: "" };
        },
      };

      await assert.rejects(
        runSmoke(
          { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
          smokeClient(),
          docker,
        ),
        /published/,
      );
    });
  }
});

test("rejects missing or invalid API host-port inspection output", async () => {
  for (const inspect of [
    { code: 1, stdout: "", stderr: "inspect failed" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "not json", stderr: "" },
    { code: 0, stdout: "[]", stderr: "" },
    { code: 0, stdout: "[null]", stderr: "" },
    { code: 0, stdout: '"value"', stderr: "" },
    { code: 0, stdout: "0", stderr: "" },
    { code: 0, stdout: "false", stderr: "" },
  ]) {
    const docker = {
      async run(command, args) {
        if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
        if (args[0] === "inspect") return inspect;
        if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    };
    await assert.rejects(
      runSmoke(
        { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
        smokeClient(),
        docker,
      ),
      /port inspection/,
    );
  }
});

test("requires the pruned API runtime to exclude Playwright and OpenTelemetry", async (t) => {
  const dockerForProbe = (probeExitCode) => ({
    async run(_command, args) {
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: '{"3000/tcp":null}\n', stderr: "" };
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      if (args.includes("node")) return { code: probeExitCode, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const options = {
    baseUrl: "https://app.markiro.example",
    assetName: "main.js",
    environment: { SMOKE_ASSERT_DEPENDENCY_ISOLATION: "1" },
  };

  await t.test("accepts an isolated runtime", async () => {
    const calls = [];
    const docker = dockerForProbe(0);
    const run = docker.run.bind(docker);
    docker.run = async (command, args) => {
      calls.push([command, args]);
      return run(command, args);
    };

    await runSmoke(options, smokeClient(), docker);

    const probe = calls.find(([, args]) => args.includes("node"));
    assert.ok(probe);
    assert.deepEqual(probe[1].slice(-5, -2), ["node", "--input-type=module", "--eval"]);
    assert.equal(probe[1].at(-1), "/app/node_modules");
    assert.match(probe[1].at(-2), /@playwright\/test/);
    assert.match(probe[1].at(-2), /@opentelemetry\/api/);
    assert.doesNotMatch(probe[1].at(-2), /require\.resolve/);
  });

  await t.test("rejects a runtime containing either dependency", async () => {
    await assert.rejects(
      runSmoke(options, smokeClient(), dockerForProbe(1)),
      /forbidden tooling or telemetry dependency/,
    );
  });

  await t.test(
    "reports an indeterminate dependency scan separately from a forbidden match",
    async () => {
      await assert.rejects(
        runSmoke(options, smokeClient(), dockerForProbe(2)),
        /runtime dependency scan failed/,
      );
    },
  );
});

test("rejects every unavailable API container ID before inspect", async (t) => {
  for (const [name, ps] of [
    ["nonzero compose ps", { code: 1, stdout: "container-id\n", stderr: "ps failed" }],
    ["empty compose ps", { code: 0, stdout: "", stderr: "" }],
    ["whitespace compose ps", { code: 0, stdout: " \t\n", stderr: "" }],
  ]) {
    await t.test(name, async () => {
      let inspected = false;
      const docker = {
        async run(command, args) {
          if (args.includes("ps")) return ps;
          if (args[0] === "inspect") inspected = true;
          return { code: 1, stdout: "", stderr: "" };
        },
      };

      await assert.rejects(
        runSmoke(
          { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
          smokeClient(),
          docker,
        ),
        /container ID is unavailable/,
      );
      assert.equal(inspected, false);
    });
  }
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
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
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

test("accepts the exact Nest 11 JSON 404 for the absent station bootstrap endpoint", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = async (url, init) =>
    new URL(url).pathname === "/station/bootstrap"
      ? response({
          status: 404,
          body: '{"statusCode":404,"message":"Cannot GET /station/bootstrap","error":"Not Found"}',
          headers: { "content-type": "application/json" },
        })
      : original(url, init);
  const docker = {
    run: async (command, args) =>
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
            ? { code: 0, stdout: "10001\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
  };

  await runSmoke(
    { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
    client,
    docker,
  );
});

test("preserves valid JSON 200, 401, and 403 station responses", async (t) => {
  for (const status of [200, 401, 403]) {
    await t.test(String(status), async () => {
      const client = smokeClient();
      const original = client.request;
      client.request = async (url, init) =>
        new URL(url).pathname === "/station/bootstrap"
          ? response({
              status,
              body: '{"upstream":true}',
              headers: { "content-type": "application/json; charset=utf-8" },
            })
          : original(url, init);
      const docker = {
        run: async (command, args) =>
          args.includes("ps")
            ? { code: 0, stdout: "container-id\n", stderr: "" }
            : args[0] === "inspect"
              ? { code: 0, stdout: "{}\n", stderr: "" }
              : args.includes("id")
                ? { code: 0, stdout: "10001\n", stderr: "" }
                : { code: 1, stdout: "", stderr: "" },
      };

      await runSmoke(
        { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
        client,
        docker,
      );
    });
  }
});

test("rejects arbitrary JSON 404 bodies for station bootstrap", async (t) => {
  for (const [name, body] of [
    ["generic Nest message", '{"statusCode":404,"message":"Not Found","error":"Not Found"}'],
    [
      "wrong request path",
      '{"statusCode":404,"message":"Cannot GET /station/other","error":"Not Found"}',
    ],
    ["missing error", '{"statusCode":404,"message":"Cannot GET /station/bootstrap"}'],
    [
      "extra property",
      '{"statusCode":404,"message":"Cannot GET /station/bootstrap","error":"Not Found","path":"/station/bootstrap"}',
    ],
    ["array", '[{"statusCode":404}]'],
    ["primitive", "404"],
  ]) {
    await t.test(name, async () => {
      const client = smokeClient();
      const original = client.request;
      client.request = async (url, init) =>
        new URL(url).pathname === "/station/bootstrap"
          ? response({ status: 404, body, headers: { "content-type": "application/json" } })
          : original(url, init);
      const docker = {
        run: async (command, args) =>
          args.includes("ps")
            ? { code: 0, stdout: "container-id\n", stderr: "" }
            : args[0] === "inspect"
              ? { code: 0, stdout: "{}\n", stderr: "" }
              : args.includes("id")
                ? { code: 0, stdout: "10001\n", stderr: "" }
                : { code: 1, stdout: "", stderr: "" },
      };

      await assert.rejects(
        runSmoke(
          { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
          client,
          docker,
        ),
        /station bootstrap/,
      );
    });
  }
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
          if (args[0] === "inspect") return shutdownInspect(args);
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
        if (args[0] === "inspect") return shutdownInspect(args);
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

test("restores the API through the fixed CI image override when requested", async () => {
  const calls = [];
  const docker = {
    async run(command, args) {
      calls.push(args);
      if (args[0] === "inspect") return shutdownInspect(args);
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "stop") return { code: 0, stdout: "", stderr: "" };
      return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
    },
  };

  await runSmoke(
    {
      baseUrl: "https://app.markiro.example",
      assetName: "main.js",
      environment: {
        MARKIRO_ENV_FILE: "/private/ci.env",
        MARKIRO_SMOKE_CI_OVERLAY: "1",
        SMOKE_ASSERT_SHUTDOWN: "1",
      },
    },
    smokeClient(),
    docker,
  );

  const restored = calls.find((args) => args.includes("up") && args.at(-1) === "api");
  assert.deepEqual(restored, [
    "compose",
    "--env-file",
    "/private/ci.env",
    "-f",
    "compose.production.yml",
    "-f",
    "deploy/production/compose.ci.yml",
    "up",
    "-d",
    "--no-deps",
    "api",
  ]);
});

test("reports a restore failure after attempting shutdown", async () => {
  const calls = [];
  const docker = {
    async run(command, args) {
      calls.push(args);
      if (args[0] === "inspect") return shutdownInspect(args);
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
      if (args[0] === "inspect") return shutdownInspect(args);
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

test("rejects unclean stopped container states and always restores the API", async () => {
  for (const state of [
    { ...cleanStoppedState, ExitCode: 137 },
    { ...cleanStoppedState, OOMKilled: true },
    { ...cleanStoppedState, Error: "secret engine state detail" },
  ]) {
    const calls = [];
    const docker = {
      async run(command, args) {
        calls.push(args);
        if (args[0] === "inspect") return shutdownInspect(args, state);
        if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
        if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
        if (args[0] === "stop") return { code: 0, stdout: "", stderr: "", durationMs: 1 };
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
        assert.match(error.message, /cleanly/);
        assert.doesNotMatch(error.message, /secret engine/);
        return true;
      },
    );
    assert.ok(calls.some((args) => args.includes("{{json .State}}")));
    assert.ok(calls.some((args) => args.includes("up") && args.at(-1) === "api"));
  }
});

test("rejects an unknown route with an HTML content type and structurally distinguishes the shell", async () => {
  const docker = {
    run: async (command, args) =>
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
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
          body: `<html><title>Markiro</title><p>/assets/main.js</p><script src="/docs/scalar.js"></script><script src="/docs/bootstrap.js"></script></html>`,
          headers: { "content-type": "text/html" },
        })
      : originalStructured(url, init);
  await runSmoke(
    { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
    structured,
    docker,
  );
});

test("rejects documentation that cannot execute under the production CSP", async (t) => {
  const docker = {
    run: async (command, args) =>
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
            ? { code: 0, stdout: "10001\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
  };

  for (const [name, docs, expected] of [
    [
      "inline initializer",
      '<html><script src="/docs/scalar.js"></script><script>Scalar.createApiReference()</script></html>',
      /inline script/,
    ],
    [
      "external bundle",
      '<html><script src="https://cdn.example/scalar.js"></script><script src="/docs/bootstrap.js"></script></html>',
      /external origin/,
    ],
  ]) {
    await t.test(name, async () => {
      const client = smokeClient();
      const original = client.request;
      client.request = async (url, init) =>
        new URL(url).pathname === "/docs"
          ? response({ body: docs, headers: { "content-type": "text/html" } })
          : original(url, init);
      await assert.rejects(
        runSmoke(
          { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
          client,
          docker,
        ),
        expected,
      );
    });
  }
});

test("rejects unavailable documentation scripts and a bootstrap with the wrong document target", async (t) => {
  const docker = {
    run: async (command, args) =>
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
            ? { code: 0, stdout: "10001\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
  };

  for (const [name, path, overridden, expected] of [
    [
      "wrong script content type",
      "/docs/scalar.js",
      response({ body: "window.Scalar={}", headers: { "content-type": "text/html" } }),
      /JavaScript/,
    ],
    [
      "empty script",
      "/docs/scalar.js",
      response({ body: "", headers: { "content-type": "application/javascript" } }),
      /empty/,
    ],
    [
      "missing Scalar browser global",
      "/docs/scalar.js",
      response({
        body: "function createApiReference() {}",
        headers: { "content-type": "application/javascript" },
      }),
      /browser global/,
    ],
    [
      "Scalar dynamic code probe",
      "/docs/scalar.js",
      response({
        body: "window.Scalar = { createApiReference: () => Function(``) };",
        headers: { "content-type": "application/javascript" },
      }),
      /dynamic code/,
    ],
    [
      "wrong OpenAPI target",
      "/docs/bootstrap.js",
      response({
        body: 'Scalar.createApiReference("#app", { url: "/private.json" });',
        headers: { "content-type": "application/javascript" },
      }),
      /openapi\.json/,
    ],
    [
      "missing disabled interactive integrations",
      "/docs/bootstrap.js",
      response({
        body: 'Scalar.createApiReference("#app", { url: "/openapi.json" });',
        headers: { "content-type": "application/javascript" },
      }),
      /safe Scalar configuration/,
    ],
  ]) {
    await t.test(name, async () => {
      const client = smokeClient();
      const original = client.request;
      client.request = async (url, init) =>
        new URL(url).pathname === path ? overridden : original(url, init);
      await assert.rejects(
        runSmoke(
          { baseUrl: "https://app.markiro.example", assetName: "main.js", environment: {} },
          client,
          docker,
        ),
        expected,
      );
    });
  }
});
