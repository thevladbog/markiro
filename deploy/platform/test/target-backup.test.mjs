import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  commandIntegrationFixture,
  integrationOptions,
} from "./host-command-integration-fixture.mjs";
import { fakeDocker } from "./backup-runtime-fixture.mjs";
import { canonical, digest } from "../backup/schemas.mjs";
import { createTargetRecoveryBackup } from "../host/target-backup.mjs";
import { withHostState } from "../host/state.mjs";

async function fixture(t, mode) {
  const f = await commandIntegrationFixture(t);
  const host = await integrationOptions(f.root);
  const operation = Object.fromEntries(
    ["root", "identity", "configuration", "dockerConfig"].map((k) => [k, f.record.deployment[k]]),
  );
  const policy = f.record.observationPolicy;
  const image = `sha256:${"e".repeat(64)}`;
  const runtime = {
    version: 1,
    executorSha: f.identity.executorSha,
    dockerExecutable: "/usr/bin/docker",
    endpoint: "unix:///var/run/docker.sock",
    image,
    provenance: "live-source",
  };
  const save = (name, value) =>
    writeFile(join(f.root, name), typeof value === "string" ? value : canonical(value), {
      mode: 0o600,
    });
  await save("backup-runtime.json", runtime);
  await save(
    "backup-service.conf",
    "[backup]\nhost=db.private\nport=5432\ndbname=markiro\nuser=backup_admin\nsslmode=verify-full\nsslrootcert=/input/ca.crt\n",
  );
  await save("backup-password", `db.private:5432:markiro:backup_admin:${"x".repeat(32)}\n`);
  const connection = {
    version: 1,
    kind: "platform-backup-connection",
    operationId: f.identity.operationId,
    target: f.identity.target,
    service: "backup",
    serviceFile: join(f.root, "backup-service.conf"),
    passFile: join(f.root, "backup-password"),
    caFile: f.env.MARKIRO_POSTGRES_CA_FILE,
    network: policy.networks.database.name,
  };
  await save("connection.json", connection);
  const daemon = JSON.parse(await readFile(join(f.root, "daemon.json")));
  daemon.images.push({
    Id: image,
    Os: "linux",
    Architecture: "amd64",
    Config: { Volumes: { "/var/lib/postgresql/data": {} } },
  });
  const publish = () => save("daemon.json", daemon);
  await publish();
  const captured = {
    snapshotId: "00000001-00000002-1",
    postgresVersion: "17.11",
    inventory: f.document.inventory,
  };
  const docker = fakeDocker({
    root: f.root,
    operationId: f.identity.operationId,
    image,
    restored: { postgresVersion: "17.11", inventory: f.document.inventory },
    failCleanup: mode === "cleanup",
  });
  let boundaries = 0,
    workerCommands = 0;
  const options = {
    readMachineId: host.readMachineId,
    runProcess: async (request) => {
      const args = request.args.slice(2);
      if (request.timeoutMs === 60000) {
        // A host observation must never coexist with archive or restore workers.
        assert.equal(docker.containers.size + docker.volumes.size, 0);
        return host.runProcess(request);
      }
      if (["create", "start"].includes(args[0]) || (args[0] === "volume" && args[1] === "create"))
        workerCommands++;
      if (mode === "unreaped" && args[0] === "start" && args.includes("--attach"))
        throw Object.assign(new Error("secret child output"), { terminationConfirmed: false });
      if (mode === "durability" && args[0] === "start" && args.includes("--attach"))
        throw Object.assign(new Error("secret uncertain process output"), {
          durabilityUncertain: true,
        });
      if (
        mode === "restore-cleanup" &&
        args[0] === "container" &&
        args[1] === "rm" &&
        args.at(-1).endsWith("-restore-worker")
      )
        throw new Error("secret cleanup output");
      const result = await docker.run(request);
      if (args[0] === "image") {
        const values = JSON.parse(result.stdout);
        values[0].Architecture = "amd64";
        result.stdout = Buffer.from(canonical(values));
      }
      if (args[0] === "cp" && args[1].includes("-archive-worker:/work/out/.")) {
        await writeFile(join(args[2], "inventory.json"), canonical(captured), { mode: 0o600 });
        await writeFile(join(args[2], "database.dump"), "PGDMP target fixture", { mode: 0o600 });
      }
      return result;
    },
  };
  const input = {
    operation,
    observationPolicy: policy,
    hbaPath: join(f.installed, "deploy/platform/postgres/pg_hba.conf"),
    hbaSha256: f.receipt.files["deploy/platform/postgres/pg_hba.conf"],
    connectionFile: join(f.root, "connection.json"),
    roleMapping: f.expected.roleMapping,
    verifySources: async () => {
      boundaries++;
      if (mode === "source-failure") throw new Error("secret source output");
      if (mode === "final-observation" && boundaries === 4) {
        daemon.adminResult.prepared = 1;
        await publish();
      }
      if (mode === "altered-private" && boundaries === 2)
        await save("backup-password", `db.private:5432:markiro:backup_admin:${"z".repeat(32)}\n`);
    },
  };
  return {
    f,
    input,
    options,
    daemon,
    publish,
    save,
    runtime,
    connection,
    docker,
    boundaries: () => boundaries,
    workerCommands: () => workerCommands,
  };
}
const invoke = (f) => createTargetRecoveryBackup(f.input, f.options);

test("target backup returns fresh bound recovery descriptors only after concrete observations and isolated cleanup", async (t) => {
  const f = await fixture(t);
  const result = await invoke(f);
  assert.equal(f.boundaries(), 4);
  assert.equal(f.docker.containers.size + f.docker.volumes.size, 0);
  const inventory = JSON.parse(await readFile(result.backup.inventoryPath));
  const evidence = JSON.parse(await readFile(result.restoreEvidence.evidencePath));
  assert.equal(evidence.status, "completed");
  assert.equal(evidence.provenance, "live-source");
  assert.equal(inventory.runtime.architecture, "amd64");
  assert.equal(inventory.executorSha, f.input.operation.identity.executorSha);
  assert.equal(result.fence.fenceId, inventory.fence.before.fenceId);
  assert.equal(result.fence.beganAt, inventory.fence.before.beganAt);
  assert.notEqual(result.fence.fenceId, f.f.record.deployment.preparedTarget.fence.fenceId);
  assert.equal(
    result.fence.enforcementSha256,
    digest({
      version: 1,
      kind: "platform-docker-private-database-fence",
      target: f.input.operation.identity.target,
      dockerId: f.input.observationPolicy.dockerId,
      network: f.input.observationPolicy.networks.database,
      volume: f.input.observationPolicy.volume,
      postgresImageId: f.input.observationPolicy.postgresImageId,
      hbaSha256: f.input.hbaSha256,
    }),
  );
  await assert.rejects(lstat(join(f.f.root, ".deploy.lock")), { code: "ENOENT" });
});

for (const mode of [
  "host",
  "image",
  "network",
  "active",
  "foreign",
  "session",
  "stale-hba",
  "hba-path",
  "service-host",
  "service-port",
  "service-db",
  "connection-network",
  "runtime-endpoint",
  "runtime-executable",
  "runtime-provenance",
  "runtime-executor",
  "runtime-architecture",
  "source-failure",
  "altered-private",
  "final-observation",
  "unreaped",
  "durability",
  "cleanup",
  "restore-cleanup",
  "journal",
]) {
  test(`target backup rejects ${mode} without returning acceptance`, async (t) => {
    const f = await fixture(t, mode);
    if (mode === "host") f.options.readMachineId = async () => "b".repeat(32);
    if (mode === "image") f.daemon.containers[0].Image = `sha256:${"0".repeat(64)}`;
    if (mode === "network") f.daemon.networks[1].Id = "0".repeat(64);
    if (["active", "foreign"].includes(mode)) {
      const c = structuredClone(f.daemon.containers[0]);
      c.Id = "9".repeat(64);
      c.Name = "/foreign-writer";
      c.Config.Labels =
        mode === "foreign"
          ? {}
          : {
              "com.docker.compose.project": "markiro-platform",
              "com.docker.compose.service": "api",
            };
      if (mode === "foreign") c.State = { Running: false, Status: "exited" };
      f.daemon.containers.push(c);
    }
    if (mode === "session")
      f.daemon.adminResult.sessions = [
        { usename: "markiro_app", client_addr: "172.20.0.5", application_name: "foreign" },
      ];
    if (mode === "stale-hba") f.daemon.adminResult.started_at = 1;
    if (mode === "hba-path") f.input.hbaPath = f.f.env.MARKIRO_POSTGRES_CA_FILE;
    if (mode.startsWith("service-")) {
      const text = String(await readFile(f.connection.serviceFile));
      const replacement = {
        "service-host": ["host=db.private", "host=foreign.private"],
        "service-port": ["port=5432", "port=5433"],
        "service-db": ["dbname=markiro", "dbname=other"],
      }[mode];
      await f.save("backup-service.conf", text.replace(...replacement));
    }
    if (mode === "connection-network") {
      f.connection.network = "foreign-network";
      await f.save("connection.json", f.connection);
    }
    const field = {
      "runtime-endpoint": ["endpoint", "unix:///other.sock"],
      "runtime-executable": ["dockerExecutable", "/tmp/docker"],
      "runtime-provenance": ["provenance", "local-synthetic"],
      "runtime-executor": ["executorSha", "0".repeat(40)],
    }[mode];
    if (field) {
      f.runtime[field[0]] = field[1];
      await f.save("backup-runtime.json", f.runtime);
    }
    if (mode === "runtime-architecture") f.daemon.images.at(-1).Architecture = "arm64";
    if (mode === "journal")
      await withHostState(f.f.root, (store) => store.begin(f.input.operation.identity));
    await f.publish();
    await assert.rejects(invoke(f), (error) => {
      assert.equal(error.code, "ERR_TARGET_BACKUP");
      assert.equal(error.message.includes("secret"), false);
      if (mode === "unreaped") assert.equal(error.terminationConfirmed, false);
      if (["unreaped", "durability", "cleanup", "restore-cleanup"].includes(mode)) {
        assert.equal(error.durabilityUncertain, true);
        assert.equal(error.recoveryRequired, true);
      }
      return true;
    });
    if (["unreaped", "durability", "cleanup", "restore-cleanup"].includes(mode))
      assert.ok(await lstat(join(f.f.root, ".deploy.lock")));
    if (
      !["unreaped", "durability", "cleanup", "restore-cleanup", "final-observation"].includes(mode)
    )
      assert.equal(f.workerCommands(), 0);
  });
}

test("target backup rejects an already held deployment lock", async (t) => {
  const f = await fixture(t);
  await withHostState(f.f.root, async () => {
    await assert.rejects(invoke(f));
    assert.equal(f.workerCommands(), 0);
    assert.equal(f.boundaries(), 0);
  });
});

test("target backup excludes concurrent deployment at every boundary", async (t) => {
  const f = await fixture(t);
  const original = f.input.verifySources;
  f.input.verifySources = async () => {
    await assert.rejects(
      withHostState(f.f.root, () => assert.fail("concurrent owner entered")),
      { code: "ERR_HOST_STATE" },
    );
    await original();
  };
  await invoke(f);
  assert.equal(f.boundaries(), 4);
});

for (const purpose of ["archive", "restore"])
  test(`target backup retains lock when ${purpose} cleanup and failure evidence persistence both fail`, async (t) => {
    const f = await fixture(t);
    const original = f.options.runProcess;
    const worker = `markiro-backup-${f.input.operation.identity.operationId}-${purpose}-worker`;
    const directory = join(
      f.f.root,
      `${purpose === "archive" ? "backup" : "restore"}-${f.input.operation.identity.operationId}`,
    );
    f.options.runProcess = async (request) => {
      const args = request.args.slice(2);
      if (args[0] === "container" && args[1] === "rm" && args.at(-1) === worker) {
        // Actual protected writer fails with EEXIST before publication, replacing
        // the producer's cleanup error with durabilityUncertain=false.
        await writeFile(join(directory, "failure.json"), "existing failure evidence", {
          mode: 0o600,
          flag: "wx",
        });
        throw new Error("controlled cleanup failure");
      }
      return original(request);
    };
    let failure;
    try {
      await invoke(f);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "ERR_TARGET_BACKUP");
    assert.equal(f.docker.containers.has(worker), true);
    assert.ok(await lstat(join(f.f.root, ".deploy.lock")));
    assert.equal(failure.durabilityUncertain, true);
    assert.equal(failure.recoveryRequired, true);
    await assert.rejects(
      withHostState(f.f.root, () => assert.fail("uncertain producer released lock")),
      { code: "ERR_HOST_STATE" },
    );
    for (const name of purpose === "archive"
      ? ["database.dump", "inventory.json"]
      : ["evidence.json"])
      await assert.rejects(lstat(join(directory, name)), { code: "ENOENT" });
  });

test("target backup never issues another process command after unconfirmed termination", async (t) => {
  const f = await fixture(t, "unreaped");
  const original = f.options.runProcess;
  let unreaped = false,
    laterCommands = 0;
  f.options.runProcess = async (request) => {
    if (unreaped) laterCommands++;
    try {
      return await original(request);
    } catch (error) {
      if (error.terminationConfirmed === false) unreaped = true;
      throw error;
    }
  };
  await assert.rejects(invoke(f), { terminationConfirmed: false, durabilityUncertain: true });
  assert.equal(unreaped, true);
  assert.equal(laterCommands, 0);
});
