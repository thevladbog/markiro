import { join } from "node:path";
import { canonical, ensure, hash, keys, plain } from "../backup/schemas.mjs";
import { catalogComposeFiles, catalogMountBindings } from "../catalog-config.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { fingerprintHostConfiguration, hostChildEnvironment } from "./config.mjs";
import { containerRecipe } from "./container-recipe.mjs";
import { guarded, validateObservationPolicy } from "./observe.mjs";
import { runHostProcess } from "./process.mjs";
import { validateIdentity } from "./state-validation.mjs";

const project = "markiro-platform";
const services = ["api", "edge"];
const same = (a, b) => ensure(canonical(a) === canonical(b));
const apiHealth = {
  Test: ["CMD", "node", "/opt/markiro/healthcheck.mjs"],
  Interval: 10000000000,
  Timeout: 3000000000,
  Retries: 12,
  StartPeriod: 20000000000,
};

function inspectEnvironment(entries) {
  ensure(Array.isArray(entries));
  const result = Object.create(null);
  for (const entry of entries) {
    const i = typeof entry === "string" ? entry.indexOf("=") : -1;
    ensure(i > 0 && !Object.hasOwn(result, entry.slice(0, i)));
    result[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return result;
}

function verifyMounts(container, service, runtime) {
  const bind = (source, RW) => ({ Type: "bind", Source: source, RW });
  const volume = (name) => ({ Type: "volume", Name: `${project}_caddy-${name}`, RW: true });
  const expected =
    service === "api"
      ? {
          "/run/markiro-postgres/ca.crt": bind(runtime.MARKIRO_POSTGRES_CA_FILE, false),
          ...Object.fromEntries(
            Object.entries(catalogMountBindings(runtime, service)).map(([target, source]) => [
              target,
              bind(source, true),
            ]),
          ),
        }
      : { "/data": volume("data"), "/config": volume("config") };
  const mounts = container.Mounts;
  ensure(Array.isArray(mounts) && mounts.length === Object.keys(expected).length);
  same(mounts.map(({ Destination }) => Destination).sort(), Object.keys(expected).sort());
  for (const mount of mounts)
    for (const [key, value] of Object.entries(expected[mount.Destination]))
      ensure(mount[key] === value);
}

function verifyRecipe(container, service, spec, runtime, image, policy) {
  const { Config: config, HostConfig: host, State: state } = container;
  ensure(
    state.Running === true &&
      state.Status === "running" &&
      ["Paused", "Restarting", "Dead", "OOMKilled"].every((key) => state[key] === false) &&
      (service === "edge" || state.Health?.Status === "healthy"),
  );
  same(inspectEnvironment(config.Env), {
    ...inspectEnvironment(image.Config.Env ?? []),
    ...spec.environment,
  });
  for (const field of ["Entrypoint", "Cmd", "WorkingDir"])
    same(config[field] ?? null, image.Config[field] ?? null);
  ensure(config.User === (service === "api" ? image.Config.User : "10001:10001"));
  if (service === "api") {
    for (const [key, value] of Object.entries(apiHealth)) same(config.Healthcheck?.[key], value);
    ensure(!config.Healthcheck.StartInterval);
  } else same(config.Healthcheck ?? null, image.Config.Healthcheck ?? null);
  ensure(host.Privileged === false && host.ReadonlyRootfs === true && !host.PublishAllPorts);
  same(host.CapDrop, ["ALL"]);
  same(host.SecurityOpt, ["no-new-privileges:true"]);
  for (const key of [
    "CapAdd",
    "Devices",
    "DeviceCgroupRules",
    "DeviceRequests",
    "ExtraHosts",
    "Links",
    "VolumesFrom",
  ])
    same(host[key] ?? [], []);
  for (const key of ["IpcMode", "PidMode", "UTSMode", "UsernsMode"])
    ensure(!/^(?:host|container(?::|$))/u.test(host[key] ?? ""));
  same(host.RestartPolicy, { Name: "unless-stopped", MaximumRetryCount: 0 });
  same(host.Tmpfs, { "/tmp": "rw,noexec,nosuid,size=64m" });
  same(host.LogConfig, { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } });
  const limits = service === "api" ? [1610612736, 1250000000] : [201326592, 250000000];
  same([host.Memory, host.NanoCpus], limits);
  const ports =
    service === "api"
      ? {}
      : {
          "8080/tcp": [{ HostIp: "", HostPort: "80" }],
          "8443/tcp": [{ HostIp: "", HostPort: "443" }],
        };
  same(host.PortBindings ?? {}, ports);

  const networks = (service === "api" ? ["database", "default"] : ["default"]).map(
    (name) => policy.networks[name],
  );
  const connection = container.NetworkSettings.Networks;
  keys(
    connection,
    networks.map(({ name }) => name),
  );
  ensure(networks.some(({ name }) => host.NetworkMode === name));
  for (const { name, id } of networks) ensure(connection[name].NetworkID === id);
  verifyMounts(container, service, runtime);
}

export function createHealthyForwardCandidateObserver(input, policyInput, hashInput, dependencies) {
  return guarded(async () => {
    const operation = plain(input);
    keys(operation, ["root", "dockerConfig", "identity", "configuration"]);
    const { root, dockerConfig, identity, configuration } = operation;
    validateIdentity(identity);
    ensure(dockerConfig === join(root, "docker"));
    keys(configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]);
    ensure(configuration.candidateId === identity.operationId);
    const policy = validateObservationPolicy(policyInput);
    ensure(
      policy.machineId === identity.target.hostId &&
        policy.volume.name === identity.target.volumeId,
    );
    const composeHashes = plain(hashInput);
    keys(composeHashes, services);
    ensure(Object.values(composeHashes).every(hash));
    const { verifyAuthority, runProcess = runHostProcess, ambient } = dependencies;
    ensure(typeof verifyAuthority === "function" && typeof runProcess === "function");
    const { runtimeSnapshot, migrationSnapshot } = configuration;
    const verify = async () => {
      await verifyAuthority();
      ensure(
        (await fingerprintHostConfiguration({ root, ...configuration })).configurationSha256 ===
          identity.configurationSha256,
      );
    };
    await verify();
    const runtime = await readProtectedEnv(runtimeSnapshot.path);
    await verify();
    const interpolation = {
      ...runtimeSnapshot.interpolation,
      MARKIRO_PLATFORM_MIGRATION_ENV_FILE: migrationSnapshot.path,
    };
    for (const [name, value] of Object.entries(runtimeSnapshot.interpolation))
      ensure(
        value === (name === "MARKIRO_PLATFORM_ENV_FILE" ? runtimeSnapshot.path : runtime[name]),
      );
    const environment = Object.freeze(
      hostChildEnvironment({ interpolation, dockerConfig, ambient }),
    );
    const docker = ["--host", "unix:///var/run/docker.sock"];
    const compose = [
      "compose",
      "--project-name",
      project,
      ...catalogComposeFiles(runtime).flatMap((file) => ["--file", file]),
    ];
    const command = async (...args) => {
      await verify();
      const { stdout } = await runProcess({
        executable: "/usr/bin/docker",
        args: [...docker, ...args],
        cwd: root,
        env: environment,
        timeoutMs: 60000,
        outputLimitBytes: 1048576,
      });
      await verify();
      return String(stdout);
    };
    const render = async () => {
      const config = JSON.parse(await command(...compose, "config", "--format", "json"));
      ensure(config.name === project);
      for (const service of services) {
        const spec = config.services[service];
        ensure(spec.image === identity.admission.registry[service].reference);
        ensure(spec.environment?.SERVER_PROFILE === "platform-only");
        if (service === "api") {
          for (const key of [
            "DATABASE_URL",
            "MARKIRO_SOURCE_SHA",
            "RELEASE_CATALOG_PUBLISHERS_JSON",
          ])
            ensure(spec.environment[key] === runtime[key]);
        } else ensure(spec.environment.MARKIRO_RELEASE_SHA === runtime.MARKIRO_SOURCE_SHA);
        const output = (await command(...compose, "config", "--hash", service)).trim();
        ensure(output === `${service} ${composeHashes[service]}`);
      }
      return config.services;
    };
    const one = async (kind, value) => {
      const rows = JSON.parse(await command(kind, "inspect", value));
      ensure(Array.isArray(rows) && rows.length === 1);
      return rows[0];
    };
    const observe = (service, id) =>
      guarded(async () => {
        ensure(services.includes(service) && hash(id));
        const spec = (await render())[service];
        const approved = identity.admission.registry[service];
        const image = await one("image", approved.reference);
        ensure(
          image.Id === approved.imageId &&
            image.Os === "linux" &&
            image.Architecture === "amd64" &&
            Array.isArray(image.RepoDigests) &&
            image.RepoDigests.includes(approved.reference),
        );
        const container = await one("container", id);
        ensure(
          container.Id === id &&
            container.Name === `/${project}-${service}-1` &&
            container.Image === approved.imageId &&
            container.Config.Image === approved.reference,
        );
        const labels = container.Config.Labels;
        for (const [key, value] of Object.entries({
          project,
          service,
          oneoff: "False",
          "container-number": "1",
          "config-hash": composeHashes[service],
          image: approved.imageId,
        }))
          ensure(labels[`com.docker.compose.${key}`] === value);
        verifyRecipe(container, service, spec, runtime, image, policy);
        return Object.freeze({
          id,
          imageId: approved.imageId,
          recipeSha256: containerRecipe(container),
        });
      });
    return Object.freeze({
      composePrefix: Object.freeze([...docker, ...compose]),
      environment,
      async verifyCompose() {
        await guarded(render);
      },
      observe,
    });
  });
}
