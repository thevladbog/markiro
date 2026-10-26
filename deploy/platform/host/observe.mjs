import { carryHostFailure } from "./failure-diagnostic.mjs";
import { catalogMountBindings, assertExclusiveCatalogMounts } from "../catalog-config.mjs";
import { readFile } from "node:fs/promises";
import { canonical, digest, ensure, keys, plain } from "../backup/schemas.mjs";
import { runHostProcess } from "./process.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { assertBindFileSync } from "./files.mjs";

export const observerProducer = "markiro-host-observer-v1";
const project = "markiro-platform";
export const postgresCommand = Object.freeze([
  "postgres",
  ...[
    "ssl=on",
    "ssl_cert_file=/run/markiro-postgres/server.crt",
    "ssl_key_file=/run/markiro-postgres/server.key",
    "hba_file=/etc/postgresql/pg_hba.conf",
    "password_encryption=scram-sha-256",
    "max_connections=32",
    "shared_buffers=256MB",
    "work_mem=4MB",
    "maintenance_work_mem=64MB",
    "autovacuum_work_mem=32MB",
    "max_wal_size=1GB",
    "min_wal_size=80MB",
    "fsync=on",
    "full_page_writes=on",
    "synchronous_commit=on",
  ].flatMap((value) => ["-c", value]),
]);
const hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const imageId = (v) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
const same = (a, b) => ensure(canonical(a) === canonical(b));
export function observationError(error) {
  const result = new Error("Host observation failed.");
  result.code = "ERR_HOST_OBSERVATION";
  return carryHostFailure(error, result);
}
export async function guarded(action) {
  try {
    return await action();
  } catch (error) {
    throw observationError(error);
  }
}
export function jsonRows(text) {
  const value = String(text).trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    const rows = JSON.parse(value);
    ensure(Array.isArray(rows));
    return rows;
  }
  return value.split("\n").map((line) => JSON.parse(line));
}
export function validateObservationPolicy(input) {
  const p = plain(input);
  keys(p, ["machineId", "dockerId", "postgresImageId", "volume", "networks"]);
  ensure(
    /^[a-f0-9]{32}$/u.test(p.machineId) &&
      /^[a-zA-Z0-9:-]{1,128}$/u.test(p.dockerId) &&
      imageId(p.postgresImageId),
  );
  keys(p.volume, ["name", "createdAt", "mountpoint"]);
  ensure(
    p.volume.name === `${project}_postgres-data` &&
      typeof p.volume.createdAt === "string" &&
      Number.isFinite(Date.parse(p.volume.createdAt)),
  );
  ensure(p.volume.mountpoint === `/var/lib/docker/volumes/${p.volume.name}/_data`);
  keys(p.networks, ["default", "database"]);
  for (const name of ["default", "database"]) {
    keys(p.networks[name], ["name", "id"]);
    ensure(p.networks[name].name === `${project}_${name}` && hex(p.networks[name].id));
  }
  return p;
}
export function createDockerCommand({ root, dockerConfig }, runProcess = runHostProcess, signal) {
  return (args, recovery = false) =>
    guarded(() =>
      runProcess({
        executable: "/usr/bin/docker",
        args: ["--host", "unix:///var/run/docker.sock", ...args],
        cwd: root,
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
          DOCKER_CONFIG: dockerConfig,
        },
        timeoutMs: 60000,
        outputLimitBytes: 1048576,
        ...(!recovery && signal ? { signal } : {}),
      }),
    );
}
export function createCleanupObserver(identity, resources, command) {
  const bound = plain(resources);
  return {
    identity: { resources: bound },
    producerId: observerProducer,
    executorSha: identity.executorSha,
    inspect: () =>
      guarded(async () => {
        const containers = jsonRows(
          (await command(["container", "ls", "--all", "--no-trunc", "--format", "json"])).stdout,
        );
        const volumes = jsonRows((await command(["volume", "ls", "--format", "json"])).stdout);
        const all = [
          ...containers.map((v) => ({ kind: "container", name: v.Names, labels: v.Labels })),
          ...volumes.map((v) => ({ kind: "volume", name: v.Name, labels: v.Labels })),
        ];
        for (const v of all) ensure(typeof v.name === "string" && typeof v.labels === "string");
        const present = all.filter((v) =>
          bound.some((r) => r.kind === v.kind && r.name === v.name),
        );
        const owned = all.filter((v) =>
          v.labels.split(",").includes(`markiro.backup-operation=${identity.operationId}`),
        );
        ensure(!present.length && !owned.length);
        return {
          version: 2,
          kind: "platform-restore-cleanup",
          status: "absent",
          operationId: identity.operationId,
          target: plain(identity.target),
          producerId: observerProducer,
          executorSha: identity.executorSha,
          observedAt: new Date().toISOString(),
          resources: plain(bound),
          present: [],
          operationResources: [],
        };
      }),
  };
}
const envMap = (values) => {
  ensure(Array.isArray(values));
  const result = {};
  for (const value of values) {
    const i = value.indexOf("=");
    ensure(i > 0 && !Object.hasOwn(result, value.slice(0, i)));
    result[value.slice(0, i)] = value.slice(i + 1);
  }
  return result;
};
const running = (c) => c.State.Running || c.State.Restarting || c.State.Paused;

// Docker inspect reports repository@digest without the optional pull tag.
// Resolve only Docker Hub's familiar-name aliases; never match digest alone.
function repositoryDigest(reference) {
  const match = /^([^@\s]+)@(sha256:[a-f0-9]{64})$/u.exec(reference);
  ensure(match);
  const name = match[1].replace(/:[^/:]+$/u, "");
  const parts = name.split("/");
  let registry = "docker.io";
  if (parts.length > 1 && (/[.:]/u.test(parts[0]) || parts[0] === "localhost"))
    registry = parts.shift();
  if (registry === "index.docker.io") registry = "docker.io";
  if (registry === "docker.io" && parts.length === 1) parts.unshift("library");
  return `${registry}/${parts.join("/")}@${match[2]}`;
}

// These are factual Docker observations, not a complete PostgreSQL acceptance.
// The caller must run the fixed PostgreSQL/TLS probe before returning a held fence.
export function createHostObservers(operation, policyInput, options = {}) {
  return createObservers(operation, policyInput, options, false);
}

// The first upgrade accepts this exact historical executor/recipe only. This is
// not a caller-supplied env allowlist or an image-ID compatibility heuristic.
export function createAcceptedRecoveryObservers(operation, policyInput, options = {}) {
  ensure(operation.identity.executorSha === "69f288e0a5299cabee229ce7dddf58bcba9fd22c");
  return createObservers(operation, policyInput, options, true);
}

// Upgrade-only dual authority: exact retained IDs select the complete old
// recipe. Every other owned application selects the complete candidate recipe.
// Selection is never based on image equality; ordinary callers cannot enable it.
export function createUpgradeHostObservers(
  operation,
  oldOperation,
  retainedIds,
  policyInput,
  options = {},
) {
  ensure(oldOperation.identity.executorSha === "69f288e0a5299cabee229ce7dddf58bcba9fd22c");
  keys(retainedIds, ["postgres", "api", "edge"]);
  ensure(Object.values(retainedIds).every(hex) && new Set(Object.values(retainedIds)).size === 3);
  same(operation.identity.target, oldOperation.identity.target);
  return createObservers(operation, policyInput, options, false, {
    operation: oldOperation,
    ids: retainedIds,
  });
}
function createObservers(operation, policyInput, options, legacyEdge, retained) {
  const policy = validateObservationPolicy(policyInput);
  const command = createDockerCommand(operation, options.runProcess, options.signal);
  const readMachineId = options.readMachineId ?? (() => readFile("/etc/machine-id", "utf8"));
  const inspectOne = async (kind, name, recovery = false) => {
    const values = JSON.parse((await command([kind, "inspect", name], recovery)).stdout);
    ensure(Array.isArray(values) && values.length === 1);
    return values[0];
  };
  const inspectImage = async (reference, id, recovery = false) => {
    const image = await inspectOne("image", reference, recovery);
    ensure(image.Id === id && image.Os === "linux" && image.Architecture === "amd64");
    if (reference.includes("@")) {
      const expected = repositoryDigest(reference);
      ensure(
        Array.isArray(image.RepoDigests) &&
          image.RepoDigests.some((value) => repositoryDigest(value) === expected),
      );
    }
    return image;
  };
  async function inventory(context) {
    const boundary = context.transitionBoundary ?? context.boundary;
    const recovery = boundary === "recovery";
    const info = JSON.parse((await command(["info", "--format", "{{json .}}"], recovery)).stdout);
    ensure(
      info.OSType === "linux" &&
        ["x86_64", "amd64"].includes(info.Architecture) &&
        info.ID === policy.dockerId,
    );
    const machineId = String(await readMachineId()).trim();
    ensure(machineId === policy.machineId && machineId === operation.identity.target.hostId);
    const volume = await inspectOne("volume", policy.volume.name, recovery);
    ensure(volume.Name === operation.identity.target.volumeId && volume.Driver === "local");
    same(
      { name: volume.Name, createdAt: volume.CreatedAt, mountpoint: volume.Mountpoint },
      policy.volume,
    );
    same(volume.Options ?? {}, {});
    ensure(
      volume.Labels?.["com.docker.compose.project"] === project &&
        volume.Labels?.["com.docker.compose.volume"] === "postgres-data",
    );
    const networks = {};
    for (const name of ["default", "database"]) {
      const n = await inspectOne("network", policy.networks[name].id, recovery);
      ensure(
        n.Id === policy.networks[name].id &&
          n.Name === policy.networks[name].name &&
          n.Driver === "bridge" &&
          n.Scope === "local",
      );
      ensure(n.Internal === (name === "database") && n.Attachable === false && n.Ingress === false);
      ensure(
        n.Labels?.["com.docker.compose.project"] === project &&
          n.Labels?.["com.docker.compose.network"] === name,
      );
      networks[name] = n;
    }
    const ids = String(
      (await command(["container", "ls", "--all", "--quiet", "--no-trunc"], recovery)).stdout,
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    ensure(ids.length <= 32 && ids.every(hex) && new Set(ids).size === ids.length);
    const containers = [];
    for (const id of ids) {
      const c = await inspectOne("container", id, recovery);
      ensure(c.Id === id);
      containers.push(c);
    }
    const config = await readProtectedEnv(operation.configuration.runtimeSnapshot.path);
    const oldConfig = retained
      ? await readProtectedEnv(retained.operation.configuration.runtimeSnapshot.path)
      : null;
    const owned = [];
    for (const c of containers) {
      const labels = c.Config.Labels ?? {};
      const member = Object.values(policy.networks).some((n) =>
        Object.values(c.NetworkSettings.Networks ?? {}).some((v) => v.NetworkID === n.id),
      );
      const mounted = c.Mounts.some(
        (m) => m.Name === policy.volume.name || m.Source === policy.volume.mountpoint,
      );
      // Unknown running workloads on a dedicated host, and even stopped foreign
      // members/mounters, cannot establish an enforceable private database fence.
      if (labels["com.docker.compose.project"] !== project) {
        ensure(!running(c) && !member && !mounted);
        continue;
      }
      const service = labels["com.docker.compose.service"];
      ensure(["postgres", "api", "edge", "migrate"].includes(service));
      const active = running(c);
      if (active) ensure(context.allowedServices.includes(service));
      ensure(
        !c.HostConfig.Privileged &&
          !["host", "container"].some(
            (v) => c.HostConfig.NetworkMode === v || c.HostConfig.NetworkMode.startsWith(v + ":"),
          ),
      );
      ensure(
        c.HostConfig.ReadonlyRootfs === true &&
          c.HostConfig.CapDrop?.includes("ALL") &&
          !c.HostConfig.CapAdd?.length,
      );
      ensure(
        c.HostConfig.SecurityOpt?.includes("no-new-privileges:true") &&
          !c.HostConfig.Devices?.length,
      );
      const networkNames = Object.keys(c.NetworkSettings.Networks ?? {}).sort();
      same(
        networkNames,
        (service === "postgres"
          ? [policy.networks.database.name]
          : service === "edge"
            ? [policy.networks.default.name]
            : Object.values(policy.networks).map((n) => n.name)
        ).sort(),
      );
      for (const [name, n] of Object.entries(c.NetworkSettings.Networks))
        ensure(n.NetworkID === Object.values(policy.networks).find((p) => p.name === name)?.id);
      if (service !== "edge") same(c.HostConfig.PortBindings ?? {}, {});
      const old = retained && c.Id === retained.ids[service];
      if (old && service !== "postgres") ensure(!active);
      const containerOperation = old ? retained.operation : operation;
      const containerConfig = old ? oldConfig : config;
      const containerLegacy = old ? true : legacyEdge;
      let reference, id;
      let selectedAdmission = containerOperation.identity.admission;
      if (service === "postgres") {
        reference = `postgres:17-alpine@${containerConfig.MARKIRO_POSTGRES_IMAGE_DIGEST}`;
        id = policy.postgresImageId;
      } else {
        const priorImage =
          context.previousHealthy?.identity.admission.registry[service === "edge" ? "edge" : "api"];
        const stoppedPrior =
          !active &&
          service !== "migrate" &&
          priorImage &&
          c.Image === priorImage.imageId &&
          c.Config.Image === priorImage.reference;
        const prior =
          context.previousHealthy &&
          (stoppedPrior ||
            ["admitted", "images-verified"].includes(context.phase) ||
            (context.phase === "target-stopped" &&
              ["entry", "command", "recovery"].includes(boundary)));
        const admission = prior
          ? context.previousHealthy.identity.admission
          : containerOperation.identity.admission;
        selectedAdmission = admission;
        const selected = admission.registry[service === "edge" ? "edge" : "api"];
        reference = selected.reference;
        id = selected.imageId;
      }
      ensure(c.Config.Image === reference && c.Image === id);
      const image = await inspectImage(reference, id, recovery);
      same(c.Config.Entrypoint, image.Config.Entrypoint);
      const env = envMap(c.Config.Env);
      const inherited = envMap(image.Config.Env ?? []);
      let expectedEnv;
      if (service === "postgres") {
        same(c.Config.Cmd, postgresCommand);
        expectedEnv = {
          ...inherited,
          POSTGRES_DB: "markiro",
          POSTGRES_USER: "postgres",
          POSTGRES_PASSWORD_FILE: "/run/markiro-postgres/password",
          POSTGRES_INITDB_ARGS:
            "--auth-host=scram-sha-256 --auth-local=peer --locale-provider=icu --icu-locale=en-US --lc-collate=C --lc-ctype=C --encoding=UTF8",
        };
      } else if (service === "edge") {
        // Docker image inspect omits an unset Cmd; container inspect returns null.
        // A supplied command must still exactly match the pinned image command.
        same(c.Config.Cmd ?? null, image.Config.Cmd ?? null);
        expectedEnv = {
          ...inherited,
          ...Object.fromEntries(
            [
              "MARKIRO_RETIRED_ADMIN_DOMAIN",
              "MARKIRO_SAAS_ADMIN_DOMAIN",
              "MARKIRO_RETIRED_KIOSK_DOMAIN",
              "MARKIRO_LANDING_DOMAIN",
              ...(!containerLegacy ? ["MARKIRO_RELEASES_DOMAIN", "MARKIRO_RELEASES_BUCKET"] : []),
              "S3_PUBLIC_ORIGIN",
              "ACME_EMAIL",
            ].map((key) => [key, containerConfig[key]]),
          ),
          SERVER_PROFILE: "platform-only",
          VITE_SERVER_PROFILE: "platform-only",
          MARKIRO_RELEASE_SHA: selectedAdmission.manifest.sourceSha,
        };
      } else {
        const environment =
          service === "api"
            ? containerConfig
            : await readProtectedEnv(containerOperation.configuration.migrationSnapshot.path);
        expectedEnv = {
          ...inherited,
          ...environment,
          ...(service === "api"
            ? {
                MARKIRO_SOURCE_SHA: selectedAdmission.manifest.sourceSha,
                MARKIRO_TOOLING_SHA: selectedAdmission.manifest.toolingSha,
                MARKIRO_API_IMAGE_DIGEST: selectedAdmission.manifest.api.split("@")[1],
                MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: selectedAdmission.manifest.edge.split("@")[1],
              }
            : {}),
          SERVER_PROFILE: "platform-only",
          NODE_ENV: "production",
          PORT: "3000",
          TRUST_PROXY_HOPS: "1",
          NODE_OPTIONS:
            service === "api" ? "--max-old-space-size=1024" : "--max-old-space-size=384",
          ...(service === "api"
            ? {
                PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA: "true",
                VALIDATION_DM_DUPLICATE_ENABLED: "false",
                NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "false",
                NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "false",
                NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED: "false",
              }
            : {}),
        };
      }
      same(env, expectedEnv);
      if (service !== "postgres") {
        ensure(env.SERVER_PROFILE === "platform-only");
        if (service === "edge") ensure(env.VITE_SERVER_PROFILE === "platform-only");
        else {
          const expected =
            service === "api"
              ? containerConfig
              : await readProtectedEnv(containerOperation.configuration.migrationSnapshot.path);
          ensure(env.DATABASE_URL === expected.DATABASE_URL && env.NODE_ENV === "production");
          same(
            c.Config.Cmd,
            service === "migrate"
              ? ["node", "node_modules/@markiro/db/dist/migrate-cli.js"]
              : image.Config.Cmd,
          );
        }
      }
      if (service === "migrate")
        ensure(
          c.Name === `/${context.migration.name}` &&
            labels["io.markiro.operation"] === containerOperation.identity.operationId &&
            labels["com.docker.compose.oneoff"] === "True",
        );
      else
        ensure(
          c.Name === `/${project}-${service}-1` && labels["com.docker.compose.oneoff"] === "False",
        );
      const binds =
        service === "postgres"
          ? {
              // A prior installed bundle can remain mounted until PostgreSQL is
              // recreated. The admin observer verifies this actual inode's bytes,
              // ownership and unchanged-since-postmaster-start metadata.
              "/etc/postgresql/pg_hba.conf": c.Mounts.find(
                (m) => m.Destination === "/etc/postgresql/pg_hba.conf",
              )?.Source,
              "/run/markiro-postgres/server.crt": containerConfig.MARKIRO_POSTGRES_SERVER_CERT_FILE,
              "/run/markiro-postgres/server.key": containerConfig.MARKIRO_POSTGRES_SERVER_KEY_FILE,
              "/run/markiro-postgres/password": containerConfig.MARKIRO_POSTGRES_PASSWORD_FILE,
            }
          : service === "edge"
            ? {}
            : { "/run/markiro-postgres/ca.crt": containerConfig.MARKIRO_POSTGRES_CA_FILE };
      const writableBinds = catalogMountBindings(env, service);
      const named =
        service === "postgres"
          ? { "/var/lib/postgresql/data": policy.volume.name }
          : service === "edge"
            ? { "/data": `${project}_caddy-data`, "/config": `${project}_caddy-config` }
            : {};
      same(
        c.Mounts.map((m) => m.Destination).sort(),
        [...Object.keys(binds), ...Object.keys(writableBinds), ...Object.keys(named)].sort(),
      );
      for (const m of c.Mounts) {
        if (Object.hasOwn(binds, m.Destination))
          ensure(m.Type === "bind" && m.Source === binds[m.Destination] && !m.RW);
        else if (Object.hasOwn(writableBinds, m.Destination))
          ensure(m.Type === "bind" && m.Source === writableBinds[m.Destination] && m.RW);
        else ensure(m.Type === "volume" && m.Name === named[m.Destination] && m.RW);
      }
      if (service === "postgres") ensure(c.Config.User === "70:70");
      owned.push({ container: c, service, active });
    }
    if (config.RELEASE_CATALOG_CACHE_DIR)
      assertExclusiveCatalogMounts(
        containers,
        owned.find((c) => c.service === "api")?.container.Id,
      );
    ensure(owned.filter((c) => c.service === "postgres").length === 1);
    for (const n of Object.values(networks))
      for (const id of Object.keys(n.Containers ?? {}))
        ensure(owned.some((c) => c.container.Id === id));
    return {
      owned,
      networks,
      volume,
      config,
      containerNames: containers.map((container) => ({ id: container.Id, name: container.Name })),
    };
  }
  return {
    command,
    inventory: (context) => guarded(() => inventory(context)),
    verifyImages: (context) =>
      guarded(async () => {
        for (const name of ["api", "edge"]) {
          const image = operation.identity.admission.registry[name];
          await inspectImage(image.reference, image.imageId);
        }
        const config = await readProtectedEnv(context.configuration.runtimeSnapshot.path);
        await inspectImage(
          `postgres:17-alpine@${config.MARKIRO_POSTGRES_IMAGE_DIGEST}`,
          policy.postgresImageId,
        );
      }),
    inspectStoppedWorkloads: (context) =>
      guarded(async () => {
        const state = await inventory(context);
        ensure(!state.owned.some((c) => c.active && c.service !== "postgres"));
        return { project, target: plain(operation.identity.target), active: [] };
      }),
    inspectMigration: (context) =>
      guarded(async () => {
        const state = await inventory(context);
        const match = state.owned.find((c) => c.service === "migrate");
        if (match) ensure(match.container.State.Status === "exited" && !match.active);
        return {
          name: context.migration.name,
          ownerOperationId: operation.identity.operationId,
          containerId: match?.container.Id ?? null,
          status: match ? "exited" : "absent",
        };
      }),
    stopMigration: (context) =>
      guarded(async () => {
        const state = await inventory(context);
        const match = state.owned.find((c) => c.service === "migrate");
        if (match?.active)
          await command(["container", "stop", "--time", "10", match.container.Id], true);
      }),
  };
}

export async function verifyBindBytes(path, expectedSha256) {
  return guarded(async () => {
    assertBindFileSync(path);
    ensure(digest(await readFile(path)) === expectedSha256);
  });
}
