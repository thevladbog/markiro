import {
  canonical,
  digest,
  ensure,
  fence,
  hash,
  keys,
  plain,
  timestamp,
} from "../backup/schemas.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { mapInventory } from "../backup/inventory.mjs";
import { fingerprintHostConfiguration } from "./config.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";

const measured = ["postgres", "tls", "rolePolicy", "restoredSnapshot"];
const attested = ["egress", "keyContinuity", "offHostRecovery"];
const names = [...measured, ...attested];
const same = (a, b) => ensure(canonical(a) === canonical(b));
const label = (v) =>
  ensure(typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u.test(v));
function fresh(value, beganAt, maxAgeMs, now) {
  const time = timestamp(value);
  ensure(time >= timestamp(beganAt) && time <= now && now - time <= maxAgeMs);
}
function acceptance(value, fields) {
  keys(value, ["approved", "actor", "reference", ...fields]);
  ensure(value.approved === true);
  label(value.actor);
  label(value.reference);
}

export const activationTables = Object.freeze([
  "public.email_deliveries",
  "public.email_outbox",
  "public.platform_reports",
  "public.standalone_support_diagnostics",
  "pgboss_platform.job",
  "pgboss.job",
]);
export function validateActivationProjection(value) {
  ensure(Array.isArray(value) && value.length === activationTables.length);
  value.forEach((row, i) => {
    keys(row, ["table", "rows", "pending", "expired", "sha256"]);
    ensure(row.table === activationTables[i] && hash(row.sha256));
    for (const k of ["rows", "pending", "expired"])
      ensure(Number.isSafeInteger(row[k]) && row[k] >= 0 && row[k] <= 2147483647);
    ensure(row.pending <= row.rows && row.expired <= row.rows);
    if (!row.rows) ensure(row.sha256 === digest("") && !row.pending && !row.expired);
  });
  return value;
}
export function validateProductionAuthorization(
  record,
  document,
  evidence,
  backupProof,
  now = Date.now(),
) {
  const observation = record.observations.egress,
    value = observation.value;
  acceptance(value, [
    "mode",
    "smtp",
    "s3",
    "retainedMail",
    "reportJobs",
    "legacyQueues",
    "retention",
    "review",
    "reviewSha256",
    "sourceHold",
    "expiresAt",
  ]);
  ensure(
    value.mode === "production-activation" &&
      value.smtp === "production" &&
      value.s3 === "production" &&
      value.retainedMail === "authorized" &&
      value.reportJobs === "authorized" &&
      value.retention === "authorized" &&
      value.legacyQueues === "disabled",
  );
  const review = value.review;
  keys(review, [
    "version",
    "kind",
    "operationId",
    "target",
    "executorSha",
    "configurationSha256",
    "fenceId",
    "snapshotId",
    "archiveSha256",
    "restoreEvidenceSha256",
    "asOf",
    "observedAt",
    "projection",
  ]);
  ensure(
    review.version === 1 &&
      review.kind === "platform-retained-intent-review" &&
      hash(value.reviewSha256) &&
      digest(review) === value.reviewSha256,
  );
  for (const key of ["operationId", "target", "executorSha", "configurationSha256"])
    same(review[key], record[key]);
  same(review.fenceId, record.fence.fenceId);
  same(review.snapshotId, document.snapshotId);
  same(review.archiveSha256, backupProof.archiveSha256);
  same(review.restoreEvidenceSha256, backupProof.restoreEvidenceSha256);
  validateActivationProjection(review.projection);
  const completed = Math.max(timestamp(document.completedAt), timestamp(evidence.completedAt));
  ensure(
    timestamp(review.asOf) >= completed &&
      timestamp(review.asOf) <= timestamp(review.observedAt) &&
      timestamp(review.observedAt) <= timestamp(observation.observedAt),
  );
  const hold = value.sourceHold;
  keys(hold, ["kind", "held", "actor", "reference", "evidenceSha256", "observedAt", "expiresAt"]);
  ensure(hold.kind === "operator-attestation" && hold.held === true && hash(hold.evidenceSha256));
  label(hold.actor);
  label(hold.reference);
  ensure(
    timestamp(hold.observedAt) >= completed &&
      timestamp(hold.observedAt) <= timestamp(observation.observedAt),
  );
  const expires = timestamp(value.expiresAt);
  ensure(
    expires > now &&
      expires <= timestamp(observation.observedAt) + 3600000 &&
      timestamp(hold.expiresAt) >= expires &&
      timestamp(hold.expiresAt) <= timestamp(hold.observedAt) + 3600000,
  );
  return value;
}

// This is an action-boundary check, not a durable authorization token. Call it
// inside withHostState immediately before every protected journal mutation.
// Trusted adapters independently inspect the held fence and exact owned workload.
// Hardware/TLS observations and operator attestations still need real producers.
export async function validatePreparedTarget(input, expected) {
  // Freeze caller-owned data before awaiting adapters or filesystem IO.
  expected = {
    ...expected,
    configuration: plain(expected.configuration),
    backup: plain(expected.backup),
    restoreEvidence: plain(expected.restoreEvidence),
    roleMapping: plain(expected.roleMapping),
    workload: { ...expected.workload, identity: plain(expected.workload.identity) },
    writerFence: { ...expected.writerFence },
  };
  const record = plain(input);
  const identity = plain(expected.identity);
  const policy = plain({
    postgres: expected.postgres,
    tls: expected.tls,
    rolePolicySha256: expected.rolePolicySha256,
    provenance: expected.provenance,
    maxAgeMs: expected.maxAgeMs,
    producers: expected.producers,
  });
  ensure(
    Number.isSafeInteger(policy.maxAgeMs) && policy.maxAgeMs > 0 && policy.maxAgeMs <= 86400000,
  );
  keys(record, [
    "version",
    "kind",
    "operationId",
    "target",
    "executorSha",
    "provenance",
    "configurationSha256",
    "fence",
    "observations",
  ]);
  ensure(
    [1, 2].includes(record.version) &&
      record.kind === "platform-prepared-target" &&
      ["local-synthetic", "live-source"].includes(policy.provenance),
  );
  for (const key of ["operationId", "target", "executorSha", "configurationSha256"])
    same(record[key], identity[key]);
  same(record.provenance, policy.provenance);
  if (record.version === 2) ensure(policy.provenance === "live-source");
  keys(record.fence, ["fenceId", "enforcementSha256", "beganAt"]);
  keys(record.observations, names);
  keys(policy.producers, names);
  const { document, evidence, backupProof } = await readVerifiedBackup({ ...expected, identity });
  same(document.provenance, policy.provenance);
  const configuration = await fingerprintHostConfiguration({
    root: expected.root,
    ...expected.configuration,
  });
  same(configuration.configurationSha256, identity.configurationSha256);
  const runtimeConfig = await readProtectedEnv(expected.configuration.runtimeSnapshot.path);
  same(runtimeConfig.MARKIRO_POSTGRES_IMAGE_DIGEST, policy.postgres.image);
  for (const key of ["fenceId", "enforcementSha256", "beganAt"])
    same(record.fence[key], document.fence.before[key]);
  const now = Date.now();
  fresh(document.startedAt, record.fence.beganAt, policy.maxAgeMs, now);
  fresh(evidence.completedAt, record.fence.beganAt, policy.maxAgeMs, now);
  for (const name of names) {
    const observation = record.observations[name];
    keys(observation, [
      "kind",
      "producerId",
      "executorSha",
      "operationId",
      "target",
      "fenceId",
      "configurationSha256",
      "snapshotId",
      "observedAt",
      "value",
    ]);
    same(observation.kind, measured.includes(name) ? "measured" : "operator-attestation");
    label(policy.producers[name]);
    same(observation.producerId, policy.producers[name]);
    for (const key of ["operationId", "target", "executorSha", "configurationSha256"])
      same(observation[key], identity[key]);
    same(observation.fenceId, record.fence.fenceId);
    same(observation.snapshotId, document.snapshotId);
    fresh(observation.observedAt, record.fence.beganAt, policy.maxAgeMs, now);
  }
  const pg = record.observations.postgres.value;
  keys(policy.postgres, ["image", "architecture", "os", "uid", "gid"]);
  keys(pg, [...Object.keys(policy.postgres), "postgresVersion"]);
  for (const key of Object.keys(policy.postgres)) same(pg[key], policy.postgres[key]);
  ensure(
    /^sha256:[a-f0-9]{64}$/u.test(pg.image) &&
      pg.os === "linux" &&
      ["amd64", "arm64"].includes(pg.architecture) &&
      /^17\.[0-9]+(?: |$)/u.test(pg.postgresVersion),
  );
  ensure(Number.isSafeInteger(pg.uid) && pg.uid > 0 && Number.isSafeInteger(pg.gid) && pg.gid > 0);
  if (policy.provenance === "live-source") ensure(pg.architecture === "amd64");
  const tls = record.observations.tls.value;
  keys(policy.tls, ["certificateSha256", "san"]);
  keys(tls, ["certificateSha256", "san", "notBefore", "expiresAt"]);
  ensure(hash(tls.certificateSha256));
  label(tls.san);
  for (const key of Object.keys(policy.tls)) same(tls[key], policy.tls[key]);
  ensure(
    timestamp(tls.notBefore) <= timestamp(record.observations.tls.observedAt) &&
      timestamp(tls.expiresAt) > now,
  );
  ensure(hash(policy.rolePolicySha256));
  same(record.observations.rolePolicy.value, {
    policySha256: policy.rolePolicySha256,
    configurationSha256: configuration.configurationSha256,
  });
  const mapped = mapInventory(document.inventory, plain(expected.roleMapping));
  same(evidence.roleMappingSha256, digest(expected.roleMapping));
  same(evidence.restoredInventorySha256, digest(mapped));
  same(record.observations.restoredSnapshot.value, {
    snapshotId: document.snapshotId,
    archiveSha256: backupProof.archiveSha256,
    inventorySha256: evidence.inventorySha256,
    restoreEvidenceSha256: backupProof.restoreEvidenceSha256,
    roleMappingSha256: evidence.roleMappingSha256,
    restoredInventorySha256: evidence.restoredInventorySha256,
    workerImage: evidence.runtime.image,
    workerArchitecture: evidence.runtime.architecture,
  });
  ensure(
    timestamp(record.observations.restoredSnapshot.observedAt) >= timestamp(evidence.completedAt),
  );
  const egress = record.observations.egress.value;
  if (record.version === 2)
    validateProductionAuthorization(record, document, evidence, backupProof, now);
  else {
    acceptance(egress, [
      "networkPolicySha256",
      "smtp",
      "s3",
      "retainedMail",
      "reportJobs",
      "legacyQueues",
      "retention",
    ]);
    ensure(
      hash(egress.networkPolicySha256) &&
        ["blocked", "sink"].includes(egress.smtp) &&
        ["blocked", "isolated"].includes(egress.s3) &&
        egress.retainedMail === "held" &&
        egress.reportJobs === "held" &&
        egress.legacyQueues === "disabled" &&
        egress.retention === "disabled",
    );
  }
  const key = record.observations.keyContinuity.value;
  acceptance(key, ["keyManifestSha256", "decryptionVerified", "signingContinuityVerified"]);
  ensure(
    hash(key.keyManifestSha256) &&
      key.decryptionVerified === true &&
      key.signingContinuityVerified === true,
  );
  const offhost = record.observations.offHostRecovery.value;
  acceptance(offhost, ["archiveSha256", "recoveryTestReference", "independentKeyAvailable"]);
  same(offhost.archiveSha256, backupProof.archiveSha256);
  label(offhost.recoveryTestReference);
  ensure(offhost.independentKeyAvailable === true);
  // Observe after byte checks. v2 binds fresh absence to the actual restore
  // producer's complete cleanup inventory; v1 retains stopped-worker compatibility.
  const workload = plain(
    await expected.workload.inspect({ operationId: identity.operationId, target: identity.target }),
  );
  const common = [
    "version",
    "kind",
    "operationId",
    "target",
    "producerId",
    "executorSha",
    "observedAt",
    "status",
  ];
  if (workload.version === 2) {
    keys(workload, [...common, "resources", "present", "operationResources"]);
    keys(expected.workload.identity, ["resources"]);
    ensure(workload.kind === "platform-restore-cleanup" && workload.status === "absent");
    same(expected.workload.identity.resources, evidence.cleanup.resources);
    same(workload.resources, evidence.cleanup.resources);
    same(workload.present, []);
    same(workload.operationResources, []);
  } else {
    keys(workload, [...common, "containerId", "name", "ownerOperationId"]);
    keys(expected.workload.identity, ["containerId", "name"]);
    ensure(
      workload.version === 1 &&
        workload.kind === "platform-owned-workload" &&
        workload.status === "exited" &&
        /^[a-f0-9]{64}$/u.test(workload.containerId),
    );
    same(workload.ownerOperationId, identity.operationId);
    for (const key of ["containerId", "name"]) same(workload[key], expected.workload.identity[key]);
    label(workload.name);
  }
  same(workload.operationId, identity.operationId);
  same(workload.target, identity.target);
  label(expected.workload.producerId);
  same(workload.producerId, expected.workload.producerId);
  same(workload.executorSha, identity.executorSha);
  same(expected.workload.executorSha, identity.executorSha);
  const observation = plain(
    await expected.writerFence.observe({
      operationId: identity.operationId,
      target: identity.target,
      boundary: "prepared-target",
    }),
  );
  const { producerId, executorSha, ...fenceValue } = observation;
  label(expected.writerFence.producerId);
  same(producerId, expected.writerFence.producerId);
  same(executorSha, identity.executorSha);
  same(expected.writerFence.executorSha, identity.executorSha);
  fence(fenceValue, identity.operationId, identity.target, "prepared-target", { fresh: false });
  for (const key of ["fenceId", "enforcementSha256", "beganAt"])
    same(fenceValue[key], record.fence[key]);
  same(
    (await fingerprintHostConfiguration({ root: expected.root, ...expected.configuration }))
      .configurationSha256,
    identity.configurationSha256,
  );
  const checkedAt = Date.now();
  fresh(document.startedAt, record.fence.beganAt, policy.maxAgeMs, checkedAt);
  fresh(evidence.completedAt, record.fence.beganAt, policy.maxAgeMs, checkedAt);
  fresh(workload.observedAt, record.fence.beganAt, 30000, checkedAt);
  fresh(fenceValue.observedAt, record.fence.beganAt, 30000, checkedAt);
  // Long adapters cannot extend the validity of older attestations/certificates.
  for (const name of names)
    fresh(record.observations[name].observedAt, record.fence.beganAt, policy.maxAgeMs, checkedAt);
  ensure(timestamp(tls.expiresAt) > checkedAt);
  if (record.version === 2)
    validateProductionAuthorization(record, document, evidence, backupProof, checkedAt);
  return { record, backupProof };
}
