import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dockerFixture } from "./host-observe-fixture.mjs";
import { upgradeFixture, upgradeBytes, upgradeHash } from "./upgrade-fixture.mjs";
import { canonical } from "../backup/schemas.mjs";

export const legacyExecutor = "69f288e0a5299cabee229ce7dddf58bcba9fd22c";
export async function upgradeObservationFixture(
  t,
  { candidatePatch = {}, daemonFixture, candidateOperationId } = {},
) {
  const d = daemonFixture ?? (await dockerFixture(t));
  const root = d.op.root;
  const oldEnv = { ...d.f.env };
  delete oldEnv.MARKIRO_RELEASES_DOMAIN;
  delete oldEnv.MARKIRO_RELEASES_BUCKET;
  async function configuration(env) {
    const candidateId = randomUUID();
    const dir = join(root, "candidates", candidateId);
    await mkdir(dir, { mode: 0o700 });
    const runtime = Buffer.from(
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
    );
    const migration = Buffer.from(`DATABASE_URL=${env.DATABASE_URL}\n`);
    await writeFile(join(dir, "runtime.env"), runtime, { mode: 0o600 });
    await writeFile(join(dir, "migration.env"), migration, { mode: 0o600 });
    const runtimeSha256 = upgradeHash(runtime),
      migrationSha256 = upgradeHash(migration);
    return {
      configuration: {
        candidateId,
        runtimeSnapshot: { path: join(dir, "runtime.env"), sha256: runtimeSha256 },
        migrationSnapshot: { path: join(dir, "migration.env"), sha256: migrationSha256 },
      },
      sha256: upgradeHash(
        canonical({
          version: 1,
          kind: "platform-host-configuration",
          candidateId,
          runtimeSha256,
          migrationSha256,
        }),
      ),
    };
  }
  const oldConfig = await configuration(oldEnv);
  const candidateEnv = { ...d.f.env, ...candidatePatch };
  const candidateConfig = await configuration(candidateEnv);
  const recovered = structuredClone(d.op.identity);
  recovered.operationId = randomUUID();
  recovered.executorSha = legacyExecutor;
  recovered.configurationSha256 = oldConfig.sha256;
  const identity = structuredClone(d.op.identity);
  identity.operationId = candidateOperationId ?? randomUUID();
  identity.configurationSha256 = candidateConfig.sha256;
  const f = upgradeFixture({
    prior: { ...recovered, operationId: randomUUID(), executorSha: "b".repeat(40) },
    recovered,
    identity,
    configuration: oldConfig.configuration,
    root,
    policy: d.policy,
  });
  // The historical ordinary target must also describe this host.
  f.records.original.current.identity.target = recovered.target;
  f.records.original.current.backup.target = recovered.target;
  f.records.preparation.admission.predecessor.identity.target = recovered.target;
  f.records.preparation.admission.predecessor.stateSha256 = upgradeHash(
    upgradeBytes(f.records.original),
  );
  f.records.acceptedRecovery.activation.preparation.sha256 = upgradeHash(
    upgradeBytes(f.records.preparation),
  );
  f.records.consumption.preparationSha256 =
    f.records.acceptedRecovery.activation.preparation.sha256;
  f.records.consumption.activationSha256 = upgradeHash(
    Buffer.from(JSON.stringify(f.records.acceptedRecovery.activation)),
  );
  for (const [name, record] of Object.entries(f.records)) {
    f.predecessorBytes[name] = upgradeBytes(record);
    f.input.predecessor.hashes[name] = upgradeHash(f.predecessorBytes[name]);
  }
  const activationDir = join(
    dirname(root),
    "recovery-operations",
    recovered.operationId,
    "activate",
  );
  await mkdir(activationDir, { recursive: true, mode: 0o700 });
  for (const [key, path] of Object.entries({
    original: join(root, "state.json"),
    acceptedRecovery: join(root, "recovery-state.json"),
    preparation: join(root, "recovery-preparation.json"),
    consumption: join(root, `recovery-activation-${recovered.operationId}.json`),
    activationOperation: join(activationDir, "operation.json"),
  }))
    await writeFile(path, f.predecessorBytes[key], { mode: 0o600 });
  const oldOperation = { ...d.op, identity: recovered, configuration: oldConfig.configuration };
  const candidateOperation = { ...d.op, identity, configuration: candidateConfig.configuration };
  const predecessorContainers = {
    postgres: d.state.containers[0].Id,
    api: "8".repeat(64),
    edge: "9".repeat(64),
  };
  for (const service of ["api", "edge"]) {
    const selected = recovered.admission.registry[service];
    const imageConfig =
      service === "api"
        ? { Entrypoint: ["/usr/bin/tini", "--"], Cmd: ["node", "dist/main.js"], Env: [] }
        : { Entrypoint: ["/usr/bin/edge-entrypoint"], Env: [] };
    d.state.images = d.state.images.filter((image) => image.Id !== selected.imageId);
    d.state.images.push({
      Id: selected.imageId,
      Os: "linux",
      Architecture: "amd64",
      RepoDigests: [selected.reference],
      Config: imageConfig,
    });
    const env =
      service === "api"
        ? {
            ...oldEnv,
            MARKIRO_SOURCE_SHA: recovered.admission.manifest.sourceSha,
            MARKIRO_TOOLING_SHA: recovered.admission.manifest.toolingSha,
            MARKIRO_API_IMAGE_DIGEST: recovered.admission.manifest.api.split("@")[1],
            MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: recovered.admission.manifest.edge.split("@")[1],
            NODE_ENV: "production",
            PORT: "3000",
            TRUST_PROXY_HOPS: "1",
            NODE_OPTIONS: "--max-old-space-size=1024",
            PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA: "true",
            VALIDATION_DM_DUPLICATE_ENABLED: "false",
            NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "false",
            NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "false",
            NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED: "false",
          }
        : {
            ...Object.fromEntries(
              [
                "MARKIRO_RETIRED_ADMIN_DOMAIN",
                "MARKIRO_SAAS_ADMIN_DOMAIN",
                "MARKIRO_RETIRED_KIOSK_DOMAIN",
                "MARKIRO_LANDING_DOMAIN",
                "S3_PUBLIC_ORIGIN",
                "ACME_EMAIL",
              ].map((k) => [k, oldEnv[k]]),
            ),
            SERVER_PROFILE: "platform-only",
            VITE_SERVER_PROFILE: "platform-only",
            MARKIRO_RELEASE_SHA: recovered.admission.manifest.sourceSha,
          };
    d.state.containers.push({
      Id: predecessorContainers[service],
      Name: `/markiro-platform-${service}-1`,
      Image: selected.imageId,
      State: { Running: true, Restarting: false, Paused: false, Status: "running" },
      Config: {
        Image: selected.reference,
        Labels: {
          "com.docker.compose.project": "markiro-platform",
          "com.docker.compose.service": service,
          "com.docker.compose.oneoff": "False",
        },
        Entrypoint: imageConfig.Entrypoint,
        Cmd: imageConfig.Cmd ?? null,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      },
      HostConfig: {
        NetworkMode: d.policy.networks.default.name,
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PortBindings:
          service === "edge"
            ? {
                "8080/tcp": [{ HostIp: "", HostPort: "80" }],
                "8443/tcp": [{ HostIp: "", HostPort: "443" }],
              }
            : {},
      },
      NetworkSettings: {
        Networks: Object.fromEntries(
          Object.entries(d.policy.networks)
            .filter(([n]) => service === "api" || n === "default")
            .map(([, n]) => [n.name, { NetworkID: n.id }]),
        ),
      },
      Mounts:
        service === "api"
          ? [
              {
                Type: "bind",
                Source: oldEnv.MARKIRO_POSTGRES_CA_FILE,
                Destination: "/run/markiro-postgres/ca.crt",
                RW: false,
              },
            ]
          : ["data", "config"].map((n) => ({
              Type: "volume",
              Name: `markiro-platform_caddy-${n}`,
              Destination: `/${n}`,
              RW: true,
            })),
    });
  }
  const commands = [];
  const dependencies = {
    readMachineId: async () => d.policy.machineId,
    runProcess: async (request) => {
      assert.equal(request.executable, "/usr/bin/docker");
      assert.equal(request.timeoutMs, 60000);
      assert.equal(request.outputLimitBytes, 1048576);
      const args = request.args.slice(2);
      commands.push(args);
      let value;
      if (args[0] === "info") value = d.state.info;
      else if (args[0] === "container" && args[1] === "ls")
        return {
          stdout: d.state.containers
            .map((c) =>
              args.at(-1) === "json"
                ? JSON.stringify({
                    Names: c.Name.slice(1),
                    Labels: Object.entries(c.Config.Labels)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(","),
                  })
                : c.Id,
            )
            .join("\n"),
        };
      else if (args[0] === "volume" && args[1] === "ls")
        return {
          stdout: JSON.stringify({
            Name: d.state.volume.Name,
            Labels: Object.entries(d.state.volume.Labels)
              .map(([k, v]) => `${k}=${v}`)
              .join(","),
          }),
        };
      else if (args[1] === "inspect") {
        const rows = d.state[args[0] === "volume" ? "volume" : `${args[0]}s`];
        value =
          args[0] === "volume"
            ? [rows]
            : rows.filter(
                (v) =>
                  v.Id === args[2] ||
                  v.RepoDigests?.includes(args[2]) ||
                  v.LookupReferences?.includes(args[2]),
              );
      } else if (args[0] === "exec") return { stdout: databaseId };
      else assert.fail(`Unexpected command ${args[0]}`);
      return { stdout: JSON.stringify(value) };
    },
  };
  let databaseId = recovered.target.databaseId;
  return {
    ...f,
    d,
    root,
    oldEnv,
    candidateEnv,
    oldOperation,
    candidateOperation,
    predecessorContainers,
    policy: d.policy,
    dependencies,
    commands,
    setDatabaseId: (v) => {
      databaseId = v;
    },
    stop: () => {
      for (const c of d.state.containers.slice(1))
        c.State = { Running: false, Restarting: false, Paused: false, Status: "exited" };
    },
  };
}
