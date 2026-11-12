import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { canonical, ensure, hash, keys, plain } from "../backup/schemas.mjs";
import { validateConfigurationContainer } from "./configuration-plan.mjs";
import { guarded } from "./observe.mjs";
import { runHostProcess } from "./process.mjs";

const project = "markiro-platform";
const docker = ["--host", "unix:///var/run/docker.sock"];
const services = ["api", "edge", "postgres"];
const same = (a, b) => ensure(canonical(a) === canonical(b));

function approvedComposePrefix(value) {
  const prefix = plain(value);
  ensure(Array.isArray(prefix) && [9, 11].includes(prefix.length));
  same(prefix.slice(0, 5), [...docker, "compose", "--project-name", project]);
  const directory = dirname(prefix[6]);
  ensure(isAbsolute(directory) && directory === normalize(directory));
  ensure(basename(directory) === "platform" && basename(dirname(directory)) === "deploy");
  const files = ["compose.yml", "compose.compact.yml"];
  if (prefix.length === 11) files.push("compose.catalog.yml");
  same(
    prefix.slice(5),
    files.flatMap((file) => ["--file", join(directory, file)]),
  );
  return prefix;
}

// Constructed only by the installed runtime. Its callers must hold the
// operation lock and provide the full observation and durable mutation guard.
export function createHealthyForwardWorkloads(input, dependencies) {
  const operation = plain(input);
  keys(operation, ["root", "dockerConfig", "sourceContainers"]);
  const { root, dockerConfig, sourceContainers } = operation;
  ensure(isAbsolute(root) && normalize(root) === root && dockerConfig === join(root, "docker"));
  keys(sourceContainers, services);
  const sourceIds = new Set();
  for (const item of Object.values(sourceContainers)) {
    validateConfigurationContainer(item);
    sourceIds.add(item.id);
  }
  ensure(sourceIds.size === services.length);
  const {
    candidate,
    observe,
    verifyAuthority,
    verifyMutation,
    runProcess = runHostProcess,
  } = dependencies;
  for (const method of [
    observe,
    verifyAuthority,
    verifyMutation,
    candidate.verifyCompose,
    candidate.observe,
    runProcess,
  ])
    ensure(typeof method === "function");
  const composePrefix = approvedComposePrefix(candidate.composePrefix);
  const composeEnvironment = plain(candidate.environment);
  ensure(
    composeEnvironment.DOCKER_CONFIG === dockerConfig &&
      composeEnvironment.COMPOSE_DISABLE_ENV_FILE === "1",
  );
  const shellEnvironment = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    DOCKER_CONFIG: dockerConfig,
  };
  let phase = "source-healthy";
  let failed = false;
  let active = false;
  const replacements = {};
  const only = (expected, action) =>
    guarded(async () => {
      ensure(!failed && !active && phase === expected);
      active = true;
      try {
        return await action();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        active = false;
      }
    });
  const inspect = async (expected) => {
    await verifyAuthority();
    const candidateContainers = plain(replacements);
    const result = await observe({
      phase: expected,
      ...(Object.keys(candidateContainers).length ? { candidateContainers } : {}),
    });
    same(result.containers, { ...sourceContainers, ...replacements });
    await verifyAuthority();
  };
  const command = async ({ args, env, timeoutMs, entered }) => {
    await verifyAuthority();
    if (entered) await verifyMutation(entered);
    const result = await runProcess({
      executable: "/usr/bin/docker",
      args,
      cwd: root,
      env,
      timeoutMs,
      outputLimitBytes: 65536,
    });
    await verifyAuthority();
    return result;
  };
  const stop = (service) =>
    command({
      args: [...docker, "container", "stop", "--time", "30", sourceContainers[service].id],
      env: shellEnvironment,
      timeoutMs: 60000,
      entered: "source-stop-entered",
    });
  const start = async (service) => {
    await candidate.verifyCompose();
    await inspect(phase);
    await command({
      args: [
        ...composePrefix,
        "up",
        "-d",
        ...(service === "api" ? ["--wait"] : []),
        "--no-deps",
        service,
      ],
      env: composeEnvironment,
      timeoutMs: 300000,
      entered: `${service}-entered`,
    });
    const { stdout } = await command({
      args: [
        ...docker,
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ],
      env: shellEnvironment,
      timeoutMs: 60000,
    });
    const id = String(stdout).trim();
    ensure(hash(id) && !sourceIds.has(id) && replacements.api?.id !== id);
    const descriptor = validateConfigurationContainer(plain(await candidate.observe(service, id)));
    ensure(descriptor.id === id);
    replacements[service] = descriptor;
    const next = `${service}-started`;
    await inspect(next);
    phase = next;
    return id;
  };
  return Object.freeze({
    stopSource: () =>
      only("source-healthy", async () => {
        await candidate.verifyCompose();
        await inspect("source-healthy");
        await stop("edge");
        await inspect("source-edge-stopped");
        await stop("api");
        await inspect("source-stopped");
        phase = "source-stopped";
      }),
    verifySourceStopped: () => only("source-stopped", () => inspect("source-stopped")),
    activateApi: () => only("source-stopped", () => start("api")),
    activateEdge: (apiId) =>
      only("api-started", async () => {
        ensure(apiId === replacements.api.id);
        return start("edge");
      }),
    verifyWorkloads: (expected) =>
      only("edge-started", async () => {
        const ids = {
          api: replacements.api.id,
          edge: replacements.edge.id,
          postgres: sourceContainers.postgres.id,
        };
        same(ids, expected);
        await inspect("edge-started");
        return Object.freeze(ids);
      }),
  });
}
