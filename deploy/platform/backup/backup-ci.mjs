/** Synthetic local PG17 round trip. No ambient credentials, URLs, or ports. */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  cp,
  rm,
  chmod,
  appendFile,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runHostProcess } from "../host/process.mjs";
import { createDatabaseBackup } from "./archive.mjs";
import { hashArchive, publishArchive } from "./files.mjs";
import { verifyDatabaseRestore } from "./restore.mjs";
import { canonical, digest, completedEvidence } from "./schemas.mjs";
import { roleProvisioningSql } from "../postgres/roles.mjs";
if (process.argv.slice(2).join() !== "--local-ci") throw new Error("Explicit --local-ci required");
const root = await mkdtemp(join(await realpath(tmpdir()), "markiro-backup-ci-"));
await chmod(root, 0o700);
const operationId = randomUUID(),
  project = `markiro-backup-ci-${operationId}`,
  network = `${project}-net`,
  source = `${project}-source`,
  volume = `${project}-source-data`,
  label = `markiro.backup-fixture=${operationId}`;
const dockerExecutable = "/opt/homebrew/bin/docker";
const executable = process.platform === "darwin" ? dockerExecutable : "/usr/bin/docker";
let endpoint,
  phase = "local runtime",
  imageId,
  owned = [];
const logs = [];
async function cmd(args) {
  return runHostProcess({
    executable,
    args: endpoint ? ["--host", endpoint, ...args] : args,
    cwd: root,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", DOCKER_CONFIG: join(root, "docker") },
    timeoutMs: 900000,
    outputLimitBytes: 1048576,
  });
}
async function privateWrite(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
}
async function dependencies(context) {
  const dbRequire = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
  const seen = new Map();
  async function copyPackage(
    name,
    resolver,
    parentDirectory = join(context, "runtime", "node_modules"),
  ) {
    let path, manifest;
    for (const directory of resolver.resolve.paths(name) ?? []) {
      try {
        const candidate = await realpath(join(directory, name));
        const found = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
        if (found.name === name) {
          path = candidate;
          manifest = found;
          break;
        }
      } catch {
        /* Keep searching installed package directories, including type-only packages. */
      }
    }
    assert.ok(path && manifest, "Installed dependency required");
    const destination = join(parentDirectory, name);
    if (seen.has(destination)) {
      assert.equal(seen.get(destination), path);
      return;
    }
    seen.set(destination, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(path, destination, {
      recursive: true,
      filter: (p) => !p.slice(path.length).includes("/node_modules"),
    });
    const next = createRequire(join(path, "package.json"));
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copyPackage(dependency, next, join(destination, "node_modules"));
  }
  await copyPackage("pg", dbRequire);
  await copyPackage("drizzle-orm", dbRequire);
  await copyPackage(
    "pg-boss",
    createRequire(new URL("../../../apps/api/package.json", import.meta.url)),
  );
}
async function cleanup() {
  let ok = true;
  for (const [kind, name] of [...owned].reverse())
    try {
      const list = String(
        (
          await cmd([
            kind,
            "ls",
            ...(kind === "container" ? ["--all"] : []),
            "--filter",
            `label=${label}`,
            "--format",
            kind === "container" ? "{{.Names}}" : "{{.Name}}",
          ])
        ).stdout,
      )
        .trim()
        .split("\n");
      if (!list.includes(name)) continue;
      const value = JSON.parse((await cmd([kind, "inspect", name])).stdout)[0];
      assert.equal((value.Config?.Labels ?? value.Labels)["markiro.backup-fixture"], operationId);
      await cmd([kind, "rm", ...(kind === "container" ? ["--force"] : []), name]);
      const after = String(
        (
          await cmd([
            kind,
            "ls",
            ...(kind === "container" ? ["--all"] : []),
            "--format",
            kind === "container" ? "{{.Names}}" : "{{.Name}}",
          ])
        ).stdout,
      )
        .trim()
        .split("\n");
      assert.ok(!after.includes(name));
    } catch {
      ok = false;
    }
  // Producer resources are owned by the operation and must already be gone.
  for (const kind of ["container", "volume"]) {
    const list = String(
      (
        await cmd([
          kind,
          "ls",
          ...(kind === "container" ? ["--all"] : []),
          "--filter",
          `label=markiro.backup-operation=${operationId}`,
          "--format",
          kind === "container" ? "{{.Names}}" : "{{.Name}}",
        ])
      ).stdout,
    ).trim();
    if (list) ok = false;
  }
  if (ok) await rm(root, { recursive: true, force: true });
  else throw new Error(`Backup harness cleanup requires recovery: ${project}`);
}
let problem;
try {
  await mkdir(join(root, "docker"), { mode: 0o700 });
  const selected = await promisify(execFile)(executable, ["context", "inspect"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout: 10000,
    maxBuffer: 65536,
  });
  endpoint = JSON.parse(selected.stdout)[0]?.Endpoints?.docker?.Host;
  assert.match(endpoint, /^unix:\/\/\//);
  const context = join(root, "image");
  await mkdir(context, { mode: 0o700 });
  await mkdir(join(context, "runtime"), { mode: 0o700 });
  for (const area of ["backup", "host", "postgres"])
    await cp(resolve("deploy/platform", area), join(context, "runtime", area), {
      recursive: true,
      filter: (p) => !p.endsWith("backup-ci.mjs"),
    });
  phase = "copy exact existing dependency graph";
  await dependencies(context);
  await mkdir(join(context, "runtime", "fixture"), { mode: 0o700 });
  await cp(
    resolve("packages/db/dist/runtime-migrate.js"),
    join(context, "runtime", "fixture", "runtime-migrate.mjs"),
  );
  await cp(resolve("packages/db/migrations"), join(context, "runtime", "fixture", "migrations"), {
    recursive: true,
  });
  await cp(
    resolve("deploy/platform/backup/fixture-probe.mjs"),
    join(context, "runtime", "fixture", "probe.mjs"),
  );
  await privateWrite(
    join(context, "Dockerfile"),
    "FROM node:24.18.0-bookworm-slim AS node\nFROM postgres:17-bookworm\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\nCOPY --chown=999:999 runtime /opt/backup\nENTRYPOINT []\nUSER postgres\n",
  );
  phase = "build immutable local worker";
  const built = await promisify(execFile)(
    executable,
    ["--host", endpoint, "build", "--quiet", "--label", label, context],
    {
      env: { PATH: process.env.PATH, DOCKER_CONFIG: join(root, "docker") },
      timeout: 900000,
      maxBuffer: 1048576,
    },
  );

  const ids = String(built.stdout)
    .trim()
    .split("\n")
    .filter((line) => /^(?:sha256:)?[a-f0-9]{64}$/u.test(line));
  assert.equal(ids.length, 1);
  imageId = ids[0].startsWith("sha256:") ? ids[0] : `sha256:${ids[0]}`;
  const image = JSON.parse((await cmd(["image", "inspect", imageId])).stdout)[0];
  assert.equal(image.Config.Labels["markiro.backup-fixture"], operationId);
  await appendFile(
    join(await realpath(tmpdir()), "markiro-backup-task3-images.jsonl"),
    canonical({ operationId, imageId }) + "\n",
    { mode: 0o600 },
  );
  phase = "worker image package smoke";
  await cmd([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--label",
    label,
    imageId,
    "node",
    "-e",
    "const f=require('node:fs');f.accessSync('/opt/backup/fixture/probe.mjs');f.accessSync('/opt/backup/backup/postgres-worker.mjs');require('/opt/backup/node_modules/pg');require('/opt/backup/node_modules/pg-boss');import('/opt/backup/fixture/runtime-migrate.mjs').catch(()=>process.exit(1));",
  ]);

  const executorSha = String(
    (await promisify(execFile)("git", ["rev-parse", "HEAD"], { timeout: 10000 })).stdout,
  ).trim();
  await privateWrite(
    join(root, "backup-runtime.json"),
    canonical({
      version: 1,
      executorSha,
      dockerExecutable: executable,
      endpoint,
      image: imageId,
      provenance: "local-synthetic",
    }),
  );
  const fixture = join(root, "fixture");
  await mkdir(fixture, { mode: 0o700 });
  const appPassword = randomBytes(32).toString("hex"),
    migratorPassword = randomBytes(32).toString("hex"),
    password = randomBytes(32).toString("hex");
  await privateWrite(join(fixture, "password"), password);
  phase = "generate local TLS";
  const openssl = async (args) =>
    runHostProcess({
      executable: process.platform === "darwin" ? "/usr/bin/openssl" : "/usr/bin/openssl",
      args,
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 30000,
      outputLimitBytes: 65536,
    });
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "ca.key"),
    "-out",
    join(fixture, "ca.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=Markiro backup synthetic CA",
  ]);
  await openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(fixture, "server.key"),
    "-out",
    join(root, "server.csr"),
    "-subj",
    "/CN=db.private",
  ]);
  await privateWrite(join(root, "tls.ext"), "subjectAltName=DNS:db.private\n");
  await openssl([
    "x509",
    "-req",
    "-in",
    join(root, "server.csr"),
    "-CA",
    join(fixture, "ca.crt"),
    "-CAkey",
    join(root, "ca.key"),
    "-CAcreateserial",
    "-out",
    join(fixture, "server.crt"),
    "-days",
    "1",
    "-extfile",
    join(root, "tls.ext"),
  ]);
  await chmod(join(fixture, "server.key"), 0o600);
  await privateWrite(
    join(fixture, "roles.sql"),
    roleProvisioningSql({ appPassword, migratorPassword }),
  );
  await privateWrite(
    join(fixture, "credentials.json"),
    canonical({ appPassword, migratorPassword }),
  );
  const sql = `
 CREATE ROLE provider_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 CREATE ROLE provider_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 CREATE SCHEMA fixture AUTHORIZATION provider_owner;
 SET ROLE provider_owner;
 CREATE TYPE fixture.state AS ENUM ('queued','done');
 CREATE TABLE fixture.encrypted(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, encrypted bytea NOT NULL, status fixture.state NOT NULL DEFAULT 'queued');
 INSERT INTO fixture.encrypted(encrypted) VALUES (decode('deadbeef00112233445566778899aabbcc','hex')),(decode('00010203040506070809','hex'));
 CREATE SEQUENCE fixture.not_called START 37;
 GRANT USAGE ON SCHEMA fixture TO provider_reader;
 GRANT SELECT ON fixture.encrypted TO provider_reader WITH GRANT OPTION;
 ALTER DEFAULT PRIVILEGES IN SCHEMA fixture GRANT SELECT ON TABLES TO provider_reader;
 CREATE FUNCTION fixture.answer() RETURNS integer LANGUAGE SQL AS 'SELECT 42';
 CREATE VIEW fixture.visible AS SELECT id FROM fixture.encrypted;
 CREATE MATERIALIZED VIEW fixture.materialized AS SELECT id FROM fixture.encrypted;
 RESET ROLE;
 ALTER TABLE fixture.encrypted ADD CONSTRAINT retained_not_valid CHECK (id>0) NOT VALID;
 `;
  await privateWrite(join(fixture, "fixture.sql"), sql);
  phase = "start source PG17";
  owned.push(["network", network]);
  await cmd(["network", "create", "--internal", "--label", label, network]);
  owned.push(["volume", volume]);
  await cmd(["volume", "create", "--label", label, volume]);
  const init = `${project}-init`;
  owned.push(["container", init]);
  await cmd([
    "create",
    "--name",
    init,
    "--label",
    label,
    "--network",
    "none",
    "--user",
    "0:0",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/postgresql/data`,
    "--mount",
    `type=volume,source=${volume},target=/fixture`,
    imageId,
    "sleep",
    "infinity",
  ]);
  await cmd(["start", init]);
  await cmd(["cp", `${fixture}/.`, `${init}:/fixture/`]);
  await cmd(["exec", init, "chown", "-R", "999:999", "/fixture"]);
  await cmd(["exec", init, "chmod", "700", "/fixture"]);
  await cmd(["container", "rm", "--force", init]);
  owned.push(["container", source]);
  await cmd([
    "create",
    "--name",
    source,
    "--label",
    label,
    "--network",
    network,
    "--network-alias",
    "db.private",
    "--user",
    "999:999",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--read-only",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/postgresql/data`,
    "--mount",
    `type=volume,source=${volume},target=/fixture`,
    "--mount",
    `type=volume,source=${volume},target=/var/run/postgresql`,
    "--env",
    "PGHOST=/var/run/postgresql",
    "--env",
    "PGDATA=/fixture/data",
    "--env",
    "POSTGRES_DB=markiro",
    "--env",
    "POSTGRES_PASSWORD_FILE=/fixture/password",
    imageId,
    "/usr/local/bin/docker-entrypoint.sh",
    "postgres",
    "-c",
    "unix_socket_directories=/var/run/postgresql",
    "-c",
    "ssl=on",
    "-c",
    "ssl_cert_file=/fixture/server.crt",
    "-c",
    "ssl_key_file=/fixture/server.key",
  ]);
  await cmd(["start", source]);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await cmd([
        "exec",
        source,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "markiro",
      ]);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(ready);
  phase = "fresh role provisioning";
  await cmd([
    "exec",
    source,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "/var/run/postgresql",
    "-U",
    "postgres",
    "-d",
    "markiro",
    "-f",
    "/fixture/roles.sql",
  ]);
  phase = "current migrations and pg-boss";
  try {
    await promisify(execFile)(
      executable,
      ["--host", endpoint, "exec", source, "node", "/opt/backup/fixture/probe.mjs"],
      {
        env: { PATH: process.env.PATH, DOCKER_CONFIG: join(root, "docker") },
        timeout: 900000,
        maxBuffer: 65536,
      },
    );
  } catch (error) {
    const text = String(error.stderr ?? "");

    const code = text.match(/ERR_[A-Z_]+/u)?.[0];
    const library = text.match(/error while loading shared libraries: ([A-Za-z0-9_.-]+)/u)?.[1];
    if (code || library) phase += ` loader-${code ?? library}`;
    throw error;
  }
  phase = "synthetic encrypted data";
  await cmd([
    "exec",
    source,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "/var/run/postgresql",
    "-U",
    "postgres",
    "-d",
    "markiro",
    "-f",
    "/fixture/fixture.sql",
  ]);
  const target = { hostId: "local-synthetic", databaseId: "markiro", volumeId: volume };
  await privateWrite(
    join(root, "service.conf"),
    "[backup]\nhost=db.private\nport=5432\ndbname=markiro\nuser=postgres\nsslmode=verify-full\nsslrootcert=/input/ca.crt\n",
  );
  await privateWrite(join(root, "password"), `db.private:5432:markiro:postgres:${password}\n`);
  await privateWrite(join(root, "ca.crt"), await readFile(join(fixture, "ca.crt")));
  const connectionFile = join(root, "connection.json");
  await privateWrite(
    connectionFile,
    canonical({
      version: 1,
      kind: "platform-backup-connection",
      operationId,
      target,
      service: "backup",
      serviceFile: join(root, "service.conf"),
      passFile: join(root, "password"),
      caFile: join(root, "ca.crt"),
      network,
    }),
  );
  const fenceId = randomUUID(),
    beganAt = new Date().toISOString();
  const writerFence = {
    async observe({ boundary }) {
      const net = JSON.parse((await cmd(["network", "inspect", network])).stdout)[0];
      assert.equal(net.Internal, true);
      for (const c of Object.values(net.Containers ?? {})) {
        const value = JSON.parse((await cmd(["inspect", c.Name])).stdout)[0];
        assert.ok(
          value.Name.replace(/^\//, "") === source ||
            value.Config.Labels["markiro.backup-operation"] === operationId,
        );
        assert.deepEqual(value.HostConfig.PortBindings ?? {}, {});
      }
      return {
        version: 1,
        kind: "platform-writer-fence",
        operationId,
        target,
        fenceId,
        enforcementSha256: digest({ network, source, operationId }),
        boundary,
        beganAt,
        observedAt: new Date().toISOString(),
        held: true,
      };
    },
  };
  phase = "real snapshot and custom dump";
  const backup = await createDatabaseBackup({
    root,
    operationId,
    target,
    connectionFile,
    writerFence,
    run: runHostProcess,
  });
  const document = JSON.parse(await readFile(backup.inventoryPath, "utf8"));
  const references = new Set(document.inventory.roles.map((r) => r.name));
  for (const o of document.inventory.objects) {
    references.add(o.owner);
    for (const a of o.acl) {
      if (a.grantee !== "PUBLIC") references.add(a.grantee);
      references.add(a.grantor);
    }
  }
  const roles = [...references].sort().map((source) => ({
    source,
    target:
      source === "provider_owner"
        ? "restored_owner"
        : source === "provider_reader"
          ? "restored_reader"
          : source === "postgres"
            ? "restored_bootstrap"
            : source,
  }));
  const allowedDeltas = [];
  for (const role of document.inventory.roles)
    for (const attribute of ["superuser", "createdb", "createrole", "replication", "bypassrls"])
      if (role[attribute])
        allowedDeltas.push({
          kind: "role-attribute",
          source: role.name,
          attribute,
          from: true,
          to: false,
        });
  const roleMapping = { version: 1, roles, allowedDeltas };
  process.stdout.write(
    JSON.stringify({
      stage: "backup",
      archiveBytes: document.archiveBytes,
      inventoryBytes: Buffer.byteLength(canonical(document)),
    }) + "\n",
  );
  phase = "real independently restored inventory";
  const proof = await verifyDatabaseRestore({
    root,
    operationId,
    target,
    backup,
    roleMapping,
    run: runHostProcess,
  });
  const evidence = JSON.parse(await readFile(proof.evidencePath, "utf8"));
  completedEvidence(evidence, { operationId, target, ...backup });
  assert.equal(digest(await readFile(proof.evidencePath)), proof.evidenceSha256);
  assert.ok(document.inventory.sequences.some((s) => s.isCalled === false && s.lastValue === "37"));
  phase = "corrupt byte rejection";
  const corrupt = join(root, "corrupt.dump");
  await publishArchive(root, backup.archivePath, "corrupt.dump");
  const corruptFile = await open(corrupt, "r+");
  try {
    const byte = Buffer.alloc(1),
      position = Math.floor(document.archiveBytes / 2);
    await corruptFile.read(byte, 0, 1, position);
    byte[0] ^= 1;
    await corruptFile.write(byte, 0, 1, position);
    await corruptFile.sync();
  } finally {
    await corruptFile.close();
  }
  await assert.rejects(
    verifyDatabaseRestore({
      root,
      operationId,
      target,
      backup: { ...backup, archivePath: corrupt },
      roleMapping,
      run: runHostProcess,
    }),
  );
  phase = "actual partial restore failure and cleanup";
  const negativeRoot = join(root, "negative-restore");
  await mkdir(negativeRoot, { mode: 0o700 });
  await privateWrite(
    join(negativeRoot, "backup-runtime.json"),
    await readFile(join(root, "backup-runtime.json")),
  );
  const truncated = await publishArchive(negativeRoot, backup.archivePath, "partial.dump", {
    sourceRoot: root,
  });
  const partialFile = await open(truncated.path, "r+");
  try {
    await partialFile.truncate(Math.floor(document.archiveBytes / 2));
    await partialFile.sync();
  } finally {
    await partialFile.close();
  }
  const partial = await hashArchive(negativeRoot, truncated.path);
  const partialDocument = {
    ...document,
    archiveBytes: partial.bytes,
    archiveSha256: partial.sha256,
  };
  const partialInventory = Buffer.from(canonical(partialDocument) + "\n"),
    partialInventoryPath = join(negativeRoot, "partial.json");
  await privateWrite(partialInventoryPath, partialInventory);
  await assert.rejects(
    verifyDatabaseRestore({
      root: negativeRoot,
      operationId,
      target,
      backup: {
        archivePath: truncated.path,
        archiveSha256: partial.sha256,
        inventoryPath: partialInventoryPath,
        inventorySha256: digest(partialInventory),
      },
      roleMapping,
      run: runHostProcess,
    }),
  );
  const partialFailure = JSON.parse(
    await readFile(join(negativeRoot, `restore-${operationId}`, "failure.json"), "utf8"),
  );
  assert.equal(partialFailure.status, "recovery-required");
  assert.match(partialFailure.stage, /^restore-/);
  assert.equal(partialFailure.cleanup.verified, true);
  assert.ok(partialFailure.cleanup.resources.length >= 3);
  await assert.rejects(readFile(join(negativeRoot, `restore-${operationId}`, "evidence.json")));
  logs.push({
    kind: "local-synthetic-backup-proof",
    architecture: image.Architecture,
    image: imageId,
    postgresVersion: evidence.runtime.postgresVersion,
    checks: [
      "PG17 consistent custom dump",
      "mapped owner and grantee",
      "ACL/default privilege equality",
      "encrypted row byte hashes",
      "sequence is_called false",
      "corrupt archive rejected",
      "actual partial restore failed and resources removed",
      "label-bound cleanup verified",
    ],
    archiveBytes: document.archiveBytes,
    inventoryBytes: Buffer.byteLength(canonical(document)),
    executorSha: evidence.executorSha,
    unvalidatedSourceConstraints: evidence.unvalidatedSourceConstraints,
  });
} catch (error) {
  if (phase === "current migrations and pg-boss") {
    try {
      await cmd(["cp", `${source}:/fixture/probe-failure.json`, join(root, "probe-failure.json")]);
      const failure = JSON.parse(await readFile(join(root, "probe-failure.json"), "utf8"));
      if (/^[a-z-]+$/u.test(failure.phase) && /^[A-Z0-9_]+$/u.test(failure.code))
        phase += ` (${failure.phase}-${failure.code})`;
    } catch {
      /* A loader/startup failure may precede the probe's safe report. */
    }
  }
  if (phase === "real independently restored inventory") {
    try {
      const diagnostic = await mkdtemp(
        join(await realpath(tmpdir()), "markiro-backup-comparison-"),
      );
      await chmod(diagnostic, 0o700);
      await cp(
        join(root, `backup-${operationId}`, "inventory.json"),
        join(diagnostic, "source.json"),
      );
      await cp(
        join(root, `markiro-backup-${operationId}-restore-restored.json`),
        join(diagnostic, "restored.json"),
      );
      process.stdout.write(JSON.stringify({ privateComparison: diagnostic }) + "\n");
    } catch {
      /* A capture may fail before producing complete diagnostics. */
    }
  }
  problem = new Error(`Backup harness failed at ${phase}; details withheld.`);
  if (error.stage) problem.message += ` Stage=${error.stage}.`;
}
try {
  await cleanup();
} catch (error) {
  problem = error;
}
if (problem) {
  if (imageId) {
    try {
      const image = JSON.parse((await cmd(["image", "inspect", imageId])).stdout)[0];
      if (image.Config.Labels?.["markiro.backup-fixture"] === operationId)
        await cmd(["image", "rm", imageId]);
    } catch {
      /* Never prune or remove another operation's image. */
    }
  }
  throw problem;
}
for (const row of logs) process.stdout.write(JSON.stringify(row) + "\n");
