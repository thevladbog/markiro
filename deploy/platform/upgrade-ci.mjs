import { createDockerInspectChannel } from "./rehearsal-inspect-channel.mjs";
/** Actual Docker/SQL/TLS rehearsal, synthetic data and admissions only.
 * The outer local daemon hosts a fresh nested daemon. Only image staging has
 * network access; it is disconnected and checked before product code starts.
 * Never an installed production command or a production admission producer.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "../production/cli-main.mjs";
import { canonical, digest } from "./backup/schemas.mjs";
import { ICU_POSTGRES_BASE } from "./backup/worker-recipes.mjs";
import { hostEnv, envBytes, hostIdentity } from "./test/host-fixtures.mjs";
import { upgradeFixture } from "./test/upgrade-fixture.mjs";
import { fingerprintHostConfiguration } from "./host/config.mjs";
import { createUpgradeObservers } from "./host/upgrade-observation.mjs";
import { createUpgradeWorkloadCommands } from "./host/upgrade-workloads.mjs";
import { createUpgradeSchemaObserver } from "./host/upgrade-schema.mjs";
import {
  withHeldUpgradeState,
  withUpgradeState,
  withUpgradePhaseState,
} from "./host/upgrade-state.mjs";
import { executeUpgradePreparation } from "./host/upgrade-preparation.mjs";
import { executeUpgradeReturn } from "./host/upgrade-return.mjs";
import {
  validateRehearsalImage,
  rehearsalFailure,
  rehearsalLabel,
  rehearsalStagingNetwork,
  assertFreshRehearsalName,
  rehearsalImages,
  rehearsalExecutor,
  rehearsalProduct,
  captureRehearsalResources,
  validateRehearsalDaemon,
  validateRehearsalEnvironment,
  rehearsalTemporaryBase,
  cleanupRehearsalResources,
  rehearsalCleanupStep,
} from "./upgrade-ci-guards.mjs";
import {
  createRehearsalMetadataReader,
  rehearsalIsolationReaders,
  parseRehearsalRoutes,
  rehearsalRouteCommand,
} from "./rehearsal-isolation-readers.mjs";
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// These four independent read-only facts are still checked before and after
// every protected command. Drain all reads even after a refusal: no background
// inspector may overlap a subsequent command or namespace cleanup.
export async function verifyRehearsalIsolation(invocationId, readers, expected) {
  const names = ["container", "volume", "ipv4", "ipv6"];
  assert.ok(names.every((name) => typeof readers[name] === "function"));
  const results = await Promise.allSettled(
    names.map((name) => Promise.resolve().then(readers[name])),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const [container, volume, ipv4, ipv6] = results.map((result) => result.value);
  validateRehearsalDaemon({ invocationId, container, volume, routes: { ipv4, ipv6 } }, expected);
}

// Compiled direct forward helpers (smoke/SQL/inspect) also execute inside the
// namespace without passing through the host-process adapter. Keep fresh full
// physical guards on both sides; never return success after a post-check fails.
export function guardRehearsalOperation(verifyIsolation, operation) {
  assert.equal(typeof verifyIsolation, "function");
  assert.equal(typeof operation, "function");
  return async (...args) => {
    await verifyIsolation();
    const result = await operation(...args);
    await verifyIsolation();
    return result;
  };
}

// Source reads do not execute workloads. The forward transport independently
// re-observes all four isolation facts before and after every Docker request.
// The ordinary return harness retains its original isolation-first composition.
export function createRehearsalSourceChecks({
  root,
  closure,
  values,
  generated,
  temporaryBase,
  verifyIsolation,
}) {
  assert.equal(typeof verifyIsolation, "function");
  const verifySourceBytes = async () => {
    for (const [file, sha] of Object.entries(closure))
      assert.equal(digest(await readFile(join(root, file))), sha);
    validateRehearsalEnvironment(values, generated, root, temporaryBase);
  };
  return Object.freeze({
    verifySourceBytes,
    verifySources: async () => {
      await verifyIsolation();
      await verifySourceBytes();
    },
  });
}

// Hash the read-back private files as configuration integrity evidence. These
// SHA256 values are file identities, never password authentication verifiers.
export async function createRehearsalConfiguration(root, values, migrationUrl) {
  const { createPrivateDirectory, writePrivateFile, readPrivateFile } =
    await import("./host/files.mjs");
  const candidateId = randomUUID();
  await createPrivateDirectory(root, "candidates", { exclusive: false });
  const relative = `candidates/${candidateId}`;
  await createPrivateDirectory(root, relative);
  await writePrivateFile(root, `${relative}/runtime.env`, envBytes(values));
  await writePrivateFile(
    root,
    `${relative}/migration.env`,
    Buffer.from(`DATABASE_URL=${migrationUrl}\n`),
  );
  const configuration = { candidateId };
  for (const name of ["runtime", "migration"]) {
    const path = `${relative}/${name}.env`;
    configuration[`${name}Snapshot`] = {
      path: join(root, path),
      sha256: digest(await readPrivateFile(root, path)),
    };
  }
  return {
    configuration,
    sha256: (await fingerprintHostConfiguration({ root, ...configuration })).configurationSha256,
  };
}

// Transfer a validated private tree, then verify every received file. The caller
// selects stdin extraction or a separately probed regular-rootfs archive copy.
export async function stageRehearsalTree(root, io) {
  const copy = Object.hasOwn(io, "copyDirectory");
  if (copy) {
    assert.equal(typeof io.copyDirectory, "function");
    assert.equal(typeof io.inspectDirectory, "function");
    assert.equal(Object.hasOwn(io, "archive"), false);
    assert.equal(Object.hasOwn(io, "extract"), false);
  } else {
    assert.equal(typeof io.archive, "function");
    assert.equal(typeof io.extract, "function");
  }
  const files = [],
    directories = [];
  async function walk(relative) {
    const path = join(root, relative),
      metadata = await lstat(path);
    assert.equal(metadata.uid, process.getuid());
    assert.equal(metadata.isSymbolicLink(), false);
    if (metadata.isDirectory()) {
      assert.equal(metadata.mode & 0o777, 0o700);
      directories.push(relative);
      for (const name of (await readdir(path)).sort()) {
        assert.match(name, /^[a-zA-Z0-9_.-]+$/u);
        await walk(join(relative, name));
      }
    } else {
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.nlink, 1);
      const mode = metadata.mode & 0o777;
      assert.ok([0o600, 0o644].includes(mode));
      files.push({ relative, mode, size: metadata.size, sha256: digest(await readFile(path)) });
    }
  }
  await walk("");
  assert.ok(files.length > 0);
  if (copy) {
    await io.copyDirectory(root);
    for (const relative of directories)
      assert.deepEqual(await io.inspectDirectory(relative), { mode: 0o700, type: "directory" });
  } else {
    const archive = await io.archive(root);
    assert.ok(Buffer.isBuffer(archive));
    await io.extract(archive);
  }
  for (const { relative, ...expected } of files)
    assert.deepEqual(await io.inspectFile(relative), expected);
  return { files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
}

// Use the already-probed regular-rootfs archive boundary for private source
// trees. The complete historical/current closures can exceed control stdin's
// unchanged 1 MiB cap. Every directory and file is still verified after copy.
export async function copyRehearsalTree(root, { archive, outer, shell, containerId }) {
  assert.match(containerId, /^[a-f0-9]{64}$/u);
  assert.equal(typeof archive, "function");
  return stageRehearsalTree(root, {
    copyDirectory: async (directory) => {
      // Preserve the old bounded TAR preflight without feeding a large archive
      // into the ordinary control process's smaller stdin contract.
      const bytes = await archive(directory);
      assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 4 * 1048576);
      await shell(["mkdir", "-p", "-m", "700", directory]);
      await shell(["chmod", "700", directory]);
      await outer(["cp", `${directory}/.`, `${containerId}:${directory}`]);
    },
    inspectDirectory: async (relative) => {
      const [mode, type] = (await shell(["stat", "-c", "%a:%F", join(root, relative)])).stdout
        .trim()
        .split(":");
      return { mode: Number.parseInt(mode, 8), type };
    },
    inspectFile: async (relative) => {
      const path = join(root, relative);
      const sha = (await shell(["sha256sum", path])).stdout;
      assert.match(sha, /^[a-f0-9]{64} {2}/u);
      assert.equal(sha.slice(66), `${path}\n`);
      const metadata = (await shell(["stat", "-c", "%a:%s", path])).stdout.trim();
      assert.match(metadata, /^[0-7]{3,4}:\d+$/u);
      const [mode, size] = metadata.split(":");
      return { sha256: sha.slice(0, 64), size: Number(size), mode: Number.parseInt(mode, 8) };
    },
  });
}

// Fail before applications if archive-copy and live exec disagree on this
// invocation's private directory. Probe bytes contain no configuration/secrets.
export async function verifyRehearsalArchiveTransfer(parent, io) {
  const source = join(parent, "archive-probe"),
    result = join(parent, "archive-probe-readback");
  const bytes = randomBytes(32);
  await writeFile(source, bytes, { mode: 0o600, flag: "wx" });
  await io.upload(source);
  assert.deepEqual(await io.readLive(source), bytes);
  await io.download(source, result);
  const metadata = await lstat(result);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.uid, process.getuid());
  assert.equal(metadata.size, bytes.length);
  await chmod(result, 0o600);
  assert.deepEqual(await readFile(result), bytes);
}

/** Restore the generated old database including its database-level privileges.
 * A restore into a manually recreated database omits these ACLs, including the
 * migrator's CREATE grant required by Drizzle even for an existing schema. */
export async function restoreRehearsalDatabase({ postgresId, sql, nested }) {
  assert.match(postgresId, /^[a-f0-9]{64}$/u);
  const databaseAuthority = `SELECT json_build_object(
    'owner', d.datdba::text,
    'acl', (SELECT json_agg(json_build_array(a.grantor::text, a.grantee::text,
      a.privilege_type, a.is_grantable) ORDER BY a.grantor, a.grantee,
      a.privilege_type, a.is_grantable)
      FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a)
    )::text FROM pg_database d WHERE d.datname = 'markiro';`;
  const authority = async () => {
    const { stdout } = await sql(databaseAuthority);
    assert.ok(typeof stdout === "string" || Buffer.isBuffer(stdout));
    const text = stdout.toString("utf8");
    assert.ok(text.trim() !== "");
    return text;
  };
  const before = await authority();
  await sql("DROP DATABASE markiro;", "postgres");
  await nested(
    [
      "exec",
      "--user",
      "70:70",
      postgresId,
      "pg_restore",
      "--exit-on-error",
      "--create",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "/tmp/rehearsal.dump",
    ],
    { timeout: 180000 },
  );
  assert.equal(await authority(), before);
}

export async function rehearseUpgrade(
  argv,
  { writeResult = async () => {}, forwardScenario } = {},
) {
  assert.ok(
    forwardScenario === undefined ||
      (forwardScenario.kind === "synthetic-forward" &&
        ["stage", "values", "candidate", "run"].every(
          (name) => typeof forwardScenario[name] === "function",
        )),
  );
  assert.equal(typeof writeResult, "function");
  assert.deepEqual(argv, ["--local-ci"]);
  const temporaryBase = rehearsalTemporaryBase(
    process.platform,
    await realpath(process.env.RUNNER_TEMP ?? (process.platform === "darwin" ? "/tmp" : "")),
  );
  const parent = await mkdtemp(join(temporaryBase, "markiro-upgrade-ci-"));
  await chmod(parent, 0o700);
  const repository = await realpath(resolve("."));
  const invocationId = randomUUID(),
    name = `markiro-upgrade-ci-${invocationId}`;
  const root = join(parent, "state");
  await mkdir(root, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: homedir(), LANG: "C.UTF-8" };
  const command = async (bin, args, options = {}) => {
    try {
      return await run(bin, args, {
        env,
        cwd: repository,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        ...options,
      });
    } catch (error) {
      const executable = basename(bin);
      error.rehearsalExecutable = executable;
      error.rehearsalCommand =
        executable === "tar"
          ? "tar archive"
          : `${executable} ${args[executable === "docker" ? 2 : 0]}`;
      throw error;
    }
  };
  const endpoint = JSON.parse((await command("docker", ["context", "inspect"])).stdout)[0]
    ?.Endpoints?.docker?.Host;
  assert.match(endpoint ?? "", /^unix:\/\//u);
  const outer = (args, options) => command("docker", ["--host", endpoint, ...args], options);
  const inspectOuter = async (kind, id) =>
    JSON.parse((await outer([kind, "inspect", id])).stdout)[0];
  const save = async (file, value) => {
    await writeFile(
      join(parent, file),
      typeof value === "string" ? value : canonical(value) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  };
  let phase = "stage isolated daemon",
    owned,
    containerId,
    inspectChannel,
    volumeCreated = false,
    completed = false,
    isolated = false,
    problem;
  const evidence = {
    version: 1,
    kind: "synthetic-only-upgrade-return-rehearsal",
    invocationId,
    productionAdmission: false,
    productSha: rehearsalProduct,
    oldExecutorSha: rehearsalExecutor,
    checks: [],
    differences: [
      "Fresh local nested daemon and generated credentials, no production data or endpoints",
      "Synthetic historical recovery and protected approvals; production GitHub authorization not exercised",
      "Fixed Docker argv transported by local docker exec into isolated daemon",
      "Synthetic old-image database migrated then dump/restored before retained containers start",
      "Local Caddy CA and localhost domains; production public DNS/ACME not exercised",
    ],
  };
  const progress = (p) => {
    phase = p;
    process.stdout.write(`Rehearsal: ${p}\n`);
  };
  const nested = async (args, options = {}) => {
    assert.match(containerId ?? "", /^[a-f0-9]{64}$/u);
    return outer(
      [
        "exec",
        ...(options.input !== undefined ? ["-i"] : []),
        containerId,
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        ...args,
      ],
      options,
    );
  };
  // execFile cannot stream stdin; use the established bounded process runner for
  // private SQL/env/auth input. All stderr stays private and errors are sanitized.
  const { runHostProcess } = await import("./host/process.mjs");
  const dockerPath = (await command("/usr/bin/which", ["docker"])).stdout.trim();
  const stdinOuter = async (args, input, timeoutMs = 120000) =>
    runHostProcess({
      executable: dockerPath,
      args: ["--host", endpoint, ...args],
      cwd: parent,
      env,
      timeoutMs,
      outputLimitBytes: 1048576,
      ...(input === undefined ? {} : { input: Buffer.from(input) }),
    });
  const stdinNested = (args, input, timeout) =>
    stdinOuter(
      ["exec", "-i", containerId, "docker", "--host", "unix:///var/run/docker.sock", ...args],
      input,
      timeout,
    );
  const inspect = async (kind, id) => JSON.parse((await nested([kind, "inspect", id])).stdout)[0];
  const shell = (args) => outer(["exec", containerId, ...args]);
  const metadata = createRehearsalMetadataReader(endpoint);
  const verifyIsolation = () =>
    verifyRehearsalIsolation(
      invocationId,
      rehearsalIsolationReaders({
        container: () => metadata.container(containerId),
        volume: () => metadata.volume(name),
        routes: async () => parseRehearsalRoutes((await shell(rehearsalRouteCommand)).stdout),
      }),
      owned,
    );
  try {
    const daemon = await inspectOuter("image", rehearsalImages.daemon);
    validateRehearsalImage(daemon);
    assertFreshRehearsalName(name, {
      containers: (await outer(["container", "ls", "--all", "--format", "{{.Names}}"])).stdout
        .trim()
        .split("\n")
        .filter(Boolean),
      volumes: (await outer(["volume", "ls", "--format", "{{.Name}}"])).stdout
        .trim()
        .split("\n")
        .filter(Boolean),
    });
    await outer(["volume", "create", "--label", `${rehearsalLabel}=${invocationId}`, name]);
    volumeCreated = true;
    containerId = (
      await outer([
        "create",
        "--platform",
        "linux/amd64",
        "--name",
        name,
        "--privileged",
        "--label",
        `${rehearsalLabel}=${invocationId}`,
        "--env",
        "DOCKER_TLS_CERTDIR=",
        "--mount",
        `type=volume,source=${name},target=/var/lib/docker`,
        rehearsalImages.daemon,
        "dockerd",
        "--host=unix:///var/run/docker.sock",
        "--storage-driver=vfs",
      ])
    ).stdout.trim();
    owned = captureRehearsalResources({
      invocationId,
      container: await inspectOuter("container", containerId),
      volume: await inspectOuter("volume", name),
    });
    await save("owned-resources.json", owned);
    await outer(["start", containerId]);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await nested(["info", "--format", "{{.ID}}"]);
        ready = true;
        break;
      } catch {
        await sleep(500);
      }
    }
    assert.ok(ready);
    assert.equal((await nested(["ps", "-aq"])).stdout.trim(), "");
    progress("pull exact accepted product images before disconnect");
    // Public pulls first; auth is only used if GHCR requires it. No retrying a
    // product process: no product container exists during this staging phase.
    for (const image of [ICU_POSTGRES_BASE, rehearsalImages.api, rehearsalImages.edge]) {
      await nested(["pull", "--platform", "linux/amd64", image], { timeout: 900000 });
      const actual = await inspect("image", image);
      assert.equal(actual.Os, "linux");
      assert.equal(actual.Architecture, "amd64");
      evidence.images ??= {};
      evidence.images[image] = { id: actual.Id, repoDigests: actual.RepoDigests };
    }
    const forwardStage = forwardScenario
      ? await forwardScenario.stage({
          parent,
          root,
          repository,
          command,
          outer,
          nested,
          shell,
          stdinOuter,
          containerId,
          inspect,
          progress,
        })
      : null;
    assert.equal((await nested(["ps", "-aq"])).stdout.trim(), "");
    progress("remove every external network before application processes");
    const stagingNetwork = rehearsalStagingNetwork(await inspectOuter("container", containerId));
    await outer(["network", "disconnect", stagingNetwork, containerId]);
    await verifyIsolation();
    isolated = true;
    const info = JSON.parse((await nested(["info", "--format", "{{json .}}"])).stdout);
    assert.equal(info.OSType, "linux");
    assert.ok(["x86_64", "amd64"].includes(info.Architecture));
    evidence.daemon = { id: info.ID, architecture: info.Architecture };
    const probe = `const net=require('node:net');const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(5000,()=>process.exit(3));s.once('connect',()=>process.exit(4));s.once('error',e=>{if(!['ENETUNREACH','EHOSTUNREACH'].includes(e.code))process.exit(5);process.stdout.write(e.code);});`;
    const denied = await nested([
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "bridge",
      "--entrypoint",
      "node",
      rehearsalImages.api,
      "-e",
      probe,
    ]);
    assert.match(denied.stdout, /^(?:ENETUNREACH|EHOSTUNREACH)$/u);
    await verifyIsolation();
    evidence.checks.push("no outer network or route; actual TCP egress denied before applications");
    progress("create private old source closure and generated configuration");
    await mkdir(join(root, "pg"), { mode: 0o700 });
    await mkdir(join(root, "docker"), { mode: 0o700 });
    await mkdir(join(parent, "postgres"), { mode: 0o700 });
    progress("read exact old Git source closure");
    const closure = {};
    for (const file of [
      "compose.yml",
      "compose.compact.yml",
      "postgres/pg_hba.conf",
      "postgres/roles.mjs",
    ]) {
      const bytes = (
        await command("git", ["show", `${rehearsalExecutor}:deploy/platform/${file}`], {
          encoding: "buffer",
        })
      ).stdout;
      const path = join(parent, file);
      await writeFile(path, bytes, {
        mode: file.endsWith("pg_hba.conf") ? 0o644 : 0o600,
        flag: "wx",
      });
      closure[file] = digest(bytes);
    }
    evidence.oldSources = { executorSha: rehearsalExecutor, files: closure };
    await save("old-source-closure.json", evidence.oldSources);
    // Audit current executable bytes, including synthetic fixture generators.
    progress("hash current executable source closure");
    const currentFiles = (await command("git", ["ls-files", "deploy/platform"])).stdout
      .trim()
      .split("\n")
      .filter((p) => p.endsWith(".mjs"));
    currentFiles.push("deploy/platform/upgrade-ci.mjs", "deploy/platform/upgrade-ci-guards.mjs");
    const current = {};
    for (const file of [...new Set(currentFiles)].sort())
      current[file] = digest(await readFile(join(repository, file)));
    evidence.rehearsalSources = {
      gitHead: (await command("git", ["rev-parse", "HEAD"])).stdout.trim(),
      files: current,
    };
    await save("rehearsal-source-closure.json", evidence.rehearsalSources);
    const password = randomBytes(32).toString("hex"),
      appPassword = randomBytes(32).toString("hex"),
      migratorPassword = randomBytes(32).toString("hex");
    await writeFile(join(root, "pg/password"), password, { mode: 0o600, flag: "wx" });
    progress("generate private rehearsal TLS files");
    const openssl = (args) => command("openssl", args);
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(parent, "ca.key"),
      "-out",
      join(root, "pg/ca.crt"),
      "-days",
      "1",
      "-subj",
      "/CN=Upgrade rehearsal only",
    ]);
    await openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "pg/server.key"),
      "-out",
      join(parent, "server.csr"),
      "-subj",
      "/CN=db.private",
    ]);
    await save("tls.ext", "subjectAltName=DNS:db.private\n");
    await openssl([
      "x509",
      "-req",
      "-in",
      join(parent, "server.csr"),
      "-CA",
      join(root, "pg/ca.crt"),
      "-CAkey",
      join(parent, "ca.key"),
      "-CAcreateserial",
      "-out",
      join(root, "pg/server.crt"),
      "-days",
      "1",
      "-extfile",
      join(parent, "tls.ext"),
    ]);
    for (const f of ["ca.crt", "server.key", "server.crt", "password"])
      await chmod(join(root, "pg", f), 0o600);
    const identity = hostIdentity();
    identity.admission.manifest.sourceSha = rehearsalProduct;
    identity.admission.manifest.toolingSha = rehearsalProduct;
    identity.admission.verified.sourceSha = rehearsalProduct;
    identity.admission.verified.toolingSha = rehearsalProduct;
    for (const service of ["api", "edge"]) {
      const ref = rehearsalImages[service],
        image = await inspect("image", ref);
      identity.admission.manifest[service] = ref;
      identity.admission.registry[service] = {
        reference: ref,
        imageId: image.Id,
        platform: "linux/amd64",
      };
      identity.admission.verified.images[service].id = image.Id;
      identity.admission.verified.images[service].tag = identity.admission.verified.images[
        service
      ].tag.replace("a".repeat(40), rehearsalProduct);
    }
    const values = hostEnv(identity.admission.manifest, root);
    Object.assign(values, {
      DATABASE_URL: `postgresql://markiro_app:${appPassword}@db.private/markiro?sslmode=verify-full&sslrootcert=/run/markiro-postgres/ca.crt`,
      PLATFORM_AUTH_SECRET: randomBytes(48).toString("hex"),
      MAIL_PAYLOAD_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      S3_ENDPOINT: "https://storage.invalid",
      S3_PUBLIC_ORIGIN: "https://storage.invalid",
      S3_BUCKET: "synthetic-rehearsal",
      S3_ACCESS_KEY_ID: randomBytes(24).toString("hex"),
      S3_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
      SMTP_HOST: "mail.invalid",
      SMTP_USER: "fixture",
      SMTP_PASSWORD: randomBytes(32).toString("hex"),
      SMTP_FROM_EMAIL: "fixture@rehearsal.invalid",
      ACME_EMAIL: "fixture@rehearsal.invalid",
      MARKIRO_POSTGRES_IMAGE_DIGEST: ICU_POSTGRES_BASE.split("@")[1],
    });
    for (const [key, value] of Object.entries({
      MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.localhost",
      MARKIRO_LANDING_DOMAIN: "landing.localhost",
      MARKIRO_RETIRED_ADMIN_DOMAIN: "admin.localhost",
      MARKIRO_RETIRED_KIOSK_DOMAIN: "kiosk.localhost",
      SAAS_ADMIN_ORIGIN: "https://saas-admin.localhost",
      PLATFORM_AUTH_URL: "https://saas-admin.localhost",
      LANDING_ORIGIN: "https://landing.localhost",
    }))
      values[key] = value;
    delete values.MARKIRO_RELEASES_DOMAIN;
    delete values.MARKIRO_RELEASES_BUCKET;
    const generated = Object.freeze({ ...values });
    validateRehearsalEnvironment(values, generated, parent, temporaryBase);
    progress("write and verify generated private configuration snapshots");
    const migrationUrl = `postgresql://markiro_migrator:${migratorPassword}@db.private/markiro?sslmode=verify-full&sslrootcert=/run/markiro-postgres/ca.crt`;
    const config = (value) => createRehearsalConfiguration(root, value, migrationUrl);
    const oldConfig = await config(values),
      candidateConfig = await config({
        ...values,
        MARKIRO_RELEASES_DOMAIN: "releases.localhost",
        MARKIRO_RELEASES_BUCKET: "synthetic-releases",
        ...(forwardScenario ? forwardScenario.values() : {}),
      });
    const interpolation = {
      ...values,
      MARKIRO_PLATFORM_ENV_FILE: oldConfig.configuration.runtimeSnapshot.path,
      MARKIRO_PLATFORM_MIGRATION_ENV_FILE: oldConfig.configuration.migrationSnapshot.path,
      COMPOSE_DISABLE_ENV_FILE: "1",
      DOCKER_CONFIG: join(root, "docker"),
    };
    const composeEnv = join(parent, "compose.env");
    await save("compose.env", envBytes(interpolation).toString());
    // Copy only the validated private tree after the live-rootfs probe; no host bind/socket.
    progress("stream and verify generated private tree in the isolated daemon");
    await shell(["mkdir", "-p", parent]);
    await verifyRehearsalArchiveTransfer(parent, {
      upload: (path) => outer(["cp", path, `${containerId}:${path}`]),
      readLive: async (path) =>
        (await outer(["exec", containerId, "cat", path], { encoding: "buffer" })).stdout,
      download: (path, out) => outer(["cp", `${containerId}:${path}`, out]),
    });
    evidence.privateTreeTransfer = await copyRehearsalTree(parent, {
      archive: async (directory) =>
        (await command("tar", ["-C", directory, "-cf", "-", "."], { encoding: "buffer" })).stdout,
      outer,
      shell,
      containerId,
    });
    progress("verify copied private PostgreSQL TLS file metadata");
    evidence.copiedTlsFiles = {};
    for (const file of ["ca.crt", "server.crt", "server.key", "password"]) {
      const metadata = (
        await shell(["stat", "-c", "%u:%g:%a:%s", join(root, "pg", file)])
      ).stdout.trim();
      assert.match(metadata, /^\d+:\d+:[0-7]{3,4}:\d+$/u);
      evidence.copiedTlsFiles[file] = metadata;
    }
    progress("assign generated private PostgreSQL TLS file ownership");
    await shell([
      "chown",
      "70:70",
      ...["server.crt", "server.key", "password"].map((f) => join(root, "pg", f)),
    ]);
    // The pinned API runs as node (UID 1000), while the server key/password
    // remain owned by PostgreSQL UID 70. Only the public test CA is shared.
    progress("verify pinned API runtime user");
    assert.equal((await inspect("image", rehearsalImages.api)).Config.User, "node");
    progress("assign generated private client CA file ownership");
    await shell(["chown", "1000:1000", join(root, "pg/ca.crt")]);
    const composeRun = async (args) => {
      await verifyIsolation();
      return nested(
        [
          "compose",
          "--env-file",
          composeEnv,
          "--project-name",
          "markiro-platform",
          "-f",
          join(parent, "compose.yml"),
          "-f",
          join(parent, "compose.compact.yml"),
          ...args,
        ],
        { timeout: 300000 },
      );
    };
    progress("bootstrap only synthetic PostgreSQL roles and old-image schema");
    for (const network of ["default", "database"])
      await nested([
        "network",
        "create",
        ...(network === "database" ? ["--internal"] : []),
        "--label",
        "com.docker.compose.project=markiro-platform",
        "--label",
        `com.docker.compose.network=${network}`,
        `markiro-platform_${network}`,
      ]);
    await nested([
      "volume",
      "create",
      "--label",
      "com.docker.compose.project=markiro-platform",
      "--label",
      "com.docker.compose.volume=postgres-data",
      "markiro-platform_postgres-data",
    ]);
    progress("initialize exact private PostgreSQL volume ownership");
    await nested([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0:0",
      "--mount",
      "type=volume,source=markiro-platform_postgres-data,target=/var/lib/postgresql/data",
      ICU_POSTGRES_BASE,
      "chown",
      "70:70",
      "/var/lib/postgresql/data",
    ]);
    progress("start isolated PostgreSQL and await health");
    await composeRun([
      "up",
      "--detach",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "120",
      "postgres",
    ]);
    const pg = (await inspect("container", "markiro-platform-postgres-1")).Id;
    const sql = (text, db = "markiro") =>
      stdinNested(
        [
          "exec",
          "-i",
          "--user",
          "70:70",
          pg,
          "psql",
          "-X",
          "--no-password",
          "-U",
          "postgres",
          "-d",
          db,
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        text,
        180000,
      );
    const { roleProvisioningSql } = await import(
      new URL(`file://${join(parent, "postgres/roles.mjs")}`)
    );
    progress("provision generated PostgreSQL roles");
    await sql(roleProvisioningSql({ appPassword, migratorPassword }));
    progress("apply exact old image migrations to synthetic database");
    await composeRun(["run", "--rm", "--no-deps", "migrate"]);
    progress("dump and restore the synthetic old schema before retaining applications");
    await nested(
      [
        "exec",
        "--user",
        "70:70",
        pg,
        "pg_dump",
        "-U",
        "postgres",
        "-d",
        "markiro",
        "-Fc",
        "-f",
        "/tmp/rehearsal.dump",
      ],
      { timeout: 180000 },
    );
    // Docker cp reads the container filesystem outside its live tmpfs mount.
    // Read the dump through the running namespace instead, preserving binary bytes.
    const archive = (
      await nested(["exec", "--user", "70:70", pg, "cat", "/tmp/rehearsal.dump"], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout;
    assert.ok(Buffer.isBuffer(archive) && archive.length > 0);
    assert.equal(archive.subarray(0, 5).toString("ascii"), "PGDMP");
    await writeFile(join(parent, "synthetic.dump"), archive, { mode: 0o600, flag: "wx" });
    evidence.archive = { sha256: digest(archive), bytes: archive.length, syntheticOnly: true };
    await restoreRehearsalDatabase({ postgresId: pg, sql, nested });
    evidence.checks.push(
      "old image migrated generated DB; full custom archive restored before app launch",
    );
    await composeRun([
      "up",
      "--detach",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "180",
      "api",
      "edge",
    ]);
    const predecessorContainers = {
      postgres: pg,
      api: (await inspect("container", "markiro-platform-api-1")).Id,
      edge: (await inspect("container", "markiro-platform-edge-1")).Id,
    };
    const volume = await inspect("volume", "markiro-platform_postgres-data");
    const machineId = digest(invocationId).slice(0, 32);
    const policy = {
      machineId,
      dockerId: info.ID,
      postgresImageId: (await inspect("image", ICU_POSTGRES_BASE)).Id,
      volume: { name: volume.Name, createdAt: volume.CreatedAt, mountpoint: volume.Mountpoint },
      networks: {},
    };
    for (const network of ["default", "database"]) {
      const n = await inspect("network", `markiro-platform_${network}`);
      policy.networks[network] = { name: n.Name, id: n.Id };
    }
    identity.target = {
      hostId: machineId,
      databaseId: String(
        (await sql("SELECT system_identifier::text FROM pg_control_system();")).stdout,
      ).trim(),
      volumeId: volume.Name,
    };
    identity.executorSha = rehearsalExecutor;
    identity.configurationSha256 = oldConfig.sha256;
    const candidate = structuredClone(identity);
    candidate.operationId = randomUUID();
    candidate.executorSha = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
    candidate.configurationSha256 = candidateConfig.sha256;
    if (forwardScenario) await forwardScenario.candidate(candidate, inspect);
    const prior = structuredClone(identity);
    prior.operationId = randomUUID();
    prior.executorSha = "b".repeat(40);
    const f = upgradeFixture({
      prior,
      recovered: identity,
      identity: candidate,
      configuration: oldConfig.configuration,
      root,
      policy,
    });
    f.input.expiresAt = new Date(Date.now() + 3600000).toISOString();
    const activation = join(parent, "recovery-operations", identity.operationId, "activate");
    await mkdir(activation, { recursive: true, mode: 0o700 });
    for (const [key, path] of Object.entries({
      original: join(root, "state.json"),
      acceptedRecovery: join(root, "recovery-state.json"),
      preparation: join(root, "recovery-preparation.json"),
      consumption: join(root, `recovery-activation-${identity.operationId}.json`),
      activationOperation: join(activation, "operation.json"),
    }))
      await writeFile(path, f.predecessorBytes[key], { mode: 0o600, flag: "wx" });
    const oldOperation = {
        root,
        dockerConfig: join(root, "docker"),
        identity,
        configuration: oldConfig.configuration,
      },
      candidateOperation = {
        root,
        dockerConfig: join(root, "docker"),
        identity: candidate,
        configuration: candidateConfig.configuration,
      };
    const sourceChecks = createRehearsalSourceChecks({
      root: parent,
      closure,
      values,
      generated,
      temporaryBase,
      verifyIsolation,
    });
    const deps = {
      readMachineId: async () => machineId,
      verifySources: sourceChecks.verifySources,
      runProcess: async (request) => {
        await verifyIsolation();
        assert.equal(request.executable, "/usr/bin/docker");
        assert.deepEqual(request.args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
        const result = await stdinOuter(
          ["exec", ...(request.input ? ["-i"] : []), containerId, "docker", ...request.args],
          request.input ?? Buffer.alloc(0),
          request.timeoutMs,
        );
        await verifyIsolation();
        return result;
      },
    };
    const input = { oldOperation, candidateOperation, predecessorContainers, policy };
    const observers = createUpgradeObservers(input, deps),
      workloads = createUpgradeWorkloadCommands(input, deps),
      schema = createUpgradeSchemaObserver({ postgresId: pg }, deps);
    let ca;
    for (let i = 0; i < 60; i++) {
      try {
        ca = (
          await nested([
            "exec",
            predecessorContainers.edge,
            "cat",
            "/data/caddy/pki/authorities/local/root.crt",
          ])
        ).stdout;
        if (ca.includes("BEGIN CERTIFICATE")) break;
      } catch {
        await sleep(500);
      }
    }
    assert.ok(ca?.includes("BEGIN CERTIFICATE"));
    const tlsScript = `const https=require('node:https');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const p=JSON.parse(input);const r=https.request({host:p.address,port:8443,servername:p.host,path:p.path,method:'GET',ca:p.ca,rejectUnauthorized:true,headers:{host:p.host}},res=>{res.resume();res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,headers:res.headers})));});r.setTimeout(15000,()=>r.destroy());r.on('error',()=>process.exit(1));r.end();});`;
    const smoke = async () => {
      const edge = await inspect("container", predecessorContainers.edge),
        address = edge.NetworkSettings.Networks["markiro-platform_default"].IPAddress;
      for (const [host, path, status] of [
        [values.MARKIRO_LANDING_DOMAIN, "/", 200],
        [values.MARKIRO_SAAS_ADMIN_DOMAIN, "/login", 200],
        [values.MARKIRO_SAAS_ADMIN_DOMAIN, "/api/platform/tenants", 401],
        [values.MARKIRO_SAAS_ADMIN_DOMAIN, "/station/sync", 404],
        [values.MARKIRO_RETIRED_ADMIN_DOMAIN, "/api/auth/get-session", 410],
        [values.MARKIRO_RETIRED_KIOSK_DOMAIN, "/kiosk/sync", 410],
      ]) {
        const result = JSON.parse(
          (
            await stdinNested(
              ["exec", "-i", predecessorContainers.api, "node", "-e", tlsScript],
              JSON.stringify({ address, host, path, ca }),
            )
          ).stdout,
        );
        assert.equal(result.status, status);
        assert.equal(result.headers.location, undefined);
        assert.equal(result.headers["x-markiro-server-profile"], "platform-only");
        assert.equal(result.headers["x-markiro-release-sha"], rehearsalProduct);
      }
    };
    progress("verify old health/TLS, then stop and retain exact IDs");
    await smoke();
    const prep = await executeUpgradePreparation(
      { root, admission: f.input },
      {
        verifyAdmission: async () => candidate,
        inspectOld: (_, cap) => observers.inspectOld(cap),
        inspectSchema: (_, cap) => schema(cap),
        stopOldEdge: (_, cap) => workloads.stopOldEdge(cap),
        stopOldApi: (_, cap) => workloads.stopOldApi(cap),
        inspectStoppedOld: (_, cap) => observers.inspectStoppedOld(cap),
        createBackup: async (_, cap) =>
          withHeldUpgradeState(cap, async (held) => {
            await held.verify();
            return {
              backup: {
                archiveSha256: evidence.archive.sha256,
                restoreEvidenceSha256: digest(canonical(evidence.archive)),
                target: candidate.target,
                operationId: candidate.operationId,
              },
              fence: {
                fenceId: randomUUID(),
                beganAt: new Date().toISOString(),
                enforcementSha256: digest(canonical(owned)),
              },
            };
          }),
      },
    );
    if (forwardScenario) {
      inspectChannel = createDockerInspectChannel({
        executable: dockerPath,
        endpoint,
        containerId,
        cwd: parent,
        env,
      });
      await forwardScenario.run({
        inspectChannel,
        root,
        parent,
        repository,
        containerId,
        invocationId,
        evidence,
        isolated,
        owned,
        forwardStage,
        verifyIsolation,
        verifySourceBytes: sourceChecks.verifySourceBytes,
        command,
        outer,
        nested: guardRehearsalOperation(verifyIsolation, nested),
        shell,
        stdinOuter,
        stdinNested: guardRehearsalOperation(verifyIsolation, stdinNested),
        inspect: guardRehearsalOperation(verifyIsolation, inspect),
        sql: guardRehearsalOperation(verifyIsolation, sql),
        oldOperation,
        candidateOperation,
        candidate,
        identity,
        f,
        prep,
        predecessorContainers,
        policy,
        oldConfig,
        candidateConfig,
        deps,
        values,
        generated,
        password,
        appPassword,
        migratorPassword,
        migrationUrl,
        ca,
        tlsScript,
        progress,
      });
    } else {
      // This harness does not substitute for fresh production backup/copy proof.
      const journal = join(root, "upgrade-operations", candidate.operationId, "state.json");
      const priorBytes = await readFile(journal),
        priorState = JSON.parse(priorBytes);
      const decision = {
        version: 1,
        kind: "platform-upgrade-phase",
        phase: "return-old",
        identity: candidate,
        prior: { sequence: priorState.sequence, sha256: digest(priorBytes) },
        executorCi: f.input.executorCi,
        reviewedPlanSha256: f.input.reviewedPlanSha256,
        dispatch: { toolingSha: candidate.executorSha, runId: "987654324", runAttempt: "1" },
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
      };
      progress("return exact retained containers through guarded return coordinator");
      await executeUpgradeReturn(
        { root, decision },
        {
          verifyAdmission: async () => candidate,
          inspectReturnEligibility: (_, cap) => observers.inspectReturnEligibility(cap),
          inspectSchema: (_, cap) => schema(cap),
          startOldApi: (_, cap) => workloads.startOldApi(cap),
          startOldEdge: (_, cap) => workloads.startOldEdge(cap),
          verifyOldHealth: (_, cap) => workloads.verifyOldHealth(cap),
          smoke: async (_, cap) =>
            withHeldUpgradeState(cap, async (held) => {
              await held.verify();
              await smoke();
              await held.verify();
            }),
          cleanupOwnedStarts: (_, cap) => workloads.cleanupOwnedStarts(cap),
        },
      );
      const terminal = JSON.parse(await readFile(journal));
      assert.equal(terminal.phase, "returned-old");
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.migrationEntered, false);
      assert.deepEqual(terminal.oldRuntime, prep.oldRuntime);
      await verifyIsolation();
      evidence.checks.push(
        "strict old configuration and exact IDs before/after stop and return; unchanged catalog/migration schema; healthy API/PG and six strict TLS endpoints",
      );
      evidence.containers = predecessorContainers;
      evidence.oldConfigurationSha256 = oldConfig.sha256;
      evidence.schema = prep.oldRuntime.schema;
      evidence.terminalSha256 = digest(await readFile(journal));
      progress("prove migration latch rejects return before any start");
      // A second synthetic state root has no mutation adapter. Even a failed spawn
      // after its durable latch must reject the return coordinator before starts.
      const faultParent = join(parent, "fault"),
        faultRoot = join(faultParent, "state");
      await mkdir(faultRoot, { recursive: true, mode: 0o700 });
      const faultCandidate = structuredClone(candidate);
      faultCandidate.operationId = randomUUID();
      const fault = upgradeFixture({
        prior,
        recovered: identity,
        identity: faultCandidate,
        configuration: oldConfig.configuration,
        root: faultRoot,
        policy,
      });
      fault.input.expiresAt = new Date(Date.now() + 3600000).toISOString();
      const faultActivation = join(
        faultParent,
        "recovery-operations",
        identity.operationId,
        "activate",
      );
      await mkdir(faultActivation, { recursive: true, mode: 0o700 });
      for (const [key, path] of Object.entries({
        original: join(faultRoot, "state.json"),
        acceptedRecovery: join(faultRoot, "recovery-state.json"),
        preparation: join(faultRoot, "recovery-preparation.json"),
        consumption: join(faultRoot, `recovery-activation-${identity.operationId}.json`),
        activationOperation: join(faultActivation, "operation.json"),
      }))
        await writeFile(path, fault.predecessorBytes[key], { mode: 0o600, flag: "wx" });
      const faultOld = { ...prep.oldRuntime, operationId: faultCandidate.operationId },
        faultBackup = { ...prep.backup, operationId: faultCandidate.operationId };
      await withUpgradeState(faultRoot, fault.input, async (s) => {
        await s.complete("admitted", faultOld);
        await s.enter("old-stopped");
        await s.complete("old-stopped");
        await s.enter("backup-verified");
        await s.complete("backup-verified", faultBackup, {
          ...prep,
          operationId: faultCandidate.operationId,
          oldRuntime: faultOld,
          backup: faultBackup,
        });
      });
      const faultJournal = join(
        faultRoot,
        "upgrade-operations",
        faultCandidate.operationId,
        "state.json",
      );
      const faultDecision = async (phase, runId) => {
        const bytes = await readFile(faultJournal);
        return {
          ...decision,
          identity: faultCandidate,
          phase,
          prior: { sequence: JSON.parse(bytes).sequence, sha256: digest(bytes) },
          dispatch: { ...decision.dispatch, runId },
        };
      };
      await assert.rejects(
        withUpgradePhaseState(
          faultRoot,
          await faultDecision("activate", "987654325"),
          async (s) => {
            await s.complete("activation-admitted");
            await s.enter("migration-entered");
            throw Error("synthetic pre-spawn failure after durable latch");
          },
        ),
      );
      assert.equal(JSON.parse(await readFile(faultJournal)).migrationEntered, true);
      let called = false;
      await assert.rejects(
        executeUpgradeReturn(
          { root: faultRoot, decision: await faultDecision("return-old", "987654326") },
          Object.fromEntries(
            [
              "verifyAdmission",
              "inspectReturnEligibility",
              "inspectSchema",
              "startOldApi",
              "startOldEdge",
              "verifyOldHealth",
              "smoke",
              "cleanupOwnedStarts",
            ].map((k) => [
              k,
              async () => {
                called = true;
                throw Error("must not enter adapter");
              },
            ]),
          ),
        ),
      );
      assert.equal(called, false);
      for (const [service, id] of Object.entries(predecessorContainers))
        assert.equal((await inspect("container", `markiro-platform-${service}-1`)).Id, id);
      evidence.checks.push(
        "durable migration-entered latch and failed spawn intent reject return before every adapter; actual retained IDs unchanged",
      );
    }
    completed = true;
  } catch (error) {
    await save(
      "failure-private.txt",
      JSON.stringify({
        code: error.code ?? null,
        signal: error.signal ?? null,
        reason: error.reason ?? null,
        stack: String(error.stack ?? error),
        stdout: String(error.stdout ?? "").slice(0, 524288),
        stderr: String(error.stderr ?? "").slice(0, 524288),
      }),
    );
    problem = rehearsalFailure(phase, error);
  } finally {
    try {
      await inspectChannel?.close();
    } catch (error) {
      problem ??= rehearsalFailure("owned cleanup", error);
    }
    if (owned) {
      try {
        await cleanupRehearsalResources(owned, {
          inspectContainer: (id) => inspectOuter("container", id),
          inspectVolume: (n) => inspectOuter("volume", n),
          removeContainer: (id) => outer(["rm", "--force", id]),
          // Run 40391451254 reached forward activation and then the exact
          // owned DinD volume removal was killed by execFile's 120s default
          // (exit143, killed=true). VFS deletes the nested image/workload tree.
          // Bound this CI resource cleanup separately; ownership checks and
          // required cleanup completion remain unchanged. No protected deployment command or
          // production observation/operation deadline receives this budget.
          removeVolume: (n) => outer(["volume", "rm", n], { timeout: 900000 }),
        });
        evidence.cleanup = true;
      } catch (error) {
        const diagnostic = rehearsalFailure("owned cleanup", error);
        process.stderr.write(
          `Rehearsal cleanup failure: ${JSON.stringify({
            step: rehearsalCleanupStep(error),
            exitStatus: diagnostic.exitStatus,
            executable: diagnostic.executable,
            processReason: diagnostic.processReason,
            childKilled: error.killed === true,
            signal: ["SIGTERM", "SIGKILL"].includes(error.signal) ? error.signal : null,
          })}\n`,
        );
        evidence.cleanup = false;
        problem ??= { phase: "owned cleanup", code: "CLEANUP_FAILED" };
      }
    } else if (volumeCreated) {
      evidence.cleanup = false;
      problem ??= {
        phase: "partial creation requires exact inspection",
        code: "PARTIAL_RESOURCES_RETAINED",
      };
    }
    evidence.isolated = isolated;
    evidence.completed = completed && !problem;
    evidence.problem = problem ?? null;
    await save("result.json", evidence);
    await writeResult(structuredClone(evidence));
    process.stdout.write(`Rehearsal evidence: ${parent}/result.json\n`);
  }
  if (problem)
    throw new Error(
      `Rehearsal failed at ${problem.phase} (${problem.code}); private evidence retained`,
    );
  return evidence;
}
if (isMainModule(import.meta.url))
  rehearseUpgrade(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
