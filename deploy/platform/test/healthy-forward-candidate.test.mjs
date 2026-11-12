import assert from "node:assert/strict";
import test from "node:test";
import { createHealthyForwardCandidateObserver } from "../host/healthy-forward-candidate.mjs";
import { preparedFixture } from "./prepared-target-fixture.mjs";

const project = "markiro-platform";
const id = "4".repeat(64);
const edgeId = "5".repeat(64);
const hashes = { api: "a".repeat(64), edge: "b".repeat(64) };

async function fixture(t) {
  const f = await preparedFixture(t);
  const { configuration } = f.expected;
  const policy = {
    machineId: "1".repeat(32),
    dockerId: "fixture-docker",
    postgresImageId: `sha256:${"2".repeat(64)}`,
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
  const admitted = f.identity.admission.registry.api;
  const overrides = {
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=1024",
    PORT: "3000",
    TRUST_PROXY_HOPS: "1",
    PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA: "true",
    VALIDATION_DM_DUPLICATE_ENABLED: "false",
    NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "false",
    NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "false",
    NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED: "false",
  };
  const environment = { ...f.env, ...overrides };
  const healthcheck = {
    Test: ["CMD", "node", "/opt/markiro/healthcheck.mjs"],
    Interval: 10000000000,
    Timeout: 3000000000,
    Retries: 12,
    StartPeriod: 20000000000,
  };
  const logOptions = { "max-size": "10m", "max-file": "3" };
  const imageConfig = {
    User: "node",
    WorkingDir: "/app",
    Entrypoint: ["/usr/bin/tini", "--"],
    Cmd: ["node", "dist/main.js"],
    Env: ["PATH=/usr/local/bin:/usr/bin:/bin"],
  };
  const container = {
    Id: id,
    Name: `/${project}-api-1`,
    Image: admitted.imageId,
    Config: {
      ...imageConfig,
      Image: admitted.reference,
      Env: [...imageConfig.Env, ...Object.entries(environment).map(([k, v]) => `${k}=${v}`)],
      Healthcheck: healthcheck,
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": "api",
        "com.docker.compose.oneoff": "False",
        "com.docker.compose.container-number": "1",
        "com.docker.compose.config-hash": hashes.api,
        "com.docker.compose.image": admitted.imageId,
      },
    },
    State: {
      Status: "running",
      Running: true,
      Paused: false,
      Restarting: false,
      Dead: false,
      OOMKilled: false,
      Health: { Status: "healthy" },
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      NetworkMode: policy.networks.default.name,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PortBindings: {},
      Memory: 1610612736,
      NanoCpus: 1250000000,
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
      LogConfig: { Type: "json-file", Config: logOptions },
    },
    NetworkSettings: {
      Networks: Object.fromEntries(
        Object.values(policy.networks).map(({ id: NetworkID, name }) => [name, { NetworkID }]),
      ),
    },
    Mounts: [
      {
        Type: "bind",
        Destination: "/run/markiro-postgres/ca.crt",
        Source: f.env.MARKIRO_POSTGRES_CA_FILE,
        RW: false,
      },
    ],
  };
  const render = {
    name: project,
    services: {
      api: {
        image: admitted.reference,
        environment,
        networks: { default: null, database: null },
        healthcheck: {
          test: healthcheck.Test,
          interval: "10s",
          timeout: "3s",
          retries: 12,
          start_period: "20s",
        },
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        mem_limit: "1610612736",
        cpus: 1.25,
        restart: "unless-stopped",
        tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"],
        logging: { driver: "json-file", options: logOptions },
        volumes: [
          {
            type: "bind",
            target: "/run/markiro-postgres/ca.crt",
            source: f.env.MARKIRO_POSTGRES_CA_FILE,
            read_only: true,
          },
        ],
      },
      edge: {
        image: f.identity.admission.registry.edge.reference,
        environment: {
          SERVER_PROFILE: "platform-only",
          MARKIRO_RELEASE_SHA: f.env.MARKIRO_SOURCE_SHA,
        },
      },
    },
  };
  const actualHashes = { ...hashes };
  const admittedEdge = f.identity.admission.registry.edge;
  const edgeImageConfig = {
    User: "10001:10001",
    WorkingDir: "/srv",
    Entrypoint: ["/usr/bin/edge-entrypoint"],
    Cmd: ["caddy", "run"],
    Env: ["PATH=/usr/local/bin:/usr/bin:/bin"],
  };
  const edge = {
    ...container,
    Id: edgeId,
    Name: `/${project}-edge-1`,
    Image: admittedEdge.imageId,
    Config: {
      ...edgeImageConfig,
      Image: admittedEdge.reference,
      Env: [
        ...edgeImageConfig.Env,
        ...Object.entries(render.services.edge.environment).map(
          ([key, value]) => `${key}=${value}`,
        ),
      ],
      Labels: {
        ...container.Config.Labels,
        "com.docker.compose.service": "edge",
        "com.docker.compose.config-hash": hashes.edge,
        "com.docker.compose.image": admittedEdge.imageId,
      },
    },
    HostConfig: {
      ...container.HostConfig,
      Memory: 201326592,
      NanoCpus: 250000000,
      PortBindings: {
        "8080/tcp": [{ HostIp: "", HostPort: "80" }],
        "8443/tcp": [{ HostIp: "", HostPort: "443" }],
      },
    },
    NetworkSettings: {
      Networks: { [policy.networks.default.name]: { NetworkID: policy.networks.default.id } },
    },
    Mounts: ["data", "config"].map((name) => ({
      Type: "volume",
      Name: `${project}_caddy-${name}`,
      Destination: `/${name}`,
      RW: true,
    })),
  };
  render.services.edge.networks = { default: null };
  const runProcess = async ({ executable, args, cwd, env }) => {
    assert.equal(executable, "/usr/bin/docker");
    assert.deepEqual(args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
    assert.equal(cwd, f.root);
    const command = args.slice(2);
    if (command[0] === "compose") {
      assert.equal(env.COMPOSE_DISABLE_ENV_FILE, "1");
      assert.equal(env.MARKIRO_PLATFORM_ENV_FILE, configuration.runtimeSnapshot.path);
      assert.equal(env.MARKIRO_PLATFORM_MIGRATION_ENV_FILE, configuration.migrationSnapshot.path);
      assert.equal(Object.hasOwn(env, "DATABASE_URL"), false);
      assert.deepEqual(command.slice(1, 3), ["--project-name", project]);
      assert.ok(command.some((value) => value.endsWith("/deploy/platform/compose.yml")));
      assert.ok(command.some((value) => value.endsWith("/deploy/platform/compose.compact.yml")));
      if (command.at(-2) === "--hash") {
        const service = command.at(-1);
        return { stdout: Buffer.from(`${service} ${actualHashes[service]}\n`) };
      }
      assert.deepEqual(command.slice(-3), ["config", "--format", "json"]);
      return { stdout: Buffer.from(JSON.stringify(render)) };
    }
    if (command[0] === "image") {
      const isEdge = command[2] === admittedEdge.reference;
      const selected = isEdge ? admittedEdge : admitted;
      assert.deepEqual(command, ["image", "inspect", selected.reference]);
      return {
        stdout: Buffer.from(
          JSON.stringify([
            {
              Id: selected.imageId,
              Os: "linux",
              Architecture: "amd64",
              RepoDigests: [selected.reference],
              Config: isEdge ? edgeImageConfig : imageConfig,
            },
          ]),
        ),
      };
    }
    const selected = command[2] === edgeId ? edge : container;
    assert.deepEqual(command, ["container", "inspect", selected.Id]);
    return { stdout: Buffer.from(JSON.stringify([selected])) };
  };
  const observer = await createHealthyForwardCandidateObserver(
    {
      root: f.root,
      dockerConfig: f.dockerConfig,
      identity: {
        ...f.identity,
        operationId: configuration.candidateId,
        target: { hostId: policy.machineId, databaseId: "123", volumeId: policy.volume.name },
      },
      configuration,
    },
    policy,
    hashes,
    { ambient: {}, verifyAuthority: async () => {}, runProcess },
  );
  return { observer, container, edge, actualHashes, admitted };
}

test("candidate observation derives a descriptor from the approved rendered and physical recipe", async (t) => {
  const { observer, admitted } = await fixture(t);
  await observer.verifyCompose();
  const descriptor = await observer.observe("api", id);
  assert.equal(descriptor.id, id);
  assert.equal(descriptor.imageId, admitted.imageId);
  assert.match(descriptor.recipeSha256, /^[a-f0-9]{64}$/u);
});

test("an unchanged Docker label cannot replace the reviewed Compose hash", async (t) => {
  const { observer, actualHashes } = await fixture(t);
  actualHashes.api = "c".repeat(64);
  await assert.rejects(observer.observe("api", id));
});

test("edge observation refuses extra ports and mounts under the reviewed Compose hash", async (t) => {
  const { observer, edge } = await fixture(t);
  assert.equal((await observer.observe("edge", edgeId)).id, edgeId);
  edge.HostConfig.PortBindings["9000/tcp"] = [{ HostIp: "", HostPort: "9000" }];
  await assert.rejects(observer.observe("edge", edgeId));
  delete edge.HostConfig.PortBindings["9000/tcp"];
  edge.Mounts[0].Name = "foreign-data";
  await assert.rejects(observer.observe("edge", edgeId));
});

for (const [field, change] of [
  ["image", (c) => (c.Image = `sha256:${"c".repeat(64)}`)],
  ["environment", (c) => c.Config.Env.push("UNREVIEWED_INJECTION=fixture")],
  ["recipe", (c) => (c.HostConfig.ReadonlyRootfs = false)],
])
  test(`matching Compose hash does not admit a changed candidate ${field}`, async (t) => {
    const { observer, container } = await fixture(t);
    change(container);
    await assert.rejects(observer.observe("api", id));
  });
