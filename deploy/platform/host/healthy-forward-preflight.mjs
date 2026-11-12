import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonical, digest, ensure, hash, keys, plain } from "../backup/schemas.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { validateConfigurationContainer } from "./configuration-plan.mjs";
import { containerRecipe } from "./container-recipe.mjs";
import { carryHostFailure } from "./failure-diagnostic.mjs";
import { assertPrivateRootSync, readPrivateFile } from "./files.mjs";
import { validateForwardDecision } from "./forward-admission.mjs";
import {
  forwardImmediatePredecessor,
  readForwardHistory,
  validateForwardHistory,
} from "./forward-history.mjs";
import {
  observeForwardMigrationLedger,
  validateProductMigrationLedger,
} from "./forward-ledger.mjs";
import { forwardPhaseReceipt, validateForwardJournal } from "./forward-state.mjs";
import { validateHealthyForwardPublisherDelta } from "./healthy-forward-publisher-policy.mjs";
import { createDockerCommand, validateObservationPolicy } from "./observe.mjs";
import { historicalOperationNow } from "./operation-authority.mjs";
import { runHostProcess } from "./process.mjs";
import { validateIdentity } from "./state-validation.mjs";
import { validateUpgradeSchema } from "./upgrade-proofs.mjs";

const project = "markiro-platform";
const services = ["api", "edge", "postgres"];
const serviceNetworks = { api: ["default", "database"], edge: ["default"], postgres: ["database"] };
const serviceImages = {
  api: ["ghcr.io/thevladbog/markiro-api", "MARKIRO_API_IMAGE_DIGEST"],
  edge: ["ghcr.io/thevladbog/markiro-platform-edge", "MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST"],
  postgres: ["postgres:17-alpine", "MARKIRO_POSTGRES_IMAGE_DIGEST"],
};
const workloadPhases = {
  "source-healthy": { running: services, replacements: [] },
  "source-edge-stopped": { running: ["api", "postgres"], replacements: [] },
  "source-stopped": { running: ["postgres"], replacements: [] },
  "api-started": { running: ["api", "postgres"], replacements: ["api"] },
  "edge-started": { running: services, replacements: ["api", "edge"] },
};
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const same = (a, b) => ensure(canonical(a) === canonical(b));

async function requireAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  ensure(false);
}

async function readHealthyPredecessor(root, expected, proof, readPinned) {
  const directory = `forward-recovery-operations/${expected.operationId}`;
  const read = (file, expectedSha256) => readPinned(root, `${directory}/${file}`, expectedSha256);
  const index = JSON.parse(await readPinned(root, "upgrade-index.json", expected.indexSha256));
  const beforeBytes = await read(
    "before-post-migration-activate.json",
    expected.beforeActivationSha256,
  );
  const before = validateForwardJournal(JSON.parse(beforeBytes));
  const state = validateForwardJournal(
    JSON.parse(await read("state.json", expected.stateSha256)),
    before,
  );
  const { admission, decision } = state;
  ensure(
    state.sequence === 14 &&
      state.phase === "healthy" &&
      state.status === "completed" &&
      admission.identity.operationId === expected.operationId,
  );
  same(index, {
    version: 1,
    kind: "platform-forward-recovery-index",
    operationId: expected.operationId,
    stateSha256: expected.stateSha256,
    predecessorIndexSha256: forwardImmediatePredecessor(admission).hashes.index,
    admissionSha256: digest(Buffer.from(`${JSON.stringify(admission)}\n`)),
  });
  validateForwardDecision(decision, {
    priorBytes: beforeBytes,
    prior: before,
    now: historicalOperationNow(decision),
  });
  for (const [phase, value, expectedSha256] of [
    ["prepare", admission, expected.prepareConsumptionSha256],
    ["activate", decision, expected.activateConsumptionSha256],
  ]) {
    const consumed = await read(`${phase}-consumption.json`, expectedSha256);
    ensure(consumed.equals(Buffer.from(`${JSON.stringify(forwardPhaseReceipt(value))}\n`)));
  }
  validateForwardHistory(
    admission,
    await readForwardHistory(root, admission, { ownIndexArchive: true }),
    {
      productMigrationProof: proof,
      now: historicalOperationNow(admission),
    },
  );
  return admission;
}

function readContainerEnv(container) {
  ensure(Array.isArray(container.Config.Env));
  const environment = Object.create(null);
  for (const entry of container.Config.Env) {
    const index = typeof entry === "string" ? entry.indexOf("=") : -1;
    ensure(index > 0);
    const name = entry.slice(0, index);
    ensure(!Object.hasOwn(environment, name));
    environment[name] = entry.slice(index + 1);
  }
  return environment;
}

function workloadPlan(runtime, workload, candidateIdentity) {
  const value = plain(workload);
  ensure(typeof value?.phase === "string" && Object.hasOwn(workloadPhases, value.phase));
  const { running, replacements } = workloadPhases[value.phase];
  const containers = { ...runtime.containers };
  keys(value, ["phase", ...(replacements.length ? ["candidateContainers"] : [])]);
  if (replacements.length) {
    keys(value.candidateContainers, replacements);
    const sourceIds = new Set(Object.values(runtime.containers).map(({ id }) => id));
    for (const service of replacements) {
      const candidate = validateConfigurationContainer(value.candidateContainers[service]);
      ensure(
        candidate.imageId === candidateIdentity.admission.registry[service].imageId &&
          !sourceIds.has(candidate.id),
      );
      containers[service] = candidate;
    }
    ensure(new Set(Object.values(containers).map(({ id }) => id)).size === services.length);
  }
  return { running, replacements, containers };
}

async function observeRuntime(
  command,
  readMachineId,
  policy,
  plan,
  sourceEnvironment,
  candidateEnvironment,
) {
  const json = async (...args) => JSON.parse(String((await command(args)).stdout));
  const info = await json("info", "--format", "{{json .}}");
  ensure(
    info.ID === policy.dockerId &&
      info.OSType === "linux" &&
      ["amd64", "x86_64"].includes(info.Architecture),
  );
  ensure(String(await readMachineId()).trim() === policy.machineId);
  const volumes = await json("volume", "inspect", policy.volume.name);
  ensure(Array.isArray(volumes) && volumes.length === 1);
  const [volume] = volumes;
  same(
    { name: volume.Name, createdAt: volume.CreatedAt, mountpoint: volume.Mountpoint },
    policy.volume,
  );
  ensure(
    volume.Driver === "local" &&
      volume.Labels?.["com.docker.compose.project"] === project &&
      volume.Labels?.["com.docker.compose.volume"] === "postgres-data",
  );
  same(volume.Options ?? {}, {});
  const networks = await json(
    "network",
    "inspect",
    policy.networks.default.id,
    policy.networks.database.id,
  );
  ensure(Array.isArray(networks) && networks.length === 2);
  for (const [name, expected] of Object.entries(policy.networks)) {
    const network = networks.find((row) => row.Id === expected.id);
    ensure(
      network &&
        network.Name === expected.name &&
        network.Driver === "bridge" &&
        network.Scope === "local" &&
        network.Internal === (name === "database") &&
        network.Attachable === false &&
        network.Ingress === false &&
        network.Labels?.["com.docker.compose.project"] === project &&
        network.Labels?.["com.docker.compose.network"] === name,
    );
  }

  const ids = String(
    (
      await command([
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    ).stdout,
  )
    .trim()
    .split(/\s+/u);
  ensure(ids.length === services.length && ids.every(hash) && new Set(ids).size === ids.length);
  const rows = await json("container", "inspect", ...ids);
  ensure(
    Array.isArray(rows) &&
      rows.length === ids.length &&
      new Set(rows.map((row) => row.Id)).size === ids.length &&
      rows.every((row) => ids.includes(row.Id)),
  );
  return services.map((service) => {
    const expected = plan.containers[service];
    const environment = plan.replacements.includes(service)
      ? candidateEnvironment
      : sourceEnvironment;
    const [image, digestKey] = serviceImages[service];
    const container = rows.find((row) => row.Id === expected.id);
    ensure(
      container &&
        container.Config.Labels["com.docker.compose.project"] === project &&
        container.Config.Labels["com.docker.compose.service"] === service &&
        container.Config.Image === `${image}@${environment[digestKey]}` &&
        container.Image === expected.imageId &&
        containerRecipe(container) === expected.recipeSha256,
    );
    const state = container.State;
    const active = plan.running.includes(service);
    ensure(
      state?.Running === active &&
        state.Status === (active ? "running" : "exited") &&
        state.Paused === false &&
        state.Restarting === false &&
        state.Dead === false &&
        (!active || service === "edge" || state.Health?.Status === "healthy"),
    );
    const connections = container.NetworkSettings.Networks;
    const expectedNetworks = serviceNetworks[service].map((name) => policy.networks[name]);
    keys(
      connections,
      expectedNetworks.map(({ name }) => name),
    );
    for (const network of expectedNetworks)
      ensure(connections[network.name].NetworkID === network.id);
    if (service === "postgres") {
      ensure(
        container.Mounts.some(
          (mount) =>
            mount.Type === "volume" &&
            mount.Name === volume.Name &&
            mount.Source === volume.Mountpoint &&
            mount.Destination === "/var/lib/postgresql/data",
        ),
      );
    } else {
      const actual = readContainerEnv(container);
      if (service === "edge") ensure(actual.MARKIRO_RELEASE_SHA === environment.MARKIRO_SOURCE_SHA);
      else {
        for (const [key, value] of Object.entries(environment)) ensure(actual[key] === value);
      }
    }
    return { service, container, active };
  });
}

/**
 * Read-only verification for a coordinator holding the shared host lock.
 * The coordinator owns release provenance and the full candidate configuration
 * fingerprint, catalog peer and mount fencing, and verified backup and restore.
 * Project inventory here establishes the three runtime identities only.
 */
export function verifyHealthyForwardPreflight(
  input,
  dependencies,
  workload = { phase: "source-healthy" },
) {
  return preflight(input, dependencies, workload);
}

// The stopped-source verifier shares its private inventory only with the
// installed backup producer. Its public result remains the sanitized evidence.
export function withStoppedHealthyForwardSource(input, dependencies, inspect) {
  ensure(typeof inspect === "function");
  return preflight(input, dependencies, { phase: "source-stopped" }, inspect);
}

async function preflight(input, dependencies, workload, inspect) {
  try {
    keys(input, [
      "root",
      "predecessor",
      "drift",
      "runtime",
      "candidateRuntime",
      "pinnedPublisherConfig",
      "candidateIdentity",
      "predecessorMigrationProof",
      "candidateMigrationProof",
    ]);
    const { predecessorMigrationProof, candidateMigrationProof, ...metadata } = input;
    const {
      root,
      predecessor,
      drift,
      runtime,
      candidateRuntime,
      pinnedPublisherConfig,
      candidateIdentity,
    } = plain(metadata);
    const {
      verifyAuthority,
      runProcess = runHostProcess,
      readMachineId = () => readFile("/etc/machine-id", "utf8"),
    } = dependencies;
    ensure(
      typeof verifyAuthority === "function" &&
        typeof runProcess === "function" &&
        typeof readMachineId === "function",
    );
    const host = dirname(root);
    assertPrivateRootSync(root);
    assertPrivateRootSync(host);
    keys(predecessor, [
      "operationId",
      "indexSha256",
      "stateSha256",
      "beforeActivationSha256",
      "prepareConsumptionSha256",
      "activateConsumptionSha256",
    ]);
    ensure(uuid(predecessor.operationId));
    keys(drift, ["receiptPath", "receiptSha256"]);
    ensure(
      typeof drift.receiptPath === "string" &&
        /^manual-configurations\/[A-Za-z0-9_-]+\/result\.json$/u.test(drift.receiptPath),
    );
    keys(runtime, ["path", "sha256", "containers", "observationPolicy", "schema"]);
    keys(candidateRuntime, ["path", "sha256"]);
    ensure(
      typeof candidateRuntime.path === "string" &&
        candidateRuntime.path.startsWith(`${basename(root)}/`) &&
        candidateRuntime.path !== runtime.path,
    );
    keys(runtime.containers, services);
    for (const descriptor of Object.values(runtime.containers))
      validateConfigurationContainer(descriptor);
    ensure(new Set(Object.values(runtime.containers).map(({ id }) => id)).size === services.length);
    validateIdentity(candidateIdentity);
    const plan = workloadPlan(runtime, workload, candidateIdentity);
    validateUpgradeSchema(runtime.schema, candidateIdentity);
    const policy = validateObservationPolicy(runtime.observationPolicy);
    ensure(
      policy.machineId === candidateIdentity.target.hostId &&
        policy.volume.name === candidateIdentity.target.volumeId &&
        policy.postgresImageId === runtime.containers.postgres.imageId,
    );
    ensure(
      candidateMigrationProof.productSha === candidateIdentity.admission.manifest.sourceSha &&
        candidateMigrationProof.imageReference === candidateIdentity.admission.manifest.api &&
        candidateMigrationProof.imageId === candidateIdentity.admission.registry.api.imageId,
    );
    validateProductMigrationLedger(
      candidateMigrationProof.entries.map(({ hash, createdAt }) => ({ hash, createdAt })),
      candidateMigrationProof,
    );

    const pins = new Map();
    const readPinned = async (directory, path, expectedSha256) => {
      ensure(hash(expectedSha256));
      const bytes = await readPrivateFile(directory, path);
      ensure(digest(bytes) === expectedSha256);
      pins.set(join(directory, path), { directory, path, expectedSha256 });
      return bytes;
    };
    const verifyUncontested = async () => {
      await verifyAuthority();
      await requireAbsent(join(root, "config-index.json"));
      await requireAbsent(join(root, "config-pending.json"));
    };
    await verifyUncontested();
    const admission = await readHealthyPredecessor(
      root,
      predecessor,
      predecessorMigrationProof,
      readPinned,
    );
    same(admission.identity.target, candidateIdentity.target);
    ensure(
      candidateIdentity.operationId !== admission.identity.operationId &&
        runtime.containers.postgres.id === admission.baseline.containers.postgres,
    );

    const receipt = JSON.parse(await readPinned(host, drift.receiptPath, drift.receiptSha256));
    ensure(
      receipt.runtimePath === join(host, runtime.path) && receipt.runtimeSha256 === runtime.sha256,
    );
    for (const service of services) {
      const recorded = service === "api" ? receipt.api : receipt.preserved[service];
      ensure(
        recorded.id === runtime.containers[service].id &&
          recorded.image === runtime.containers[service].imageId,
      );
    }
    await readPinned(host, runtime.path, runtime.sha256);
    const environment = await readProtectedEnv(receipt.runtimePath);
    await readPinned(host, candidateRuntime.path, candidateRuntime.sha256);
    const candidateEnvironment = await readProtectedEnv(join(host, candidateRuntime.path));
    validateHealthyForwardPublisherDelta(
      environment,
      candidateEnvironment,
      candidateIdentity.admission.manifest,
      pinnedPublisherConfig,
    );
    ensure(sha(environment.MARKIRO_SOURCE_SHA) && sha(environment.MARKIRO_TOOLING_SHA));
    for (const key of [
      "MARKIRO_API_IMAGE_DIGEST",
      "MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST",
      "MARKIRO_POSTGRES_IMAGE_DIGEST",
    ]) {
      ensure(
        typeof environment[key] === "string" && /^sha256:[a-f0-9]{64}$/u.test(environment[key]),
      );
    }
    const guardedRun = async (request) => {
      await verifyUncontested();
      const result = await runProcess(request);
      await verifyUncontested();
      return result;
    };
    const command = createDockerCommand({ root, dockerConfig: join(root, "docker") }, guardedRun);
    const observe = () =>
      observeRuntime(command, readMachineId, policy, plan, environment, candidateEnvironment);
    const owned = await observe();
    const ledger = await observeForwardMigrationLedger({
      postgresId: runtime.containers.postgres.id,
      proof: candidateMigrationProof,
      root,
      runProcess: guardedRun,
    });
    same(ledger.schema, runtime.schema);
    if (inspect) await inspect({ owned, config: Object.freeze({ ...environment }) });
    await observe();
    await readHealthyPredecessor(root, predecessor, predecessorMigrationProof, readPinned);
    for (const { directory, path, expectedSha256 } of pins.values())
      await readPinned(directory, path, expectedSha256);
    await verifyUncontested();
    return Object.freeze({
      predecessorOperationId: predecessor.operationId,
      sourceSha: environment.MARKIRO_SOURCE_SHA,
      containers: Object.freeze(
        Object.fromEntries(
          Object.entries(plan.containers).map(([name, value]) => [name, Object.freeze(value)]),
        ),
      ),
      schema: ledger.schema,
      productMigrationProofSha256: ledger.productProofSha256,
    });
  } catch (cause) {
    const error = new Error("Healthy forward application rollout preflight refused.");
    error.code = "ERR_HEALTHY_FORWARD_PREFLIGHT";
    throw carryHostFailure(cause, error);
  }
}
