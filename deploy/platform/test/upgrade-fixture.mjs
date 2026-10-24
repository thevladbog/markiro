import { createHash } from "node:crypto";
import { hostIdentity, backupProof } from "./host-fixtures.mjs";

export const upgradeNow = Date.parse("2026-10-24T08:00:00.000Z");
export const upgradeHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const upgradeBytes = (value) => Buffer.from(JSON.stringify(value) + "\n");

// Synthetic complete predecessor, matching the existing recovery persistence
// shapes. Historical expiry is deliberately four days before the new admission.
export function upgradeFixture() {
  const prior = hostIdentity();
  const recovered = hostIdentity();
  const original = {
    version: 1,
    sequence: 14,
    previousHealthy: null,
    current: {
      identity: prior,
      phase: "api-started",
      status: "recovery-required",
      backup: backupProof(prior),
    },
  };
  const historical = {
    version: 1,
    kind: "platform-failed-activation-recovery",
    identity: recovered,
    predecessor: {
      identity: prior,
      sequence: 14,
      stateSha256: upgradeHash(upgradeBytes(original)),
    },
    executorCi: { runId: "123456789", runAttempt: "1" },
    expiresAt: "2026-10-20T00:10:00.000Z",
  };
  const preparation = {
    version: 1,
    admission: historical,
    sequence: 6,
    phase: "backup-verified",
    status: "completed",
    backup: backupProof(recovered),
  };
  const names = [
    "postgres",
    "tls",
    "rolePolicy",
    "restoredSnapshot",
    "egress",
    "keyContinuity",
    "offHostRecovery",
  ];
  const observations = Object.fromEntries(
    names.map((name) => [
      name,
      {
        kind: ["postgres", "tls", "rolePolicy", "restoredSnapshot"].includes(name)
          ? "measured"
          : "operator-attestation",
        producerId: name,
        executorSha: recovered.executorSha,
        operationId: recovered.operationId,
        target: recovered.target,
        fenceId: "fixture-fence",
        configurationSha256: recovered.configurationSha256,
        snapshotId: "fixture-snapshot",
        observedAt: "2026-10-20T00:20:00.000Z",
        value: {},
      },
    ]),
  );
  observations.restoredSnapshot.value = {
    archiveSha256: preparation.backup.archiveSha256,
    restoreEvidenceSha256: preparation.backup.restoreEvidenceSha256,
  };
  const activation = {
    version: 1,
    kind: "platform-recovery-activation",
    admission: { ...historical, expiresAt: "2026-10-20T00:50:00.000Z" },
    preparation: { sequence: 6, sha256: upgradeHash(upgradeBytes(preparation)) },
    preparedTarget: {
      version: 2,
      kind: "platform-prepared-target",
      operationId: recovered.operationId,
      target: recovered.target,
      executorSha: recovered.executorSha,
      provenance: "live-source",
      configurationSha256: recovered.configurationSha256,
      fence: {
        fenceId: "fixture-fence",
        enforcementSha256: "f".repeat(64),
        beganAt: "2026-10-20T00:00:00.000Z",
      },
      observations,
    },
    preparedPolicy: {
      backup: {},
      restoreEvidence: {},
      roleMapping: {},
      postgres: {},
      tls: {},
      rolePolicySha256: "f".repeat(64),
      provenance: "live-source",
      maxAgeMs: 3600000,
      producers: Object.fromEntries(names.map((name) => [name, name])),
    },
    configuration: {
      candidateId: recovered.operationId,
      runtimeSnapshot: {},
      migrationSnapshot: {},
    },
    dispatch: { toolingSha: "a".repeat(40), runId: "456789", runAttempt: "1" },
  };
  const acceptedRecovery = {
    ...preparation,
    sequence: 16,
    phase: "healthy",
    status: "completed",
    preparation: activation.preparation,
    activation,
  };
  const consumption = {
    version: 1,
    kind: "platform-recovery-activation-consumption",
    operationId: recovered.operationId,
    preparationSha256: activation.preparation.sha256,
    activationSha256: upgradeHash(Buffer.from(JSON.stringify(activation))),
    dispatch: activation.dispatch,
  };
  const activationOperation = {
    version: 1,
    kind: "platform-recovery-host-operation",
    phase: "activate",
    installedRoot: `/opt/markiro-platform/recovery-bootstrap/${recovered.executorSha}`,
    dispatch: activation.dispatch,
    observationPolicy: {},
    operation: {
      root: "/opt/markiro-platform/state",
      dockerConfig: "/opt/markiro-platform/state/docker",
      activation,
    },
  };
  const records = { original, acceptedRecovery, preparation, consumption, activationOperation };
  const predecessorBytes = Object.fromEntries(
    Object.entries(records).map(([name, value]) => [name, upgradeBytes(value)]),
  );
  const identity = hostIdentity();
  identity.configurationSha256 = "e".repeat(64);
  const input = {
    version: 1,
    kind: "platform-accepted-recovery-upgrade",
    phase: "prepare",
    identity,
    predecessor: {
      identity: recovered,
      hashes: Object.fromEntries(
        Object.entries(predecessorBytes).map(([name, value]) => [name, upgradeHash(value)]),
      ),
    },
    oldConfigurationSha256: recovered.configurationSha256,
    candidateConfigurationSha256: identity.configurationSha256,
    executorCi: { runId: "987654321", runAttempt: "1" },
    dispatch: { toolingSha: identity.executorSha, runId: "987654322", runAttempt: "1" },
    reviewedPlanSha256: "f".repeat(64),
    expiresAt: "2026-10-24T08:30:00.000Z",
  };
  return { records, predecessorBytes, input, now: upgradeNow };
}

export function rewriteUpgradePredecessor(fixture, name, mutate) {
  const value = JSON.parse(fixture.predecessorBytes[name]);
  mutate(value);
  fixture.predecessorBytes[name] = upgradeBytes(value);
  fixture.input.predecessor.hashes[name] = upgradeHash(fixture.predecessorBytes[name]);
}
