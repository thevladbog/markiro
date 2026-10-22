/** Disposable local integration only. No URLs or credentials accepted from ambient env. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { roleProvisioningSql } from "./roles.mjs";
import { provisionRoles } from "./provision.mjs";

if (process.argv.slice(2).join() !== "--local-ci")
  throw new Error("Explicit --local-ci required; remote targets are unsupported");
const run = promisify(execFile);
const environment = { PATH: process.env.PATH, HOME: homedir(), LANG: "C.UTF-8" };
const directory = await mkdtemp(join(await realpath(tmpdir()), "markiro-roles-"));
const project = `markiro-roles-${randomBytes(8).toString("hex")}`;
const network = `${project}-network`,
  volume = `${project}-fixture`,
  helper = `${project}-copy`,
  postgres = `${project}-postgres`,
  probe = `${project}-probe`;
const label = `markiro.disposable-test=${project}`;
const owned = new Set();
const interruption = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => interruption.abort());
let endpoint;
let phase = "inspect local Docker";
async function command(bin, args, cleanup = false) {
  try {
    return await run(bin, args, {
      env: environment,
      timeout: 180000,
      maxBuffer: 1024 * 1024,
      ...(cleanup ? {} : { signal: interruption.signal }),
    });
  } catch (error) {
    const safe = String(error.stderr ?? "")
      .split("\n")
      .filter((line) => /^Role probe failed at [a-zA-Z0-9 -]+; code=[A-Z0-9_]+$/u.test(line));
    for (const line of safe) process.stderr.write(line + "\n");
    const category = [
      "ERR_MODULE_NOT_FOUND",
      "MODULE_NOT_FOUND",
      "permission denied",
      "no such file or directory",
    ].find((code) => String(error.stderr).includes(code));
    throw protectedHarnessError(
      `Isolated role harness failed at ${phase}; category=${category ?? "child failure"}; raw child output withheld.`,
    );
  }
}
const protectedHarnessError = (message) => new Error(message);
const docker = (...args) => command("docker", ["--host", endpoint, ...args]);
try {
  // Read the selected context once, reject TCP/SSH, then pin that endpoint with
  // a fresh empty Docker config for every mutation (no inherited Compose/proxy).
  const contexts = JSON.parse((await command("docker", ["context", "inspect"])).stdout);
  endpoint = contexts[0]?.Endpoints?.docker?.Host;
  assert.ok(
    typeof endpoint === "string" && endpoint.startsWith("unix:///"),
    "Local Docker Unix socket required",
  );
  const plugins = JSON.parse(
    (await command("docker", ["info", "--format", "{{json .ClientInfo.Plugins}}"])).stdout,
  );
  const composePlugin = plugins.find((plugin) => plugin.Name === "compose")?.Path;
  if (typeof composePlugin !== "string" || !composePlugin.startsWith("/"))
    throw new Error("Installed Compose plugin required");
  await mkdir(join(directory, "docker"), { mode: 0o700 });
  await mkdir(join(directory, "docker", "cli-plugins"), { mode: 0o700 });
  await symlink(
    await realpath(composePlugin),
    join(directory, "docker", "cli-plugins", "docker-compose"),
  );
  environment.DOCKER_CONFIG = join(directory, "docker");
  const info = JSON.parse((await docker("info", "--format", "{{json .}}")).stdout);
  assert.equal(info.OSType, "linux");
  const appPassword = randomBytes(32).toString("hex"),
    migratorPassword = randomBytes(32).toString("hex");
  const fixture = join(directory, "fixture");
  await mkdir(fixture, { mode: 0o700 });
  await writeFile(
    join(fixture, "credentials.json"),
    JSON.stringify({ appPassword, migratorPassword }),
    { mode: 0o600 },
  );
  await writeFile(join(fixture, "password"), randomBytes(32).toString("hex"), { mode: 0o600 });
  await writeFile(
    join(fixture, "roles.sql"),
    roleProvisioningSql({ appPassword, migratorPassword }) +
      "CREATE SCHEMA pgboss; CREATE TABLE pgboss.legacy_probe(id int);\n",
    { mode: 0o600 },
  );
  await cp("deploy/platform/postgres/pg_hba.conf", join(fixture, "pg_hba.conf"));
  phase = "generate task-local TLS";
  await command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "ca.key"),
    "-out",
    join(fixture, "ca.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=Markiro disposable role test CA",
  ]);
  await command("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(fixture, "server.key"),
    "-out",
    join(directory, "server.csr"),
    "-subj",
    "/CN=db.private",
  ]);
  await writeFile(join(directory, "extensions"), "subjectAltName=DNS:db.private\n");
  await command("openssl", [
    "x509",
    "-req",
    "-in",
    join(directory, "server.csr"),
    "-CA",
    join(fixture, "ca.crt"),
    "-CAkey",
    join(directory, "ca.key"),
    "-CAcreateserial",
    "-out",
    join(fixture, "server.crt"),
    "-days",
    "1",
    "-extfile",
    join(directory, "extensions"),
  ]);
  phase = "render isolated Compose credentials";
  const databaseUrl = (user, password) =>
    `postgresql://${user}:${password}@db.private:5432/markiro?sslmode=verify-full&sslrootcert=/run/markiro-postgres/ca.crt`;
  const runtimeFile = join(directory, "runtime.env"),
    migrationFile = join(directory, "migration.env");
  await writeFile(
    runtimeFile,
    `DATABASE_URL=${databaseUrl("markiro_app", appPassword)}\nSMTP_PASSWORD=${randomBytes(24).toString("hex")}\nSTANDALONE_LICENSE_PRIVATE_KEY_PEM=synthetic-only\nSUPPORT_CHATWOOT_API_TOKEN=synthetic-only\n`,
    { mode: 0o600 },
  );
  await writeFile(
    migrationFile,
    `DATABASE_URL=${databaseUrl("markiro_migrator", migratorPassword)}\n`,
    { mode: 0o600 },
  );
  const interpolation = {
    MARKIRO_PLATFORM_ENV_FILE: runtimeFile,
    MARKIRO_PLATFORM_MIGRATION_ENV_FILE: migrationFile,
    MARKIRO_API_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    MARKIRO_POSTGRES_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    MARKIRO_SOURCE_SHA: "d".repeat(40),
    MARKIRO_SAAS_ADMIN_DOMAIN: "saas.example.invalid",
    MARKIRO_LANDING_DOMAIN: "landing.example.invalid",
    MARKIRO_RETIRED_ADMIN_DOMAIN: "admin.example.invalid",
    MARKIRO_RETIRED_KIOSK_DOMAIN: "kiosk.example.invalid",
    MARKIRO_RELEASES_DOMAIN: "releases.example.invalid",
    MARKIRO_RELEASES_BUCKET: "markiro-releases",
    S3_PUBLIC_ORIGIN: "https://storage.example.invalid",
    ACME_EMAIL: "test@example.invalid",
    MARKIRO_POSTGRES_CA_FILE: join(fixture, "ca.crt"),
    MARKIRO_POSTGRES_SERVER_CERT_FILE: join(fixture, "server.crt"),
    MARKIRO_POSTGRES_SERVER_KEY_FILE: join(fixture, "server.key"),
    MARKIRO_POSTGRES_PASSWORD_FILE: join(fixture, "password"),
  };
  Object.assign(environment, interpolation);
  const rendered = JSON.parse(
    (
      await docker(
        "compose",
        "--project-name",
        project,
        "--env-file",
        "/dev/null",
        "-f",
        "deploy/platform/compose.yml",
        "-f",
        "deploy/platform/compose.compact.yml",
        "config",
        "--format",
        "json",
      )
    ).stdout,
  );
  for (const [service, user] of [
    ["api", "markiro_app"],
    ["migrate", "markiro_migrator"],
  ])
    assert.ok(
      new URL(rendered.services[service].environment.DATABASE_URL).username === user,
      "Compose role isolation",
    );
  assert.deepEqual(Object.keys(rendered.services.migrate.environment).sort(), [
    "DATABASE_URL",
    "NODE_ENV",
    "NODE_OPTIONS",
    "PORT",
    "SERVER_PROFILE",
    "TRUST_PROXY_HOPS",
  ]);
  assert.ok(
    !JSON.stringify(rendered.services.api).includes(migratorPassword),
    "API never receives migration password",
  );
  for (const key of Object.keys(interpolation)) delete environment[key];
  phase = "create owned resources";
  owned.add(network);
  await docker("network", "create", "--internal", "--label", label, network);
  owned.add(volume);
  await docker("volume", "create", "--label", label, volume);
  owned.add(helper);
  await docker(
    "run",
    "-d",
    "--name",
    helper,
    "--label",
    label,
    "--network",
    "none",
    "--mount",
    `type=volume,source=${volume},target=/fixture`,
    "postgres:17-alpine",
    "sleep",
    "infinity",
  );
  await docker("cp", `${fixture}/.`, `${helper}:/fixture`);
  await docker("exec", helper, "chmod", "755", "/fixture");
  await docker(
    "exec",
    helper,
    "chown",
    "70:70",
    "/fixture/server.key",
    "/fixture/password",
    "/fixture/roles.sql",
  );
  await docker(
    "exec",
    helper,
    "chmod",
    "600",
    "/fixture/server.key",
    "/fixture/password",
    "/fixture/roles.sql",
  );
  // Some local Docker-compatible daemons reject tmpfs uid/gid options.
  // Prepare owned data/socket directories before entering the hardened service.
  await docker("exec", helper, "mkdir", "/fixture/data");
  await docker("exec", helper, "chown", "70:70", "/fixture/data", "/fixture");
  await docker("exec", helper, "chmod", "700", "/fixture/data");
  owned.add(postgres);
  phase = "start PG17";
  await docker(
    "run",
    "-d",
    "--name",
    postgres,
    "--label",
    label,
    "--network",
    network,
    "--network-alias",
    "db.private",
    "--network-alias",
    "wrong.private",
    "--mount",
    `type=volume,source=${volume},target=/fixture,readonly`,
    "--mount",
    `type=volume,source=${volume},target=/var/run/postgresql`,
    "--env",
    "PGDATA=/var/run/postgresql/data",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--user",
    "70:70",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--read-only",
    "--env",
    "POSTGRES_DB=markiro",
    "--env",
    "POSTGRES_PASSWORD_FILE=/fixture/password",
    "--env",
    "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=peer",
    "postgres:17-alpine",
    "postgres",
    "-c",
    "ssl=on",
    "-c",
    "ssl_cert_file=/fixture/server.crt",
    "-c",
    "ssl_key_file=/fixture/server.key",
    "-c",
    "hba_file=/fixture/pg_hba.conf",
    "-c",
    "password_encryption=scram-sha-256",
  );
  const hardened = JSON.parse((await docker("inspect", postgres)).stdout)[0];
  assert.equal(hardened.Config.User, "70:70");
  assert.ok(
    hardened.HostConfig.CapDrop.includes("ALL") || hardened.HostConfig.CapDrop.includes("CHOWN"),
  );
  assert.ok(
    hardened.HostConfig.SecurityOpt.some((value) =>
      /^no-new-privileges(?::true|=true)?$/u.test(value),
    ),
  );
  assert.equal(hardened.HostConfig.ReadonlyRootfs, true);
  const processStatus = (await docker("exec", postgres, "cat", "/proc/self/status")).stdout;
  assert.match(processStatus, /^Uid:\s+70\s+70\s+70\s+70$/mu);
  for (const mask of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
    assert.match(processStatus, new RegExp(`^${mask}:\\s+0+$`, "mu"));
  assert.match(processStatus, /^NoNewPrivs:\s+1$/mu);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await docker(
        "exec",
        "--user",
        "postgres",
        postgres,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "markiro",
      );
      ready = true;
      break;
    } catch {
      const state = JSON.parse(
        (await docker("inspect", "--format", "{{json .State}}", postgres)).stdout,
      );
      if (!state.Running) {
        break;
      }
      if (interruption.signal.aborted) throw new Error("Role harness interrupted");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(ready, "Isolated PostgreSQL readiness");
  phase = "fresh-database negative checks";
  const bootstrap = (...args) =>
    docker(
      "exec",
      "--user",
      "postgres",
      postgres,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "markiro",
      ...args,
    );
  const beforePolicy = (
    await bootstrap(
      "-Atc",
      "SELECT coalesce(datacl::text, ''), datdba FROM pg_database WHERE datname='markiro'",
    )
  ).stdout;
  for (const [prepare, cleanup, roles] of [
    ["CREATE TABLE public.preexisting(id int)", "DROP TABLE public.preexisting", "0"],
    [
      "CREATE SCHEMA custom_existing; CREATE TABLE custom_existing.business(id int)",
      "DROP SCHEMA custom_existing CASCADE",
      "0",
    ],
    ["CREATE ROLE markiro_app NOLOGIN", "DROP ROLE markiro_app", "1"],
  ]) {
    await bootstrap("-c", prepare);
    let rejected = false;
    try {
      await bootstrap("-f", "/fixture/roles.sql");
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "Fresh-only provisioning must reject existing state");
    assert.equal(
      (
        await bootstrap(
          "-Atc",
          "SELECT count(*) FROM pg_roles WHERE rolname IN ('markiro_app','markiro_migrator')",
        )
      ).stdout.trim(),
      roles,
    );
    assert.equal(
      (
        await bootstrap(
          "-Atc",
          "SELECT coalesce(datacl::text, ''), datdba FROM pg_database WHERE datname='markiro'",
        )
      ).stdout,
      beforePolicy,
    );
    assert.equal(
      (
        await bootstrap(
          "-Atc",
          "SELECT count(*) FROM pg_namespace WHERE nspname IN ('drizzle','pgboss_platform')",
        )
      ).stdout.trim(),
      "0",
    );
    await bootstrap("-c", cleanup);
  }
  phase = "explicit bootstrap provisioning";
  await provisionRoles({
    prefix: ["--host", endpoint],
    container: postgres,
    env: environment,
    sqlFile: join(fixture, "roles.sql"),
    signal: interruption.signal,
  });
  phase = "actual migrations, role permissions, pinned pg-boss and TLS";
  // Mount only code/dependencies, never the checkout root or a user's .env.
  const mounts = [
    "node_modules",
    "packages/db",
    "apps/api/node_modules",
    "apps/api/package.json",
    "deploy/platform/postgres",
    "deploy/platform/host/probe-worker.mjs",
  ].flatMap((path) => [
    "--mount",
    `type=bind,source=${resolve(path)},target=/workspace/${path},readonly`,
  ]);
  owned.add(probe);
  await docker(
    "create",
    "--name",
    probe,
    "--label",
    label,
    "--network",
    network,
    "--mount",
    `type=volume,source=${volume},target=/fixture,readonly`,
    ...mounts,
    "node:24.18.0-bookworm-slim",
    "node",
    "/workspace/deploy/platform/postgres/roles-probe.mjs",
  );
  const result = await docker("start", "--attach", probe);
  const state = JSON.parse((await docker("inspect", "--format", "{{json .State}}", probe)).stdout);
  if (state.ExitCode !== 0) {
    // Probe stderr uses only allowlisted stage/code, no error text or query data.
    const safe = result.stderr.trim();
    if (/^Role probe failed at [a-zA-Z0-9 -]+; code=[A-Z0-9_]+$/u.test(safe))
      process.stderr.write(safe + "\n");
    throw new Error("Isolated role probe failed");
  }
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.checks) && report.checks.length === 7);
  assert.ok(
    report.checks.includes("fixed host probe read-only policy and independent TLS negatives"),
  );
  assert.ok(
    report.checks.includes(
      "effective schema USAGE and current sequence USAGE/SELECT revocation rejected and restored",
    ),
  );
  process.stdout.write(
    JSON.stringify({
      kind: "local-synthetic-role-proof",
      architecture: info.Architecture,
      postgresVersion: report.postgresVersion,
      pgBossVersion: report.pgBossVersion,
      checks: [
        "rendered Compose credential isolation",
        "SQL stdin provisioning as PostgreSQL with user70, cap-dropALL, no-new-privileges and read-only root",
        "fresh-only provisioning rejects existing objects/roles without partial grants",
        ...report.checks,
      ],
    }) + "\n",
  );
} finally {
  await cleanup();
}

async function cleanup() {
  phase = "cleanup owned resources";
  let cleanupFailed = false;
  for (const [kind, name] of [
    ["container", probe],
    ["container", postgres],
    ["container", helper],
    ["volume", volume],
    ["network", network],
  ]) {
    if (!owned.has(name)) continue;
    try {
      const names = (
        await command(
          "docker",
          [
            "--host",
            endpoint,
            kind,
            "ls",
            ...(kind === "container" ? ["--all"] : []),
            "--filter",
            `label=${label}`,
            "--format",
            kind === "container" ? "{{.Names}}" : "{{.Name}}",
          ],
          true,
        )
      ).stdout
        .trim()
        .split("\n");
      if (!names.includes(name)) continue;
      const inspection = JSON.parse(
        (await command("docker", ["--host", endpoint, kind, "inspect", name], true)).stdout,
      )[0];
      assert.equal(
        (inspection.Config?.Labels ?? inspection.Labels)?.["markiro.disposable-test"],
        project,
      );
      await command(
        "docker",
        [
          "--host",
          endpoint,
          kind,
          "rm",
          ...(kind === "container" ? ["--force", "--volumes"] : []),
          name,
        ],
        true,
      );
    } catch {
      cleanupFailed = true;
    }
  }
  await chmod(directory, 0o700);
  await rm(directory, { recursive: true, force: true });
  if (cleanupFailed)
    throw new Error(`Cleanup requires inspection of task-owned resources: ${project}`);
  process.stdout.write(`Owned role harness resources removed: ${project}\n`);
}
