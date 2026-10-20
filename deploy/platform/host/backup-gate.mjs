import { inventoryDocumentOptions } from "./files.mjs";
import { hashArchive } from "../backup/files.mjs";
import { readPrivateAbsolute } from "../backup/local-runtime.mjs";
import { validateBackupInventory } from "../backup/restore.mjs";
import {
  canonical,
  completedEvidence,
  digest,
  ensure,
  keys,
  plain,
  timestamp,
} from "../backup/schemas.mjs";
import { validateIdentity } from "./state-validation.mjs";

// Private cooperating-operator storage and reviewed producer code are trusted.
// This verifies bytes and bindings, not the truth of arbitrary caller JSON.
export async function readVerifiedBackup({ root, identity, backup, restoreEvidence }) {
  identity = validateIdentity(plain(identity));
  backup = plain(backup);
  restoreEvidence = plain(restoreEvidence);
  keys(backup, ["archivePath", "archiveSha256", "inventoryPath", "inventorySha256"]);
  keys(restoreEvidence, ["evidencePath", "evidenceSha256"]);
  const inventoryBytes = await readPrivateAbsolute(
    root,
    backup.inventoryPath,
    inventoryDocumentOptions,
  );
  const evidenceBytes = await readPrivateAbsolute(root, restoreEvidence.evidencePath);
  ensure(
    digest(inventoryBytes) === backup.inventorySha256 &&
      digest(evidenceBytes) === restoreEvidence.evidenceSha256,
  );
  const document = validateBackupInventory(JSON.parse(inventoryBytes), {
    ...identity,
    archiveSha256: backup.archiveSha256,
  });
  const evidence = completedEvidence(JSON.parse(evidenceBytes), { ...identity, ...backup });
  const archive = await hashArchive(root, backup.archivePath);
  ensure(archive.sha256 === backup.archiveSha256 && archive.bytes === document.archiveBytes);
  ensure(
    document.executorSha === identity.executorSha && evidence.executorSha === identity.executorSha,
  );
  for (const key of ["provenance", "snapshotId", "fence", "runtime"])
    ensure(canonical(document[key]) === canonical(evidence[key]));
  ensure(
    timestamp(document.fence.before.beganAt) <= timestamp(document.startedAt) &&
      timestamp(document.completedAt) <= timestamp(evidence.startedAt) &&
      timestamp(evidence.completedAt) <= Date.now(),
  );
  ensure(
    evidence.unvalidatedSourceConstraints ===
      document.inventory.constraints.filter((c) => !c.validated).length,
  );
  const prefix = `markiro-backup-${identity.operationId}-restore`;
  ensure(
    canonical(evidence.cleanup.resources) ===
      canonical([
        { kind: "volume", name: `${prefix}-data` },
        { kind: "volume", name: `${prefix}-input` },
        { kind: "container", name: `${prefix}-init` },
        { kind: "container", name: `${prefix}-worker` },
      ]),
  );
  // Recheck metadata after streaming a potentially large archive.
  ensure(
    digest(await readPrivateAbsolute(root, backup.inventoryPath, inventoryDocumentOptions)) ===
      backup.inventorySha256 &&
      digest(await readPrivateAbsolute(root, restoreEvidence.evidencePath)) ===
        restoreEvidence.evidenceSha256,
  );
  return {
    document,
    evidence,
    backupProof: {
      archiveSha256: archive.sha256,
      restoreEvidenceSha256: digest(evidenceBytes),
      target: plain(identity.target),
      operationId: identity.operationId,
    },
  };
}
export async function verifyBackupGate(options) {
  return (await readVerifiedBackup(options)).backupProof;
}
