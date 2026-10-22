import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, chmod, readFile } from "node:fs/promises";
import { load } from "js-yaml";
import { join } from "node:path";
import { preparedFixture } from "./prepared-target-fixture.mjs";
import { validatePreparedTarget } from "../host/prepared-target.mjs";
import { dockerFixture } from "./host-observe-fixture.mjs";

async function observerModule() {
  return import("../host/observe.mjs");
}

test("cleanup observer inspects complete Docker inventories, rejects survivors and preserves unreaped-process flags", async (t) => {
  const { createCleanupObserver } = await observerModule();
  const f = await preparedFixture(t);
  const calls = [];
  let containers = [],
    volumes = [],
    failed = false;
  const run = async (args) => {
    calls.push(args);
    if (failed)
      throw Object.assign(new Error("secret command output"), { terminationConfirmed: false });
    return { stdout: JSON.stringify(args[0] === "container" ? containers : volumes) };
  };
  const observer = createCleanupObserver(f.identity, f.evidence.cleanup.resources, run);
  f.expected.workload = observer;
  f.expected.workload.producerId = "markiro-host-observer-v1";
  const accepted = await validatePreparedTarget(f.record, f.expected);
  assert.equal(accepted.backupProof.archiveSha256, f.backup.archiveSha256);
  assert.ok(calls.every((args) => args.includes("--all") || args[0] === "volume"));
  containers = [{ Names: f.evidence.cleanup.resources[3].name, Labels: "" }];
  await assert.rejects(observer.inspect());
  containers = [
    { Names: "foreign-name", Labels: `markiro.backup-operation=${f.identity.operationId}` },
  ];
  await assert.rejects(observer.inspect());
  containers = [];
  volumes = [{ Name: f.evidence.cleanup.resources[0].name, Labels: "" }];
  await assert.rejects(observer.inspect());
  volumes = [];
  failed = true;
  await assert.rejects(
    observer.inspect(),
    (error) => error.terminationConfirmed === false && !error.message.includes("secret"),
  );
});

test("observer exports concrete inspection and fixed adapter factory", async () => {
  const m = await observerModule();
  for (const name of ["createHostObservers", "validateObservationPolicy", "createCleanupObserver"])
    assert.equal(typeof m[name], "function");
});

test("Docker observation obtains identities through a real bounded fake executable with minimal environment", async (t) => {
  const f = await dockerFixture(t);
  const observed = await f.observers.inventory(f.context);
  assert.equal(observed.owned[0].container.Id, f.state.containers[0].Id);
  for (const call of await f.trace())
    assert.deepEqual(
      call.keys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"),
      ["DOCKER_CONFIG", "LANG", "PATH"],
    );
  assert.deepEqual(await f.observers.inspectStoppedWorkloads(f.context), {
    project: "markiro-platform",
    target: f.op.identity.target,
    active: [],
  });
});
test("Docker observation accepts actual compact ICU initialization and rejects legacy init arguments", async (t) => {
  const f = await dockerFixture(t);
  const compact = load(await readFile(new URL("../compose.compact.yml", import.meta.url), "utf8"));
  const env = f.state.containers[0].Config.Env;
  const index = env.findIndex((value) => value.startsWith("POSTGRES_INITDB_ARGS="));
  assert.notEqual(index, -1);
  env[index] = `POSTGRES_INITDB_ARGS=${compact.services.postgres.environment.POSTGRES_INITDB_ARGS}`;
  await f.publish();
  assert.equal(
    (await f.observers.inventory(f.context)).owned[0].container.Id,
    f.state.containers[0].Id,
  );
  env[index] = "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=peer";
  await f.publish();
  await assert.rejects(f.observers.inventory(f.context));
});

for (const repository of [
  "postgres",
  "library/postgres",
  "docker.io/postgres",
  "docker.io/library/postgres",
  "index.docker.io/library/postgres",
]) {
  test(`Docker observation accepts real tagless RepoDigests with ${repository} alias`, async (t) => {
    const f = await dockerFixture(t);
    f.state.images[0].RepoDigests = [`${repository}@${f.f.env.MARKIRO_POSTGRES_IMAGE_DIGEST}`];
    await f.publish();
    assert.equal(
      (await f.observers.inventory(f.context)).owned[0].container.Image,
      f.policy.postgresImageId,
    );
  });
}
for (const value of [
  "postgres-other@",
  "evil.example/postgres@",
  "docker.io/other/postgres@",
  "docker.io.evil/library/postgres@",
  "wrong-digest",
]) {
  test(`Docker observation rejects repository/digest mismatch: ${value}`, async (t) => {
    const f = await dockerFixture(t);
    f.state.images[0].RepoDigests = [
      value === "wrong-digest"
        ? `postgres@sha256:${"1".repeat(64)}`
        : `${value}${f.f.env.MARKIRO_POSTGRES_IMAGE_DIGEST}`,
    ];
    await f.publish();
    await assert.rejects(f.observers.inventory(f.context));
  });
}
for (const mutation of [
  "nonlinux",
  "wrong architecture",
  "wrong daemon",
  "wrong image",
  "wrong image platform",
  "wrong project",
  "retargeted volume",
  "wrong network",
  "public database",
  "foreign writer",
  "foreign stopped mount",
  "phase writer",
  "changed command",
  "extra mount",
])
  test(`Docker observation independently rejects ${mutation}`, async (t) => {
    const f = await dockerFixture(t);
    const pg = f.state.containers[0];
    if (mutation === "nonlinux") f.state.info.OSType = "windows";
    if (mutation === "wrong architecture") f.state.info.Architecture = "arm64";
    if (mutation === "wrong daemon") f.state.info.ID = "other";
    if (mutation === "wrong image") pg.Image = `sha256:${"a".repeat(64)}`;
    if (mutation === "wrong image platform") f.state.images[0].Architecture = "arm64";
    if (mutation === "wrong project") pg.Config.Labels["com.docker.compose.project"] = "legacy";
    if (mutation === "retargeted volume") f.state.volume.CreatedAt = "2026-10-19T00:00:00Z";
    if (mutation === "wrong network") f.state.networks[1].Id = "7".repeat(64);
    if (mutation === "public database")
      pg.HostConfig.PortBindings = { "5432/tcp": [{ HostPort: "5432" }] };
    if (mutation === "foreign writer" || mutation === "foreign stopped mount") {
      const c = structuredClone(pg);
      c.Id = "9".repeat(64);
      c.Config.Labels = {};
      if (mutation === "foreign stopped mount") c.State.Running = false;
      f.state.containers.push(c);
    }
    if (mutation === "phase writer") f.context.allowedServices = [];
    if (mutation === "changed command")
      pg.Config.Cmd = ["postgres", "-c", "shared_preload_libraries=evil"];
    if (mutation === "extra mount")
      pg.Mounts.push({ Type: "bind", Source: "/etc", Destination: "/host", RW: false });
    await f.publish();
    await assert.rejects(f.observers.inventory(f.context));
  });

for (const mode of [
  "success",
  "worker timeout",
  "unreaped start",
  "unreaped stop",
  "foreign image",
  "foreign user",
  "foreign network mode",
  "foreign created network",
  "missing started network",
  "public worker",
])
  test(`one-shot probe lifecycle ${mode} never treats CLI termination as daemon cleanup`, async (t) => {
    const { runPostgresProbe } = await import("../host/probe.mjs");
    const f = await preparedFixture(t);
    const context = { root: f.root, identity: f.identity, configuration: f.expected.configuration };
    const policy = {
      networks: { database: { name: "markiro-platform_database", id: "2".repeat(64) } },
    };
    const image = f.identity.admission.registry.api;
    const calls = [];
    const workerPath = join(f.root, "worker.mjs");
    await writeFile(workerPath, "// fixed worker fixture", { mode: 0o600 });
    if (mode === "public worker") await chmod(workerPath, 0o644);
    let container;
    const command = async (args) => {
      calls.push(args);
      if (args[0] === "create") {
        const mounts = args
          .flatMap((v, i) => (v === "--mount" ? [args[i + 1]] : []))
          .map((text) => Object.fromEntries(text.split(",").map((part) => part.split("="))));
        container = {
          Id: "a".repeat(64),
          Name: `/markiro-platform-probe-${f.identity.operationId}`,
          Image: mode === "foreign image" ? `sha256:${"0".repeat(64)}` : image.imageId,
          State: { Status: "created", Running: false, ExitCode: 0 },
          Config: {
            Image: image.reference,
            User:
              mode === "foreign user"
                ? `${process.getuid() + 1}:${process.getgid()}`
                : args[args.indexOf("--user") + 1],
            Labels: { "io.markiro.probe-operation": f.identity.operationId },
            Entrypoint: ["node"],
            Cmd: ["/probe/worker.mjs"],
          },
          HostConfig: {
            NetworkMode:
              mode === "foreign network mode" ? "9".repeat(64) : policy.networks.database.id,
            ReadonlyRootfs: true,
            Privileged: false,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            PortBindings: {},
          },
          NetworkSettings: {
            Networks: {
              [policy.networks.database.name]: {
                NetworkID: mode === "foreign created network" ? "9".repeat(64) : "",
              },
            },
          },
          Mounts: mounts.map((m) => ({
            Type: m.type,
            Source: m.source,
            Destination: m.target,
            RW: false,
          })),
        };
        return { stdout: container.Id };
      }
      if (args[0] === "start") {
        container.NetworkSettings.Networks[policy.networks.database.name].NetworkID =
          mode === "missing started network" ? "" : policy.networks.database.id;
        container.State = { Status: "running", Running: true, ExitCode: 0 };
        if (!["success", "missing started network"].includes(mode))
          throw Object.assign(new Error("secret fixture output"), {
            terminationConfirmed: mode !== "unreaped start",
          });
        container.State = { Status: "exited", Running: false, ExitCode: 0 };
        return {
          stdout: JSON.stringify({
            postgresVersion: "17.11",
            tls: {
              certificateSha256: "c".repeat(64),
              san: "db.private",
              notBefore: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          }),
        };
      }
      if (args[1] === "ls") return { stdout: container ? container.Name.slice(1) : "" };
      if (args[1] === "inspect") return { stdout: JSON.stringify([container]) };
      if (args[1] === "stop") {
        if (mode === "unreaped stop")
          throw Object.assign(new Error("secret fixture output"), { terminationConfirmed: false });
        container.State = { Status: "exited", Running: false, ExitCode: 1 };
        return { stdout: "" };
      }
      if (args[1] === "rm") {
        container = undefined;
        return { stdout: "" };
      }
      throw new Error("Unexpected fixture command");
    };
    const action = () =>
      runPostgresProbe({
        context,
        policy,
        command,
        workerPath,
        verifySources: async () => {},
      });
    if (mode === "success") {
      assert.equal((await action()).postgresVersion, "17.11");
      assert.equal(container, undefined);
      assert.equal(
        calls.find((args) => args[0] === "create")[
          calls.find((args) => args[0] === "create").indexOf("--user") + 1
        ],
        `${process.getuid()}:${process.getgid()}`,
      );
    } else {
      await assert.rejects(
        action(),
        (error) =>
          !error.message.includes("secret") &&
          (!mode.startsWith("unreaped") || error.terminationConfirmed === false),
      );
      if (mode === "worker timeout") assert.equal(container, undefined);
      if (mode === "unreaped start") assert.equal(calls.at(-1)[0], "start");
      if (mode === "unreaped stop") assert.equal(calls.at(-1)[1], "stop");
      if (mode === "public worker") assert.ok(!calls.some((args) => args[0] === "create"));
      if (mode === "foreign image" || mode === "foreign user")
        assert.ok(
          !calls.some(
            (args) => ["start", "stop", "rm"].includes(args[0]) || ["stop", "rm"].includes(args[1]),
          ),
        );
    }
    assert.ok(
      calls.every((args) => !JSON.stringify(args).includes(new URL(f.env.DATABASE_URL).password)),
    );
  });

test("stopped prior release remains inspectable until Compose replaces it without admitting an active old writer", async (t) => {
  const f = await dockerFixture(t);
  const previous = structuredClone(f.op.identity);
  previous.admission.manifest.sourceSha = "e".repeat(40);
  previous.admission.manifest.toolingSha = "e".repeat(40);
  previous.admission.registry.api = {
    reference: `ghcr.io/thevladbog/markiro-api@sha256:${"d".repeat(64)}`,
    imageId: `sha256:${"e".repeat(64)}`,
    platform: "linux/amd64",
  };
  previous.admission.manifest.api = previous.admission.registry.api.reference;
  f.context.previousHealthy = { identity: previous, phase: "healthy", status: "completed" };
  const image = previous.admission.registry.api;
  f.state.images.push({
    Id: image.imageId,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [image.reference],
    Config: { Entrypoint: ["/usr/bin/tini", "--"], Cmd: ["node", "dist/main.js"], Env: [] },
  });
  const env = {
    ...f.f.env,
    MARKIRO_SOURCE_SHA: previous.admission.manifest.sourceSha,
    MARKIRO_TOOLING_SHA: previous.admission.manifest.toolingSha,
    MARKIRO_API_IMAGE_DIGEST: previous.admission.manifest.api.split("@")[1],
    MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: previous.admission.manifest.edge.split("@")[1],
    NODE_ENV: "production",
    PORT: "3000",
    TRUST_PROXY_HOPS: "1",
    NODE_OPTIONS: "--max-old-space-size=1024",
    PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA: "true",
    VALIDATION_DM_DUPLICATE_ENABLED: "false",
    NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "false",
    NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "false",
    NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED: "false",
  };
  const c = {
    Id: "8".repeat(64),
    Name: "/markiro-platform-api-1",
    Image: image.imageId,
    State: { Status: "exited", Running: false, Restarting: false, Paused: false },
    Config: {
      Image: image.reference,
      User: "node",
      Labels: {
        "com.docker.compose.project": "markiro-platform",
        "com.docker.compose.service": "api",
        "com.docker.compose.oneoff": "False",
      },
      Entrypoint: ["/usr/bin/tini", "--"],
      Cmd: ["node", "dist/main.js"],
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    },
    HostConfig: {
      NetworkMode: f.policy.networks.default.name,
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PortBindings: {},
    },
    NetworkSettings: {
      Networks: Object.fromEntries(
        Object.values(f.policy.networks).map((n) => [n.name, { NetworkID: n.id, IPAddress: "" }]),
      ),
    },
    Mounts: [
      {
        Type: "bind",
        Source: f.f.env.MARKIRO_POSTGRES_CA_FILE,
        Destination: "/run/markiro-postgres/ca.crt",
        RW: false,
      },
    ],
  };
  f.state.containers.push(c);
  await f.publish();
  await f.observers.inspectStoppedWorkloads(f.context);
  c.State.Running = true;
  c.State.Status = "running";
  await f.publish();
  await assert.rejects(f.observers.inspectStoppedWorkloads(f.context));
});

for (const mutation of [
  "valid old bundle",
  "owned IPv4 session",
  "owned IPv6 session",
  "reload only",
  "wrong database",
  "foreign session",
  "prepared transaction",
  "changed policy",
]) {
  test(`PostgreSQL peer observation ${mutation}`, async (t) => {
    const { observePostgresAdmin } = await import("../host/probe.mjs");
    const { readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { digest } = await import("../backup/schemas.mjs");
    const f = await preparedFixture(t);
    const path = join(f.root, "actual-prior-hba.conf");
    const bytes = await readFile(new URL("../postgres/pg_hba.conf", import.meta.url));
    await writeFile(path, bytes, { mode: 0o644 });
    const pg = {
      Id: "a".repeat(64),
      State: { Running: true, Restarting: false, Paused: false },
      Mounts: [{ Destination: "/etc/postgresql/pg_hba.conf", Source: path }],
    };
    const context = {
      identity: { ...f.identity, target: { ...f.identity.target, databaseId: "1234" } },
      boundary: "entry",
    };
    const value = {
      system_id: "1234",
      version: "17.11",
      ssl: "on",
      hba_file: "/etc/postgresql/pg_hba.conf",
      started_at: Date.now() + 100,
      sessions: [],
      prepared: 0,
      hba: [
        {
          rule_number: 1,
          type: "local",
          database: ["all"],
          user_name: ["all"],
          address: null,
          netmask: null,
          auth_method: "peer",
          options: null,
          error: null,
        },
        {
          rule_number: 2,
          type: "hostnossl",
          database: ["all"],
          user_name: ["all"],
          address: "all",
          netmask: null,
          auth_method: "reject",
          options: null,
          error: null,
        },
        {
          rule_number: 3,
          type: "hostssl",
          database: ["all"],
          user_name: ["all"],
          address: "all",
          netmask: null,
          auth_method: "scram-sha-256",
          options: null,
          error: null,
        },
      ],
    };
    const sessionAddress = mutation === "owned IPv6 session" ? "2001:db8::9" : "172.20.0.8";
    const owned = [
      { service: "postgres", container: pg },
      {
        service: "api",
        active: true,
        container: { NetworkSettings: { Networks: { database: { IPAddress: sessionAddress } } } },
      },
    ];
    if (mutation.startsWith("owned "))
      value.sessions = [{ usename: "markiro_app", client_addr: sessionAddress }];
    if (mutation === "reload only") value.started_at = 0;
    if (mutation === "wrong database") value.system_id = "9999";
    if (mutation === "foreign session")
      value.sessions = [
        { usename: "markiro_app", client_addr: "172.20.0.9", application_name: "trusted-looking" },
      ];
    if (mutation === "prepared transaction") value.prepared = 1;
    if (mutation === "changed policy") value.hba[2].auth_method = "trust";
    const action = () =>
      observePostgresAdmin({
        context,
        state: { owned },
        hbaSha256: digest(bytes),
        command: async (args) => {
          assert.equal(args[0], "exec");
          assert.ok(args.includes("70:70"));
          assert.ok(
            args.some(
              (arg) =>
                arg.includes("default_transaction_read_only=on") &&
                arg.includes("statement_timeout=10000"),
            ),
          );
          const observed = structuredClone(value);
          // PostgreSQL inet::text includes the mask; host(inet) returns the address.
          if (!args.at(-1).includes("host(client_addr) AS client_addr"))
            for (const session of observed.sessions)
              session.client_addr += session.client_addr.includes(":") ? "/128" : "/32";
          return { stdout: JSON.stringify(observed) };
        },
      });
    if (mutation === "valid old bundle" || mutation.startsWith("owned "))
      assert.equal((await action()).system_id, "1234");
    else await assert.rejects(action());
  });
}

test("Docker command pins the local daemon even with a private remote currentContext", async (t) => {
  const { createDockerCommand } = await observerModule();
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const f = await preparedFixture(t);
  await writeFile(
    join(f.dockerConfig, "config.json"),
    JSON.stringify({ currentContext: "remote-attacker" }),
    { mode: 0o600 },
  );
  const command = createDockerCommand(
    { root: f.root, dockerConfig: f.dockerConfig },
    async (request) => {
      assert.deepEqual(request.args, [
        "--host",
        "unix:///var/run/docker.sock",
        "info",
        "--format",
        "{{json .}}",
      ]);
      assert.equal(request.env.DOCKER_CONFIG, f.dockerConfig);
      assert.equal(request.env.DOCKER_HOST, undefined);
      assert.equal(request.env.DOCKER_CONTEXT, undefined);
      return { stdout: "{}" };
    },
  );
  await command(["info", "--format", "{{json .}}"]);
});

for (const mode of [
  "image command omitted",
  "image command null",
  "changed command",
  "changed entrypoint",
]) {
  test(`edge observation handles Docker optional Cmd: ${mode}`, async (t) => {
    const f = await dockerFixture(t);
    const selected = f.op.identity.admission.registry.edge;
    const image = {
      Id: selected.imageId,
      Os: "linux",
      Architecture: "amd64",
      RepoDigests: [selected.reference],
      Config: { Entrypoint: ["/usr/bin/edge-entrypoint"], Env: [] },
    };
    if (mode === "image command null") image.Config.Cmd = null;
    f.state.images.push(image);
    const env = Object.fromEntries(
      [
        "MARKIRO_RETIRED_ADMIN_DOMAIN",
        "MARKIRO_SAAS_ADMIN_DOMAIN",
        "MARKIRO_RETIRED_KIOSK_DOMAIN",
        "MARKIRO_LANDING_DOMAIN",
        "MARKIRO_RELEASES_DOMAIN",
        "MARKIRO_RELEASES_BUCKET",
        "S3_PUBLIC_ORIGIN",
        "ACME_EMAIL",
      ].map((key) => [key, f.f.env[key]]),
    );
    Object.assign(env, {
      SERVER_PROFILE: "platform-only",
      VITE_SERVER_PROFILE: "platform-only",
      MARKIRO_RELEASE_SHA: f.op.identity.admission.manifest.sourceSha,
    });
    const edge = {
      Id: "8".repeat(64),
      Name: "/markiro-platform-edge-1",
      Image: selected.imageId,
      State: { Running: true, Restarting: false, Paused: false, Status: "running" },
      Config: {
        Image: selected.reference,
        Labels: {
          "com.docker.compose.project": "markiro-platform",
          "com.docker.compose.service": "edge",
          "com.docker.compose.oneoff": "False",
        },
        Entrypoint: ["/usr/bin/edge-entrypoint"],
        Cmd: mode === "changed command" ? ["sh", "-c", "unexpected"] : null,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      },
      HostConfig: {
        NetworkMode: f.policy.networks.default.name,
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PortBindings: { "8443/tcp": [{ HostPort: "443" }] },
      },
      NetworkSettings: {
        Networks: {
          [f.policy.networks.default.name]: { NetworkID: f.policy.networks.default.id },
        },
      },
      Mounts: ["data", "config"].map((name) => ({
        Type: "volume",
        Name: `markiro-platform_caddy-${name}`,
        Destination: `/${name}`,
        RW: true,
      })),
    };
    if (mode === "changed entrypoint") edge.Config.Entrypoint = ["sh"];
    f.state.containers.push(edge);
    f.state.networks[0].Containers[edge.Id] = {};
    f.context.allowedServices = ["postgres", "edge"];
    f.context.phase = "edge-started";
    await f.publish();
    if (mode.startsWith("changed")) await assert.rejects(f.observers.inventory(f.context));
    else
      assert.equal(
        (await f.observers.inventory(f.context)).owned.find((row) => row.service === "edge")
          .container.Id,
        edge.Id,
      );
  });
}
