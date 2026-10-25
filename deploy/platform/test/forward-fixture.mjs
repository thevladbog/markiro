import { dirname } from "node:path";
import { hostIdentity, backupProof } from "./host-fixtures.mjs";
import {
  upgradeFixture,
  upgradeOldRuntime,
  upgradePreparation,
  upgradeBytes,
  upgradeHash,
} from "./upgrade-fixture.mjs";
import { upgradePhaseReceipt } from "../host/upgrade-phase-admission.mjs";
import { buildProductMigrationProof } from "../host/forward-ledger.mjs";
import { proofInput } from "./forward-product-fixture.mjs";
export function forwardFixture(options = {}) {
  const u = options.upgrade ?? upgradeFixture(options);
  const oldRuntime = {
      ...upgradeOldRuntime(u.input),
      ...(options.retainedIds ? { containers: options.retainedIds } : {}),
    },
    preparation = upgradePreparation(u.input, oldRuntime);
  const prior = {
    version: 1,
    admission: u.input,
    sequence: 6,
    phase: "backup-verified",
    status: "completed",
    backup: preparation.backup,
    oldRuntime,
    preparation,
    migrationEntered: false,
  };
  const decision = {
    version: 1,
    kind: "platform-upgrade-phase",
    phase: "activate",
    identity: u.input.identity,
    prior: { sequence: 6, sha256: upgradeHash(upgradeBytes(prior)) },
    executorCi: u.input.executorCi,
    reviewedPlanSha256: u.input.reviewedPlanSha256,
    dispatch: { ...u.input.dispatch, runId: "987654333" },
    expiresAt: u.input.expiresAt,
  };
  const state = {
    ...prior,
    sequence: 14,
    phase: "api-started",
    status: "recovery-required",
    migrationEntered: true,
    decision,
  };
  const authorization = {
    actorId: "11",
    actorLogin: "publisher",
    reviewerId: "12",
    reviewerLogin: "reviewer",
    environmentId: "44",
  };
  const root = options.root ?? "/opt/markiro-platform/state";
  const operation = {
    root,
    dockerConfig: `${root}/docker`,
    admission: u.input,
    configuration: options.failedConfiguration ?? {
      candidateId: u.input.identity.operationId,
      runtimeSnapshot: {},
      migrationSnapshot: {},
    },
    predecessorContainers: oldRuntime.containers,
  };
  const base = {
    version: 1,
    kind: "platform-upgrade-host-operation",
    installedRoot: `${dirname(root)}/upgrade-bootstrap/${u.input.identity.executorSha}`,
    authorization,
    observationPolicy: options.policy ?? u.records.activationOperation.observationPolicy,
  };
  const records = {
    state,
    beforeActivate: prior,
    prepareConsumption: {
      version: 1,
      kind: "platform-upgrade-prepare-consumption",
      operationId: u.input.identity.operationId,
      admissionSha256: upgradeHash(upgradeBytes(u.input)),
      dispatch: u.input.dispatch,
    },
    activateConsumption: upgradePhaseReceipt(decision),
    prepareOperation: {
      ...base,
      phase: "prepare",
      dispatch: u.input.dispatch,
      operation: {
        ...operation,
        connectionFile: `${root}/connection.json`,
        roleMapping: { version: 1, roles: [], allowedDeltas: [] },
      },
    },
    activateOperation: {
      ...base,
      phase: "activate",
      dispatch: decision.dispatch,
      operation: {
        ...operation,
        decision,
        preparedTarget: {
          version: 2,
          provenance: "live-source",
          operationId: u.input.identity.operationId,
          executorSha: u.input.identity.executorSha,
          configurationSha256: u.input.identity.configurationSha256,
          target: u.input.identity.target,
          fence: preparation.fence,
        },
        preparedPolicy: { provenance: "live-source" },
      },
    },
    index: {
      version: 1,
      kind: "platform-upgrade-index",
      operationId: u.input.identity.operationId,
      stateSha256: upgradeHash(upgradeBytes(state)),
    },
  };
  const failedBytes = Object.fromEntries(
    Object.entries(records).map(([k, v]) => [k, upgradeBytes(v)]),
  );
  const identity = structuredClone(u.input.identity);
  identity.operationId = hostIdentity().operationId;
  identity.executorSha = "f".repeat(40);
  identity.configurationSha256 = options.candidateConfigurationSha256 ?? "d".repeat(64);
  const productMigrationProof = buildProductMigrationProof({
    ...proofInput(),
    productSha: identity.admission.manifest.sourceSha,
    imageId: identity.admission.registry.api.imageId,
    imageReference: identity.admission.manifest.api,
  });
  const now = Date.parse("2026-10-25T09:30:00.000Z");
  const input = {
    version: 1,
    kind: "platform-upgrade-forward-recovery",
    phase: "post-migration-prepare",
    identity,
    failed: {
      identity: u.input.identity,
      hashes: Object.fromEntries(Object.entries(failedBytes).map(([k, v]) => [k, upgradeHash(v)])),
    },
    originalPredecessor: u.input.predecessor,
    oldConfigurationSha256: u.input.oldConfigurationSha256,
    failedConfigurationSha256: u.input.candidateConfigurationSha256,
    candidateConfigurationSha256: identity.configurationSha256,
    baseline: {
      containers: oldRuntime.containers,
      schema: {
        ...oldRuntime.schema,
        schemaSha256: "c".repeat(64),
        migrationSha256: "d".repeat(64),
        migrationCount: "2",
      },
      productMigrationProofSha256: productMigrationProof.proofSha256,
    },
    executorCi: { runId: "998001", runAttempt: "1" },
    dispatch: { toolingSha: identity.executorSha, runId: "998002", runAttempt: "1" },
    reviewedPlanSha256: "f".repeat(64),
    expiresAt: new Date(now + 1800000).toISOString(),
  };
  return {
    u,
    records,
    failedBytes,
    originalPredecessorBytes: u.predecessorBytes,
    productMigrationProof,
    now,
    input,
  };
}
export function forwardPrepared(f) {
  const sourceRuntime = {
    version: 1,
    kind: "platform-forward-source-runtime",
    operationId: f.input.identity.operationId,
    configurationSha256: f.input.candidateConfigurationSha256,
    ...f.input.baseline,
  };
  const backup = backupProof(f.input.identity);
  return {
    version: 1,
    admission: f.input,
    sequence: 6,
    phase: "backup-verified",
    status: "completed",
    migrationEntered: true,
    sourceRuntime,
    backup,
    preparation: {
      version: 1,
      kind: "platform-forward-preparation",
      operationId: f.input.identity.operationId,
      sourceRuntime,
      backup,
      sourceSchema: f.input.baseline.schema,
      productMigrationProofSha256: f.productMigrationProof.proofSha256,
      fence: f.records.beforeActivate.preparation.fence,
    },
  };
}
export function forwardDecision(f, prior = forwardPrepared(f)) {
  return {
    version: 1,
    kind: "platform-forward-recovery-phase",
    phase: "post-migration-activate",
    identity: f.input.identity,
    prior: { sequence: 6, sha256: upgradeHash(upgradeBytes(prior)) },
    executorCi: f.input.executorCi,
    reviewedPlanSha256: f.input.reviewedPlanSha256,
    dispatch: { ...f.input.dispatch, runId: "998003" },
    expiresAt: f.input.expiresAt,
  };
}
