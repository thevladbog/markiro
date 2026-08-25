import {
  canonicalizeKm,
  classifyInventorySnapshotRow,
  inventorySnapshotContentDigest,
  inventorySnapshotPageDigest,
  kmHash,
  parseStationInventoryBundleManifest,
  parseStationInventoryBundlePage,
  type StationInventoryBundleCode,
  type StationInventoryBundleManifest,
  type StationInventoryBundlePage,
} from "@markiro/domain";

import type { SqlExecutor } from "./mirror.js";

export type InventoryBundleManifest = StationInventoryBundleManifest;
export type InventoryBundleCode = StationInventoryBundleCode;
export type InventoryBundlePage = StationInventoryBundlePage;

export interface InventoryMirrorCandidate {
  inventoryId: string;
  snapshotId: string;
  snapshotFixedAt: string;
  combinedDigest: string;
  contentDigest: string;
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
  verifiedContentDigest: string | null;
  lastPageDigest: string | null;
  stagedCodeCount: number;
  generation: number;
}

interface TaskStateRow {
  inventory_number: string;
  active_snapshot_id: string | null;
  active_snapshot_fixed_at: string | null;
  active_combined_digest: string | null;
  active_content_digest: string | null;
  active_code_count: number | null;
  active_manifest_json: string | null;
  staged_snapshot_id: string | null;
  staged_snapshot_fixed_at: string | null;
  staged_combined_digest: string | null;
  staged_content_digest: string | null;
  staged_code_count: number | null;
  staged_manifest_json: string | null;
  staged_next_cursor: string | null;
  staged_verified_digest: string | null;
  staged_verified_content_digest: string | null;
  staged_last_page_digest: string | null;
  staging_generation: number;
}

interface StoredCodeRow {
  snapshot_id: string;
  code_hash: string;
  canonical_raw: string;
  gtin14: string;
  serial: string;
  source_status: InventoryBundleCode["sourceStatus"];
  source_state: string | null;
  source_production_date: string | null;
  parent_sscc: string | null;
  expected: number;
  protected: number;
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

function storedCode(row: StoredCodeRow): InventoryBundleCode {
  return {
    codeHash: row.code_hash,
    canonicalRaw: row.canonical_raw,
    gtin14: row.gtin14,
    serial: row.serial,
    sourceStatus: row.source_status,
    sourceState: row.source_state,
    sourceProductionDate: row.source_production_date,
    parentSscc: row.parent_sscc,
    expected: row.expected === 1,
    protected: row.protected === 1,
  };
}

function validateCode(candidate: InventoryMirrorCandidate, item: InventoryBundleCode): void {
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
    `SELECT inventory_number,
            active_snapshot_id, active_snapshot_fixed_at, active_combined_digest,
            active_content_digest, active_code_count, active_manifest_json,
            staged_snapshot_id, staged_snapshot_fixed_at, staged_combined_digest,
            staged_content_digest, staged_code_count, staged_manifest_json,
            staged_next_cursor, staged_verified_digest, staged_verified_content_digest,
            staged_last_page_digest, staging_generation
       FROM inventory_task_mirror
      WHERE inventory_id = ?`,
    [inventoryId],
  );
  return rows[0] ?? null;
}

async function snapshotRows(exec: SqlExecutor, snapshotId: string): Promise<StoredCodeRow[]> {
  return exec.all<StoredCodeRow>(
    `SELECT snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
            source_state, source_production_date, parent_sscc, expected, protected
       FROM inventory_snapshot_codes_mirror
      WHERE snapshot_id = ?
      ORDER BY code_hash`,
    [snapshotId],
  );
}

function immutableManifest(manifest: InventoryBundleManifest): unknown {
  return Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "sscc" && key !== "ssccRevokedFrom"),
  );
}

function parseStoredManifest(
  json: string | null,
  incoming: InventoryBundleManifest,
): { manifest: InventoryBundleManifest; hasProof: boolean } {
  if (json === null) throw new Error("active inventory manifest is missing");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("active inventory manifest is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("active inventory manifest is invalid");
  }

  // Task 3 originally persisted manifests before these immutable proof fields
  // existed. A same-snapshot server response may fix those two facts once;
  // every other field still passes the current strict shared parser.
  const legacy = value as Record<string, unknown>;
  return {
    manifest: parseStationInventoryBundleManifest({
      ...legacy,
      snapshotFixedAt: legacy.snapshotFixedAt ?? incoming.snapshotFixedAt,
      contentDigest: legacy.contentDigest ?? incoming.contentDigest,
    }),
    hasProof:
      typeof legacy.snapshotFixedAt === "string" && typeof legacy.contentDigest === "string",
  };
}

function storedManifestHasProof(json: string | null): boolean {
  if (json === null) return false;
  try {
    const value: unknown = JSON.parse(json);
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).snapshotFixedAt === "string" &&
      typeof (value as Record<string, unknown>).contentDigest === "string"
    );
  } catch {
    return false;
  }
}

function sameImmutableManifest(
  current: InventoryBundleManifest,
  incoming: InventoryBundleManifest,
): boolean {
  return JSON.stringify(immutableManifest(current)) === JSON.stringify(immutableManifest(incoming));
}

function mergeSsccSafety(
  current: InventoryBundleManifest,
  incoming: InventoryBundleManifest,
): InventoryBundleManifest {
  if (!sameImmutableManifest(current, incoming)) {
    throw new Error("inventory snapshot immutable manifest mismatch");
  }
  if (current.mode === "check") return current;
  if (current.sscc === null || incoming.sscc === null) {
    throw new Error("unsafe inventory SSCC transition");
  }

  const revoked = [...new Set([...current.ssccRevokedFrom, ...incoming.ssccRevokedFrom])].sort(
    (left, right) => left - right,
  );
  const sameBlock =
    current.sscc.issuerPrefix === incoming.sscc.issuerPrefix &&
    current.sscc.extensionDigit === incoming.sscc.extensionDigit &&
    current.sscc.fromSerial === incoming.sscc.fromSerial &&
    current.sscc.toSerial === incoming.sscc.toSerial;

  let sscc: InventoryBundleManifest["sscc"];
  if (sameBlock) {
    const consumed = [
      current.sscc.consumedThroughSerial,
      incoming.sscc.consumedThroughSerial,
    ].filter((value): value is number => value !== null);
    sscc = {
      ...current.sscc,
      consumedThroughSerial: consumed.length === 0 ? null : Math.max(...consumed),
    };
  } else if (
    (incoming.ssccRevokedFrom.includes(current.sscc.fromSerial) ||
      current.sscc.consumedThroughSerial === current.sscc.toSerial) &&
    !revoked.includes(incoming.sscc.fromSerial)
  ) {
    sscc = incoming.sscc;
  } else if (current.ssccRevokedFrom.includes(incoming.sscc.fromSerial)) {
    sscc = current.sscc;
  } else {
    throw new Error("unsafe inventory SSCC transition");
  }

  return parseStationInventoryBundleManifest({ ...incoming, sscc, ssccRevokedFrom: revoked });
}

function candidateFrom(
  manifest: InventoryBundleManifest,
  generation: number,
  alreadyActive: boolean,
): InventoryMirrorCandidate {
  return {
    inventoryId: manifest.inventoryId,
    snapshotId: manifest.snapshotId,
    snapshotFixedAt: manifest.snapshotFixedAt,
    combinedDigest: manifest.combinedDigest,
    contentDigest: manifest.contentDigest,
    codeCount: manifest.codeCount,
    generation,
    manifest,
    alreadyActive,
  };
}

function fixedAtMillis(value: string): number {
  return new Date(value).getTime();
}

async function refreshActiveManifest(
  exec: SqlExecutor,
  before: TaskStateRow,
  incoming: InventoryBundleManifest,
): Promise<InventoryBundleManifest> {
  let observed = before;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      observed.active_snapshot_id !== incoming.snapshotId ||
      observed.active_combined_digest !== incoming.combinedDigest ||
      observed.active_code_count !== incoming.codeCount
    ) {
      throw new Error("inventory bundle active state changed");
    }
    const current = parseStoredManifest(observed.active_manifest_json, incoming).manifest;
    const merged = mergeSsccSafety(current, incoming);
    const currentJson = observed.active_manifest_json;
    const mergedJson = JSON.stringify(merged);
    await exec.run(
      `UPDATE inventory_task_mirror
          SET active_snapshot_fixed_at = ?, active_content_digest = ?,
              active_manifest_json = ?, inventory_number = ?, updated_at = ?
        WHERE inventory_id = ?
          AND active_snapshot_id = ?
          AND active_combined_digest = ?
          AND active_code_count = ?
          AND active_manifest_json IS ?`,
      [
        merged.snapshotFixedAt,
        merged.contentDigest,
        mergedJson,
        merged.inventoryNumber,
        new Date().toISOString(),
        merged.inventoryId,
        merged.snapshotId,
        merged.combinedDigest,
        merged.codeCount,
        currentJson,
      ],
    );
    const after = await taskState(exec, incoming.inventoryId);
    if (after?.active_manifest_json === mergedJson) return merged;
    if (after === null) throw new Error("inventory bundle active state changed");
    observed = after;
  }
  throw new Error("inventory bundle active manifest refresh was superseded");
}

async function resetLegacyStage(
  exec: SqlExecutor,
  inventoryId: string,
  before: TaskStateRow,
): Promise<void> {
  if (before.staged_snapshot_id === null) return;
  await exec.run(
    `UPDATE inventory_task_mirror
        SET staged_reset_snapshot_id = staged_snapshot_id,
            staged_snapshot_id = NULL, staged_snapshot_revision = NULL,
            staged_snapshot_fixed_at = NULL, staged_combined_digest = NULL,
            staged_content_digest = NULL, staged_code_count = NULL,
            staged_manifest_json = NULL, staged_next_cursor = NULL,
            staged_verified_digest = NULL, staged_verified_content_digest = NULL,
            staged_last_page_digest = NULL, staged_page_json = NULL,
            staging_generation = staging_generation + 1, updated_at = ?
      WHERE inventory_id = ?
        AND staged_snapshot_id = ?
        AND staged_snapshot_fixed_at IS ?
        AND staged_content_digest IS ?
        AND staged_manifest_json IS ?`,
    [
      new Date().toISOString(),
      inventoryId,
      before.staged_snapshot_id,
      before.staged_snapshot_fixed_at,
      before.staged_content_digest,
      before.staged_manifest_json,
    ],
  );
}

async function resetLegacyActive(
  exec: SqlExecutor,
  inventoryId: string,
  before: TaskStateRow,
): Promise<void> {
  if (before.active_snapshot_id === null) return;
  await exec.run(
    `UPDATE inventory_task_mirror
        SET staged_reset_snapshot_id = active_snapshot_id,
            active_snapshot_id = NULL, active_snapshot_revision = NULL,
            active_snapshot_fixed_at = NULL, active_combined_digest = NULL,
            active_content_digest = NULL, active_code_count = NULL,
            active_manifest_json = NULL,
            staged_snapshot_id = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_snapshot_id END,
            staged_snapshot_revision = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_snapshot_revision END,
            staged_snapshot_fixed_at = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_snapshot_fixed_at END,
            staged_combined_digest = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_combined_digest END,
            staged_content_digest = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_content_digest END,
            staged_code_count = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_code_count END,
            staged_manifest_json = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_manifest_json END,
            staged_next_cursor = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_next_cursor END,
            staged_verified_digest = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_verified_digest END,
            staged_verified_content_digest = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_verified_content_digest END,
            staged_last_page_digest = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_last_page_digest END,
            staged_page_json = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN NULL ELSE staged_page_json END,
            staging_generation = CASE WHEN staged_snapshot_id = active_snapshot_id
              THEN staging_generation + 1 ELSE staging_generation END,
            updated_at = ?
      WHERE inventory_id = ?
        AND active_snapshot_id = ?
        AND active_snapshot_fixed_at IS ?
        AND active_combined_digest IS ?
        AND active_content_digest IS ?
        AND active_code_count IS ?
        AND active_manifest_json IS ?`,
    [
      new Date().toISOString(),
      inventoryId,
      before.active_snapshot_id,
      before.active_snapshot_fixed_at,
      before.active_combined_digest,
      before.active_content_digest,
      before.active_code_count,
      before.active_manifest_json,
    ],
  );
}

/** Starts/resumes one server-ordered revision or monotonically tightens active SSCC safety. */
export async function beginInventoryMirror(
  exec: SqlExecutor,
  value: unknown,
): Promise<InventoryMirrorCandidate> {
  let manifest = parseStationInventoryBundleManifest(value);
  const before = await taskState(exec, manifest.inventoryId);

  if (before?.active_snapshot_id === manifest.snapshotId) {
    if (
      before.active_combined_digest !== manifest.combinedDigest ||
      before.active_code_count !== manifest.codeCount ||
      (before.active_snapshot_fixed_at !== null &&
        before.active_snapshot_fixed_at !== manifest.snapshotFixedAt) ||
      (before.active_content_digest !== null &&
        before.active_content_digest !== manifest.contentDigest)
    ) {
      throw new Error("inventory snapshot immutable fixation mismatch");
    }
    const legacyActive =
      before.active_snapshot_fixed_at === null ||
      before.active_content_digest === null ||
      !storedManifestHasProof(before.active_manifest_json);
    if (legacyActive) {
      const rows = (await snapshotRows(exec, manifest.snapshotId)).map(storedCode);
      if (
        rows.length !== manifest.codeCount ||
        inventorySnapshotContentDigest(rows) !== manifest.contentDigest
      ) {
        await resetLegacyActive(exec, manifest.inventoryId, before);
        return beginInventoryMirror(exec, manifest);
      }
    }
    manifest = await refreshActiveManifest(exec, before, manifest);
    const active = await taskState(exec, manifest.inventoryId);
    return candidateFrom(manifest, active?.staging_generation ?? before.staging_generation, true);
  }

  if (
    before?.staged_snapshot_id !== null &&
    before?.staged_snapshot_id !== undefined &&
    (before.staged_snapshot_fixed_at === null ||
      before.staged_content_digest === null ||
      !storedManifestHasProof(before.staged_manifest_json))
  ) {
    await resetLegacyStage(exec, manifest.inventoryId, before);
    return beginInventoryMirror(exec, manifest);
  }

  if (
    before !== null &&
    before.active_snapshot_id !== null &&
    (before?.active_snapshot_fixed_at === null ||
      fixedAtMillis(manifest.snapshotFixedAt) <= fixedAtMillis(before.active_snapshot_fixed_at))
  ) {
    throw new Error("inventory snapshot rollback rejected");
  }
  if (
    before !== null &&
    before.staged_snapshot_id !== null &&
    before.staged_snapshot_id !== manifest.snapshotId &&
    (before.staged_snapshot_fixed_at === null ||
      fixedAtMillis(manifest.snapshotFixedAt) <= fixedAtMillis(before.staged_snapshot_fixed_at))
  ) {
    throw new Error("inventory snapshot rollback rejected");
  }

  if (before?.staged_snapshot_id === manifest.snapshotId) {
    if (
      before.staged_combined_digest !== manifest.combinedDigest ||
      before.staged_code_count !== manifest.codeCount ||
      before.staged_snapshot_fixed_at !== manifest.snapshotFixedAt ||
      before.staged_content_digest !== manifest.contentDigest
    ) {
      throw new Error("inventory snapshot immutable fixation mismatch");
    }
    const current = parseStoredManifest(before.staged_manifest_json, manifest).manifest;
    manifest = mergeSsccSafety(current, manifest);
  }

  const manifestJson = JSON.stringify(manifest);
  await exec.run(
    `INSERT INTO inventory_task_mirror (
       inventory_id, inventory_number,
       staged_snapshot_id, staged_snapshot_revision, staged_snapshot_fixed_at,
       staged_combined_digest, staged_content_digest, staged_code_count,
       staged_manifest_json, staged_next_cursor, staged_verified_digest,
       staged_verified_content_digest, staged_last_page_digest, staged_page_json,
       staging_generation, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, ?)
     ON CONFLICT(inventory_id) DO UPDATE SET
       inventory_number = excluded.inventory_number,
       staged_snapshot_id = excluded.staged_snapshot_id,
       staged_snapshot_revision = excluded.staged_snapshot_revision,
       staged_snapshot_fixed_at = excluded.staged_snapshot_fixed_at,
       staged_combined_digest = excluded.staged_combined_digest,
       staged_content_digest = excluded.staged_content_digest,
       staged_code_count = excluded.staged_code_count,
       staged_manifest_json = excluded.staged_manifest_json,
       staged_next_cursor = CASE WHEN
         inventory_task_mirror.staged_snapshot_id = excluded.staged_snapshot_id AND
         inventory_task_mirror.staged_snapshot_fixed_at = excluded.staged_snapshot_fixed_at AND
         inventory_task_mirror.staged_combined_digest = excluded.staged_combined_digest AND
         inventory_task_mirror.staged_content_digest = excluded.staged_content_digest AND
         inventory_task_mirror.staged_code_count = excluded.staged_code_count
         THEN inventory_task_mirror.staged_next_cursor ELSE NULL END,
       staged_verified_digest = CASE WHEN
         inventory_task_mirror.staged_snapshot_id = excluded.staged_snapshot_id AND
         inventory_task_mirror.staged_snapshot_fixed_at = excluded.staged_snapshot_fixed_at AND
         inventory_task_mirror.staged_combined_digest = excluded.staged_combined_digest AND
         inventory_task_mirror.staged_content_digest = excluded.staged_content_digest AND
         inventory_task_mirror.staged_code_count = excluded.staged_code_count
         THEN inventory_task_mirror.staged_verified_digest ELSE NULL END,
       staged_verified_content_digest = CASE WHEN
         inventory_task_mirror.staged_snapshot_id = excluded.staged_snapshot_id AND
         inventory_task_mirror.staged_snapshot_fixed_at = excluded.staged_snapshot_fixed_at AND
         inventory_task_mirror.staged_combined_digest = excluded.staged_combined_digest AND
         inventory_task_mirror.staged_content_digest = excluded.staged_content_digest AND
         inventory_task_mirror.staged_code_count = excluded.staged_code_count
         THEN inventory_task_mirror.staged_verified_content_digest ELSE NULL END,
       staged_last_page_digest = CASE WHEN
         inventory_task_mirror.staged_snapshot_id = excluded.staged_snapshot_id AND
         inventory_task_mirror.staged_snapshot_fixed_at = excluded.staged_snapshot_fixed_at AND
         inventory_task_mirror.staged_combined_digest = excluded.staged_combined_digest AND
         inventory_task_mirror.staged_content_digest = excluded.staged_content_digest AND
         inventory_task_mirror.staged_code_count = excluded.staged_code_count
         THEN inventory_task_mirror.staged_last_page_digest ELSE NULL END,
       staged_page_json = NULL,
       staging_generation = CASE WHEN
         inventory_task_mirror.staged_snapshot_id = excluded.staged_snapshot_id AND
         inventory_task_mirror.staged_snapshot_fixed_at = excluded.staged_snapshot_fixed_at AND
         inventory_task_mirror.staged_combined_digest = excluded.staged_combined_digest AND
         inventory_task_mirror.staged_content_digest = excluded.staged_content_digest AND
         inventory_task_mirror.staged_code_count = excluded.staged_code_count
         THEN inventory_task_mirror.staging_generation
         ELSE inventory_task_mirror.staging_generation + 1 END,
       updated_at = excluded.updated_at
     WHERE (inventory_task_mirror.active_snapshot_id IS NULL OR
            inventory_task_mirror.active_snapshot_fixed_at < excluded.staged_snapshot_fixed_at)
       AND (inventory_task_mirror.staged_snapshot_id IS NULL OR
            inventory_task_mirror.staged_snapshot_id = excluded.staged_snapshot_id OR
            inventory_task_mirror.staged_snapshot_fixed_at < excluded.staged_snapshot_fixed_at)`,
    [
      manifest.inventoryId,
      manifest.inventoryNumber,
      manifest.snapshotId,
      manifest.snapshotFixedAt,
      manifest.combinedDigest,
      manifest.contentDigest,
      manifest.codeCount,
      manifestJson,
      new Date().toISOString(),
    ],
  );
  const staged = await taskState(exec, manifest.inventoryId);
  if (
    staged?.staged_snapshot_id !== manifest.snapshotId ||
    staged.staged_snapshot_fixed_at !== manifest.snapshotFixedAt ||
    staged.staged_combined_digest !== manifest.combinedDigest ||
    staged.staged_content_digest !== manifest.contentDigest ||
    staged.staged_code_count !== manifest.codeCount ||
    staged.staged_manifest_json !== manifestJson
  ) {
    if (
      staged?.active_snapshot_fixed_at === null ||
      (staged?.active_snapshot_fixed_at !== undefined &&
        fixedAtMillis(staged.active_snapshot_fixed_at) >=
          fixedAtMillis(manifest.snapshotFixedAt)) ||
      staged?.staged_snapshot_fixed_at === null ||
      (staged?.staged_snapshot_fixed_at !== undefined &&
        fixedAtMillis(staged.staged_snapshot_fixed_at) > fixedAtMillis(manifest.snapshotFixedAt))
    ) {
      throw new Error("inventory snapshot rollback rejected");
    }
    throw new Error("inventory bundle staging was superseded");
  }
  return candidateFrom(manifest, staged.staging_generation, false);
}

function requirePageIdentity(
  candidate: InventoryMirrorCandidate,
  cursor: string | null,
  page: InventoryBundlePage,
): void {
  if (
    page.snapshotId !== candidate.snapshotId ||
    page.snapshotRevision !== 1 ||
    page.snapshotFixedAt !== candidate.snapshotFixedAt ||
    page.contentDigest !== candidate.contentDigest
  ) {
    throw new Error("inventory bundle snapshot mismatch");
  }
  if (page.combinedDigest !== candidate.combinedDigest) {
    throw new Error("inventory bundle digest mismatch");
  }
  if (page.cursor !== cursor) throw new Error("inventory bundle cursor mismatch");
  const proof = inventorySnapshotPageDigest({
    snapshotId: page.snapshotId,
    snapshotFixedAt: page.snapshotFixedAt,
    contentDigest: page.contentDigest,
    cursor: page.cursor,
    items: page.items,
    nextCursor: page.nextCursor,
  });
  if (proof !== page.pageDigest) throw new Error("inventory bundle page digest mismatch");
}

function validatePageCodes(
  candidate: InventoryMirrorCandidate,
  cursor: string | null,
  page: InventoryBundlePage,
): void {
  let previous = cursor;
  for (const item of page.items) {
    validateCode(candidate, item);
    if (previous !== null && item.codeHash <= previous) {
      throw new Error("inventory bundle code order mismatch");
    }
    previous = item.codeHash;
  }
  if (
    page.nextCursor !== null &&
    (page.items.length === 0 || page.nextCursor !== page.items.at(-1)?.codeHash)
  ) {
    throw new Error("inventory bundle next cursor mismatch");
  }
}

async function verifyStoredPage(
  exec: SqlExecutor,
  candidate: InventoryMirrorCandidate,
  page: InventoryBundlePage,
): Promise<void> {
  for (const item of page.items) {
    const rows = await exec.all<StoredCodeRow>(
      `SELECT snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
              source_state, source_production_date, parent_sscc, expected, protected
         FROM inventory_snapshot_codes_mirror
        WHERE snapshot_id = ? AND code_hash = ?`,
      [candidate.snapshotId, item.codeHash],
    );
    if (!rows[0] || !sameStoredCode(rows[0], item)) {
      throw new Error("inventory bundle duplicate code conflict");
    }
  }
}

async function requireProspectiveFinalContent(
  exec: SqlExecutor,
  candidate: InventoryMirrorCandidate,
  page: InventoryBundlePage,
): Promise<void> {
  if (page.nextCursor !== null) return;
  const existing = await snapshotRows(exec, candidate.snapshotId);
  const combined = new Map(existing.map((row) => [row.code_hash, storedCode(row)]));
  for (const item of page.items) {
    const prior = existing.find((row) => row.code_hash === item.codeHash);
    if (prior && !sameStoredCode(prior, item)) {
      throw new Error("inventory bundle duplicate code conflict");
    }
    combined.set(item.codeHash, item);
  }
  const ordered = [...combined.values()].sort((left, right) =>
    left.codeHash.localeCompare(right.codeHash),
  );
  if (
    ordered.length !== candidate.codeCount ||
    inventorySnapshotContentDigest(ordered) !== candidate.contentDigest
  ) {
    throw new Error("inventory bundle content digest mismatch");
  }
}

async function verifyAndMarkFinalSnapshot(
  exec: SqlExecutor,
  candidate: InventoryMirrorCandidate,
  pageDigest: string,
): Promise<void> {
  const allRows = (await snapshotRows(exec, candidate.snapshotId)).map(storedCode);
  if (
    allRows.length !== candidate.codeCount ||
    inventorySnapshotContentDigest(allRows) !== candidate.contentDigest
  ) {
    throw new Error("inventory bundle content digest mismatch");
  }
  await exec.run(
    `UPDATE inventory_task_mirror
        SET staged_verified_digest = staged_combined_digest,
            staged_verified_content_digest = staged_content_digest,
            updated_at = ?
      WHERE inventory_id = ?
        AND staged_snapshot_id = ?
        AND staged_snapshot_fixed_at = ?
        AND staged_combined_digest = ?
        AND staged_content_digest = ?
        AND staging_generation = ?
        AND staged_next_cursor IS NULL
        AND staged_last_page_digest = ?
        AND (SELECT COUNT(*) FROM inventory_snapshot_codes_mirror
              WHERE snapshot_id = ?) = staged_code_count`,
    [
      new Date().toISOString(),
      candidate.inventoryId,
      candidate.snapshotId,
      candidate.snapshotFixedAt,
      candidate.combinedDigest,
      candidate.contentDigest,
      candidate.generation,
      pageDigest,
      candidate.snapshotId,
    ],
  );
}

/**
 * Accepts one page with one guarded UPDATE. Its SQLite trigger inserts the
 * page rows in the same statement transaction, so two responses sharing a
 * cursor cannot combine through a pooled executor.
 */
export async function ingestInventoryPage(
  exec: SqlExecutor,
  candidate: InventoryMirrorCandidate,
  cursor: string | null,
  value: unknown,
): Promise<void> {
  const page = parseStationInventoryBundlePage(value);
  requirePageIdentity(candidate, cursor, page);
  validatePageCodes(candidate, cursor, page);

  const current = await taskState(exec, candidate.inventoryId);
  if (
    current?.staged_snapshot_id !== candidate.snapshotId ||
    current.staged_snapshot_fixed_at !== candidate.snapshotFixedAt ||
    current.staged_combined_digest !== candidate.combinedDigest ||
    current.staged_content_digest !== candidate.contentDigest ||
    current.staging_generation !== candidate.generation
  ) {
    throw new Error("inventory bundle staging was superseded");
  }
  if (current.staged_last_page_digest === page.pageDigest) {
    await verifyStoredPage(exec, candidate, page);
    if (page.nextCursor === null) {
      await verifyAndMarkFinalSnapshot(exec, candidate, page.pageDigest);
    }
    return;
  }
  if (current.staged_next_cursor !== cursor) throw new Error("inventory bundle cursor mismatch");

  await requireProspectiveFinalContent(exec, candidate, page);
  await exec.run(
    `UPDATE inventory_task_mirror
        SET staged_next_cursor = ?, staged_last_page_digest = ?,
            staged_page_json = ?, staged_verified_digest = NULL,
            staged_verified_content_digest = NULL, updated_at = ?
      WHERE inventory_id = ?
        AND staged_snapshot_id = ?
        AND staged_snapshot_revision = 1
        AND staged_snapshot_fixed_at = ?
        AND staged_combined_digest = ?
        AND staged_content_digest = ?
        AND staging_generation = ?
        AND staged_next_cursor IS ?
        AND staged_last_page_digest IS ?`,
    [
      page.nextCursor,
      page.pageDigest,
      JSON.stringify(page.items),
      new Date().toISOString(),
      candidate.inventoryId,
      candidate.snapshotId,
      candidate.snapshotFixedAt,
      candidate.combinedDigest,
      candidate.contentDigest,
      candidate.generation,
      cursor,
      current.staged_last_page_digest,
    ],
  );

  const after = await taskState(exec, candidate.inventoryId);
  if (
    after?.staged_snapshot_id !== candidate.snapshotId ||
    after.staging_generation !== candidate.generation
  ) {
    throw new Error("inventory bundle staging was superseded");
  }
  if (after.staged_last_page_digest !== page.pageDigest) {
    throw new Error("inventory bundle page acceptance was superseded");
  }
  await verifyStoredPage(exec, candidate, page);

  if (page.nextCursor === null) {
    await verifyAndMarkFinalSnapshot(exec, candidate, page.pageDigest);
  }
}

/** Atomically publishes the exact ordered/content-verified staged revision. */
export async function publishInventorySnapshot(
  exec: SqlExecutor,
  candidate: InventoryMirrorCandidate,
): Promise<boolean> {
  const before = await taskState(exec, candidate.inventoryId);
  if (
    before?.active_snapshot_id === candidate.snapshotId &&
    before.active_snapshot_fixed_at === candidate.snapshotFixedAt &&
    before.active_combined_digest === candidate.combinedDigest &&
    before.active_content_digest === candidate.contentDigest &&
    before.active_code_count === candidate.codeCount
  ) {
    return true;
  }

  await exec.run(
    `UPDATE inventory_task_mirror
        SET active_snapshot_id = staged_snapshot_id,
            active_snapshot_revision = staged_snapshot_revision,
            active_snapshot_fixed_at = staged_snapshot_fixed_at,
            active_combined_digest = staged_combined_digest,
            active_content_digest = staged_content_digest,
            active_code_count = staged_code_count,
            active_manifest_json = staged_manifest_json,
            staged_snapshot_id = NULL, staged_snapshot_revision = NULL,
            staged_snapshot_fixed_at = NULL, staged_combined_digest = NULL,
            staged_content_digest = NULL, staged_code_count = NULL,
            staged_manifest_json = NULL, staged_next_cursor = NULL,
            staged_verified_digest = NULL, staged_verified_content_digest = NULL,
            staged_last_page_digest = NULL, staged_page_json = NULL,
            updated_at = ?
      WHERE inventory_id = ?
        AND staged_snapshot_id = ?
        AND staged_snapshot_revision = 1
        AND staged_snapshot_fixed_at = ?
        AND staged_combined_digest = ?
        AND staged_content_digest = ?
        AND staged_code_count = ?
        AND staging_generation = ?
        AND staged_verified_digest = ?
        AND staged_verified_content_digest = ?
        AND (active_snapshot_fixed_at IS NULL OR active_snapshot_fixed_at < staged_snapshot_fixed_at)
        AND (SELECT COUNT(*) FROM inventory_snapshot_codes_mirror
              WHERE snapshot_id = ?) = staged_code_count`,
    [
      new Date().toISOString(),
      candidate.inventoryId,
      candidate.snapshotId,
      candidate.snapshotFixedAt,
      candidate.combinedDigest,
      candidate.contentDigest,
      candidate.codeCount,
      candidate.generation,
      candidate.combinedDigest,
      candidate.contentDigest,
      candidate.snapshotId,
    ],
  );
  const after = await taskState(exec, candidate.inventoryId);
  const published =
    after?.active_snapshot_id === candidate.snapshotId &&
    after.active_snapshot_fixed_at === candidate.snapshotFixedAt &&
    after.active_combined_digest === candidate.combinedDigest &&
    after.active_content_digest === candidate.contentDigest &&
    after.active_code_count === candidate.codeCount;
  if (!published) return false;

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
    verifiedContentDigest: row.staged_verified_content_digest,
    lastPageDigest: row.staged_last_page_digest,
    stagedCodeCount: counts[0]?.count ?? 0,
    generation: row.staging_generation,
  };
}
