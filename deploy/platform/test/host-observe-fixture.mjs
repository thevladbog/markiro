import assert from "node:assert/strict";
import { preparedFixture } from "./prepared-target-fixture.mjs";
export async function dockerFixture(t, supplied = {}) {
  const { createHostObservers, postgresCommand } = await import("../host/observe.mjs");
  const { writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { runHostProcess } = await import("../host/process.mjs");
  const f = supplied.fixture ?? (await preparedFixture(t));
  const project = "markiro-platform",
    pgid = "3".repeat(64),
    imageId = `sha256:${"f".repeat(64)}`;
  const policy = supplied.policy ?? {
    machineId: "a".repeat(32),
    dockerId: "fixture-docker",
    postgresImageId: imageId,
    volume: {
      name: `${project}_postgres-data`,
      createdAt: "2026-10-18T00:00:00Z",
      mountpoint: `/var/lib/docker/volumes/${project}_postgres-data/_data`,
    },
    networks: {
      default: { name: `${project}_default`, id: "1".repeat(64) },
      database: { name: `${project}_database`, id: "2".repeat(64) },
    },
  };
  f.identity.target = {
    hostId: policy.machineId,
    databaseId: supplied.fixture?.identity.target.databaseId ?? "1234",
    volumeId: policy.volume.name,
  };
  const reference = `postgres:17-alpine@${f.env.MARKIRO_POSTGRES_IMAGE_DIGEST}`;
  const composeFiles = supplied.composeFiles ?? [
    "/installed/deploy/platform/compose.yml",
    "/installed/deploy/platform/compose.compact.yml",
  ];
  const state = {
    info: { OSType: "linux", Architecture: "x86_64", ID: policy.dockerId },
    volume: {
      Name: policy.volume.name,
      CreatedAt: policy.volume.createdAt,
      Mountpoint: policy.volume.mountpoint,
      Driver: "local",
      Options: {},
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.volume": "postgres-data",
      },
    },
    networks: Object.entries(policy.networks).map(([name, n]) => ({
      Id: n.id,
      Name: n.name,
      Driver: "bridge",
      Scope: "local",
      Internal: name === "database",
      Attachable: false,
      Ingress: false,
      Labels: { "com.docker.compose.project": project, "com.docker.compose.network": name },
      Containers: name === "database" ? { [pgid]: {} } : {},
    })),
    images: [
      {
        Id: imageId,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [reference],
        Config: { Entrypoint: ["docker-entrypoint.sh"], Cmd: ["postgres"] },
      },
    ],
    containers: [
      {
        Id: pgid,
        Name: `/${project}-postgres-1`,
        Image: imageId,
        State: { Running: true, Restarting: false, Paused: false, Status: "running" },
        Config: {
          Image: reference,
          User: "70:70",
          Labels: {
            "com.docker.compose.project": project,
            "com.docker.compose.service": "postgres",
            "com.docker.compose.oneoff": "False",
          },
          Entrypoint: ["docker-entrypoint.sh"],
          Cmd: [...postgresCommand],
          Env: [
            "POSTGRES_DB=markiro",
            "POSTGRES_USER=postgres",
            "POSTGRES_PASSWORD_FILE=/run/markiro-postgres/password",
            "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=peer",
          ],
        },
        HostConfig: {
          NetworkMode: policy.networks.database.name,
          ReadonlyRootfs: true,
          Privileged: false,
          CapDrop: ["ALL"],
          CapAdd: [],
          SecurityOpt: ["no-new-privileges:true"],
          PortBindings: {},
        },
        NetworkSettings: {
          Networks: {
            [policy.networks.database.name]: {
              NetworkID: policy.networks.database.id,
              IPAddress: "172.20.0.2",
            },
          },
        },
        Mounts: [
          {
            Type: "volume",
            Name: policy.volume.name,
            Source: policy.volume.mountpoint,
            Destination: "/var/lib/postgresql/data",
            RW: true,
          },
          ...Object.entries({
            "/etc/postgresql/pg_hba.conf":
              supplied.hbaPath ?? "/installed/deploy/platform/postgres/pg_hba.conf",
            "/run/markiro-postgres/server.crt": f.env.MARKIRO_POSTGRES_SERVER_CERT_FILE,
            "/run/markiro-postgres/server.key": f.env.MARKIRO_POSTGRES_SERVER_KEY_FILE,
            "/run/markiro-postgres/password": f.env.MARKIRO_POSTGRES_PASSWORD_FILE,
          }).map(([Destination, Source]) => ({ Type: "bind", Source, Destination, RW: false })),
        ],
      },
    ],
  };
  const stateFile = join(f.root, "daemon.json");
  const publish = () => writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  await publish();
  const op = {
    root: f.root,
    dockerConfig: join(f.root, "docker"),
    identity: f.identity,
    configuration: f.expected.configuration,
  };
  const observers = createHostObservers(op, policy, {
    readMachineId: async () => policy.machineId,
    runProcess: async (request) => {
      assert.equal(request.executable, "/usr/bin/docker");
      assert.equal(request.timeoutMs, 60000);
      assert.deepEqual(request.args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
      return runHostProcess({
        ...request,
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("./fixtures/host-docker.mjs", import.meta.url)),
          stateFile,
          JSON.stringify(request.args.slice(2)),
        ],
      });
    },
  });
  const context = {
    ...op,
    composeFiles,
    allowedServices: ["postgres"],
    phase: "backup-verified",
    boundary: "entry",
    previousHealthy: null,
    migration: { name: `${project}-migrate-${f.identity.operationId}` },
  };
  return {
    f,
    stateFile,
    op,
    policy,
    state,
    observers,
    context,
    publish,
    trace: async () =>
      String(await readFile(`${stateFile}.trace`))
        .trim()
        .split("\n")
        .map(JSON.parse),
  };
}
