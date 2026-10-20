/** Real host recovery integration on a disposable Linux runner. Synthetic data only.
 * No evidence from this harness is a migration admission or exported restore proof.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectRecoveryCiHost } from "./recovery-ci-preflight.mjs";
import {
  validateWorkerManifest,
  recoveryRoleMapping,
  cleanupRecoveryResources,
} from "./recovery-ci-helpers.mjs";
import { runHostProcess } from "./host/process.mjs";
import {
  snapshotHostConfig,
  snapshotMigrationConfig,
  fingerprintHostConfiguration,
  hostChildEnvironment,
} from "./host/config.mjs";
import { withRecoveryState } from "./host/recovery-state.mjs";
import { withHostState } from "./host/state.mjs";
import { createHeldTargetRecoveryBackup } from "./host/target-backup.mjs";
import { canonical, digest } from "./backup/schemas.mjs";
import { hashArchive } from "./backup/files.mjs";
import { ICU_POSTGRES_BASE } from "./backup/worker-recipes.mjs";
import { roleProvisioningSql } from "./postgres/roles.mjs";
import { hostEnv, envBytes, hostIdentity, backupProof } from "./test/host-fixtures.mjs";

const repositoryRoot = await realpath(resolve("."));
const root = await mkdtemp(join(await realpath(tmpdir()), "markiro-recovery-ci-"));
await chmod(root, 0o700);
let phase = "host preflight",
  admittedHost = false,
  completed = false,
  problem;
const command = (executable, args, env = {}, timeoutMs = 60000, input) =>
  runHostProcess({
    executable,
    args,
    cwd: root,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...env },
    timeoutMs,
    outputLimitBytes: 1048576,
    ...(input ? { input } : {}),
  });
const docker = (args) =>
  command(
    "/usr/bin/docker",
    ["--host", "unix:///var/run/docker.sock", ...args],
    { DOCKER_CONFIG: join(root, "docker") },
    900000,
  );
const inspect = async (kind, name) => JSON.parse((await docker([kind, "inspect", name])).stdout)[0];
const save = (name, bytes) =>
  writeFile(
    join(root, name),
    typeof bytes === "string" || Buffer.isBuffer(bytes) ? bytes : canonical(bytes) + "\n",
    { mode: 0o600, flag: "wx" },
  );
const exists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
try {
  const dockerId = await inspectRecoveryCiHost({ root, argv: process.argv.slice(2) });
  assert.equal(process.getuid(), 0, "Disposable runner must invoke recovery harness as root");
  assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_SHA, "Explicit CI image export required");
  admittedHost = true;
  await mkdir(join(root, "docker"), { mode: 0o700 });
  phase = "verify tested ICU worker export";
  const exportRoot = join(process.env.RUNNER_TEMP, "platform-recovery-image-icu");
  const sourceSha = String(
    (
      await command("/usr/bin/git", [
        "-c",
        `safe.directory=${repositoryRoot}`,
        "-C",
        repositoryRoot,
        "rev-parse",
        "HEAD",
      ])
    ).stdout,
  ).trim();
  assert.equal(sourceSha, process.env.GITHUB_SHA);
  await save("synthetic-only.json", {
    version: 1,
    kind: "synthetic-only-held-recovery-integration",
    migrationProof: false,
    sourceSha,
    warning:
      "Every journal, archive and restore proof in this private root uses synthetic CI data only.",
  });
  const manifest = validateWorkerManifest(
    JSON.parse(await readFile(join(exportRoot, "recovery-image.json"))),
    sourceSha,
  );
  for (const file of manifest.sources.files) {
    assert.match(file.path, /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u);
    assert.equal(digest(await readFile(join(repositoryRoot, file.path))), file.sha256);
  }
  assert.equal(manifest.sources.generated.path, "packages/db/dist/runtime-migrate.js");
  assert.equal(
    digest(await readFile(join(repositoryRoot, manifest.sources.generated.path))),
    manifest.sources.generated.sha256,
  );
  await cp(join(exportRoot, "recovery-image.tar"), join(root, "recovery-image.tar"));
  await chmod(join(root, "recovery-image.tar"), 0o600);
  const archive = await hashArchive(root, join(root, "recovery-image.tar"));
  assert.equal(archive.sha256, manifest.archive.sha256);
  assert.equal(archive.bytes, manifest.archive.bytes);
  const images = String((await docker(["image", "ls", "--quiet", "--no-trunc"])).stdout)
    .trim()
    .split("\n");
  if (!images.includes(manifest.image.id))
    await docker(["load", "--input", join(root, "recovery-image.tar")]);
  const worker = await inspect("image", manifest.image.id);
  assert.equal(worker.Id, manifest.image.id);
  assert.equal(worker.Os, "linux");
  assert.equal(worker.Architecture, "amd64");
  assert.equal(worker.Config.User, "postgres");
  assert.ok(worker.Config.Entrypoint === null || worker.Config.Entrypoint.length === 0);
  assert.deepEqual(Object.keys(worker.Config.Volumes), ["/var/lib/postgresql/data"]);
  await docker(["pull", ICU_POSTGRES_BASE]);
  const pgImage = await inspect("image", ICU_POSTGRES_BASE);
  phase = "prepare private production composition";
  await mkdir(join(root, "postgres"), { mode: 0o700 });
  await mkdir(join(root, "pg"), { mode: 0o700 });
  for (const name of ["compose.yml", "compose.compact.yml", "postgres/pg_hba.conf"]) {
    await cp(join(repositoryRoot, "deploy/platform", name), join(root, name));
    await chmod(join(root, name), name.endsWith("pg_hba.conf") ? 0o644 : 0o600);
  }
  const hbaPath = join(root, "postgres/pg_hba.conf"),
    hbaSha256 = digest(await readFile(hbaPath));
  const password = randomBytes(32).toString("hex"),
    appPassword = randomBytes(32).toString("hex"),
    migratorPassword = randomBytes(32).toString("hex");
  await save("pg/password", password);
  const openssl = (args) => command("/usr/bin/openssl", args);
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "ca.key"),
    "-out",
    join(root, "pg/ca.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=Recovery CI synthetic CA",
  ]);
  await openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "pg/server.key"),
    "-out",
    join(root, "server.csr"),
    "-subj",
    "/CN=db.private",
  ]);
  await save("tls.ext", "subjectAltName=DNS:db.private\n");
  await openssl([
    "x509",
    "-req",
    "-in",
    join(root, "server.csr"),
    "-CA",
    join(root, "pg/ca.crt"),
    "-CAkey",
    join(root, "ca.key"),
    "-CAcreateserial",
    "-out",
    join(root, "pg/server.crt"),
    "-days",
    "1",
    "-extfile",
    join(root, "tls.ext"),
  ]);
  for (const name of ["server.crt", "server.key", "password"]) {
    await chmod(join(root, "pg", name), 0o600);
    await chown(join(root, "pg", name), 70, 70);
  }
  await chmod(join(root, "pg/ca.crt"), 0o600);
  const identity = hostIdentity(); // Deliberately synthetic product images; never started.
  const env = hostEnv(identity.admission.manifest, root);
  env.MARKIRO_POSTGRES_IMAGE_DIGEST = ICU_POSTGRES_BASE.split("@")[1];
  env.DATABASE_URL = `postgresql://markiro_app:${appPassword}@db.private/markiro?sslmode=verify-full`;
  await save("source.env", envBytes(env));
  await save(
    "migration-source.env",
    `DATABASE_URL=postgresql://markiro_migrator:${migratorPassword}@db.private/markiro?sslmode=verify-full\n`,
  );
  const candidateId = randomUUID();
  const runtimeSnapshot = await snapshotHostConfig({
    root,
    candidateId,
    envFile: join(root, "source.env"),
    manifest: identity.admission.manifest,
  });
  const migrationSnapshot = await snapshotMigrationConfig({
    root,
    candidateId,
    envFile: join(root, "migration-source.env"),
    runtimeSnapshot,
  });
  const configuration = {
    candidateId,
    runtimeSnapshot: { path: runtimeSnapshot.path, sha256: runtimeSnapshot.sha256 },
    migrationSnapshot,
  };
  identity.configurationSha256 = (
    await fingerprintHostConfiguration({ root, ...configuration })
  ).configurationSha256;
  identity.executorSha = sourceSha;
  const interpolation = {
    ...runtimeSnapshot.interpolation,
    MARKIRO_PLATFORM_MIGRATION_ENV_FILE: migrationSnapshot.path,
  };
  const childEnv = hostChildEnvironment({
    interpolation,
    dockerConfig: join(root, "docker"),
    ambient: {},
  });
  const compose = (args) =>
    command(
      "/usr/bin/docker",
      [
        "--host",
        "unix:///var/run/docker.sock",
        "compose",
        "--project-name",
        "markiro-platform",
        "-f",
        join(root, "compose.yml"),
        "-f",
        join(root, "compose.compact.yml"),
        ...args,
      ],
      childEnv,
      180000,
    );
  phase = "initialize UID70 PostgreSQL volume";
  await docker([
    "volume",
    "create",
    "--label",
    "com.docker.compose.project=markiro-platform",
    "--label",
    "com.docker.compose.volume=postgres-data",
    "markiro-platform_postgres-data",
  ]);
  // Root bootstrap is confined to the fresh named volume, before the real service starts.
  await docker([
    "run",
    "--rm",
    "--name",
    "markiro-platform-ci-bootstrap",
    "--user",
    "0:0",
    "--label",
    "com.docker.compose.project=markiro-platform",
    "--network",
    "none",
    "--mount",
    "type=volume,source=markiro-platform_postgres-data,target=/var/lib/postgresql/data",
    ICU_POSTGRES_BASE,
    "chown",
    "70:70",
    "/var/lib/postgresql/data",
  ]);
  await compose(["up", "--detach", "--no-deps", "--wait", "postgres"]);
  // Compose only creates service-used networks. The host observer also requires default.
  const networkNames = String((await docker(["network", "ls", "--format", "{{.Name}}"])).stdout)
    .trim()
    .split("\n");
  if (!networkNames.includes("markiro-platform_default"))
    await docker([
      "network",
      "create",
      "--label",
      "com.docker.compose.project=markiro-platform",
      "--label",
      "com.docker.compose.network=default",
      "markiro-platform_default",
    ]);
  const psql = (sql) =>
    command(
      "/usr/bin/docker",
      [
        "--host",
        "unix:///var/run/docker.sock",
        "exec",
        "--interactive",
        "--user",
        "70:70",
        "markiro-platform-postgres-1",
        "psql",
        "-X",
        "--no-password",
        "--username",
        "postgres",
        "--dbname",
        "markiro",
        "--tuples-only",
        "--no-align",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { DOCKER_CONFIG: join(root, "docker") },
      60000,
      Buffer.from(sql),
    );
  phase = "synthetic role and row provisioning";
  await psql(roleProvisioningSql({ appPassword, migratorPassword }));
  await psql(
    "SET ROLE markiro_migrator; CREATE TABLE public.recovery_fixture(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL); INSERT INTO public.recovery_fixture(value) VALUES ('synthetic-one'),('synthetic-two'); CREATE SEQUENCE public.recovery_unused START 37; RESET ROLE;",
  );
  const systemId = String(
    (await psql("SELECT system_identifier::text FROM pg_control_system();")).stdout,
  ).trim();
  const machineId = String(await readFile("/etc/machine-id", "utf8")).trim();
  identity.target = {
    hostId: machineId,
    databaseId: systemId,
    volumeId: "markiro-platform_postgres-data",
  };
  const volume = await inspect("volume", identity.target.volumeId);
  const networks = {};
  for (const name of ["default", "database"]) {
    const n = await inspect("network", `markiro-platform_${name}`);
    networks[name] = { name: n.Name, id: n.Id };
  }
  const observationPolicy = {
    machineId,
    dockerId,
    postgresImageId: pgImage.Id,
    volume: { name: volume.Name, createdAt: volume.CreatedAt, mountpoint: volume.Mountpoint },
    networks,
  };
  const roles = JSON.parse(
    String(
      (
        await psql(
          "SELECT json_agg(row_to_json(r)) FROM (SELECT rolname AS name,rolsuper AS superuser,rolcreatedb AS createdb,rolcreaterole AS createrole,rolreplication AS replication,rolbypassrls AS bypassrls FROM pg_roles WHERE rolname !~ '^pg_') r;",
        )
      ).stdout,
    ),
  );
  const roleMapping = recoveryRoleMapping({ roles, objects: [] });
  await save("backup-runtime.json", {
    version: 1,
    executorSha: sourceSha,
    dockerExecutable: "/usr/bin/docker",
    endpoint: "unix:///var/run/docker.sock",
    image: manifest.image.id,
    provenance: "live-source",
  });
  await save(
    "service.conf",
    "[backup]\nhost=db.private\nport=5432\ndbname=markiro\nuser=postgres\nsslmode=verify-full\nsslrootcert=/input/ca.crt\n",
  );
  await save("backup-password", `db.private:5432:markiro:postgres:${password}\n`);
  await save("connection.json", {
    version: 1,
    kind: "platform-backup-connection",
    operationId: identity.operationId,
    target: identity.target,
    service: "backup",
    serviceFile: join(root, "service.conf"),
    passFile: join(root, "backup-password"),
    caFile: join(root, "pg/ca.crt"),
    network: networks.database.name,
  });
  const prior = { ...identity, operationId: randomUUID() };
  const stateBytes = Buffer.from(
    canonical({
      version: 1,
      sequence: 14,
      previousHealthy: null,
      current: {
        identity: prior,
        phase: "api-started",
        status: "recovery-required",
        backup: backupProof(prior),
      },
    }) + "\n",
  );
  await save("state.json", stateBytes);
  const admission = {
    version: 1,
    kind: "platform-failed-activation-recovery",
    identity,
    predecessor: { identity: prior, sequence: 14, stateSha256: digest(stateBytes) },
    executorCi: { runId: "123", runAttempt: "1" },
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  };
  phase = "wrong admission makes no producer mutation";
  const invalid = structuredClone(admission);
  invalid.predecessor.stateSha256 = "0".repeat(64);
  const producerInventory = async () => {
    const result = {};
    for (const kind of ["container", "volume"])
      result[kind] = String(
        (await docker([kind, "ls", ...(kind === "container" ? ["--all"] : []), "--quiet"])).stdout,
      );
    return result;
  };
  const beforeInvalid = await producerInventory();
  let producerCalled = false;
  await assert.rejects(
    withRecoveryState(root, invalid, async (store) => {
      producerCalled = true;
      await store.produceBackup(() => {});
    }),
  );
  assert.equal(producerCalled, false);
  assert.deepEqual(await producerInventory(), beforeInvalid);
  assert.equal(await exists(join(root, ".deploy.lock")), false);
  assert.equal(await exists(join(root, "recovery-state.json")), false);
  assert.deepEqual(await readFile(join(root, "state.json")), stateBytes);
  phase = "held host admission, real archive and isolated restore";
  const operation = { root, identity, configuration, dockerConfig: join(root, "docker") };
  let result;
  await withRecoveryState(root, admission, async (store) => {
    await assert.rejects(withHostState(root, () => {}));
    await store.complete("admitted");
    await store.enter("target-stopped");
    await store.complete("target-stopped");
    await store.enter("backup-verified");
    result = await store.produceBackup((capability) =>
      createHeldTargetRecoveryBackup(
        {
          operation,
          observationPolicy,
          hbaPath,
          hbaSha256,
          connectionFile: join(root, "connection.json"),
          roleMapping,
          verifySources: async () => {
            assert.equal(digest(await readFile(hbaPath)), hbaSha256);
            for (const file of manifest.sources.files)
              assert.equal(digest(await readFile(join(repositoryRoot, file.path))), file.sha256);
          },
        },
        capability,
        admission,
      ),
    );
    await store.complete("backup-verified", {
      archiveSha256: result.backup.archiveSha256,
      restoreEvidenceSha256: result.restoreEvidence.evidenceSha256,
      target: identity.target,
      operationId: identity.operationId,
    });
  });
  assert.deepEqual(await readFile(join(root, "state.json")), stateBytes);
  assert.equal(await exists(join(root, ".deploy.lock")), false);
  await withHostState(root, () => {});
  const inventory = JSON.parse(await readFile(result.backup.inventoryPath));
  assert.equal(
    inventory.inventory.tables.find((v) => v.schema === "public" && v.name === "recovery_fixture")
      ?.count,
    "2",
  );
  const expectedRows = [
    { id: 1, value: "synthetic-one" },
    { id: 2, value: "synthetic-two" },
  ]
    .map((value) => digest(JSON.stringify(value)))
    .sort();
  assert.equal(
    inventory.inventory.tables.find((v) => v.name === "recovery_fixture" && v.schema === "public")
      .sha256,
    digest(expectedRows.map((v) => v + "\n").join("")),
  );
  assert.ok(
    inventory.inventory.sequences.some((v) => v.lastValue === "37" && v.isCalled === false),
  );
  const proof = JSON.parse(await readFile(result.restoreEvidence.evidencePath));
  assert.equal(proof.status, "completed");
  assert.equal(
    digest(await readFile(result.restoreEvidence.evidencePath)),
    result.restoreEvidence.evidenceSha256,
  );
  for (const kind of ["container", "volume"])
    assert.equal(
      String(
        (
          await docker([
            kind,
            "ls",
            ...(kind === "container" ? ["--all"] : []),
            "--filter",
            `label=markiro.backup-operation=${identity.operationId}`,
            "--quiet",
          ])
        ).stdout,
      ).trim(),
      "",
    );
  completed = true;
} catch (error) {
  problem = new Error(
    `Synthetic recovery integration failed at ${phase}; private details withheld.`,
  );
  if (error.terminationConfirmed === false || error.durabilityUncertain === true)
    admittedHost = false; // Keep uncertain resources and private evidence for reconciliation.
}
if (admittedHost) {
  try {
    const resources = [];
    for (const kind of ["network", "volume", "container"]) {
      const names = String(
        (
          await docker([
            kind,
            "ls",
            ...(kind === "container" ? ["--all"] : []),
            "--filter",
            "label=com.docker.compose.project=markiro-platform",
            "--format",
            kind === "container" ? "{{.Names}}" : "{{.Name}}",
          ])
        ).stdout,
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const name of names) resources.push([kind, name]);
    }
    await cleanupRecoveryResources(resources, docker);
    if (completed) await rm(root, { recursive: true });
  } catch {
    problem = new Error(
      "Synthetic recovery integration cleanup failed; private evidence retained.",
    );
  }
} else if (!problem) await rm(root, { recursive: true });
if (problem) throw problem;
process.stdout.write(
  JSON.stringify({
    kind: "synthetic-only-held-recovery-integration",
    status: "completed",
    migrationProof: false,
    checks: [
      "wrong admission rejected before producer",
      "original journal unchanged",
      "shared lock released",
      "real archive and matching isolated restore",
      "owned resources removed",
    ],
  }) + "\n",
);
