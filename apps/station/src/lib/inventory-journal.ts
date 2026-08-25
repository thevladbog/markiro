import {
  classifyInventoryScan,
  classifyScan,
  INVENTORY_CHZ_STATUSES,
  kmHash,
  type InventoryChzStatus,
  type InventoryLocalClaim,
  type InventoryOriginClassification,
  type InventoryScanClassification,
  type InventoryScanSnapshotRow,
} from "@markiro/domain";

import type { SqlExecutor } from "./mirror.js";

export type InventoryLocalVerdict =
  "expected" | "protected" | "known-ineligible" | "unknown" | "duplicate" | "invalid";

export interface RecordInventoryScanInput {
  inventoryId: string;
  snapshotId: string;
  deviceId: string;
  operatorId: string;
  taskGtin14: string;
  raw: string;
  eventId: string;
  scannedAt: string;
}

export interface InventoryScanPresentation {
  scanKind: "item" | "known_box" | "old_box" | "invalid";
  serialSuffix: string | null;
  ssccSuffix: string | null;
}

export interface RecordInventoryScanResult extends InventoryScanPresentation {
  verdict: InventoryLocalVerdict;
  claimedCount: number;
  boxChildCount: number;
  firstWinning: InventoryLocalClaim | null;
}

export interface RecentInventoryOperation extends InventoryScanPresentation {
  eventId: string;
  verdict: Exclude<InventoryLocalVerdict, "invalid">;
  scannedAt: string | null;
  winningDeviceId: string | null;
  winningScannedAt: string | null;
  claimedCount: number;
  firstWinning: InventoryLocalClaim | null;
}

export interface InventoryProgress {
  verified: number;
  discrepancies: number;
  protected: number;
  claimedByDevice: number;
  acceptedBoxes: number;
  acceptedItems: number;
}

interface SnapshotDbRow {
  code_hash: string;
  canonical_raw: string;
  gtin14: string;
  serial: string;
  source_status: string;
  source_state: string | null;
  expected: number;
  protected: number;
  parent_sscc: string | null;
}

interface ClaimDbRow {
  code_hash: string;
  first_accepted_event_id: string;
  winning_device_id: string;
  winning_scanned_at: string;
}

interface ExistingEventRow {
  event_id: string;
  device_id: string;
  device_sequence: number;
  operator_id: string;
  scanned_at: string;
  kind: string;
  normalized_identity: string;
  raw_payload: string | null;
  active_production_date: string | null;
  local_verdict: string;
  outbox_exists: number;
}

const RECENT_LIMIT = 6;

function isInventoryChzStatus(value: string): value is InventoryChzStatus {
  return INVENTORY_CHZ_STATUSES.some((status) => status === value);
}

function inventoryVerdict(value: string): InventoryLocalVerdict {
  if (
    value === "expected" ||
    value === "protected" ||
    value === "known-ineligible" ||
    value === "unknown" ||
    value === "duplicate" ||
    value === "invalid"
  ) {
    return value;
  }
  throw new Error("inventory event verdict is invalid");
}

function snapshotRow(row: SnapshotDbRow): InventoryScanSnapshotRow {
  if (!isInventoryChzStatus(row.source_status)) {
    throw new Error("inventory snapshot status is invalid");
  }
  return {
    codeHash: row.code_hash,
    canonicalRaw: row.canonical_raw,
    gtin14: row.gtin14,
    serial: row.serial,
    sourceStatus: row.source_status,
    sourceState: row.source_state,
    expected: row.expected === 1,
    protected: row.protected === 1,
    parentSscc: row.parent_sscc,
  };
}

function localClaim(row: ClaimDbRow): InventoryLocalClaim {
  return {
    codeHash: row.code_hash,
    eventId: row.first_accepted_event_id,
    deviceId: row.winning_device_id,
    scannedAt: row.winning_scanned_at,
  };
}

async function loadClassifierFacts(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<{ rows: InventoryScanSnapshotRow[]; claims: InventoryLocalClaim[] }> {
  const scannerInput = classifyScan(input.raw);
  let snapshotRows: SnapshotDbRow[] = [];
  let claimRows: ClaimDbRow[] = [];
  if (scannerInput.kind === "km") {
    const codeHash = kmHash(scannerInput.km);
    snapshotRows = await exec.all<SnapshotDbRow>(
      `SELECT code_hash, canonical_raw, gtin14, serial, source_status, source_state,
              expected, protected, parent_sscc
         FROM inventory_snapshot_codes_mirror
        WHERE snapshot_id = ? AND code_hash = ?
          AND EXISTS (
            SELECT 1 FROM inventory_task_mirror
             WHERE inventory_id = ? AND active_snapshot_id = ?
          )`,
      [input.snapshotId, codeHash, input.inventoryId, input.snapshotId],
    );
    claimRows = await exec.all<ClaimDbRow>(
      `SELECT code_hash, first_accepted_event_id, winning_device_id, winning_scanned_at
         FROM inventory_code_results_mirror
        WHERE inventory_id = ? AND snapshot_id = ? AND code_hash = ?`,
      [input.inventoryId, input.snapshotId, codeHash],
    );
  } else if (scannerInput.kind === "sscc") {
    snapshotRows = await exec.all<SnapshotDbRow>(
      `SELECT code_hash, canonical_raw, gtin14, serial, source_status, source_state,
              expected, protected, parent_sscc
         FROM inventory_snapshot_codes_mirror
        WHERE snapshot_id = ? AND parent_sscc = ?
          AND EXISTS (
            SELECT 1 FROM inventory_task_mirror
             WHERE inventory_id = ? AND active_snapshot_id = ?
          )
        ORDER BY code_hash`,
      [input.snapshotId, scannerInput.sscc, input.inventoryId, input.snapshotId],
    );
    claimRows = await exec.all<ClaimDbRow>(
      `SELECT result.code_hash, result.first_accepted_event_id,
              result.winning_device_id, result.winning_scanned_at
         FROM inventory_code_results_mirror result
         JOIN inventory_snapshot_codes_mirror snapshot
           ON snapshot.snapshot_id = result.snapshot_id AND snapshot.code_hash = result.code_hash
        WHERE result.inventory_id = ? AND result.snapshot_id = ? AND snapshot.parent_sscc = ?`,
      [input.inventoryId, input.snapshotId, scannerInput.sscc],
    );
  }
  const rows = snapshotRows.map(snapshotRow);
  return { rows, claims: claimRows.map(localClaim) };
}

function normalizedIdentity(
  classification: Exclude<InventoryScanClassification, { kind: "invalid" }>,
): string {
  if (classification.scanKind === "item") return `item:${classification.codeHash}`;
  return `${classification.scanKind}:${classification.sscc}`;
}

function validPayload(classification: InventoryScanClassification): string | null {
  if (classification.kind === "invalid") return null;
  if (classification.scanKind === "item") return classification.canonicalRaw;
  return classification.sscc;
}

function presentation(classification: InventoryScanClassification): InventoryScanPresentation {
  if (classification.kind === "invalid") {
    return { scanKind: "invalid", serialSuffix: null, ssccSuffix: null };
  }
  if (classification.scanKind === "item") {
    const characters = Array.from(classification.serial).filter((character) =>
      /[\p{L}\p{N}]/u.test(character),
    );
    return {
      scanKind: "item",
      serialSuffix: characters.length > 0 ? `…${characters.slice(-4).join("")}` : null,
      ssccSuffix: null,
    };
  }
  return {
    scanKind: classification.scanKind,
    serialSuffix: null,
    ssccSuffix: `…${classification.sscc.slice(-4)}`,
  };
}

async function existingEvent(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<ExistingEventRow | null> {
  const rows = await exec.all<ExistingEventRow>(
    `SELECT event_id, device_id, device_sequence, operator_id, scanned_at, kind,
            normalized_identity, raw_payload, active_production_date, local_verdict,
            EXISTS(
              SELECT 1 FROM inventory_outbox o
               WHERE o.inventory_id = e.inventory_id AND o.snapshot_id = e.snapshot_id
                 AND o.event_id = e.event_id
            ) AS outbox_exists
       FROM inventory_scan_events_mirror e
      WHERE inventory_id = ? AND snapshot_id = ? AND event_id = ?`,
    [input.inventoryId, input.snapshotId, input.eventId],
  );
  return rows[0] ?? null;
}

async function activeDate(exec: SqlExecutor, input: RecordInventoryScanInput): Promise<string> {
  const rows = await exec.all<{ active_production_date: string | null }>(
    `SELECT active_production_date
       FROM inventory_terminal_state
      WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
    [input.inventoryId, input.snapshotId, input.deviceId],
  );
  const value = rows[0]?.active_production_date;
  if (!value) throw new Error("inventory production date is not selected");
  return value;
}

async function allocateSequence(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<number> {
  await exec.run(
    `INSERT INTO inventory_terminal_state
       (inventory_id, snapshot_id, device_id, operator_id, next_device_sequence, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(inventory_id, snapshot_id, device_id) DO UPDATE SET
       operator_id = excluded.operator_id, updated_at = excluded.updated_at`,
    [input.inventoryId, input.snapshotId, input.deviceId, input.operatorId, input.scannedAt],
  );
  const rows = await exec.all<{ device_sequence: number }>(
    `UPDATE inventory_terminal_state
        SET next_device_sequence = next_device_sequence + 1,
            operator_id = ?, updated_at = ?
      WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?
      RETURNING next_device_sequence - 1 AS device_sequence`,
    [input.operatorId, input.scannedAt, input.inventoryId, input.snapshotId, input.deviceId],
  );
  const sequence = rows[0]?.device_sequence;
  if (!Number.isInteger(sequence) || !sequence || sequence < 1) {
    throw new Error("inventory device sequence allocation failed");
  }
  return sequence;
}

function eventKind(classification: InventoryScanClassification): "item" | "known_box" | "old_box" {
  if (classification.kind === "invalid") throw new Error("invalid scan has no inventory event");
  return classification.scanKind;
}

function originOf(
  classification: InventoryScanClassification,
): InventoryOriginClassification | "unknown" {
  if (classification.kind === "invalid" || classification.kind === "duplicate") {
    throw new Error("scan has no new item origin");
  }
  if (classification.kind === "unknown") return "unknown";
  return classification.originClassification;
}

async function insertItemProjection(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
  classification: Exclude<InventoryScanClassification, { kind: "invalid" }>,
  observedProductionDate: string,
): Promise<number> {
  if (classification.scanKind !== "item" || classification.kind === "duplicate") return 0;
  const classificationValue = originOf(classification);
  const rows = await exec.all<{ code_hash: string }>(
    `INSERT INTO inventory_code_results_mirror
       (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
        winning_scanned_at, observed_production_date, classification, origin_classification, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(inventory_id, snapshot_id, code_hash) DO NOTHING
     RETURNING code_hash`,
    [
      input.inventoryId,
      input.snapshotId,
      classification.codeHash,
      input.eventId,
      input.deviceId,
      input.scannedAt,
      observedProductionDate,
      classificationValue,
      classificationValue,
      input.scannedAt,
    ],
  );
  return rows.length;
}

async function insertKnownBoxProjections(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
  sscc: string,
  observedProductionDate: string,
): Promise<number> {
  const rows = await exec.all<{ code_hash: string }>(
    `INSERT INTO inventory_code_results_mirror
       (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
        winning_scanned_at, observed_production_date, classification, origin_classification, updated_at)
     SELECT ?, snapshot_id, code_hash, ?, ?, ?, ?,
            CASE
              WHEN source_state = 'MOVING_BY_UD' OR protected = 1 THEN 'protected'
              WHEN expected = 1 THEN 'expected'
              ELSE 'known-ineligible'
            END,
            CASE
              WHEN source_state = 'MOVING_BY_UD' OR protected = 1 THEN 'protected'
              WHEN expected = 1 THEN 'expected'
              ELSE 'known-ineligible'
            END,
            ?
       FROM inventory_snapshot_codes_mirror
      WHERE snapshot_id = ? AND parent_sscc = ?
        AND EXISTS (
          SELECT 1 FROM inventory_task_mirror
           WHERE inventory_id = ? AND active_snapshot_id = ?
        )
     ON CONFLICT(inventory_id, snapshot_id, code_hash) DO NOTHING
     RETURNING code_hash`,
    [
      input.inventoryId,
      input.eventId,
      input.deviceId,
      input.scannedAt,
      observedProductionDate,
      input.scannedAt,
      input.snapshotId,
      sscc,
      input.inventoryId,
      input.snapshotId,
    ],
  );
  return rows.length;
}

async function compensateOwnedProjections(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<void> {
  try {
    await exec.run(
      `DELETE FROM inventory_code_results_mirror
        WHERE inventory_id = ? AND snapshot_id = ? AND first_accepted_event_id = ?`,
      [input.inventoryId, input.snapshotId, input.eventId],
    );
  } catch {
    // Best effort. Preserve the original event/outbox failure for the floor signal.
  }
}

function resultFrom(
  classification: InventoryScanClassification,
  verdict: InventoryLocalVerdict,
  claimedCount: number,
): RecordInventoryScanResult {
  const firstWinning = classification.kind === "duplicate" ? classification.firstWinning : null;
  return {
    verdict,
    claimedCount,
    boxChildCount:
      classification.kind !== "invalid" && classification.scanKind === "known_box"
        ? classification.children.length
        : 0,
    firstWinning,
    ...presentation(classification),
  };
}

/**
 * Records one inventory observation without relying on a pooled transaction. Projection
 * writes happen first; later event/outbox failures compensate only rows owned
 * by this event id, leaving any earlier winner intact and the item rescannable.
 */
export async function recordInventoryScan(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<RecordInventoryScanResult> {
  if (!input.eventId) throw new Error("inventory event id is required");
  const facts = await loadClassifierFacts(exec, input);
  const rowsByHash = new Map(facts.rows.map((row) => [row.codeHash, row]));
  const claimsByHash = new Map(facts.claims.map((claim) => [claim.codeHash, claim]));
  const classification = classifyInventoryScan(input.raw, {
    taskGtin14: input.taskGtin14,
    findSnapshotCode: (codeHash) => rowsByHash.get(codeHash) ?? null,
    findSnapshotChildren: (parentSscc) => facts.rows.filter((row) => row.parentSscc === parentSscc),
    findLocalClaim: (codeHash) => claimsByHash.get(codeHash) ?? null,
  });
  if (classification.kind === "invalid") return resultFrom(classification, "invalid", 0);

  const identity = normalizedIdentity(classification);
  const previous = await existingEvent(exec, input);
  if (
    previous &&
    (previous.device_id !== input.deviceId ||
      previous.operator_id !== input.operatorId ||
      previous.scanned_at !== input.scannedAt ||
      previous.normalized_identity !== identity)
  ) {
    throw new Error("inventory event id payload mismatch");
  }
  if (previous?.outbox_exists === 1) {
    return resultFrom(classification, inventoryVerdict(previous.local_verdict), 0);
  }

  const productionDate = previous?.active_production_date ?? (await activeDate(exec, input));
  const sequence = previous?.device_sequence ?? (await allocateSequence(exec, input));
  const claimedCount =
    classification.scanKind === "known_box"
      ? await insertKnownBoxProjections(exec, input, classification.sscc, productionDate)
      : await insertItemProjection(exec, input, classification, productionDate);
  const verdict: Exclude<InventoryLocalVerdict, "invalid"> =
    classification.kind === "duplicate" ||
    (classification.scanKind === "known_box" && claimedCount === 0)
      ? "duplicate"
      : classification.kind;
  const kind = eventKind(classification);
  try {
    await exec.run(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(inventory_id, snapshot_id, event_id) DO NOTHING`,
      [
        input.inventoryId,
        input.snapshotId,
        input.eventId,
        input.deviceId,
        sequence,
        input.operatorId,
        input.scannedAt,
        kind,
        identity,
        classification.scanKind === "item" ? classification.codeHash : null,
        validPayload(classification),
        productionDate,
        verdict,
      ],
    );
  } catch (error) {
    await compensateOwnedProjections(exec, input);
    throw error;
  }

  const payloadJson = JSON.stringify({
    eventId: input.eventId,
    deviceSequence: sequence,
    operatorId: input.operatorId,
    scannedAt: input.scannedAt,
    kind,
    normalizedIdentity: identity,
    codeHash: classification.scanKind === "item" ? classification.codeHash : null,
    canonicalRaw: validPayload(classification),
    activeProductionDate: productionDate,
    localVerdict: verdict,
  });
  try {
    await exec.run(
      `INSERT INTO inventory_outbox
         (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(inventory_id, snapshot_id, event_id) DO NOTHING`,
      [input.inventoryId, input.snapshotId, input.eventId, sequence, payloadJson, input.scannedAt],
    );
  } catch (error) {
    await compensateOwnedProjections(exec, input);
    throw error;
  }
  return resultFrom(classification, verdict, claimedCount);
}

export async function readInventoryProgress(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  deviceId: string,
): Promise<InventoryProgress> {
  const rows = await exec.all<{
    verified: number;
    discrepancies: number;
    protected_count: number;
    claimed_by_device: number;
    accepted_boxes: number;
    accepted_items: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM inventory_code_results_mirror
         WHERE inventory_id = ? AND snapshot_id = ? AND origin_classification = 'expected') AS verified,
       (SELECT COUNT(*) FROM inventory_code_results_mirror
         WHERE inventory_id = ? AND snapshot_id = ?
           AND origin_classification IN ('unknown', 'known-ineligible')) AS discrepancies,
       (SELECT COUNT(*) FROM inventory_code_results_mirror
         WHERE inventory_id = ? AND snapshot_id = ? AND origin_classification = 'protected') AS protected_count,
       (SELECT COUNT(*) FROM inventory_code_results_mirror
         WHERE inventory_id = ? AND snapshot_id = ? AND winning_device_id = ?) AS claimed_by_device,
       (SELECT COUNT(*) FROM inventory_scan_events_mirror
         WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?
           AND kind = 'known_box' AND local_verdict = 'expected') AS accepted_boxes,
       (SELECT COUNT(*) FROM inventory_scan_events_mirror
         WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?
           AND kind = 'item' AND local_verdict = 'expected') AS accepted_items`,
    [
      inventoryId,
      snapshotId,
      inventoryId,
      snapshotId,
      inventoryId,
      snapshotId,
      inventoryId,
      snapshotId,
      deviceId,
      inventoryId,
      snapshotId,
      deviceId,
      inventoryId,
      snapshotId,
      deviceId,
    ],
  );
  const row = rows[0];
  return {
    verified: row?.verified ?? 0,
    discrepancies: row?.discrepancies ?? 0,
    protected: row?.protected_count ?? 0,
    claimedByDevice: row?.claimed_by_device ?? 0,
    acceptedBoxes: row?.accepted_boxes ?? 0,
    acceptedItems: row?.accepted_items ?? 0,
  };
}

function safeRecentPresentation(row: {
  kind: string;
  raw_payload: string | null;
}): InventoryScanPresentation {
  if (row.kind === "item" && row.raw_payload) {
    const scan = classifyScan(row.raw_payload);
    if (scan.kind === "km") {
      const characters = Array.from(scan.km.serial).filter((character) =>
        /[\p{L}\p{N}]/u.test(character),
      );
      return {
        scanKind: "item",
        serialSuffix: characters.length > 0 ? `…${characters.slice(-4).join("")}` : null,
        ssccSuffix: null,
      };
    }
  }
  if ((row.kind === "known_box" || row.kind === "old_box") && row.raw_payload) {
    const scan = classifyScan(row.raw_payload);
    if (scan.kind === "sscc") {
      return {
        scanKind: row.kind,
        serialSuffix: null,
        ssccSuffix: `…${scan.sscc.slice(-4)}`,
      };
    }
  }
  return { scanKind: "invalid", serialSuffix: null, ssccSuffix: null };
}

export async function listRecentInventoryOperations(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
): Promise<RecentInventoryOperation[]> {
  const rows = await exec.all<{
    event_id: string;
    scanned_at: string;
    kind: string;
    raw_payload: string | null;
    local_verdict: string;
    winning_code_hash: string | null;
    winning_event_id: string | null;
    winning_device_id: string | null;
    winning_scanned_at: string | null;
    claimed_count: number;
  }>(
    `SELECT e.event_id, e.scanned_at, e.kind, e.raw_payload, e.local_verdict,
            winner.code_hash AS winning_code_hash,
            winner.first_accepted_event_id AS winning_event_id,
            winner.winning_device_id, winner.winning_scanned_at,
            (SELECT COUNT(*) FROM inventory_code_results_mirror claimed
              WHERE claimed.inventory_id = e.inventory_id
                AND claimed.snapshot_id = e.snapshot_id
                AND claimed.first_accepted_event_id = e.event_id) AS claimed_count
       FROM inventory_scan_events_mirror e
       LEFT JOIN inventory_code_results_mirror winner
         ON winner.inventory_id = e.inventory_id AND winner.snapshot_id = e.snapshot_id
        AND winner.code_hash = e.code_hash
      WHERE e.inventory_id = ? AND e.snapshot_id = ?
      ORDER BY e.device_sequence DESC, e.event_id DESC
      LIMIT ?`,
    [inventoryId, snapshotId, RECENT_LIMIT],
  );
  return rows.map((row) => {
    const verdict = inventoryVerdict(row.local_verdict);
    if (verdict === "invalid") throw new Error("invalid inventory noise cannot be journalled");
    return {
      eventId: row.event_id,
      verdict,
      scannedAt: Number.isNaN(Date.parse(row.scanned_at)) ? null : row.scanned_at,
      winningDeviceId: row.winning_device_id,
      winningScannedAt: row.winning_scanned_at,
      claimedCount: row.claimed_count,
      firstWinning:
        row.winning_code_hash &&
        row.winning_event_id &&
        row.winning_device_id &&
        row.winning_scanned_at
          ? {
              codeHash: row.winning_code_hash,
              eventId: row.winning_event_id,
              deviceId: row.winning_device_id,
              scannedAt: row.winning_scanned_at,
            }
          : null,
      ...safeRecentPresentation(row),
    };
  });
}
