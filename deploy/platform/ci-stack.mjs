/** Local synthetic CI harness, deliberately not a host deployment executor. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { readProtectedEnv } from "./preflight.mjs";
import { smokePlatform } from "./smoke.mjs";
import { browserSmoke } from "./browser-smoke.mjs";

const run = promisify(execFile);
if (process.argv.slice(2).join() !== "--local-ci")
  throw new Error("This harness requires --local-ci and never targets a remote host");
const sha = process.env.MARKIRO_SOURCE_SHA;
if (!/^[a-f0-9]{40}$/u.test(sha ?? ""))
  throw new Error("MARKIRO_SOURCE_SHA must identify locally built images");
// Docker context can otherwise silently target a remote daemon. Context metadata
// is inspected before creating resources; only the local Unix socket is allowed.
const dockerEnv = { ...process.env };
delete dockerEnv.DOCKER_HOST;
delete dockerEnv.DOCKER_CONTEXT;
const endpoint = JSON.parse(
  (await run("docker", ["context", "inspect"], { env: dockerEnv })).stdout,
)[0]?.Endpoints?.docker?.Host;
if (typeof endpoint !== "string" || !endpoint.startsWith("unix://"))
  throw new Error("Local Docker Unix socket required");
const directory = await mkdtemp(join(await realpath(tmpdir()), "markiro-platform-ci-"));
const project = `markiro-platform-ci-${randomBytes(6).toString("hex")}`;
const evidenceDir = resolve(process.env.PLATFORM_CI_EVIDENCE_DIR ?? join(directory, "evidence"));
await mkdir(evidenceDir, { recursive: true });
const envFile = join(directory, "runtime.env");
async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}
const httpPort = await freePort();
let httpsPort = await freePort();
while (httpsPort === httpPort) httpsPort = await freePort();
const values = {
  SERVER_PROFILE: "platform-only",
  VITE_SERVER_PROFILE: "platform-only",
  DATABASE_URL: "postgresql://markiro:platform-ci-only@postgres:5432/markiro",
  PLATFORM_AUTH_SECRET: randomBytes(48).toString("base64"),
  PLATFORM_AUTH_URL: `https://saas-admin.localhost:${httpsPort}`,
  SAAS_ADMIN_ORIGIN: `https://saas-admin.localhost:${httpsPort}`,
  LANDING_ORIGIN: `https://landing.localhost:${httpsPort}`,
  SMTP_HOST: "mailpit",
  SMTP_PORT: "1025",
  SMTP_SECURE: "false",
  SMTP_USER: "platform-ci",
  SMTP_PASSWORD: randomBytes(24).toString("base64"),
  SMTP_FROM_EMAIL: "no-reply@markiro.local",
  SMTP_FROM_NAME: "Platform CI",
  MAIL_PAYLOAD_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  S3_ENDPOINT: "http://seaweedfs:8333",
  S3_REGION: "us-east-1",
  S3_BUCKET: "markiro-private",
  S3_ACCESS_KEY_ID: "markiro",
  S3_SECRET_ACCESS_KEY: "platform-ci-only",
  S3_FORCE_PATH_STYLE: "true",
  LANDING_DEMO_SUBMISSION_ENABLED: "false",
  SUPPORT_CHAT_ENABLED: "false",
};
await writeFile(
  envFile,
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
await readProtectedEnv(envFile);
const environment = {
  ...dockerEnv,
  MARKIRO_PLATFORM_ENV_FILE: envFile,
  MARKIRO_SOURCE_SHA: sha,
  MARKIRO_API_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.localhost",
  MARKIRO_LANDING_DOMAIN: "landing.localhost",
  MARKIRO_RETIRED_ADMIN_DOMAIN: "admin.localhost",
  MARKIRO_RETIRED_KIOSK_DOMAIN: "kiosk.localhost",
  S3_PUBLIC_ORIGIN: "https://storage.example.org",
  ACME_EMAIL: "ci@markiro.local",
  PLATFORM_CI_HTTP_PORT: String(httpPort),
  PLATFORM_CI_HTTPS_PORT: String(httpsPort),
};
const interruption = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => interruption.abort());
const args = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  "/dev/null",
  "-f",
  "deploy/platform/compose.yml",
  "-f",
  "deploy/platform/compose.ci.yml",
];
async function compose(...extra) {
  try {
    return await run("docker", [...args, ...extra], {
      env: environment,
      timeout: 240000,
      maxBuffer: 8 * 1024 * 1024,
      ...(extra[0] === "down" ? {} : { signal: interruption.signal }),
    });
  } catch {
    throw new Error(
      `Platform CI command failed: ${extra.slice(0, 2).join(" ")} (raw output withheld to protect env)`,
    );
  }
}
function request(host, path, init = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: httpsPort,
        servername: host,
        path,
        method: init.method ?? "GET",
        headers: { Host: host, ...init.headers },
        rejectUnauthorized: false,
        timeout: 10000,
      },
      (incoming) =>
        resolveResponse(
          new Response(Readable.toWeb(incoming), {
            status: incoming.statusCode,
            headers: incoming.headers,
          }),
        ),
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("local smoke timeout")));
    req.end();
  });
}
const evidence = {
  project,
  sourceSha: sha,
  kind: "local-synthetic-platform-preparation",
  checks: [],
  cleanup: false,
};
process.stdout.write(`Platform CI resources: ${project}; evidence: ${evidenceDir}\n`);
try {
  const config = JSON.parse((await compose("config", "--format", "json")).stdout);
  assert.deepEqual(Object.keys(config.services).sort(), [
    "api",
    "edge",
    "mailpit",
    "migrate",
    "postgres",
    "seaweedfs",
  ]);
  for (const [name, service] of Object.entries(config.services))
    if (name !== "edge") assert.ok(!service.ports?.length, `${name} exposes a port`);
  assert.equal(config.services.api.environment.SERVER_PROFILE, "platform-only");
  for (const port of config.services.edge.ports) assert.equal(port.host_ip, "127.0.0.1");
  evidence.checks.push("rendered Compose isolation");
  await compose("up", "-d", "--wait", "--wait-timeout", "120", "postgres", "mailpit", "seaweedfs");
  await compose("run", "--rm", "migrate");
  await compose("run", "--rm", "migrate");
  evidence.checks.push("migration twice");
  await compose("up", "-d", "--wait", "--wait-timeout", "120", "--no-deps", "api", "edge");
  // Caddy has no healthcheck; retry only its readiness, never contract failures.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      await (await request("saas-admin.localhost", "/login")).arrayBuffer();
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  assert.ok(ready, "edge TLS readiness");
  evidence.httpChecks = await smokePlatform({ request, sourceSha: sha });
  evidence.checks.push("edge HTTP positive and negative contracts");
  await compose(
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    `
    for (const [path,status] of [["/health/ready",200],["/platform/tenants",401],["/api/auth/get-session",404],["/station/pair",404],["/kiosk/pair",404],["/signer-agent/auth/challenge",404],["/1c_exchange",404],["/products",404],["/unknown",404]]) {
      const response=await fetch("http://127.0.0.1:3000"+path);
      if(response.status!==status) throw new Error("direct API contract failed: "+path);
    }
    const a=await fetch("http://127.0.0.1:3000/api/platform-auth/get-session");
    if(a.status!==200 || await a.text()!=="null") throw new Error("platform auth unavailable");
  `,
  );
  evidence.checks.push("direct API disabled routes and platform authentication");
  const queue = (
    await compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "markiro",
      "-d",
      "markiro",
      "-Atc",
      "SELECT name FROM pgboss_platform.queue ORDER BY name",
    )
  ).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(queue, [
    "__pgboss__send-it",
    "dispatch-email-outbox",
    "materialize-subscription-statuses",
    "platform-report-repair",
    "platform-report-run",
    "prune-email-deliveries",
    "reconcile-email-deliveries",
    "send-email-delivery",
  ]);
  evidence.queues = queue;
  await browserSmoke(httpsPort, evidenceDir);
  evidence.checks.push("Chromium login denial and landing render");
} catch (error) {
  evidence.error = error.message;
  throw error;
} finally {
  try {
    await compose("down", "--volumes", "--remove-orphans");
    evidence.cleanup = true;
  } finally {
    await rm(envFile, { force: true });
    await writeFile(
      join(evidenceDir, "verification.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
}
process.stdout.write(
  `Platform CI verified ${evidence.httpChecks} HTTP contracts; cleanup=${evidence.cleanup}\n`,
);
