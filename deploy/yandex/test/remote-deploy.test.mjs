import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runPreflight } from "../../production/preflight.mjs";
import {
  deployRelease,
  runRemoteDeployment,
  runRemoteDeploymentWithReporting,
  streamArchive,
  waitForAlbTarget,
} from "../remote-deploy.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "987654321";
const API = `ghcr.io/thevladbog/markiro-api@sha256:${"a".repeat(64)}`;
const EDGE = `ghcr.io/thevladbog/markiro-edge@sha256:${"b".repeat(64)}`;
const MANIFEST = JSON.stringify({
  api: API,
  commit: COMMIT,
  createdAt: "2026-08-05T10:00:00.000Z",
  edge: EDGE,
  workflowRunId: RUN_ID,
});
const CANDIDATE = {
  tag: COMMIT,
  previousTag: "f".repeat(40),
  apiDigest: API,
  edgeDigest: EDGE,
  state: "pending",
  createdAt: "2026-08-05T10:20:30.000Z",
};
const FIRST_CANDIDATE = { ...CANDIDATE, previousTag: null };

test("release transfer terminates tar when SSH exits before consuming the archive", async () => {
  const archive = Object.assign(new EventEmitter(), {
    exitCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killCalled: false,
    kill() {
      this.killCalled = true;
      this.exitCode = null;
      queueMicrotask(() => this.emit("close", null));
      return true;
    },
  });
  const remote = Object.assign(new EventEmitter(), {
    exitCode: null,
    stderr: new PassThrough(),
    kill() {
      return true;
    },
  });
  const children = [archive, remote];

  const transfer = streamArchive(["-cf", "-"], ["host", "tar"], {
    spawn: () => children.shift(),
    timeoutMs: 1_000,
  });
  remote.exitCode = 255;
  remote.emit("close", 255);

  await assert.rejects(transfer, /private release transfer failed/);
  assert.equal(archive.killCalled, true);
  assert.equal(archive.stdout.destroyed, true);
});

test("ALB target gate waits for the exact application target through transitional states", async () => {
  const responses = [
    {
      targetStates: [
        {
          target: { ipAddress: "10.20.0.7" },
          status: { zoneStatuses: [{ status: "UNHEALTHY" }] },
        },
      ],
    },
    {
      targetStates: [
        {
          target: { ipAddress: "10.20.0.7" },
          status: { zoneStatuses: [{ status: "HEALTHY" }] },
        },
      ],
    },
  ];
  const sleeps = [];
  let now = 0;

  await waitForAlbTarget({
    expectedAddress: "10.20.0.7",
    fetchTargetStates: async () => responses.shift(),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    monotonicNow: () => now,
    timeoutMs: 1_000,
    initialBackoffMs: 100,
    maxBackoffMs: 200,
  });

  assert.deepEqual(sleeps, [100]);
});

test("ALB target gate rejects a stale healthy target and reports only a bounded sanitized cause", async () => {
  let now = 0;
  await assert.rejects(
    waitForAlbTarget({
      expectedAddress: "10.20.0.7",
      fetchTargetStates: async () => ({
        targetStates: [
          {
            target: { ipAddress: "10.20.0.8" },
            status: { zoneStatuses: [{ status: "HEALTHY" }] },
          },
        ],
      }),
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      monotonicNow: () => now,
      timeoutMs: 250,
      initialBackoffMs: 100,
      maxBackoffMs: 100,
    }),
    /production ALB gate failed after 250ms \(last cause: expected target unavailable\)/,
  );
});

test("ALB target gate rejects the legacy-only address field", async () => {
  let now = 0;
  await assert.rejects(
    waitForAlbTarget({
      expectedAddress: "10.20.0.7",
      fetchTargetStates: async () => ({
        targetStates: [
          {
            target: { address: "10.20.0.7" },
            status: { zoneStatuses: [{ status: "HEALTHY" }] },
          },
        ],
      }),
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      monotonicNow: () => now,
      timeoutMs: 100,
      initialBackoffMs: 100,
      maxBackoffMs: 100,
    }),
    /production ALB gate failed after 100ms \(last cause: expected target unavailable\)/,
  );
});

test("ALB target gate abort-bounds malformed provider responses without exposing them", async () => {
  let now = 0;
  let signal;
  await assert.rejects(
    waitForAlbTarget({
      expectedAddress: "10.20.0.7",
      fetchTargetStates: async (options) => {
        signal = options.signal;
        return { targetStates: [{ target: { ipAddress: "10.20.0.7" }, status: {} }] };
      },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      monotonicNow: () => now,
      timeoutMs: 100,
      initialBackoffMs: 100,
      maxBackoffMs: 100,
    }),
    /production ALB gate failed after 100ms \(last cause: malformed target response\)/,
  );
  assert.ok(signal instanceof AbortSignal);
});

function sshField(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function publicKey(algorithm, seed = 1) {
  const blob =
    algorithm === "ssh-ed25519"
      ? Buffer.concat([sshField(algorithm), sshField(Buffer.alloc(32, seed))])
      : Buffer.concat([
          sshField(algorithm),
          sshField(Buffer.from([1, 0, 1])),
          sshField(Buffer.alloc(64, seed)),
        ]);
  return `${algorithm} ${blob.toString("base64")}`;
}

const ED25519_KEY = publicKey("ssh-ed25519");
const RSA_KEY = publicKey("ssh-rsa");

function orchestrationFixture({ candidate = CANDIDATE, failAt } = {}) {
  const events = [];
  const phase = async (name, result) => {
    events.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
    return result;
  };
  return {
    events,
    dependencies: {
      expectedWorkflowRunId: RUN_ID,
      expectedCommit: COMMIT,
      transferBundle: () => phase("transfer immutable bundle"),
      refreshRuntime: () => phase("runtime refresh"),
      prepare: () => phase("remote prepare", candidate),
      verifyAlb: () => phase("ALB healthy"),
      smoke: () => phase("external smoke"),
      finalize: () => phase("remote finalize", { ...candidate, state: "healthy" }),
      rollback: () => phase("remote rollback", { ...candidate, state: "failed" }),
    },
  };
}

test("deployRelease uses the staged boundary in exact ALB, external smoke, finalize order", async () => {
  const { dependencies, events } = orchestrationFixture();

  const record = await deployRelease(dependencies, MANIFEST);

  assert.deepEqual(events, [
    "transfer immutable bundle",
    "runtime refresh",
    "remote prepare",
    "ALB healthy",
    "external smoke",
    "remote finalize",
  ]);
  assert.equal(record.state, "healthy");
});

test("first deployment runs the ALB pre-DNS probe and never uses public DNS smoke", async () => {
  const { dependencies, events } = orchestrationFixture({ candidate: FIRST_CANDIDATE });
  dependencies.deploymentPhase = "first";
  delete dependencies.smoke;
  dependencies.preDnsSmoke = () => {
    events.push("pre-DNS ALB smoke");
  };

  const record = await deployRelease(dependencies, MANIFEST);

  assert.equal(record.state, "healthy");
  assert.deepEqual(events, [
    "transfer immutable bundle",
    "runtime refresh",
    "remote prepare",
    "ALB healthy",
    "pre-DNS ALB smoke",
    "remote finalize",
  ]);
});

test("separately selected first-release rehearsal stops the running candidate before finalize", async () => {
  const { dependencies, events } = orchestrationFixture({ candidate: FIRST_CANDIDATE });
  dependencies.deploymentPhase = "first";
  dependencies.rollbackRehearsal = true;
  delete dependencies.smoke;
  dependencies.preDnsSmoke = () => events.push("pre-DNS ALB smoke");

  const record = await deployRelease(dependencies, MANIFEST);

  assert.deepEqual(record, { state: "rehearsed", tag: COMMIT });
  assert.deepEqual(events, [
    "transfer immutable bundle",
    "runtime refresh",
    "remote prepare",
    "ALB healthy",
    "pre-DNS ALB smoke",
    "remote rollback",
  ]);
});

test("rollback rehearsal never retries a failed first-release stop", async () => {
  const { dependencies, events } = orchestrationFixture({ candidate: FIRST_CANDIDATE });
  dependencies.deploymentPhase = "first";
  dependencies.rollbackRehearsal = true;
  delete dependencies.smoke;
  dependencies.preDnsSmoke = () => events.push("pre-DNS ALB smoke");
  dependencies.rollback = async () => {
    events.push("remote rollback");
    throw new Error("first deployment recovery failed");
  };

  await assert.rejects(deployRelease(dependencies, MANIFEST), /first deployment recovery failed/);

  assert.equal(events.filter((event) => event === "remote rollback").length, 1);
});

test("repeat deployment rejects a missing previous healthy release before public smoke", async () => {
  const { dependencies, events } = orchestrationFixture({ candidate: FIRST_CANDIDATE });
  dependencies.deploymentPhase = "repeat";

  await assert.rejects(deployRelease(dependencies, MANIFEST), /previous healthy release/);

  assert.equal(events.includes("external smoke"), false);
  assert.equal(events.includes("remote finalize"), false);
});

test("prepare failure relies on remote local recovery and never invokes a second rollback", async () => {
  const { dependencies, events } = orchestrationFixture({ failAt: "remote prepare" });

  await assert.rejects(deployRelease(dependencies, MANIFEST), /remote prepare failed/);

  assert.equal(events.includes("remote rollback"), false);
  assert.equal(events.includes("ALB healthy"), false);
});

for (const failAt of ["ALB healthy", "external smoke", "remote finalize"]) {
  test(`${failAt} failure rolls back the exact prepared candidate`, async () => {
    const { dependencies, events } = orchestrationFixture({ failAt });

    await assert.rejects(deployRelease(dependencies, MANIFEST), new RegExp(`${failAt} failed`));

    assert.ok(events.indexOf("remote rollback") > events.indexOf(failAt));
    assert.equal(events.filter((event) => event === "remote rollback").length, 1);
  });
}

test("rollback cleanup failure is surfaced alongside the primary deployment failure", async () => {
  const { dependencies } = orchestrationFixture({
    candidate: FIRST_CANDIDATE,
    failAt: "ALB healthy",
  });
  dependencies.deploymentPhase = "first";
  dependencies.preDnsSmoke = () => undefined;
  dependencies.rollback = async () => {
    throw new Error("first deployment recovery failed");
  };

  let error;
  try {
    await deployRelease(dependencies, MANIFEST);
    assert.fail("deployment unexpectedly succeeded");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof AggregateError);
  assert.deepEqual(
    error.errors.map(({ message }) => message),
    ["ALB healthy failed", "first deployment recovery failed"],
  );
  assert.equal(error.cause.message, "ALB healthy failed");
});

test("deployment wrapper emits the exact success or failure metric without masking the primary error", async () => {
  for (const failure of [undefined, new Error("deploy failed")]) {
    const writes = [];
    const environment = { MARKIRO_FOLDER_ID: "folder-1", YC_APP_INSTANCE_ID: "app-1" };
    const reporting = {
      runDeployment: async () => {
        if (failure) throw failure;
        return "healthy";
      },
      metadataIamToken: async () => "iam-token",
      writeMetrics: async (request) => writes.push(request),
    };
    if (failure)
      await assert.rejects(
        runRemoteDeploymentWithReporting(environment, {}, reporting),
        /deploy failed/,
      );
    else
      assert.equal(await runRemoteDeploymentWithReporting(environment, {}, reporting), "healthy");
    assert.deepEqual(writes[0].metrics, [
      {
        name: "markiro.deployment.failure",
        labels: { resource_id: "app-1" },
        type: "DGAUGE",
        value: failure ? 1 : 0,
      },
    ]);
  }
});

function response(body, ok = true) {
  return {
    ok,
    async json() {
      return body;
    },
  };
}

const smokeCsp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";
const adminShell =
  '<html><head><title>Markiro</title><script type="module" src="/assets/main.js"></script></head><body></body></html>';
const kioskShell =
  '<html lang="ru"><head><title>Маркиро — Киоск</title><script type="module" src="/assets/kiosk.js"></script><link rel="manifest" href="/manifest.webmanifest"><script id="vite-plugin-pwa:register-sw" src="/registerSW.js" defer></script></head><body><div id="root"></div></body></html>';

function curlSmokeResponse(value, releaseSha = COMMIT) {
  const url = new URL(value);
  const kiosk = url.hostname === "kiosk.markiro.example";
  const headers = {
    "content-security-policy": smokeCsp,
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  let status = 200;
  let body = "{}";
  headers["content-type"] = "application/json";

  if (url.pathname === "/") {
    body = kiosk ? kioskShell : adminShell;
    headers["content-type"] = "text/html";
    headers["cache-control"] = "no-cache";
    headers["x-markiro-release-sha"] = releaseSha;
  } else if (url.pathname === "/team/deep-link" && !kiosk) {
    body = adminShell;
    headers["content-type"] = "text/html";
    headers["cache-control"] = "no-cache";
  } else if (url.pathname === "/assets/main.js" && !kiosk) {
    body = "console.log('admin')";
    headers["content-type"] = "application/javascript";
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else if (url.pathname === "/assets/kiosk.js" && kiosk) {
    body = "console.log('kiosk')";
    headers["content-type"] = "application/javascript";
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else if (url.pathname === "/manifest.webmanifest" && kiosk) {
    body = JSON.stringify({
      id: "/",
      name: "Маркиро — Киоск",
      short_name: "Киоск",
      start_url: "/",
      scope: "/",
      display: "fullscreen",
      icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    });
    headers["content-type"] = "application/manifest+json";
  } else if (url.pathname === "/registerSW.js" && kiosk) {
    body = "navigator.serviceWorker.register('/sw.js', { scope: '/' })";
    headers["content-type"] = "application/javascript";
  } else if (url.pathname === "/sw.js" && kiosk) {
    body =
      'precacheAndRoute([{url:"index.html",revision:"1"}],{});registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"),{denylist:[/^\\/(?:api|station|kiosk)(?:\\/|$)/]}));';
    headers["content-type"] = "application/javascript";
  } else if (url.pathname === "/docs" && !kiosk) {
    body =
      '<html><script src="/docs/scalar.js"></script><script src="/docs/bootstrap.js"></script></html>';
    headers["content-type"] = "text/html";
  } else if (url.pathname === "/docs/scalar.js" && !kiosk) {
    body = "window.Scalar={createApiReference:()=>{}}";
    headers["content-type"] = "application/javascript";
  } else if (url.pathname === "/docs/bootstrap.js" && !kiosk) {
    body =
      'Scalar.createApiReference("#app", {url:"/openapi.json",telemetry:false,withDefaultFonts:false,hideClientButton:true,hideTestRequestButton:true,showDeveloperTools:"never",agent:{disabled:true},mcp:{disabled:true}});';
    headers["content-type"] = "application/javascript";
  } else if (url.pathname === "/1c_exchange" && !kiosk) {
    body = "failure\n";
    headers["content-type"] = "text/plain";
  } else if (
    kiosk &&
    [
      "/api",
      "/api/auth/get-session",
      "/station",
      "/station/bootstrap",
      "/kiosk",
      "/docs",
      "/unknown",
    ].includes(url.pathname)
  ) {
    status = 404;
    body = "not found";
    headers["content-type"] = "text/plain";
  } else if (url.pathname === "/unknown") {
    status = 404;
    body = "not found";
    headers["content-type"] = "text/plain";
  } else if (url.pathname.includes("ready")) {
    body = '{"status":"degraded"}';
  } else {
    body = '{"status":"ok"}';
  }

  const reason = status === 404 ? "Not Found" : "OK";
  const serializedHeaders = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  return `HTTP/1.1 ${status} ${reason}\r\n${serializedHeaders}\r\n\r\n${body}\nMARKIRO_HTTP_STATUS:${status}\n`;
}

function cliFixture({ candidate = CANDIDATE, failAt } = {}) {
  const events = [];
  const commands = [];
  let activeRelease = candidate.previousTag;
  let monotonicTime = 0;
  const environment = {
    RELEASE_MANIFEST_PATH: "/runner/release-manifest.json",
    EXPECTED_RELEASE_RUN_ID: RUN_ID,
    EXPECTED_RELEASE_SHA: COMMIT,
    YC_APP_INSTANCE_ID: "fv4app123",
    YC_REGISTRY_SECRET_ID: "e6qregistry123",
    YC_OS_LOGIN: "deployer",
    YC_ORGANIZATION_ID: "bpforganization",
    YC_LOAD_BALANCER_ID: "ds7loadbalancer",
    YC_BACKEND_GROUP_ID: "ds7backend",
    YC_TARGET_GROUP_ID: "ds7target",
    MARKIRO_DOMAIN: "markiro.example",
    MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
    MARKIRO_DEPLOYMENT_PHASE: candidate.previousTag === null ? "first" : "repeat",
    YC_LOAD_BALANCER_ADDRESS: "203.0.113.42",
    APP_SSH_HOST_KEYS_B64: Buffer.from(`${ED25519_KEY}\n${RSA_KEY}`).toString("base64"),
  };
  const system = {
    monotonicNow: () => monotonicTime,
    sleep: async (milliseconds) => {
      monotonicTime += milliseconds;
    },
    async readFile() {
      return MANIFEST;
    },
    async metadataIamToken() {
      return "runner-iam-token";
    },
    async fetch(url) {
      if (String(url).includes("payload.lockbox"))
        return response({
          entries: [
            { key: "GHCR_USERNAME", textValue: "deployer" },
            { key: "GHCR_TOKEN", textValue: "registry-token" },
          ],
        });
      if (String(url).includes("/targetStates/")) {
        events.push("ALB healthy");
        if (failAt === "ALB healthy") return response({ targetStates: [] });
        return response({
          targetStates: [
            {
              target: { ipAddress: "10.20.0.7" },
              status: { zoneStatuses: [{ status: "HEALTHY" }] },
            },
          ],
        });
      }
      return response({
        status: "RUNNING",
        networkInterfaces: [{ primaryV4Address: { address: "10.20.0.7" } }],
      });
    },
    async mkdtemp(prefix) {
      return prefix.includes("os-login") ? "/tmp/os-login" : "/tmp/manifest";
    },
    async readdir() {
      return ["id_ed25519", "id_ed25519-cert.pub"];
    },
    async copyFile() {
      events.push("copy manifest");
    },
    async writeFile(path, value, options) {
      events.push("write known hosts");
      assert.equal(options.mode, 0o600);
      assert.equal(value, `10.20.0.7 ${ED25519_KEY}\n10.20.0.7 ${RSA_KEY}\n`);
    },
    async rm() {
      events.push("cleanup local material");
    },
    async streamArchive(_tar, ssh) {
      events.push("transfer immutable bundle");
      assert.ok(ssh.includes("StrictHostKeyChecking=yes"));
      assert.ok(ssh.includes("BatchMode=yes"));
      assert.ok(ssh.includes("ConnectTimeout=15"));
      assert.ok(ssh.includes("ServerAliveInterval=15"));
      assert.ok(ssh.includes("ServerAliveCountMax=2"));
      assert.equal(
        ssh.some((value) => value.includes("accept-new")),
        false,
      );
    },
    async run(command, args, options = {}) {
      commands.push({ command, args, options });
      if (command === "yc") return "";
      if (args.includes("markiro-runtime-env.service")) {
        events.push("runtime refresh");
        return "";
      }
      if (args.includes("prepare")) {
        events.push("remote prepare");
        assert.ok(args.some((value) => value.includes("registry-auth.mjs run-stdin")));
        if (failAt === "remote prepare") throw new Error("remote prepare failed");
        return `${JSON.stringify(candidate)}\n`;
      }
      if (args.includes("finalize")) {
        events.push("remote finalize");
        assert.deepEqual(JSON.parse(JSON.parse(options.input).commandInput), candidate);
        if (failAt === "remote finalize") throw new Error("remote finalize failed");
        return `${JSON.stringify({ ...candidate, state: "healthy" })}\n`;
      }
      if (args.includes("markiro-active-release")) {
        events.push("activate release pointer");
        if (failAt === "activate release pointer")
          throw new Error("activate release pointer failed");
        activeRelease = COMMIT;
        return "";
      }
      if (args.includes("markiro-restore-active-release")) {
        events.push("restore release pointer");
        activeRelease = candidate.previousTag;
        return "";
      }
      if (args.includes("/opt/markiro/active-release") && args.includes("rm")) {
        events.push("restore release pointer");
        activeRelease = null;
        return "";
      }
      if (args.includes("rollback")) {
        events.push("remote rollback");
        assert.deepEqual(JSON.parse(JSON.parse(options.input).commandInput), candidate);
        return `${JSON.stringify({ ...candidate, state: "failed" })}\n`;
      }
      if (command === "curl") return curlSmokeResponse(args.at(-1));
      if (args.includes("--dump-header"))
        return `HTTP/1.1 200 OK\r\nx-markiro-release-sha: ${COMMIT}\r\n\r\n`;
      return "";
    },
    async smoke({ adminBaseUrl, kioskBaseUrl, expectedReleaseSha }) {
      events.push("external smoke");
      assert.equal(adminBaseUrl, "https://markiro.example");
      assert.equal(kioskBaseUrl, "https://kiosk.markiro.example");
      assert.equal(expectedReleaseSha, COMMIT);
      if (failAt === "external smoke") throw new Error("external smoke failed");
    },
  };
  return { activeRelease: () => activeRelease, commands, environment, events, system };
}

test("real CLI adapter stages remote prepare, ALB, runner smoke, and remote finalize", async () => {
  const { commands, environment, events, system } = cliFixture();

  await runRemoteDeployment(environment, system);

  assert.deepEqual(
    events.filter(
      (event) =>
        !event.startsWith("cleanup") && event !== "copy manifest" && event !== "write known hosts",
    ),
    [
      "transfer immutable bundle",
      "runtime refresh",
      "remote prepare",
      "ALB healthy",
      "external smoke",
      "remote finalize",
      "activate release pointer",
    ],
  );
  assert.ok(
    commands.some(
      ({ command, args }) =>
        command === "ssh" &&
        args.includes("prepare") &&
        args.includes("MARKIRO_REQUIRE_PREVIOUS_HEALTHY=1"),
    ),
  );
  const expectedRemoteEnvironment = [
    `MARKIRO_IMAGE_TAG=${COMMIT}`,
    `MARKIRO_API_IMAGE_DIGEST=sha256:${"a".repeat(64)}`,
    `MARKIRO_EDGE_IMAGE_DIGEST=sha256:${"b".repeat(64)}`,
    "MARKIRO_COMPOSE_PROJECT=markiro-production",
    "MARKIRO_DOMAIN=markiro.example",
    "MARKIRO_KIOSK_DOMAIN=kiosk.markiro.example",
    "MARKIRO_EDGE_MODE=behind-alb",
    "MARKIRO_REQUIRE_PREVIOUS_HEALTHY=1",
    "MARKIRO_REQUIRE_NO_PREVIOUS_HEALTHY=0",
    "MARKIRO_ENV_FILE=/etc/markiro/production.env",
    "MARKIRO_RELEASE_DIRECTORY=/var/lib/markiro/releases",
  ];
  const successfulStages = commands.filter(
    ({ command, args }) =>
      command === "ssh" && (args.includes("prepare") || args.includes("finalize")),
  );
  assert.equal(successfulStages.length, 2);
  for (const { args } of successfulStages)
    for (const variable of expectedRemoteEnvironment) assert.ok(args.includes(variable));
  const activeRelease = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("markiro-active-release"),
  );
  assert.ok(activeRelease);
  assert.ok(activeRelease.args.includes("/opt/markiro/active-release"));
  assert.ok(activeRelease.args.some((value) => value.includes("mv -Tf")));
  assert.ok(events.indexOf("activate release pointer") > events.indexOf("remote finalize"));
});

test("repeat ALB smoke ignores an ambient direct-mode HTTPS port", async () => {
  const { environment, system } = cliFixture();
  environment.MARKIRO_HTTPS_PORT = "18443";

  await runRemoteDeployment(environment, system);
});

test("actual remote prepare argv satisfies the real app-side preflight environment boundary", async () => {
  const { commands, environment, system } = cliFixture();

  await runRemoteDeployment(environment, system);

  const prepare = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("prepare"),
  );
  const envStart = prepare.args.indexOf("env") + 1;
  const envEnd = prepare.args.indexOf("/usr/bin/bash");
  const remoteEnvironment = Object.fromEntries(
    prepare.args.slice(envStart, envEnd).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  let composeEnvironment;

  const preflight = await runPreflight(remoteEnvironment, {
    mode: async () => 0o600,
    readText: async () => "KIOSK_ORIGIN=https://kiosk.markiro.example\n",
    composeQuiet: async (value) => {
      composeEnvironment = value;
    },
  });

  assert.deepEqual(preflight, {
    imageTag: COMMIT,
    apiImageDigest: `sha256:${"a".repeat(64)}`,
    edgeImageDigest: `sha256:${"b".repeat(64)}`,
    domain: "markiro.example",
    kioskDomain: "kiosk.markiro.example",
    acmeEmail: undefined,
    envFile: "/etc/markiro/production.env",
    edgeMode: "behind-alb",
  });
  assert.equal(composeEnvironment.MARKIRO_DOMAIN, "markiro.example");
  assert.equal(composeEnvironment.MARKIRO_KIOSK_DOMAIN, "kiosk.markiro.example");
});

test("runner rejects a malformed production domain before transferring the release", async () => {
  const { environment, events, system } = cliFixture();
  environment.MARKIRO_DOMAIN = "https://markiro.example/path";

  await assert.rejects(runRemoteDeployment(environment, system), /MARKIRO_DOMAIN is invalid/);

  assert.equal(events.includes("transfer immutable bundle"), false);
});

test("first deployment probes both authorities through one reserved ALB address before DNS", async () => {
  const { commands, environment, events, system } = cliFixture({ candidate: FIRST_CANDIDATE });

  await runRemoteDeployment(environment, system);

  const localProbe = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("http://127.0.0.1:8080/health/ready"),
  );
  const albProbes = commands.filter(
    ({ command, args }) => command === "curl" && args.includes("--resolve"),
  );
  const prepare = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("prepare"),
  );
  assert.ok(localProbe);
  assert.ok(localProbe.args.includes("Host: markiro.example"));
  assert.ok(localProbe.args.includes("--dump-header"));
  assert.ok(
    albProbes.some(
      ({ args }) =>
        args.includes("markiro.example:443:203.0.113.42") &&
        args.includes("https://markiro.example/health/ready"),
    ),
  );
  for (const path of [
    "/",
    "/manifest.webmanifest",
    "/sw.js",
    "/api/kiosk/bootstrap",
    "/api",
    "/api/auth/get-session",
    "/station",
    "/station/bootstrap",
    "/kiosk",
    "/docs",
  ]) {
    assert.ok(
      albProbes.some(
        ({ args }) =>
          args.includes("kiosk.markiro.example:443:203.0.113.42") &&
          args.includes(`https://kiosk.markiro.example${path}`),
      ),
      `missing kiosk pre-DNS probe for ${path}`,
    );
  }
  for (const { args } of albProbes) {
    assert.ok(args.includes("--max-time"));
    assert.ok(args.includes("--dump-header"));
  }
  assert.ok(prepare.args.includes("MARKIRO_REQUIRE_PREVIOUS_HEALTHY=0"));
  assert.ok(prepare.args.includes("MARKIRO_REQUIRE_NO_PREVIOUS_HEALTHY=1"));
  assert.equal(events.includes("external smoke"), false);
});

test("runner rejects a malformed kiosk domain before transferring the release", async () => {
  const { environment, events, system } = cliFixture();
  environment.MARKIRO_KIOSK_DOMAIN = "https://kiosk.markiro.example/path";

  await assert.rejects(runRemoteDeployment(environment, system), /MARKIRO_KIOSK_DOMAIN is invalid/);

  assert.equal(events.includes("transfer immutable bundle"), false);
});

test("first-deployment rollback rehearsal never activates the candidate release pointer", async () => {
  const { activeRelease, environment, events, system } = cliFixture({
    candidate: FIRST_CANDIDATE,
  });
  environment.MARKIRO_ROLLBACK_REHEARSAL = "1";

  const result = await runRemoteDeployment(environment, system);

  assert.deepEqual(result, { state: "rehearsed", tag: COMMIT });
  assert.equal(events.includes("remote finalize"), false);
  assert.equal(events.includes("activate release pointer"), false);
  assert.ok(events.includes("remote rollback"));
  assert.ok(events.includes("restore release pointer"));
  assert.equal(activeRelease(), null);
});

test("app-side first-deployment precondition failure never mutates rollback or release pointer state", async () => {
  const { commands, environment, events, system } = cliFixture({ failAt: "remote prepare" });
  environment.MARKIRO_DEPLOYMENT_PHASE = "first";
  environment.MARKIRO_ROLLBACK_REHEARSAL = "1";

  await assert.rejects(runRemoteDeployment(environment, system), /remote prepare failed/);

  const prepare = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("prepare"),
  );
  assert.ok(prepare.args.includes("MARKIRO_REQUIRE_NO_PREVIOUS_HEALTHY=1"));
  assert.equal(events.includes("remote rollback"), false);
  assert.equal(events.includes("activate release pointer"), false);
});

test("activation failure rolls containers back and preserves the previous live pointer", async () => {
  const { activeRelease, environment, events, system } = cliFixture({
    failAt: "activate release pointer",
  });

  await assert.rejects(runRemoteDeployment(environment, system), /activate release pointer failed/);

  assert.deepEqual(
    events.filter((event) =>
      [
        "remote finalize",
        "activate release pointer",
        "remote rollback",
        "restore release pointer",
      ].includes(event),
    ),
    ["remote finalize", "activate release pointer", "remote rollback", "restore release pointer"],
  );
  assert.equal(activeRelease(), CANDIDATE.previousTag);
});

for (const authority of ["markiro.example", "kiosk.markiro.example"]) {
  test(`first deployment rejects a stale ${authority} release before finalization`, async () => {
    const { environment, events, system } = cliFixture({ candidate: FIRST_CANDIDATE });
    const run = system.run;
    system.run = async (command, args, options) => {
      const output = await run(command, args, options);
      if (command === "curl" && args.at(-1) === `https://${authority}/`)
        return output.replace(COMMIT, "f".repeat(40));
      return output;
    };

    await assert.rejects(
      runRemoteDeployment(environment, system),
      /live release identity does not match the expected release/,
    );

    assert.equal(events.includes("remote finalize"), false);
    assert.equal(events.includes("remote rollback"), true);
    assert.equal(events.includes("activate release pointer"), false);
  });
}

test("real CLI adapter rejects a noncanonical authenticated host-key bundle before writing trust", async () => {
  const { environment, events, system } = cliFixture();
  environment.APP_SSH_HOST_KEYS_B64 = Buffer.from(
    `${ED25519_KEY}\n${RSA_KEY}\n${publicKey("ssh-ed25519", 2)}`,
  ).toString("base64");

  await assert.rejects(runRemoteDeployment(environment, system), /authenticated SSH host keys/);

  assert.equal(events.includes("write known hosts"), false);
  assert.equal(events.includes("transfer immutable bundle"), false);
});

test("real CLI adapter rolls back remotely when runner external smoke fails", async () => {
  const { commands, environment, events, system } = cliFixture({ failAt: "external smoke" });

  await assert.rejects(runRemoteDeployment(environment, system), /external smoke failed/);

  assert.ok(events.indexOf("remote rollback") > events.indexOf("external smoke"));
  assert.equal(events.includes("remote finalize"), false);
  const rollback = commands.find(
    ({ command, args }) => command === "ssh" && args.includes("rollback"),
  );
  assert.ok(rollback.args.includes("MARKIRO_DOMAIN=markiro.example"));
  assert.ok(rollback.args.includes("MARKIRO_KIOSK_DOMAIN=kiosk.markiro.example"));
});

for (const failedAuthority of ["admin", "kiosk"]) {
  test(`${failedAuthority} external authority failure rolls back without finalizing`, async () => {
    const { environment, events, system } = cliFixture();
    system.smoke = async ({ adminBaseUrl, kioskBaseUrl, expectedReleaseSha }) => {
      assert.equal(adminBaseUrl, "https://markiro.example");
      assert.equal(kioskBaseUrl, "https://kiosk.markiro.example");
      assert.equal(expectedReleaseSha, COMMIT);
      events.push(`${failedAuthority} authority failed`);
      throw new Error(`${failedAuthority} authority failed`);
    };

    await assert.rejects(
      runRemoteDeployment(environment, system),
      new RegExp(`${failedAuthority} authority failed`),
    );

    assert.ok(
      events.indexOf("remote rollback") > events.indexOf(`${failedAuthority} authority failed`),
    );
    assert.equal(events.includes("remote finalize"), false);
  });
}

for (const failAt of ["ALB healthy", "remote finalize"]) {
  test(`real CLI adapter terminalizes a first deployment after ${failAt} failure`, async () => {
    const { environment, events, system } = cliFixture({
      candidate: FIRST_CANDIDATE,
      failAt,
    });

    await assert.rejects(runRemoteDeployment(environment, system));

    assert.ok(events.indexOf("remote rollback") > events.indexOf(failAt));
    assert.equal(events.filter((event) => event === "remote rollback").length, 1);
    assert.equal(events.includes("remote finalize"), failAt === "remote finalize");
    assert.equal(events.includes("activate release pointer"), false);
  });
}
