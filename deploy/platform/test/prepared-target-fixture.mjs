import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { privateFixture, hostIdentity } from "./host-fixtures.mjs";
import { canonical, digest } from "../backup/schemas.mjs";
import {
  snapshotHostConfig,
  snapshotMigrationConfig,
  fingerprintHostConfiguration,
} from "../host/config.mjs";

export async function preparedFixture(t) {
  const f = await privateFixture(t);
  const identity = hostIdentity();
  const runtimeSnapshot = await snapshotHostConfig(f);
  const migrationFile = join(f.root, "migration-source.env");
  const url = new URL(f.env.DATABASE_URL);
  url.username = "migrator";
  await writeFile(migrationFile, `DATABASE_URL=${url.href}\n`, { mode: 0o600 });
  const migrationSnapshot = await snapshotMigrationConfig({
    ...f,
    envFile: migrationFile,
    runtimeSnapshot,
  });
  const configuration = { candidateId: f.candidateId, runtimeSnapshot, migrationSnapshot };
  const hashes = await fingerprintHostConfiguration({ root: f.root, ...configuration });
  identity.configurationSha256 = hashes.configurationSha256;
  const now = new Date(Date.now() - 1000).toISOString();
  const fence = {
    version: 1,
    kind: "platform-writer-fence",
    operationId: identity.operationId,
    target: identity.target,
    fenceId: randomUUID(),
    enforcementSha256: digest("enforced"),
    beganAt: now,
    observedAt: now,
    held: true,
  };
  const inventory = {
    roles: [],
    memberships: [],
    objects: [],
    defaultPrivileges: [],
    extensions: [],
    tables: [],
    sequences: [],
    indexes: [],
    constraints: [],
    triggers: [],
    migrationJournal: null,
  };
  const archive = Buffer.from("PGDMP unit fixture only");
  const runtime = {
    image: `sha256:${"d".repeat(64)}`,
    architecture: "arm64",
    postgresVersion: "17.11",
  };
  const document = {
    version: 1,
    kind: "platform-database-backup",
    operationId: identity.operationId,
    target: identity.target,
    executorSha: identity.executorSha,
    provenance: "local-synthetic",
    archiveSha256: digest(archive),
    archiveBytes: archive.length,
    snapshotId: "00000001-00000002-1",
    fence: {
      before: { ...fence, boundary: "before-snapshot" },
      after: { ...fence, boundary: "after-snapshot" },
    },
    startedAt: now,
    completedAt: now,
    runtime,
    inventory,
  };
  const roleMapping = { version: 1, roles: [], allowedDeltas: [] };
  const prefix = `markiro-backup-${identity.operationId}-restore`;
  const evidence = {
    version: 1,
    kind: "platform-database-restore",
    status: "completed",
    operationId: identity.operationId,
    target: identity.target,
    executorSha: identity.executorSha,
    provenance: "local-synthetic",
    archiveSha256: document.archiveSha256,
    inventorySha256: digest(canonical(document)),
    roleMappingSha256: digest(roleMapping),
    restoredInventorySha256: digest(inventory),
    snapshotId: document.snapshotId,
    fence: document.fence,
    startedAt: now,
    completedAt: now,
    runtime,
    unvalidatedSourceConstraints: 0,
    checks: [
      "archive",
      "inventory",
      "roles",
      "owners-acl-defaults",
      "extensions",
      "migration-journal",
      "table-bytes-counts",
      "sequences",
      "indexes-constraints",
      "cleanup",
    ],
    cleanup: {
      verified: true,
      resources: [
        { kind: "volume", name: `${prefix}-data` },
        { kind: "volume", name: `${prefix}-input` },
        { kind: "container", name: `${prefix}-init` },
        { kind: "container", name: `${prefix}-worker` },
      ],
    },
  };
  const backup = {
    archivePath: join(f.root, "database.dump"),
    archiveSha256: document.archiveSha256,
    inventoryPath: join(f.root, "inventory.json"),
    inventorySha256: evidence.inventorySha256,
  };
  const restoreEvidence = {
    evidencePath: join(f.root, "evidence.json"),
    evidenceSha256: digest(canonical(evidence)),
  };
  await writeFile(backup.archivePath, archive, { mode: 0o600 });
  const publish = async () => {
    await writeFile(backup.inventoryPath, canonical(document), { mode: 0o600 });
    backup.inventorySha256 = digest(canonical(document));
    evidence.inventorySha256 = backup.inventorySha256;
    await writeFile(restoreEvidence.evidencePath, canonical(evidence), { mode: 0o600 });
    restoreEvidence.evidenceSha256 = digest(canonical(evidence));
  };
  await publish();
  const producerId = "local-test-producer";
  const postgres = {
    image: `sha256:${"f".repeat(64)}`,
    architecture: "arm64",
    os: "linux",
    uid: 999,
    gid: 999,
  };
  const tls = { certificateSha256: digest("cert"), san: "db.private" };
  const rolePolicySha256 = digest("role-policy");
  const resource = { containerId: "a".repeat(64), name: `migration-${identity.operationId}` };
  let held = true,
    status = "exited";
  const expected = {
    root: f.root,
    identity,
    configuration,
    backup,
    restoreEvidence,
    roleMapping,
    postgres,
    tls,
    rolePolicySha256,
    provenance: "local-synthetic",
    maxAgeMs: 60000,
    producers: Object.fromEntries(
      [
        "postgres",
        "tls",
        "rolePolicy",
        "restoredSnapshot",
        "egress",
        "keyContinuity",
        "offHostRecovery",
      ].map((k) => [k, producerId]),
    ),
    writerFence: {
      producerId,
      executorSha: identity.executorSha,
      observe: async ({ boundary }) => ({
        ...fence,
        boundary,
        held,
        observedAt: new Date().toISOString(),
        producerId,
        executorSha: identity.executorSha,
      }),
    },
    workload: {
      identity: resource,
      producerId,
      executorSha: identity.executorSha,
      inspect: async () => ({
        version: 1,
        kind: "platform-owned-workload",
        operationId: identity.operationId,
        target: identity.target,
        producerId,
        executorSha: identity.executorSha,
        observedAt: new Date().toISOString(),
        ...resource,
        ownerOperationId: identity.operationId,
        status,
      }),
    },
  };
  const value = {
    postgres: { ...postgres, postgresVersion: "17.11" },
    tls: { ...tls, notBefore: now, expiresAt: new Date(Date.now() + 86400000).toISOString() },
    rolePolicy: {
      policySha256: rolePolicySha256,
      configurationSha256: identity.configurationSha256,
    },
    restoredSnapshot: {
      snapshotId: document.snapshotId,
      archiveSha256: backup.archiveSha256,
      inventorySha256: backup.inventorySha256,
      restoreEvidenceSha256: restoreEvidence.evidenceSha256,
      roleMappingSha256: evidence.roleMappingSha256,
      restoredInventorySha256: evidence.restoredInventorySha256,
      workerImage: runtime.image,
      workerArchitecture: runtime.architecture,
    },
    egress: {
      approved: true,
      actor: "fixture-operator",
      reference: "synthetic-egress",
      networkPolicySha256: digest("isolated"),
      smtp: "blocked",
      s3: "isolated",
      retainedMail: "held",
      reportJobs: "held",
      legacyQueues: "disabled",
      retention: "disabled",
    },
    keyContinuity: {
      approved: true,
      actor: "fixture-operator",
      reference: "synthetic-keys",
      keyManifestSha256: digest("keys"),
      decryptionVerified: true,
      signingContinuityVerified: true,
    },
    offHostRecovery: {
      approved: true,
      actor: "fixture-operator",
      reference: "synthetic-offhost",
      archiveSha256: backup.archiveSha256,
      recoveryTestReference: "synthetic-restore",
      independentKeyAvailable: true,
    },
  };
  const record = {
    version: 1,
    kind: "platform-prepared-target",
    operationId: identity.operationId,
    target: identity.target,
    executorSha: identity.executorSha,
    provenance: "local-synthetic",
    configurationSha256: identity.configurationSha256,
    fence: {
      fenceId: fence.fenceId,
      enforcementSha256: fence.enforcementSha256,
      beganAt: fence.beganAt,
    },
    observations: Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        {
          kind: ["egress", "keyContinuity", "offHostRecovery"].includes(k)
            ? "operator-attestation"
            : "measured",
          producerId,
          executorSha: identity.executorSha,
          operationId: identity.operationId,
          target: identity.target,
          fenceId: fence.fenceId,
          configurationSha256: identity.configurationSha256,
          snapshotId: document.snapshotId,
          observedAt: now,
          value: v,
        },
      ]),
    ),
  };
  return {
    ...f,
    identity,
    backup,
    restoreEvidence,
    document,
    evidence,
    record,
    expected,
    publish,
    setHeld: (v) => {
      held = v;
    },
    setStatus: (v) => {
      status = v;
    },
  };
}
