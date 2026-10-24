import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commandIntegrationFixture,
  integrationOptions,
} from "./host-command-integration-fixture.mjs";
import { fakeDocker } from "./backup-runtime-fixture.mjs";
import { canonical } from "../backup/schemas.mjs";

export async function targetBackupFixture(t, mode, fixtureOptions) {
  const f = await commandIntegrationFixture(t, null, fixtureOptions);
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
