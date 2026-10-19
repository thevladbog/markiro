/** LOCAL SYNTHETIC ONLY. Never accepts a URL, credentials or an external Docker daemon. */
import assert from "node:assert/strict";
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  createHash,
  createHmac,
  createCipheriv,
  diffieHellman,
  hkdfSync,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
  realpath,
  symlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { deflateRawSync, gzipSync } from "node:zlib";
import { roleProvisioningSql } from "../postgres/roles.mjs";
import { provisionRoles } from "../postgres/provision.mjs";
import { localDockerEndpoint, summarize, runBoundedPhase, assess, hasOomEvent } from "./core.mjs";
const argv = process.argv.slice(2);
assert.ok(
  argv.includes("--local-load") &&
    argv.every((x) => ["--local-load", "--smoke", "--fail-after-start"].includes(x)),
  "Explicit --local-load required; URLs are not accepted",
);
const smoke = argv.includes("--smoke"),
  injected = argv.includes("--fail-after-start");
const redactions = [];
const protectedLoadError = (message) => new Error(message);
const run = promisify(execFile),
  dockerEnv = { PATH: process.env.PATH, HOME: homedir(), LANG: "C.UTF-8" };
delete dockerEnv.DOCKER_HOST;
delete dockerEnv.DOCKER_CONTEXT;
const interruption = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => interruption.abort());
async function command(bin, args, options = {}) {
  try {
    return await run(bin, args, {
      env: dockerEnv,
      timeout: 240000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const categories = [
      "permission denied",
      "does not exist",
      "unhealthy",
      "invalid",
      "no such file",
      "manifest unknown",
      "not found",
      "no matching",
      "read-only",
      "bind",
      "exit code",
      "unknown flag",
    ].filter((x) => String(error.stderr).toLowerCase().includes(x));
    let safe = String(error.stderr ?? "");
    for (const value of redactions) safe = safe.replaceAll(value, "[redacted]");
    safe = safe
      .replace(/postgres(?:ql)?:[^\s]+/g, "[database URL redacted]")
      .replace(/[A-Za-z0-9+/_=-]{28,}/g, "[long value redacted]");
    throw protectedLoadError(
      `Local command failed: ${bin} ${args.slice(0, 2).join(" ")}; categories=${categories.join(",")}; sanitized=${safe.slice(-600)}`,
    );
  }
}
const endpoint = JSON.parse((await command("docker", ["context", "inspect"])).stdout)[0]?.Endpoints
  ?.docker?.Host;
localDockerEndpoint(endpoint);
dockerEnv.DOCKER_HOST = endpoint;
dockerEnv.COMPOSE_DISABLE_ENV_FILE = "1";
const directory = await mkdtemp(join(await realpath(tmpdir()), "markiro-compact-load-"));
await chmod(directory, 0o755);
const plugins = JSON.parse(
  (await command("docker", ["info", "--format", "{{json .ClientInfo.Plugins}}"])).stdout,
);
const composePlugin = plugins.find((plugin) => plugin.Name === "compose")?.Path;
assert.ok(
  typeof composePlugin === "string" && composePlugin.startsWith("/"),
  "Installed Compose plugin required",
);
await mkdir(join(directory, "docker"), { mode: 0o700 });
await mkdir(join(directory, "docker", "cli-plugins"), { mode: 0o700 });
await symlink(
  await realpath(composePlugin),
  join(directory, "docker", "cli-plugins", "docker-compose"),
);
dockerEnv.DOCKER_CONFIG = join(directory, "docker");
const project = `markiro-compact-load-${randomBytes(5).toString("hex")}`;
const evidenceDir = resolve(process.env.COMPACT_LOAD_EVIDENCE_DIR ?? join(directory, "evidence"));
assert.ok(
  !evidenceDir.startsWith(directory + "/"),
  "Evidence must survive private temporary directory cleanup: set COMPACT_LOAD_EVIDENCE_DIR",
);
await mkdir(evidenceDir, { recursive: true });
const evidence = {
  version: 1,
  validatorRevision: "oom-and-exact-report-grain-v2",
  project,
  startedAt: new Date().toISOString(),
  kind: "local-synthetic-derived-runtime",
  smoke,
  phases: {},
  checks: [],
  samples: [],
  requests: [],
  reports: [],
  cleanup: false,
};
const images = {
  api: "markiro-compact-load-api:derived",
  edge: "markiro-compact-load-edge:derived",
};
const values = {},
  users = Array.from({ length: 10 }, (_, i) => ({
    id: randomUUID(),
    email: `load-${i}@example.invalid`,
    name: `Synthetic operator ${i}`,
  })),
  tenants = Array.from({ length: 100 }, () => randomUUID());
const password = randomBytes(24).toString("base64url"),
  pgPassword = randomBytes(24).toString("base64url"),
  appPassword = randomBytes(32).toString("hex"),
  migratorPassword = randomBytes(32).toString("hex");
const support = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
  license = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const licenseJwk = license.publicKey.export({ format: "jwk" });
const pem = (key) => key.export({ type: "pkcs8", format: "pem" }).toString();
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const httpPort = await freePort(),
  httpsPort = await freePort(),
  origin = `https://saas-admin.localhost:${httpsPort}`;
const envFile = join(directory, "runtime.env"),
  migrationFile = join(directory, "migration.env"),
  rolesFile = join(directory, "roles.sql"),
  overlay = join(directory, "overlay.yml");
const tlsVolume = `${project}-tls`;
const environment = {
  ...dockerEnv,
  MARKIRO_PLATFORM_ENV_FILE: envFile,
  MARKIRO_PLATFORM_MIGRATION_ENV_FILE: migrationFile,
  MARKIRO_SOURCE_SHA: process.env.MARKIRO_SOURCE_SHA ?? "68070da5f4cb1e2a54e1eca3d7ca223d1ff993d1",
  MARKIRO_API_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  MARKIRO_POSTGRES_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
  MARKIRO_POSTGRES_CA_FILE: join(directory, "ca.crt"),
  MARKIRO_POSTGRES_SERVER_CERT_FILE: join(directory, "server.crt"),
  MARKIRO_POSTGRES_SERVER_KEY_FILE: join(directory, "server.key"),
  MARKIRO_POSTGRES_PASSWORD_FILE: join(directory, "password"),
  MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.localhost",
  MARKIRO_LANDING_DOMAIN: "landing.localhost",
  MARKIRO_RETIRED_ADMIN_DOMAIN: "admin.localhost",
  MARKIRO_RETIRED_KIOSK_DOMAIN: "kiosk.localhost",
  S3_PUBLIC_ORIGIN: "https://storage.example.invalid",
  ACME_EMAIL: "load@markiro.local",
};
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  "/dev/null",
  "-f",
  "deploy/platform/compose.yml",
  "-f",
  "deploy/platform/compose.compact.yml",
  "-f",
  overlay,
];
const compose = async (...args) => {
  try {
    return await command("docker", [...composeArgs, ...args], {
      env: environment,
      ...(args[0] === "down" ? {} : { signal: interruption.signal }),
    });
  } catch (error) {
    throw protectedLoadError(`compose ${args.slice(0, 2).join(" ")}: ${error.message}`);
  }
};
const sql = async (query) =>
  (
    await compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "markiro",
      "-Atc",
      query,
    )
  ).stdout.trim();
const cookies = users.map(() => new Map());
let phase = "setup",
  monitor,
  edgeCa;
async function request(
  path,
  {
    user = 0,
    method = "GET",
    body,
    status = 200,
    check = () => {},
    operation = path.split("?")[0],
  } = {},
) {
  const started = performance.now();
  let actual = 0,
    ok = false;
  try {
    const response = await new Promise((resolveResponse, reject) => {
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: httpsPort,
          servername: "saas-admin.localhost",
          path: path.startsWith("/platform/") ? "/api" + path : path,
          method,
          rejectUnauthorized: true,
          ca: edgeCa,
          timeout: 10000,
          headers: {
            Host: `saas-admin.localhost:${httpsPort}`,
            Origin: origin,
            "Content-Type": "application/json",
            "X-Markiro-Commercial-Version": "4",
            Cookie: [...cookies[user]].map(([k, v]) => `${k}=${v}`).join("; "),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolveResponse({
              status: res.statusCode,
              headers: res.headers,
              bytes: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("bounded local request timeout")));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    actual = response.status;
    for (const cookie of response.headers["set-cookie"] ?? []) {
      const [name, ...rest] = cookie.split(";")[0].split("=");
      cookies[user].set(name, rest.join("="));
    }
    assert.equal(actual, status, `${operation} unexpected HTTP ${actual}`);
    let parsed;
    try {
      parsed = JSON.parse(response.bytes.toString());
    } catch {
      parsed = response.bytes.toString();
    }
    await check(parsed);
    ok = true;
    return parsed;
  } finally {
    evidence.requests.push({
      phase,
      operation,
      ms: Math.round((performance.now() - started) * 100) / 100,
      status: actual,
      ok,
    });
  }
}
function totp(uri) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of new URL(uri).searchParams.get("secret").toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", key).update(counter).digest(),
    offset = mac.at(-1) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
function seal(payload) {
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
    jwk = ephemeral.publicKey.export({ format: "jwk" }),
    epk = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]),
    label = Buffer.from("MKS1.load"),
    flag = Buffer.from([1]),
    shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: support.publicKey }),
    key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([label, epk]), 32)),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.concat([label, flag]));
  return `MKS1.load.${Buffer.concat([flag, epk, iv, cipher.update(deflateRawSync(Buffer.from(JSON.stringify(payload)))), cipher.final(), cipher.getAuthTag()]).toString("base64url")}`;
}
const month = {
  month: new Date().toISOString().slice(0, 7),
  shifts: {
    aggregation: 6,
    validation: 1,
    validationPrint: 0,
    fromOffice: 5,
    fromStation: 2,
    withPallets: 2,
  },
  scans: { accepted: 7020, duplicates: 64, rejected: 9 },
  boxes: { closed: 585, disassembled: 0, codes: 7020 },
  pallets: { closed: 13, disassembled: 0 },
  exceptions: {
    boxUndo: 4,
    boxClear: 0,
    boxReprint: 2,
    boxDisassemble: 0,
    palletReprint: 0,
    palletDisassemble: 0,
  },
  conflicts: { late: 1, displaced: 0, reviewed: 0 },
  reprints: { warehouse: 0, unitLabel: 0 },
  disaggregationApplied: 0,
  syncRejected: 0,
};
const sites = [],
  diagnostics = [],
  reportJobs = [];
const { verifyStandaloneLicense } = createRequire(resolve("apps/api/package.json"))(
  "@markiro/domain",
);
async function sample() {
  const ids = {};
  for (const service of ["api", "postgres", "edge"])
    ids[service] = (await compose("ps", "-q", service)).stdout.trim();
  const stats = (
    await command("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      ...Object.values(ids),
    ])
  ).stdout
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  const cgroups = {};
  for (const service of Object.keys(ids)) {
    const raw = (
      await compose(
        "exec",
        "-T",
        service,
        "cat",
        "/sys/fs/cgroup/cpu.stat",
        "/sys/fs/cgroup/memory.current",
        "/sys/fs/cgroup/memory.peak",
      )
    ).stdout
      .trim()
      .split("\n");
    const peakBytes = Number(raw.pop()),
      currentBytes = Number(raw.pop());
    cgroups[service] = {
      cpu: Object.fromEntries(
        raw.map((line) => {
          const [key, value] = line.split(" ");
          return [key, Number(value)];
        }),
      ),
      currentBytes,
      peakBytes,
    };
  }
  const connections = Number(
    await sql("select count(*) from pg_stat_activity where datname='markiro'"),
  );
  const queue = JSON.parse(
    await sql(
      "select json_build_object('pending',(select count(*) from platform_reports where status in ('queued','processing')),'failed',(select count(*) from platform_reports where status='failed'))",
    ),
  );
  evidence.samples.push({
    at: new Date().toISOString(),
    phase,
    connections,
    queue,
    cgroups,
    services: stats.map((s) => ({
      service: Object.keys(ids).find((k) => ids[k].startsWith(s.ID)),
      cpu: s.CPUPerc,
      memory: s.MemUsage,
      memoryPercent: s.MemPerc,
      pids: s.PIDs,
    })),
  });
}
async function createReport(user) {
  const date = new Date(),
    toDate = date.toISOString().slice(0, 10),
    fromDate = new Date(date - 29 * 86400000).toISOString().slice(0, 10);
  const r = await request("/platform/reports", {
    user,
    method: "POST",
    status: 201,
    operation: "report-create",
    body: {
      reportType: "commercial",
      tenantIds: tenants.slice(0, 10),
      fromDate,
      toDate,
      timezone: "UTC",
      periodBasis: "events",
      privacy: "identified",
      idempotencyKey: randomUUID(),
    },
    check: (r) => assert.ok(r.id),
  });
  reportJobs.push({ id: r.id, user, fromDate, toDate, at: Date.now() });
}
try {
  for (const [service, tag] of Object.entries(images)) {
    const info = JSON.parse((await command("docker", ["image", "inspect", tag])).stdout)[0];
    evidence[`${service}Image`] = {
      id: info.Id,
      architecture: info.Architecture,
      provenance: "local derived host dist; not exact release image",
    };
  }
  evidence.sourceSha = environment.MARKIRO_SOURCE_SHA;
  evidence.sourceFiles = {};
  for (const path of [
    "apps/api/src/main.ts",
    "apps/api/src/jobs/platform-jobs.service.ts",
    "apps/api/dist/main.js",
    "deploy/platform/compose.compact.yml",
    "deploy/platform/load/compact-load.mjs",
    "deploy/platform/load/core.mjs",
    "deploy/platform/load/report-content.mjs",
    "deploy/platform/load/verify-download.mjs",
    "deploy/platform/load/seed.mjs",
  ])
    evidence.sourceFiles[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  evidence.host = JSON.parse(
    (
      await command("docker", [
        "info",
        "--format",
        '{"memoryBytes":{{.MemTotal}},"cpus":{{.NCPU}}}',
      ])
    ).stdout,
  );
  await command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Markiro Synthetic Load CA",
    "-keyout",
    join(directory, "ca.key"),
    "-out",
    join(directory, "ca.crt"),
  ]);
  await command("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=db.private",
    "-keyout",
    join(directory, "server.key"),
    "-out",
    join(directory, "server.csr"),
  ]);
  await writeFile(join(directory, "ext"), "subjectAltName=DNS:db.private\n");
  await command("openssl", [
    "x509",
    "-req",
    "-in",
    join(directory, "server.csr"),
    "-CA",
    join(directory, "ca.crt"),
    "-CAkey",
    join(directory, "ca.key"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    join(directory, "ext"),
    "-out",
    join(directory, "server.crt"),
  ]);
  await writeFile(join(directory, "password"), pgPassword, { mode: 0o600 });
  await mkdir(join(directory, "private"), { mode: 0o755 });
  await writeFile(
    join(directory, "private", "seed.json"),
    JSON.stringify({ users, tenants, password }),
    { mode: 0o600 },
  );
  Object.assign(values, {
    SERVER_PROFILE: "platform-only",
    VITE_SERVER_PROFILE: "platform-only",
    DATABASE_URL: `postgresql://markiro_app:${appPassword}@db.private:5432/markiro?sslmode=verify-full&sslrootcert=/run/markiro-postgres/ca.crt`,
    PLATFORM_AUTH_SECRET: randomBytes(48).toString("base64"),
    PLATFORM_AUTH_URL: origin,
    SAAS_ADMIN_ORIGIN: origin,
    LANDING_ORIGIN: `https://landing.localhost:${httpsPort}`,
    SMTP_HOST: "mailpit",
    SMTP_PORT: "1025",
    SMTP_SECURE: "false",
    SMTP_USER: "load",
    SMTP_PASSWORD: randomBytes(24).toString("base64"),
    SMTP_FROM_EMAIL: "load@markiro.local",
    SMTP_FROM_NAME: "Synthetic Load",
    MAIL_PAYLOAD_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    S3_ENDPOINT: "http://seaweedfs:8333",
    S3_REGION: "us-east-1",
    S3_BUCKET: "markiro-private",
    S3_ACCESS_KEY_ID: "markiro",
    S3_SECRET_ACCESS_KEY: "synthetic-local-only",
    S3_FORCE_PATH_STYLE: "true",
    LANDING_DEMO_SUBMISSION_ENABLED: "false",
    SUPPORT_CHAT_ENABLED: "false",
    STANDALONE_LICENSE_ISSUER: "https://api.example.invalid",
    STANDALONE_LICENSE_KID: "load",
    STANDALONE_LICENSE_PRIVATE_KEY_PEM: pem(license.privateKey).replaceAll("\n", "\\n"),
    STANDALONE_LICENSE_KEYSET_JSON: JSON.stringify({
      protocol: "standalone-license-v1",
      origin: "https://api.example.invalid",
      revision: "load-v1",
      keys: [
        {
          kid: "load",
          jwk: { kty: licenseJwk.kty, crv: licenseJwk.crv, x: licenseJwk.x, y: licenseJwk.y },
        },
      ],
      retiredKids: [],
    }),
    STANDALONE_SUPPORT_KEYS_JSON: JSON.stringify([{ kid: "load", pem: pem(support.privateKey) }]),
  });
  redactions.push(
    password,
    pgPassword,
    appPassword,
    migratorPassword,
    directory,
    ...Object.values(values).filter((v) => v.length > 8),
  );
  await writeFile(
    envFile,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    migrationFile,
    `DATABASE_URL=postgresql://markiro_migrator:${migratorPassword}@db.private:5432/markiro?sslmode=verify-full&sslrootcert=/run/markiro-postgres/ca.crt\n`,
    { mode: 0o600 },
  );
  await writeFile(rolesFile, roleProvisioningSql({ appPassword, migratorPassword }), {
    mode: 0o600,
  });
  await writeFile(
    overlay,
    `services:\n  api:\n    image: ${images.api}\n    volumes:\n      - ${resolve("deploy/platform/load")}:/load:ro\n      - ${directory}/private:/load-private:ro\n  migrate:\n    image: ${images.api}\n  edge:\n    image: ${images.edge}\n    ports: !override\n      - "127.0.0.1:${httpPort}:8080"\n      - "127.0.0.1:${httpsPort}:8443"\n  postgres:\n    image: postgres:17-alpine\n    tmpfs: !override\n      - /tmp:rw,noexec,nosuid,size=64m\n      - /var/run/postgresql:rw,noexec,nosuid,size=16m,mode=1777\n    volumes: !override\n      - postgres-data:/var/lib/postgresql/data\n      - ${resolve("deploy/platform/postgres/pg_hba.conf")}:/etc/postgresql/pg_hba.conf:ro\n      - load-tls:/run/markiro-postgres:ro\n  mailpit:\n    image: axllent/mailpit:v1.30.0\n    mem_limit: 128m\n  seaweedfs:\n    image: docker.io/chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882\n    mem_limit: 256m\n    environment:\n      AWS_ACCESS_KEY_ID: markiro\n      AWS_SECRET_ACCESS_KEY: synthetic-local-only\n      S3_BUCKET: markiro-private\nvolumes:\n  load-tls:\n    external: true\n    name: ${tlsVolume}\n`,
  );
  await command("docker", ["volume", "create", tlsVolume]);
  const copyContainer = `${project}-tls-copy`;
  await command("docker", [
    "create",
    "--name",
    copyContainer,
    "--network",
    "none",
    "-v",
    `${tlsVolume}:/output`,
    "postgres:17-alpine",
    "sleep",
    "infinity",
  ]);
  try {
    await command("docker", ["start", copyContainer]);
    for (const file of ["server.crt", "server.key", "password"])
      await command("docker", ["cp", join(directory, file), `${copyContainer}:/output/${file}`]);
    await command("docker", ["exec", copyContainer, "chown", "-R", "70:70", "/output"]);
    await command("docker", [
      "exec",
      copyContainer,
      "chmod",
      "600",
      "/output/server.key",
      "/output/password",
    ]);
  } finally {
    await command("docker", ["rm", "-f", copyContainer]);
  }
  const config = JSON.parse((await compose("config", "--format", "json")).stdout);
  for (const [name, s] of Object.entries(config.services)) {
    if (name !== "edge") assert.ok(!s.ports?.length);
    else for (const p of s.ports) assert.equal(p.host_ip, "127.0.0.1");
  }
  await compose("up", "-d", "--wait", "--wait-timeout", "120", "postgres", "mailpit", "seaweedfs");
  if (injected) throw new Error("Injected failure after task-owned services started");
  await provisionRoles({
    prefix: composeArgs,
    container: "postgres",
    env: environment,
    sqlFile: rolesFile,
    signal: interruption.signal,
    compose: true,
  });
  await compose("run", "--rm", "migrate");
  await compose("up", "-d", "--wait", "--wait-timeout", "120", "--no-deps", "api", "edge");
  edgeCa = (
    await compose("exec", "-T", "edge", "cat", "/data/caddy/pki/authorities/local/root.crt")
  ).stdout;
  evidence.checks.push("HTTPS edge certificate verified against task-local Caddy CA");
  for (let n = 0; n < 30; n++) {
    try {
      await request("/api/platform-auth/get-session", {
        check: (r) => assert.equal(r, null),
        operation: "readiness",
      });
      break;
    } catch {
      if (n === 29) throw new Error("edge readiness failed");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  evidence.seed = JSON.parse(
    (await compose("exec", "-T", "--user", "0", "api", "node", "/load/seed.mjs")).stdout,
  );
  evidence.database = JSON.parse(
    await sql(
      "select json_build_object('version',version(),'maxConnections',current_setting('max_connections'),'sharedBuffers',current_setting('shared_buffers'),'fsync',current_setting('fsync'),'fullPageWrites',current_setting('full_page_writes'),'synchronousCommit',current_setting('synchronous_commit'),'sizeBytes',pg_database_size('markiro'))",
    ),
  );
  process.stdout.write("Compact stack ready; synthetic seed loaded.\n");
  const tlsProbe = `const fs=require('node:fs');const {Client}=require('node:module').createRequire(require.resolve('@markiro/db'))('pg');(async()=>{const u=new URL(process.env.DATABASE_URL);u.search='';const ca=fs.readFileSync('/run/markiro-postgres/ca.crt');const outcomes={};for(const [name,ssl] of [['valid',{ca,rejectUnauthorized:true}],['wrong-host',{ca,rejectUnauthorized:true,servername:'wrong.invalid'}],['untrusted',{rejectUnauthorized:true}],['plaintext',false]]){const target=new URL(u);if(name==='wrong-host')target.hostname='postgres';const c=new Client({connectionString:target.toString(),ssl,connectionTimeoutMillis:5000});try{await c.connect();await c.query('select 1');outcomes[name]='accepted';}catch(e){outcomes[name]=e.code??'rejected';}finally{await c.end().catch(()=>{});}}console.log(JSON.stringify(outcomes));})().catch(()=>process.exit(1));`;
  evidence.tls = JSON.parse((await compose("exec", "-T", "api", "node", "-e", tlsProbe)).stdout);
  assert.equal(evidence.tls.valid, "accepted");
  for (const name of ["wrong-host", "untrusted", "plaintext"])
    assert.notEqual(evidence.tls[name], "accepted");
  evidence.checks.push(
    "PostgreSQL verify-full TLS positive; wrong hostname, untrusted CA and plaintext rejected",
  );
  evidence.quotas = {};
  let cpuTotal = 0,
    memoryTotal = 0;
  for (const [service, cpu, memory] of [
    ["api", 1.25, 1536],
    ["postgres", 0.5, 1024],
    ["edge", 0.25, 192],
  ]) {
    const id = (await compose("ps", "-q", service)).stdout.trim(),
      info = JSON.parse((await command("docker", ["inspect", id])).stdout)[0];
    const cg = (
      await compose(
        "exec",
        "-T",
        service,
        "cat",
        "/sys/fs/cgroup/cpu.max",
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory.events",
      )
    ).stdout.trim();
    const lines = cg.split("\n"),
      [quota, period] = lines[0].split(" ").map(Number);
    assert.equal(quota / period, cpu);
    assert.equal(Number(lines[1]), memory * 1024 * 1024);
    cpuTotal += quota / period;
    memoryTotal += Number(lines[1]);
    evidence.quotas[service] = {
      cpu: quota / period,
      memoryBytes: Number(lines[1]),
      cgroup: cg,
      restarts: info.RestartCount,
      oomKilled: info.State.OOMKilled,
    };
  }
  assert.equal(cpuTotal, 2);
  assert.equal(memoryTotal, 2752 * 1024 * 1024);
  evidence.checks.push("running cgroup aggregate 2 CPU / 2752 MiB");
  for (let i = 0; i < users.length; i++) {
    await request("/api/platform-auth/sign-in/email", {
      user: i,
      method: "POST",
      body: { email: users[i].email, password },
      operation: "auth-sign-in",
    });
    await request("/platform/me", { user: i, status: 403, operation: "auth-2fa-required" });
    const enrollment = await request("/api/platform-auth/two-factor/enable", {
      user: i,
      method: "POST",
      body: { password },
      operation: "auth-enroll",
    });
    await request("/api/platform-auth/two-factor/verify-totp", {
      user: i,
      method: "POST",
      body: { code: totp(enrollment.totpURI), trustDevice: false },
      operation: "auth-totp",
    });
    await request("/platform/me", {
      user: i,
      operation: "auth-principal",
      check: (r) => assert.equal(r.userId, users[i].id),
    });
    const activation = JSON.parse(
      await readFile("packages/domain/fixtures/standalone-license/activation-request.json", "utf8"),
    );
    activation.hostId = randomUUID();
    activation.usage = { stations: 1, cabinetUsers: 1, lines: 1 };
    activation.trial = null;
    activation.currentLicense = null;
    activation.createdAt = new Date().toISOString();
    const path = `/platform/tenants/${tenants[i]}/standalone-sites`;
    const inspection = await request(`${path}/inspect`, {
      user: i,
      method: "POST",
      body: { request: activation },
      operation: "license-inspect",
    });
    const site = await request(path, {
      user: i,
      method: "POST",
      body: {
        intent: "create",
        requestId: randomUUID(),
        name: `Synthetic line ${i}`,
        request: activation,
        acknowledgedWarnings: inspection.warnings,
      },
      operation: "site-register",
    });
    assert.ok(site.id);
    sites.push({ ...site, path, hostId: activation.hostId });
    if (i % 3 === 2) await new Promise((r) => setTimeout(r, 11000)); // Better Auth resets after 10s of inactivity, not a fixed window.
  }
  evidence.checks.push(
    "10 production HTTP sign-in/password/TOTP verified sessions; unverified principal denied",
  );
  await request("/api/platform-auth/sign-up/email", {
    method: "POST",
    body: {},
    status: 404,
    operation: "public-signup-denied",
  });
  async function issue(user) {
    const site = sites[user],
      p = `${site.path}/${site.id}/issuances`;
    const preview = await request(`${p}/preview`, {
      user,
      method: "POST",
      body: { graceDays: null, offline: null },
      operation: "license-preview",
    });
    const result = await request(p, {
      user,
      method: "POST",
      body: { requestId: randomUUID(), graceDays: null, offline: null, expected: preview.expected },
      operation: "license-issue",
      check: async (r) => {
        assert.equal(r.issuance.sequence, preview.next.sequence);
        assert.equal(r.sha256, createHash("sha256").update(r.compact).digest("hex"));
        const verified = await verifyStandaloneLicense(r.compact, {
          origin: "https://api.example.invalid",
          keys: [{ kid: "load", jwk: licenseJwk }],
          retiredKids: [],
        });
        assert.equal(verified.ok, true);
        assert.equal(verified.license.tenantId, tenants[user]);
        assert.equal(verified.license.hostId, site.hostId);
        assert.deepEqual(verified.license.quotas, {
          lines: 2,
          stations: 3,
          kiosks: 0,
          cabinetUsers: 5,
        });
      },
    });
    await request(`${p}/${result.issuance.licenseId}/file`, {
      user,
      operation: "license-download",
      check: (r) => assert.equal(r.sha256, result.sha256),
    });
    site.issued = (site.issued ?? 0) + 1;
    site.latest = result.issuance.licenseId;
  }
  async function ingest(user) {
    const site = sites[user],
      text = seal({
        v: 2,
        generatedAt: new Date().toISOString(),
        appVersion: "0.2.0",
        hostVersion: "0.2.0",
        months: [month],
        devices: { station: 3, office: 2, handheld: 1 },
        hostId: site.hostId,
        role: "host",
        os: "Synthetic Linux",
        arch: "arm64",
        webview: null,
        license: null,
      });
    const r = await request(`/platform/tenants/${tenants[user]}/standalone-diagnostics`, {
      user,
      method: "POST",
      body: { text },
      operation: "diagnostics-ingest",
      check: (r) => {
        assert.equal(r.duplicate, false);
        assert.equal(r.monthsApplied, 1);
        assert.equal(r.diagnostic.hostKey, site.hostId);
      },
    });
    diagnostics[user] = r.diagnostic.id;
    site.diagnostics = (site.diagnostics ?? 0) + 1;
  }
  for (let i = 0; i < 10; i++) {
    await issue(i);
    await ingest(i);
  }
  await request(`/platform/tenants/${tenants[1]}/standalone-sites/${sites[0].id}/issuances`, {
    status: 404,
    operation: "cross-tenant-license-denied",
  });
  await request(`/platform/tenants/${tenants[1]}/standalone-diagnostics/${diagnostics[0]}`, {
    status: 404,
    operation: "cross-tenant-diagnostics-denied",
  });
  evidence.checks.push(
    "license file hash/replay, encrypted diagnostics durable ingestion, cross-tenant resource denial",
  );
  process.stdout.write("Business preparation complete; TLS/cgroups/auth verified.\n");
  let sampling = true,
    monitoringError;
  monitor = (async () => {
    while (sampling && !interruption.signal.aborted) {
      await sample();
      await new Promise((r) => setTimeout(r, 5000));
    }
  })().catch((error) => {
    monitoringError = error;
  });
  const definitions = smoke
    ? [
        ["warmup", 2000, 2],
        ["steady", 3000, 5],
        ["burst", 3000, 10],
        ["recovery", 2000, 2],
      ]
    : [
        ["warmup", 60000, 5],
        ["steady", 180000, 5],
        ["burst", 60000, 10],
        ["recovery", 60000, 5],
      ];
  try {
    for (const [name, durationMs, count] of definitions) {
      phase = name;
      const started = performance.now(),
        counter = Array(10).fill(0),
        reported = new Set();
      await runBoundedPhase({
        durationMs,
        users: count,
        paceMs: 100,
        signal: interruption.signal,
        operation: async (user) => {
          const turn = counter[user]++;
          if (!reported.has(user)) {
            reported.add(user);
            await createReport(user);
          }
          if (turn % 20 === 0) {
            await issue(user);
            await ingest(user);
            return;
          }
          const tenant = tenants[user],
            site = sites[user];
          switch (turn % 6) {
            case 0:
              await request("/platform/tenants?limit=50&page=1", {
                user,
                operation: "tenant-list",
                check: (r) => assert.ok(r.items.length >= 50),
              });
              break;
            case 1:
              await request(`/platform/tenants/${tenant}`, {
                user,
                operation: "tenant-detail",
                check: (r) => assert.equal(r.id ?? r.tenant?.id, tenant),
              });
              break;
            case 2:
              await request(site.path, {
                user,
                operation: "site-list",
                check: (r) => assert.ok(r.sites.some((s) => s.id === site.id)),
              });
              break;
            case 3:
              await request(`${site.path}/${site.id}/issuances`, {
                user,
                operation: "license-history",
                check: (r) => assert.ok((r.issuances ?? r.items)?.length > 0),
              });
              break;
            case 4:
              await request(
                `/platform/tenants/${tenant}/standalone-diagnostics/${diagnostics[user]}`,
                {
                  user,
                  operation: "diagnostics-detail",
                  check: (r) => assert.equal(r.diagnostic?.id ?? r.id, diagnostics[user]),
                },
              );
              break;
            case 5:
              await request(`/platform/tenants/${tenant}/standalone-diagnostics/statistics`, {
                user,
                operation: "diagnostics-statistics",
                check: (r) => assert.ok(JSON.stringify(r).includes("7020")),
              });
              break;
          }
        },
      });
      const elapsed = performance.now() - started,
        rows = evidence.requests.filter((r) => r.phase === name);
      evidence.phases[name] = {
        users: count,
        durationMs: elapsed,
        throughput: rows.length / (elapsed / 1000),
        interactive: summarize(rows),
        operations: Object.fromEntries(
          [...new Set(rows.map((r) => r.operation))].map((op) => [
            op,
            summarize(rows.filter((r) => r.operation === op)),
          ]),
        ),
      };
      for (const required of [
        "report-create",
        "license-preview",
        "license-issue",
        "license-download",
        "diagnostics-ingest",
        "tenant-list",
        "tenant-detail",
        "site-list",
        "license-history",
        "diagnostics-detail",
        "diagnostics-statistics",
      ])
        assert.ok(
          evidence.phases[name].operations[required]?.count > 0,
          `${name} omitted ${required}`,
        );
      process.stdout.write(
        `${name}: ${rows.length} responses; p95 ${evidence.phases[name].interactive.p95}ms\n`,
      );
    }
  } finally {
    sampling = false;
    await monitor;
    monitor = undefined;
  }
  if (monitoringError) throw monitoringError;
  assert.ok(!interruption.signal.aborted, "load interrupted");
  phase = "verification";
  for (const job of reportJobs) {
    let report;
    while (Date.now() - job.at < 600000) {
      const list = await request("/platform/reports?limit=100&offset=0", {
        user: job.user,
        operation: "report-poll",
      });
      report = list.items.find((r) => r.id === job.id);
      if (report?.status === "ready") break;
      assert.notEqual(report?.status, "failed");
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(report?.status, "ready");
    assert.equal(report.rowCount, 300);
    const download = await request(`/platform/reports/${job.id}/download`, {
      user: job.user,
      method: "POST",
      operation: "report-download-url",
    });
    await writeFile(
      join(directory, "private", "download.json"),
      JSON.stringify({
        url: download.url,
        tenants: tenants.slice(0, 10),
        fromDate: job.fromDate,
        toDate: job.toDate,
        rowCount: 300,
      }),
      { mode: 0o600 },
    );
    const checked = JSON.parse(
      (await compose("exec", "-T", "--user", "0", "api", "node", "/load/verify-download.mjs"))
        .stdout,
    );
    evidence.reports.push({
      rowCount: report.rowCount,
      readyMs: Date.parse(report.completedAt) - Date.parse(report.createdAt),
      ...checked,
    });
  }
  await request(`/platform/reports/${reportJobs[0].id}/download`, {
    user: 9,
    method: "POST",
    status: 404,
    operation: "report-creator-isolation",
  });
  const writes = JSON.parse(
    await sql(
      "select json_build_object('licenses',(select count(*) from standalone_license_issuances),'diagnostics',(select count(*) from standalone_support_diagnostics),'reports',(select count(*) from platform_reports),'notReady',(select count(*) from platform_reports where status<>'ready'))",
    ),
  );
  assert.equal(
    Number(writes.licenses),
    sites.reduce((a, s) => a + s.issued, 0),
  );
  assert.equal(
    Number(writes.diagnostics),
    sites.reduce((a, s) => a + s.diagnostics, 0),
  );
  assert.equal(Number(writes.reports), reportJobs.length);
  assert.equal(Number(writes.notReady), 0);
  evidence.writes = writes;
  const auditMismatch = Number(
    await sql(
      "select count(*) from standalone_license_issuances i where not exists (select 1 from platform_audit_events a where a.action='standalone_license.issued' and a.outcome='success' and a.tenant_id=i.tenant_id and a.actor_platform_user_id=i.issued_by_platform_user_id and a.actor_role='platform_admin' and a.target_type='standalone_license' and a.target_id=i.id::text and a.after->>'licenseId'=i.id::text and a.after->>'siteId'=i.site_id::text)",
    ),
  );
  assert.equal(auditMismatch, 0);
  evidence.auditMismatches = auditMismatch;
  let oom = false,
    restarts = 0;
  for (const service of ["api", "postgres", "edge"]) {
    const id = (await compose("ps", "-q", service)).stdout.trim(),
      info = JSON.parse((await command("docker", ["inspect", id])).stdout)[0],
      cg = (await compose("exec", "-T", service, "cat", "/sys/fs/cgroup/memory.events")).stdout;
    oom ||= hasOomEvent(info.State.OOMKilled, cg);
    restarts += info.RestartCount;
    evidence.quotas[service].final = {
      restarts: info.RestartCount,
      oomKilled: info.State.OOMKilled,
      memoryEvents: cg.trim(),
    };
  }
  evidence.acceptance = assess({
    phases: evidence.phases,
    reportsComplete: evidence.reports.length === reportJobs.length,
    oom,
    restarts,
  });
  assert.deepEqual(evidence.acceptance, []);
  assert.ok(
    evidence.requests.filter((r) => r.operation !== "readiness").every((r) => r.ok),
    "all setup/workload/report responses must satisfy correctness",
  );
  evidence.checks.push(
    "durable writes exact counts; nonempty report CSV/metadata/hash/tenant scope; creator isolation; drained report queue",
  );
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error =
    error instanceof assert.AssertionError ? String(error.message).slice(0, 300) : error.message;
  process.exitCode = 1;
  process.stderr.write(`Compact load failed: ${evidence.error}\n`);
} finally {
  if (monitor) await monitor.catch(() => {});
  try {
    await compose("down", "--volumes", "--remove-orphans");
    await command("docker", ["volume", "rm", tlsVolume]);
    const containers = (
      await command("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    ).stdout.trim();
    const volumes = (
      await command("docker", [
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    ).stdout.trim();
    assert.equal(containers, "");
    assert.equal(volumes, "");
    evidence.cleanup = true;
  } catch {
    evidence.cleanup = false;
    process.exitCode = 1;
  }
  await rm(directory, { recursive: true, force: true });
  evidence.finishedAt = new Date().toISOString();
  await writeFile(
    join(evidenceDir, "requests.json.gz"),
    gzipSync(JSON.stringify(evidence.requests)),
  );
  const { requests, ...summary } = evidence;
  summary.requestCount = requests.length;
  summary.requestFailures = requests.filter((r) => !r.ok).length;
  await writeFile(join(evidenceDir, "results.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`Evidence saved; cleanup=${evidence.cleanup}\n`);
}
