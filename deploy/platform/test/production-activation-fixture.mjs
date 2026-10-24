import { digest } from "../backup/schemas.mjs";
import { preparedFixture } from "./prepared-target-fixture.mjs";
export function productionAuthorization(
  record,
  { document, backup, restoreEvidence },
  now = Date.now(),
) {
  const observedAt = new Date(now).toISOString(),
    expiresAt = new Date(now + 1800000).toISOString();
  const review = {
    version: 1,
    kind: "platform-retained-intent-review",
    operationId: record.operationId,
    target: record.target,
    executorSha: record.executorSha,
    configurationSha256: record.configurationSha256,
    fenceId: record.fence.fenceId,
    snapshotId: document.snapshotId,
    archiveSha256: backup.archiveSha256,
    restoreEvidenceSha256: restoreEvidence.evidenceSha256,
    asOf: observedAt,
    observedAt,
    projection: [
      "public.email_deliveries",
      "public.email_outbox",
      "public.platform_reports",
      "public.standalone_support_diagnostics",
      "pgboss_platform.job",
      "pgboss.job",
    ].map((table) => ({ table, rows: 0, pending: 0, expired: 0, sha256: digest("") })),
  };
  return {
    mode: "production-activation",
    approved: true,
    actor: "fixture-operator",
    reference: "explicit-first-production-approval",
    smtp: "production",
    s3: "production",
    retainedMail: "authorized",
    reportJobs: "authorized",
    legacyQueues: "disabled",
    retention: "authorized",
    review,
    reviewSha256: digest(review),
    sourceHold: {
      kind: "operator-attestation",
      held: true,
      actor: "fixture-operator",
      reference: "source-held-after-backup",
      evidenceSha256: "c".repeat(64),
      observedAt,
      expiresAt: new Date(now + 3600000).toISOString(),
    },
    expiresAt,
  };
}
export async function productionFixture(t, options) {
  const f = await preparedFixture(t, options);
  f.record.version = 2;
  for (const x of [f.record, f.document, f.evidence, f.expected]) x.provenance = "live-source";
  for (const x of [f.document.runtime, f.evidence.runtime]) x.architecture = "amd64";
  Object.assign(f.expected.postgres, { architecture: "amd64", uid: 70, gid: 70 });
  Object.assign(f.record.observations.postgres.value, f.expected.postgres);
  await f.publish();
  Object.assign(f.record.observations.restoredSnapshot.value, {
    inventorySha256: f.backup.inventorySha256,
    restoreEvidenceSha256: f.restoreEvidence.evidenceSha256,
    workerArchitecture: "amd64",
  });
  const at = Date.now();
  f.record.observations.egress.observedAt = new Date(at).toISOString();
  f.record.observations.egress.value = productionAuthorization(f.record, f, at);
  return f;
}
