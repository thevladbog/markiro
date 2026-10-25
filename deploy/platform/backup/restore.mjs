import { carryHostFailure } from "../host/failure-diagnostic.mjs";
import { validateCatalogBackup } from "./catalog.mjs";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  createPrivateDirectory,
  writePrivateFile,
  readPrivateFile,
  inventoryDocumentOptions,
} from "../host/files.mjs";
import { hashArchive, publishArchive } from "./files.mjs";
import { readPrivateAbsolute, openRuntime } from "./local-runtime.mjs";
import { mapInventory, compareInventories } from "./inventory.mjs";
import {
  validateFencePair,
  timestamp,
  runtimeIdentity,
  identity,
  plain,
  bound,
  keys,
  canonical,
  digest,
  ensure,
  hash,
  validateInventory,
  completedEvidence,
  fail,
} from "./schemas.mjs";
export function validateBackupInventory(document, { operationId, target, archiveSha256 }) {
  const v = plain(document);
  keys(v, [
    "version",
    "kind",
    "operationId",
    "target",
    "executorSha",
    "provenance",
    "archiveSha256",
    "archiveBytes",
    "snapshotId",
    "fence",
    "startedAt",
    "completedAt",
    "runtime",
    "inventory",
    ...(Object.hasOwn(v, "catalogBackup") ? ["catalogBackup"] : []),
  ]);
  bound(v, operationId, target);
  ensure(
    v.version === 1 &&
      v.kind === "platform-database-backup" &&
      v.archiveSha256 === archiveSha256 &&
      Number.isSafeInteger(v.archiveBytes) &&
      v.archiveBytes > 0 &&
      /^[A-F0-9-]+$/u.test(v.snapshotId) &&
      /^[a-f0-9]{40}$/u.test(v.executorSha) &&
      ["local-synthetic", "live-source"].includes(v.provenance),
  );
  validateFencePair(v.fence, operationId, target);
  runtimeIdentity(v.runtime);
  ensure(
    timestamp(v.startedAt) <= timestamp(v.fence.before.observedAt) &&
      timestamp(v.fence.after.observedAt) <= timestamp(v.completedAt) &&
      timestamp(v.completedAt) <= Date.now() + 30000,
  );
  validateInventory(v.inventory);
  validateCatalogBackup(v.catalogBackup, v.inventory);
  return v;
}
export async function verifyDatabaseRestore({
  root,
  operationId,
  target,
  backup,
  roleMapping,
  run,
  recoveryRuntime,
  beforeFailureCleanup,
}) {
  ensure(beforeFailureCleanup === undefined || typeof beforeFailureCleanup === "function");
  identity(operationId, target);
  target = plain(target);
  backup = plain(backup);
  roleMapping = plain(roleMapping);
  keys(backup, ["archivePath", "archiveSha256", "inventoryPath", "inventorySha256"]);
  ensure(hash(backup.archiveSha256) && hash(backup.inventorySha256) && typeof run === "function");
  const inventoryBytes = await readPrivateAbsolute(
    root,
    backup.inventoryPath,
    inventoryDocumentOptions,
  );
  ensure(digest(inventoryBytes) === backup.inventorySha256);
  const document = validateBackupInventory(JSON.parse(inventoryBytes), {
    operationId,
    target,
    archiveSha256: backup.archiveSha256,
  });
  const archive = await hashArchive(root, backup.archivePath);
  ensure(archive.sha256 === backup.archiveSha256 && archive.bytes === document.archiveBytes);
  const expected = mapInventory(document.inventory, roleMapping);
  const name = `restore-${operationId}`;
  await createPrivateDirectory(root, name);
  const directory = join(root, name);
  await createPrivateDirectory(directory, "input");
  await createPrivateDirectory(directory, "output");
  const input = join(directory, "input"),
    output = join(directory, "output"),
    startedAt = new Date().toISOString();
  let runtime, cleanup, problem, restored;
  try {
    const copy = await publishArchive(input, backup.archivePath, "database.dump", {
      sourceRoot: root,
    });
    ensure(copy.sha256 === backup.archiveSha256);
    await writePrivateFile(
      input,
      "request.json",
      Buffer.from(canonical({ inventory: document.inventory, roleMapping })),
      inventoryDocumentOptions,
    );
    runtime = await openRuntime({ root, operationId, purpose: "restore", run, recoveryRuntime });
    ensure(
      runtime.config.executorSha === document.executorSha &&
        runtime.config.provenance === document.provenance &&
        runtime.config.image === document.runtime.image,
    );
    await runtime.prepare(input, "none");
    await runtime.execute();
    await runtime.output(output);
    restored = JSON.parse(await readPrivateFile(output, "restored.json", inventoryDocumentOptions));
    compareInventories(expected, restored.inventory);
    ensure(restored.postgresVersion.startsWith("17."));
    ensure((await hashArchive(root, backup.archivePath)).sha256 === backup.archiveSha256);
    ensure(
      digest(await readPrivateAbsolute(root, backup.inventoryPath, inventoryDocumentOptions)) ===
        backup.inventorySha256,
    );
  } catch (error) {
    if (beforeFailureCleanup) await beforeFailureCleanup(error);
    problem = error;
  }
  if (
    beforeFailureCleanup &&
    (problem?.terminationConfirmed === false || problem?.durabilityUncertain === true)
  )
    throw problem;
  try {
    cleanup = runtime ? await runtime.cleanup() : { verified: true, resources: [] };
  } catch (error) {
    if (beforeFailureCleanup) await beforeFailureCleanup(error);
    cleanup = error.cleanup;
    if (problem && beforeFailureCleanup) problem.durabilityUncertain = true;
    else problem = carryHostFailure(error, fail("cleanup"));
  }
  await rm(input, { recursive: true, force: true }).catch(async (error) => {
    if (beforeFailureCleanup) await beforeFailureCleanup(error);
    if (!beforeFailureCleanup || !problem) problem = carryHostFailure(error, fail("cleanup"));
    if (cleanup) cleanup.verified = false;
  });
  await rm(output, { recursive: true, force: true }).catch(async (error) => {
    if (beforeFailureCleanup) await beforeFailureCleanup(error);
    if (!beforeFailureCleanup || !problem) problem = carryHostFailure(error, fail("cleanup"));
    if (cleanup) cleanup.verified = false;
  });
  if (problem) {
    const evidence = {
      version: 1,
      kind: "platform-database-restore",
      status: "recovery-required",
      operationId,
      target,
      archiveSha256: backup.archiveSha256,
      inventorySha256: backup.inventorySha256,
      stage: problem.stage ?? "restore",
      cleanup: cleanup ?? { verified: false, resources: [] },
    };
    await writePrivateFile(directory, "failure.json", Buffer.from(canonical(evidence) + "\n"));
    throw carryHostFailure(problem, fail(problem.stage ?? "restore"));
  }
  const evidence = {
    version: 1,
    kind: "platform-database-restore",
    status: "completed",
    operationId,
    target,
    executorSha: runtime.config.executorSha,
    provenance: runtime.config.provenance,
    archiveSha256: backup.archiveSha256,
    inventorySha256: backup.inventorySha256,
    roleMappingSha256: digest(roleMapping),
    restoredInventorySha256: digest(restored.inventory),
    snapshotId: document.snapshotId,
    fence: document.fence,
    startedAt,
    completedAt: new Date().toISOString(),
    runtime: {
      image: runtime.config.image,
      architecture: runtime.architecture,
      postgresVersion: restored.postgresVersion,
    },
    unvalidatedSourceConstraints: document.inventory.constraints.filter((c) => !c.validated).length,
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
    cleanup,
  };
  completedEvidence(evidence, { operationId, target, ...backup });
  const bytes = Buffer.from(canonical(evidence) + "\n");
  await writePrivateFile(directory, "evidence.json", bytes);
  return { evidencePath: join(directory, "evidence.json"), evidenceSha256: digest(bytes) };
}
