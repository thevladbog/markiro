import { basename, dirname, join } from "node:path";
import { canonical, digest, ensure, hash, keys } from "../backup/schemas.mjs";
import { canonicalId } from "../release-admission.mjs";
import { validateUpgradeAuthorization, validateUpgradeDispatch } from "../upgrade-dispatch.mjs";
import { interpolationKeys } from "./config.mjs";
import {
  validateConfigurationContainer,
  validateConfigurationRuntime,
} from "./configuration-plan.mjs";
import { validateForwardDecision } from "./forward-admission.mjs";
import { forwardImmediatePredecessor } from "./forward-history.mjs";
import { forwardPhaseReceipt, validateForwardJournal } from "./forward-state.mjs";
import { validateObservationPolicy } from "./observe.mjs";
import { historicalOperationNow, validateOperationAuthority } from "./operation-authority.mjs";
import { sameTarget, validateIdentity } from "./state-validation.mjs";
import { validateUpgradeSchema } from "./upgrade-proofs.mjs";

const healthyIndexKind = "platform-healthy-forward-rollout-index";
const recoveryIndexKind = "platform-forward-recovery-index";
const predecessorPins = ["operationId", "indexSha256", "stateSha256"];
const services = ["api", "edge", "postgres"];
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const same = (a, b) => ensure(canonical(a) === canonical(b));
const document = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

function parseDocument(bytes) {
  const value = JSON.parse(bytes);
  ensure(bytes.equals(document(value)));
  return value;
}

export const isHealthyRolloutPredecessor = (predecessor) => predecessor?.kind === healthyIndexKind;

function validateHealthyPins(predecessor) {
  keys(predecessor, ["kind", ...predecessorPins]);
  ensure(
    isHealthyRolloutPredecessor(predecessor) &&
      uuid(predecessor.operationId) &&
      hash(predecessor.indexSha256) &&
      hash(predecessor.stateSha256),
  );
}

async function readRecoveryAnchor(root, index, predecessor, identity, runtime, readPinned) {
  keys(predecessor, [
    ...predecessorPins,
    "beforeActivationSha256",
    "prepareConsumptionSha256",
    "activateConsumptionSha256",
  ]);
  const read = (file, sha256) =>
    readPinned(root, `forward-recovery-operations/${index.operationId}/${file}`, sha256);
  const beforeBytes = await read(
    "before-post-migration-activate.json",
    predecessor.beforeActivationSha256,
  );
  const before = validateForwardJournal(parseDocument(beforeBytes));
  const state = validateForwardJournal(
    parseDocument(await read("state.json", predecessor.stateSha256)),
    before,
  );
  const { admission, decision } = state;
  ensure(
    state.phase === "healthy" &&
      state.status === "completed" &&
      state.sequence === 14 &&
      admission.identity.operationId === index.operationId &&
      sameTarget(admission.identity.target, identity.target) &&
      admission.baseline.containers.postgres === runtime.containers.postgres.id,
  );
  same(index, {
    version: 1,
    kind: recoveryIndexKind,
    operationId: predecessor.operationId,
    stateSha256: predecessor.stateSha256,
    predecessorIndexSha256: forwardImmediatePredecessor(admission).hashes.index,
    admissionSha256: digest(document(admission)),
  });
  validateForwardDecision(decision, {
    priorBytes: beforeBytes,
    prior: before,
    now: historicalOperationNow(decision),
  });
  for (const [phase, value, sha256] of [
    ["prepare", admission, predecessor.prepareConsumptionSha256],
    ["activate", decision, predecessor.activateConsumptionSha256],
  ]) {
    const receipt = await read(`${phase}-consumption.json`, sha256);
    ensure(receipt.equals(document(forwardPhaseReceipt(value))));
  }
  return index.operationId;
}

async function readHealthyStep(root, index, predecessor, runtime, target, readPinned) {
  validateHealthyPins(predecessor);
  keys(index, ["version", "kind", "operationId", "stateSha256", "predecessorIndexSha256"]);
  ensure(index.version === 1 && hash(index.predecessorIndexSha256));
  const directory = `healthy-forward-rollouts/${index.operationId}`;
  const state = parseDocument(await readPinned(root, `${directory}/state.json`, index.stateSha256));
  keys(state, [
    "version",
    "kind",
    "operationId",
    "operationSha256",
    "predecessorOperationId",
    "predecessorIndexSha256",
    "phase",
    "sequence",
    "backupProofSha256",
    ...services,
  ]);
  ensure(
    state.version === 1 &&
      state.kind === "platform-healthy-forward-rollout-state" &&
      state.operationId === index.operationId &&
      state.phase === "healthy" &&
      state.sequence === 9 &&
      uuid(state.predecessorOperationId) &&
      state.predecessorIndexSha256 === index.predecessorIndexSha256 &&
      hash(state.backupProofSha256) &&
      new Set(services.map((service) => state[service])).size === services.length,
  );
  keys(runtime, ["path", "sha256", "containers", "observationPolicy", "schema"]);
  keys(runtime.containers, services);
  for (const service of services) {
    const descriptor = validateConfigurationContainer(runtime.containers[service]);
    ensure(descriptor.id === state[service]);
  }

  const host = dirname(root);
  // The state pins the original operation bytes, whose JSON may use any whitespace.
  const record = JSON.parse(
    await readPinned(
      host,
      `upgrade-operations/${index.operationId}/healthy-forward-rollout/operation.json`,
      state.operationSha256,
    ),
  );
  keys(record, [
    "version",
    "kind",
    "phase",
    "installedRoot",
    "dispatch",
    "authorization",
    "operation",
    "observationPolicy",
  ]);
  const { operation } = record;
  const { admission, configuration, predecessor: previous, runtime: source } = operation;
  keys(admission, ["version", "authority", "identity", "executorCi", "dispatch"]);
  const identity = validateIdentity(admission.identity);
  ensure(
    record.version === 1 &&
      record.kind === "platform-healthy-forward-rollout-host-operation" &&
      record.phase === "healthy-forward-rollout" &&
      record.installedRoot === join(host, "upgrade-bootstrap", identity.executorSha) &&
      identity.operationId === state.operationId &&
      sameTarget(identity.target, target) &&
      operation.root === root &&
      operation.dockerConfig === join(root, "docker") &&
      admission.version === 2 &&
      record.dispatch.toolingSha === identity.executorSha,
  );
  validateOperationAuthority(admission);
  validateUpgradeAuthorization(record.authorization);
  validateUpgradeDispatch(record.dispatch);
  same(record.dispatch, admission.dispatch);
  keys(admission.executorCi, ["runId", "runAttempt"]);
  ensure(Object.values(admission.executorCi).every(canonicalId));
  for (const [service, { imageId }] of Object.entries(identity.admission.registry))
    ensure(imageId === runtime.containers[service].imageId);

  const observationPolicy = validateObservationPolicy(runtime.observationPolicy);
  ensure(
    observationPolicy.machineId === target.hostId &&
      observationPolicy.volume.name === target.volumeId &&
      observationPolicy.postgresImageId === runtime.containers.postgres.imageId,
  );
  same(record.observationPolicy, observationPolicy);
  same(source.observationPolicy, observationPolicy);
  same(source.containers.postgres, runtime.containers.postgres);
  same(source.schema, validateUpgradeSchema(runtime.schema, identity));
  ensure(
    previous.operationId === state.predecessorOperationId &&
      previous.indexSha256 === state.predecessorIndexSha256 &&
      hash(previous.stateSha256),
  );

  keys(configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]);
  const { runtimeSnapshot } = configuration;
  keys(runtimeSnapshot, ["path", "sha256", "interpolation"]);
  const { interpolation, ...runtimeDescriptor } = runtimeSnapshot;
  validateConfigurationRuntime(runtimeDescriptor);
  keys(interpolation, interpolationKeys);
  const { manifest } = identity.admission;
  ensure(
    Object.values(interpolation).every(
      (value) => typeof value === "string" && value.length > 0 && !/[\s\x00-\x1f\x7f]/u.test(value),
    ) &&
      interpolation.MARKIRO_PLATFORM_ENV_FILE === runtimeSnapshot.path &&
      interpolation.MARKIRO_SOURCE_SHA === manifest.sourceSha &&
      interpolation.MARKIRO_API_IMAGE_DIGEST === manifest.api.split("@")[1] &&
      interpolation.MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST === manifest.edge.split("@")[1],
  );
  const migrationSnapshot = validateConfigurationRuntime(configuration.migrationSnapshot);
  const snapshotPath = `candidates/${state.operationId}/runtime.env`;
  ensure(
    configuration.candidateId === state.operationId &&
      runtimeSnapshot.path === join(root, snapshotPath) &&
      migrationSnapshot.path === join(root, "candidates", state.operationId, "migration.env") &&
      runtime.path === join(basename(root), snapshotPath) &&
      runtime.sha256 === runtimeSnapshot.sha256 &&
      identity.configurationSha256 ===
        digest({
          version: 1,
          kind: "platform-host-configuration",
          candidateId: state.operationId,
          runtimeSha256: runtimeSnapshot.sha256,
          migrationSha256: migrationSnapshot.sha256,
        }),
  );
  await readPinned(root, snapshotPath, runtimeSnapshot.sha256);
  await readPinned(root, `candidates/${state.operationId}/migration.env`, migrationSnapshot.sha256);
  return { directory, identity, previous, source };
}

/** Verify the active healthy handoff and the archived chain under the caller's host lock. */
export async function readHealthyRolloutPredecessor(
  root,
  predecessor,
  runtime,
  candidateIdentity,
  readPinned,
) {
  validateHealthyPins(predecessor);
  const target = validateIdentity(candidateIdentity).target;
  let path = "upgrade-index.json";
  let expected = predecessor;
  let source = runtime;
  let identity;
  const seen = new Set([candidateIdentity.operationId]);
  // The traversal has an explicit work bound in addition to rejecting repeated IDs.
  for (let remaining = 256; remaining > 0; remaining -= 1) {
    const index = parseDocument(await readPinned(root, path, expected.indexSha256));
    ensure(
      index.operationId === expected.operationId &&
        index.stateSha256 === expected.stateSha256 &&
        uuid(index.operationId) &&
        !seen.has(index.operationId),
    );
    seen.add(index.operationId);
    if (index.kind === recoveryIndexKind) {
      ensure(identity);
      const custodyOperationId = await readRecoveryAnchor(
        root,
        index,
        expected,
        identity,
        source,
        readPinned,
      );
      return Object.freeze({ identity, custodyOperationId });
    }
    ensure(index.kind === healthyIndexKind);
    const step = await readHealthyStep(root, index, expected, source, target, readPinned);
    identity ??= step.identity;
    path = `${step.directory}/predecessor-index.json`;
    expected = step.previous;
    source = step.source;
  }
  ensure(false);
}
