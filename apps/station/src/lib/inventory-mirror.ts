import {
  canonicalizeKm,
  classifyInventorySnapshotRow,
  INVENTORY_CHZ_STATUSES,
  kmHash,
  type InventoryChzStatus,
} from "@markiro/domain";

import type { SqlExecutor } from "./mirror.js";

export interface InventoryBundleManifest {
  inventoryId: string;
  inventoryNumber: string;
  snapshotId: string;
  snapshotRevision: 1;
  combinedDigest: string;
  codeCount: number;
  productId: string;
  productName: string;
  gtin14: string;
  boxCapacity: number;
  mode: "check" | "repack";
  lineId: string;
  lineName: string;
  productionDateFrom: string;
  productionDateTo: string;
  boxLabelTemplate: { id: string; name: string; spec: unknown } | null;
  limits: { codePageSize: 200; eventBatchSize: 100; progressPageSize: 200 };
  sscc: {
    issuerPrefix: string;
    extensionDigit: number;
    fromSerial: number;
    toSerial: number;
    consumedThroughSerial: number | null;
  } | null;
  ssccRevokedFrom: number[];
}

export interface InventoryBundleCode {
  codeHash: string;
  canonicalRaw: string;
  gtin14: string;
  serial: string;
  sourceStatus: InventoryChzStatus;
  sourceState: string | null;
  sourceProductionDate: string | null;
  parentSscc: string | null;
  expected: boolean;
  protected: boolean;
}

export interface InventoryBundlePage {
  snapshotId: string;
  snapshotRevision: 1;
  combinedDigest: string;
  items: readonly InventoryBundleCode[];
  nextCursor: string | null;
}

export interface InventoryMirrorCandidate {
  inventoryId: string;
  snapshotId: string;
  combinedDigest: string;
  codeCount: number;
  generation: number;
  manifest: InventoryBundleManifest;
  alreadyActive: boolean;
}

export interface InventoryMirrorState {
  activeSnapshotId: string | null;
  stagedSnapshotId: string | null;
  nextCursor: string | null;
  verifiedDigest: string | null;
  stagedCodeCount: number;
  generation: number;
}

interface TaskStateRow {
  inventory_number: string;
  active_snapshot_id: string | null;
  active_combined_digest: string | null;
  active_code_count: number | null;
  staged_snapshot_id: string | null;
  staged_combined_digest: string | null;
  staged_code_count: number | null;
  staged_manifest_json: string | null;
  staged_next_cursor: string | null;
  staged_verified_digest: string | null;
  staging_generation: number;
}

interface StoredCodeRow {
  snapshot_id: string;
  code_hash: string;
  canonical_raw: string;
  gtin14: string;
  serial: string;
  source_status: string;
  source_state: string | null;
  source_production_date: string | null;
  parent_sscc: string | null;
  expected: number;
  protected: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const GTIN14 = /^[0-9]{14}$/;
const CIVIL_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const SSCC18 = /^[0-9]{18}$/;
const STATUS_SET = new Set<string>(INVENTORY_CHZ_STATUSES);

function requireManifest(manifest: InventoryBundleManifest): void {
  if (
    !UUID.test(manifest.inventoryId) ||
    !UUID.test(manifest.snapshotId) ||
    manifest.snapshotRevision !== 1 ||
    !SHA256.test(manifest.combinedDigest) ||
    !Number.isSafeInteger(manifest.codeCount) ||
    manifest.codeCount < 0 ||
    !GTIN14.test(manifest.gtin14) ||
    !CIVIL_DATE.test(manifest.productionDateFrom) ||
    !CIVIL_DATE.test(manifest.productionDateTo) ||
    manifest.productionDateFrom > manifest.productionDateTo ||
    manifest.limits.codePageSize !== 200 ||
    manifest.limits.eventBatchSize !== 100 ||
    manifest.limits.progressPageSize !== 200 ||
    (manifest.mode === "check" && manifest.boxLabelTemplate !== null) ||
    (manifest.mode === "repack" && manifest.boxLabelTemplate === null)
  ) {
    throw new Error("invalid inventory bundle manifest");
  }
}

function requirePageIdentity(candidate: InventoryMirrorCandidate, page: InventoryBundlePage): void {
  if (page.snapshotId !== candidate.snapshotId || page.snapshotRevision !== 1) {
    throw new Error("inventory bundle snapshot mismatch");
  }
  if (page.combinedDigest !== candidate.combinedDigest) {
    throw new Error("inventory bundle digest mismatch");
  }
}

function sameStoredCode(row: StoredCodeRow, item: InventoryBundleCode): boolean {
  return (
    row.code_hash === item.codeHash &&
    row.canonical_raw === item.canonicalRaw &&
    row.gtin14 === item.gtin14 &&
    row.serial === item.serial &&
    row.source_status === item.sourceStatus &&
    row.source_state === item.sourceState &&
    row.source_production_date === item.sourceProductionDate &&
    row.parent_sscc === item.parentSscc &&
    row.expected === (item.expected ? 1 : 0) &&
    row.protected === (item.protected ? 1 : 0)
  );
}

function validateCode(candidate: InventoryMirrorCandidate, item: InventoryBundleCode): void {
  if (
    !SHA256.test(item.codeHash) ||
    !GTIN14.test(item.gtin14) ||
    !STATUS_SET.has(item.sourceStatus) ||
    (item.sourceProductionDate !== null && !CIVIL_DATE.test(item.sourceProductionDate)) ||
    (item.parentSscc !== null && !SSCC18.test(item.parentSscc))
  ) {
    throw new Error("invalid inventory bundle code");
  }

  let km: ReturnType<typeof canonicalizeKm>;
  try {
    km = canonicalizeKm(item.canonicalRaw);
  } catch {
    throw new Error("inventory bundle code identity mismatch");
  }
  if (
    km.raw !== item.canonicalRaw ||
    kmHash(km) !== item.codeHash ||
    km.gtin14 !== item.gtin14 ||
    km.gtin14 !== candidate.manifest.gtin14 ||
    km.serial !== item.serial
  ) {
    throw new Error("inventory bundle code identity mismatch");
  }

  const classification = classifyInventorySnapshotRow(
    {
      gtin14: item.gtin14,
      status: item.sourceStatus,
      state: item.sourceState,
      sourceProductionDate: item.sourceProductionDate,
    },
    {
      productionDateFrom: candidate.manifest.productionDateFrom,
      productionDateTo: candidate.manifest.productionDateTo,
    },
  );
  if (classification.expected !== item.expected || classification.protected !== item.protected) {
    throw new Error("inventory bundle code classification mismatch");
  }
}

async function taskState(exec: SqlExecutor, inventoryId: string): Promise<TaskStateRow | null> {
  const rows = await exec.all<TaskStateRow>(
    `SELECT inventory_number, active_snapshot_id, active_combined_digest, active_code_count,
            staged_snapshot_id, staged_combined_digest, staged_code_count,
            staged_manifest_json, staged_next_cursor, staged_verified_digest,
            staging_generation
       FROM inventory_task_mirror
      WHERE inventory_id = ?`,
    [inventoryId],
  );
  return rows[0] ?? null;
}

/**
 * Starts or resumes one staged revision. One upsert selects a new monotonic
 * generation only when the candidate identity changes; this is the fence that
 * stops an older in-flight request from publishing after a newer download.
 */
export async function beginInventoryMirror(
  exec: SqlExecutor,
  manifest: InventoryBundleManifest,
): Promise<InventoryMirrorCandidate> {
  requireManifest(manifest);
  const manifestJson = JSON.stringify(manifest);
  const before = await taskState(exec, manifest.inventoryId);
  if (
    before?.active_snapshot_id === manifest.snapshotId &&
    before.active_combined_digest === manifest.combinedDigest &&
    before.active_code_count === manifest.codeCount
  ) {
    return {
      inventoryId: manifest.inventoryId,
      snapshotId: manifest.snapshotId,
      combinedDigest: manifest.combinedDigest,
      codeCount: manifest.codeCount,
      generation: before.staging_generation,
      manifest,
      alreadyActive: true,
    };
  }

  await exec.run(
    `INSERT INTO inventory_task_mirror (
       inventory_id, inventory_number,
       staged_snapshot_id, staged_snapshot_revision, staged_combined_digest,
       staged_code_count, staged_manifest_json, staged_next_cursor,
       staged_verified_digest, staging_generation, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, NULL, 1, ?)
     ON CONFLICT(inventory_id) DO UPDATE SET
       inventory_number = excluded.inventory_number,
       staged_snapshot_id = excluded.staged_snapshot_id,
       staged_snapshot_revision = excluded.staged_snapshot_revision,
       staged_combined_digest = excluded.staged_combined_digest,
       staged_code_count = excluded.staged_code_count,
       staged_manifest_json = excluded.staged_manifest_json,
       staged_next_cursor = CASE
         WHEN inventory_task_mirror.staged_snapshot_id = excluded.staged_snapshot_id
          AND inventory_task_mirror.staged_combined_digest = excluded.staged_combined_digest
          AND inventory_task_mirror.staged_code_count = excluded.staged_code_count
          AND inventory_task_mirror.staged_manifest_json = excluded.staged_manifest_json
         THEN inventory_task_mirror.staged_next_cursor ELSE NULL END,
       staged_verified_digest = CASE
         WHEN inventory_task_mirror.staged_snapshot_id = excluded.staged_snapshot_id
          AND inventory_task_mirror.staged_combined_digest = excluded.staged_combined_digest
          AND inventory_task_mirror.staged_code_count = excluded.staged_code_count
          AND inventory_task_mirror.staged_manifest_json = excluded.staged_manifest_json
         THEN inventory_task_mirror.staged_verified_digest ELSE NULL END,
       staging_generation = CASE
         WHEN inventory_task_mirror.staged_snapshot_id = excluded.staged_snapshot_id
          AND inventory_task_mirror.staged_combined_digest = excluded.staged_combined_digest
          AND inventory_task_mirror.staged_code_count = excluded.staged_code_count
          AND inventory_task_mirror.staged_manifest_json = excluded.staged_manifest_json
         THEN inventory_task_mirror.staging_generation
         ELSE inventory_task_mirror.staging_generation + 1 END,
       updated_at = excluded.updated_at`,
    [
      manifest.inventoryId,
      manifest.inventoryNumber,
      manifest.snapshotId,
      manifest.combinedDigest,
      manifest.codeCount,
      manifestJson,
      new Date().toISOString(),
    ],
  );
  const staged = await taskState(exec, manifest.inventoryId);
  if (staged?.staged_snapshot_id !== manifest.snapshotId) {
    throw new Error("inventory bundle staging was superseded");
  }
  return {
    inventoryId: manifest.inventoryId,
    snapshotId: manifest.snapshotId,
    combinedDigest: manifest.combinedDigest,
    codeCount: manifest.codeCount,
    generation: staged.staging_generation,
    manifest,
    alreadyActive: false,
  };
}

async function exactDuplicatePage(
  exec: SqlExecutor,
  candidate: InventoryMirrorCandidate,
  page: InventoryBundlePage,
): Promise<boolean> {
  for (const item of page.items) {
    const stored = await exec.all<StoredCodeRow>(
      `SELECT snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
              source_state, source_production_date, parent_sscc, expected, protected
         FROM inventory_snapshot_codes_mirror
        WHERE snapshot_id = ? AND code_hash = ?`,
      [candidate.snapshotId, item.codeHash],
    );
    if (!stored[0] || !sameStoredCode(stored[0], item)) return false;
  }
  return page.items.length > 0;
}

/** Inserts one immutable page idempotently and advances only its fenced cursor. */
export async function ingestInventoryPage(
  exec: SqlExecutor,
  candidate: InventoryMirrorCandidate,
  cursor: string | null,
  page: InventoryBundlePage,
): Promise<void> {
  requirePageIdentity(candidate, page);
  if (
    (cursor !== null && !SHA256.test(cursor)) ||
    (page.nextCursor !== null && !SHA256.test(page.nextCursor)) ||
    page.items.length > candidate.manifest.limits.codePageSize
  ) {
    throw new Error("invalid inventory bundle page");
  }
  const current = await taskState(exec, candidate.inventoryId);
  if (
    current?.staged_snapshot_id !== candidate.snapshotId ||
    current.staged_combined_digest !== candidate.combinedDigest ||
    current.staging_generation !== candidate.generation
  ) {
    throw new Error("inventory bundle staging was superseded");
  }

  if (cursor !== current.staged_next_cursor) {
    if (await exactDuplicatePage(exec, candidate, page)) {
      if (page.nextCursor !== current.staged_next_cursor) {
        throw new Error("inventory bundle next cursor mismatch");
      }
      return;
    }
    throw new Error("inventory bundle cursor mismatch");
  }

  let previous = cursor;
  const seen = new Set<string>();
  for (const item of page.items) {
    validateCode(candidate, item);
    if (seen.has(item.codeHash) || (previous !== null && item.codeHash <= previous)) {
      throw new Error("inventory bundle code order mismatch");
    }
    seen.add(item.codeHash);
    previous = item.codeHash;
  }
  if (
    (page.nextCursor !== null &&
      (page.items.length === 0 || page.nextCursor !== page.items.at(-1)?.codeHash)) ||
    (page.nextCursor === null && page.items.length > 0 && previous === cursor)
  ) {
    throw new Error("inventory bundle next cursor mismatch");
  }

  for (const item of page.items) {
    await exec.run(
      `INSERT INTO inventory_snapshot_codes_mirror (
         snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
         source_production_date, parent_sscc, expected, protected
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, code_hash) DO NOTHING`,
      [
        candidate.snapshotId,
        item.codeHash,
        item.canonicalRaw,
        item.gtin14,
        item.serial,
        item.sourceStatus,
        item.sourceState,
        item.sourceProductionDate,
        item.parentSscc,
        item.expected ? 1 : 0,
        item.protected ? 1 : 0,
      ],
    );
    const stored = await exec.all<StoredCodeRow>(
      `SELECT snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
              source_state, source_production_date, parent_sscc, expected, protected
         FROM inventory_snapshot_codes_mirror
        WHERE snapshot_id = ? AND code_hash = ?`,
      [candidate.snapshotId, item.codeHash],
    );
    if (!stored[0] || !sameStoredCode(stored[0], item)) {
      throw new Error("inventory bundle duplicate code conflict");
    }
  }

  // This one guarded UPDATE publishes the page cursor and, for the final
  // page only, the count/digest verification marker. Individual code inserts
  // may already exist after a crash; replay is harmless and reaches this same
  // marker once the complete page is durable.
  await exec.run(
    `UPDATE inventory_task_mirror
        SET staged_next_cursor = ?,
            staged_verified_digest = CASE
              WHEN ? IS NULL
               AND (SELECT COUNT(*) FROM inventory_snapshot_codes_mirror
                     WHERE snapshot_id = ?) = staged_code_count
              THEN staged_combined_digest ELSE NULL END,
            updated_at = ?
      WHERE inventory_id = ?
        AND staged_snapshot_id = ?
        AND staged_snapshot_revision = 1
        AND staged_combined_digest = ?
        AND staging_generation = ?
        AND staged_next_cursor IS ?`,
    [
      page.nextCursor,
      page.nextCursor,
      candidate.snapshotId,
      new Date().toISOString(),
      candidate.inventoryId,
      candidate.snapshotId,
      candidate.combinedDigest,
      candidate.generation,
      cursor,
    ],
  );
  const after = await taskState(exec, candidate.inventoryId);
  if (
    after?.staged_snapshot_id !== candidate.snapshotId ||
    after.staging_generation !== candidate.generation
  ) {
    throw new Error("inventory bundle staging was superseded");
  }
  if (after.staged_next_cursor !== page.nextCursor) {
    throw new Error("inventory bundle cursor mismatch");
  }
}

/**
 * Publishes active_snapshot_id with one SQLite statement. Its WHERE clause is
 * the atomic boundary: the exact generation, verified digest marker and
 * durable row count must all still match when SQLite executes the update.
 */
export async function publishInventorySnapshot(
  exec: SqlExecutor,
  candidate: InventoryMirrorCandidate,
): Promise<boolean> {
  const before = await taskState(exec, candidate.inventoryId);
  if (
    before?.active_snapshot_id === candidate.snapshotId &&
    before.active_combined_digest === candidate.combinedDigest &&
    before.active_code_count === candidate.codeCount
  ) {
    return true;
  }

  await exec.run(
    `UPDATE inventory_task_mirror
        SET active_snapshot_id = staged_snapshot_id,
            active_snapshot_revision = staged_snapshot_revision,
            active_combined_digest = staged_combined_digest,
            active_code_count = staged_code_count,
            active_manifest_json = staged_manifest_json,
            staged_snapshot_id = NULL,
            staged_snapshot_revision = NULL,
            staged_combined_digest = NULL,
            staged_code_count = NULL,
            staged_manifest_json = NULL,
            staged_next_cursor = NULL,
            staged_verified_digest = NULL,
            updated_at = ?
      WHERE inventory_id = ?
        AND staged_snapshot_id = ?
        AND staged_snapshot_revision = 1
        AND staged_combined_digest = ?
        AND staged_code_count = ?
        AND staging_generation = ?
        AND staged_verified_digest = ?
        AND (SELECT COUNT(*) FROM inventory_snapshot_codes_mirror
              WHERE snapshot_id = ?) = staged_code_count`,
    [
      new Date().toISOString(),
      candidate.inventoryId,
      candidate.snapshotId,
      candidate.combinedDigest,
      candidate.codeCount,
      candidate.generation,
      candidate.combinedDigest,
      candidate.snapshotId,
    ],
  );
  const after = await taskState(exec, candidate.inventoryId);
  const published =
    after?.active_snapshot_id === candidate.snapshotId &&
    after.active_combined_digest === candidate.combinedDigest &&
    after.active_code_count === candidate.codeCount;
  if (!published) return false;

  // Cleanup deliberately follows successful pointer publication. Keep every
  // snapshot still active or staged by any task so concurrent inventories are
  // never damaged by another task's revision switch.
  await exec.run(
    `DELETE FROM inventory_snapshot_codes_mirror
      WHERE snapshot_id NOT IN (
        SELECT active_snapshot_id FROM inventory_task_mirror WHERE active_snapshot_id IS NOT NULL
        UNION
        SELECT staged_snapshot_id FROM inventory_task_mirror WHERE staged_snapshot_id IS NOT NULL
      )`,
  );
  return true;
}

export async function readInventoryMirrorState(
  exec: SqlExecutor,
  inventoryId: string,
): Promise<InventoryMirrorState | null> {
  const row = await taskState(exec, inventoryId);
  if (!row) return null;
  const counts =
    row.staged_snapshot_id === null
      ? []
      : await exec.all<{ count: number }>(
          "SELECT COUNT(*) AS count FROM inventory_snapshot_codes_mirror WHERE snapshot_id = ?",
          [row.staged_snapshot_id],
        );
  return {
    activeSnapshotId: row.active_snapshot_id,
    stagedSnapshotId: row.staged_snapshot_id,
    nextCursor: row.staged_next_cursor,
    verifiedDigest: row.staged_verified_digest,
    stagedCodeCount: counts[0]?.count ?? 0,
    generation: row.staging_generation,
  };
}
