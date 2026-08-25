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

export interface InventoryJournalReconciliation {
  requiresRescan: boolean;
  recoveredCommitted: number;
  failed: number;
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

type InventoryEventCommitState = "pending" | "committed" | "failed";

interface ExistingEventRow {
  event_id: string;
  device_id: string;
  device_sequence: number;
  operator_id: string;
  scanned_at: string;
  kind: string;
  normalized_identity: string;
  code_hash: string | null;
  raw_payload: string | null;
  active_production_date: string | null;
  local_verdict: string;
  commit_state: string;
}

interface OutboxDbRow {
  device_sequence: number;
  payload_json: string;
}

interface ProjectionSummary {
  expected: number;
  protected: number;
  ineligible: number;
  total: number;
}

const RECENT_LIMIT = 6;
let journalTail: Promise<void> = Promise.resolve();

function serializeJournal<T>(operation: () => Promise<T>): Promise<T> {
  const result = journalTail.then(operation, operation);
  journalTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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

function commitState(value: string): InventoryEventCommitState {
  if (value === "pending" || value === "committed" || value === "failed") return value;
  throw new Error("inventory event commit state is invalid");
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
      `SELECT result.code_hash, result.first_accepted_event_id,
              result.winning_device_id, result.winning_scanned_at
         FROM inventory_code_results_mirror result
         JOIN inventory_scan_events_mirror event
           ON event.inventory_id = result.inventory_id
          AND event.snapshot_id = result.snapshot_id
          AND event.event_id = result.first_accepted_event_id
          AND event.commit_state IN ('pending', 'committed')
        WHERE result.inventory_id = ? AND result.snapshot_id = ? AND result.code_hash = ?`,
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
         JOIN inventory_scan_events_mirror event
           ON event.inventory_id = result.inventory_id
          AND event.snapshot_id = result.snapshot_id
          AND event.event_id = result.first_accepted_event_id
          AND event.commit_state IN ('pending', 'committed')
         JOIN inventory_snapshot_codes_mirror snapshot
           ON snapshot.snapshot_id = result.snapshot_id AND snapshot.code_hash = result.code_hash
        WHERE result.inventory_id = ? AND result.snapshot_id = ? AND snapshot.parent_sscc = ?`,
      [input.inventoryId, input.snapshotId, scannerInput.sscc],
    );
  }
  return { rows: snapshotRows.map(snapshotRow), claims: claimRows.map(localClaim) };
}

function classifyFromFacts(
  input: RecordInventoryScanInput,
  facts: Awaited<ReturnType<typeof loadClassifierFacts>>,
): InventoryScanClassification {
  const rowsByHash = new Map(facts.rows.map((row) => [row.codeHash, row]));
  const claimsByHash = new Map(facts.claims.map((claim) => [claim.codeHash, claim]));
  return classifyInventoryScan(input.raw, {
    taskGtin14: input.taskGtin14,
    findSnapshotCode: (codeHash) => rowsByHash.get(codeHash) ?? null,
    findSnapshotChildren: (parentSscc) => facts.rows.filter((row) => row.parentSscc === parentSscc),
    findLocalClaim: (codeHash) => claimsByHash.get(codeHash) ?? null,
  });
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

function eventKind(classification: InventoryScanClassification): "item" | "known_box" | "old_box" {
  if (classification.kind === "invalid") throw new Error("invalid scan has no inventory event");
  return classification.scanKind;
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
  inventoryId: string,
  snapshotId: string,
  eventId: string,
): Promise<ExistingEventRow | null> {
  const rows = await exec.all<ExistingEventRow>(
    `SELECT event_id, device_id, device_sequence, operator_id, scanned_at, kind,
            normalized_identity, code_hash, raw_payload, active_production_date,
            local_verdict, commit_state
       FROM inventory_scan_events_mirror
      WHERE inventory_id = ? AND snapshot_id = ? AND event_id = ?`,
    [inventoryId, snapshotId, eventId],
  );
  return rows[0] ?? null;
}

function ensureExactReservation(
  row: ExistingEventRow,
  input: RecordInventoryScanInput,
  classification: Exclude<InventoryScanClassification, { kind: "invalid" }>,
): void {
  const codeHash = classification.scanKind === "item" ? classification.codeHash : null;
  if (
    row.device_id !== input.deviceId ||
    row.operator_id !== input.operatorId ||
    row.scanned_at !== input.scannedAt ||
    row.kind !== eventKind(classification) ||
    row.normalized_identity !== normalizedIdentity(classification) ||
    row.code_hash !== codeHash ||
    row.raw_payload !== validPayload(classification)
  ) {
    throw new Error("inventory event id payload mismatch");
  }
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

async function reserveEvent(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
  classification: Exclude<InventoryScanClassification, { kind: "invalid" }>,
): Promise<ExistingEventRow> {
  const productionDate = await activeDate(exec, input);
  const sequence = await allocateSequence(exec, input);
  await exec.run(
    `INSERT INTO inventory_scan_events_mirror
       (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
        kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
        commit_state, legacy_audit_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
     ON CONFLICT(inventory_id, snapshot_id, event_id) DO NOTHING`,
    [
      input.inventoryId,
      input.snapshotId,
      input.eventId,
      input.deviceId,
      sequence,
      input.operatorId,
      input.scannedAt,
      eventKind(classification),
      normalizedIdentity(classification),
      classification.scanKind === "item" ? classification.codeHash : null,
      validPayload(classification),
      productionDate,
      classification.kind,
    ],
  );
  const reserved = await existingEvent(exec, input.inventoryId, input.snapshotId, input.eventId);
  if (!reserved) throw new Error("inventory event reservation failed");
  ensureExactReservation(reserved, input, classification);
  return reserved;
}

function originOf(classification: InventoryScanClassification): InventoryOriginClassification {
  if (
    classification.kind === "invalid" ||
    classification.kind === "duplicate" ||
    classification.kind === "unknown"
  ) {
    throw new Error("scan has no result projection origin");
  }
  return classification.originClassification;
}

async function insertItemProjection(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
  classification: Exclude<InventoryScanClassification, { kind: "invalid" }>,
  observedProductionDate: string,
): Promise<void> {
  if (
    classification.scanKind !== "item" ||
    classification.kind === "duplicate" ||
    classification.kind === "unknown"
  ) {
    return;
  }
  const classificationValue = originOf(classification);
  await exec.all<{ code_hash: string }>(
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
}

async function insertKnownBoxProjections(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
  sscc: string,
  observedProductionDate: string,
): Promise<void> {
  await exec.all<{ code_hash: string }>(
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
}

async function ownedProjectionSummary(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  eventId: string,
): Promise<ProjectionSummary> {
  const rows = await exec.all<{
    expected_count: number;
    protected_count: number;
    ineligible_count: number;
    total_count: number;
  }>(
    `SELECT
       SUM(CASE WHEN origin_classification = 'expected' THEN 1 ELSE 0 END) AS expected_count,
       SUM(CASE WHEN origin_classification = 'protected' THEN 1 ELSE 0 END) AS protected_count,
       SUM(CASE WHEN origin_classification = 'known-ineligible' THEN 1 ELSE 0 END) AS ineligible_count,
       COUNT(*) AS total_count
       FROM inventory_code_results_mirror
      WHERE inventory_id = ? AND snapshot_id = ? AND first_accepted_event_id = ?`,
    [inventoryId, snapshotId, eventId],
  );
  const row = rows[0];
  return {
    expected: row?.expected_count ?? 0,
    protected: row?.protected_count ?? 0,
    ineligible: row?.ineligible_count ?? 0,
    total: row?.total_count ?? 0,
  };
}

async function firstUnknownObservation(
  exec: SqlExecutor,
  event: ExistingEventRow,
  inventoryId: string,
  snapshotId: string,
): Promise<InventoryLocalClaim | null> {
  const rows = await exec.all<{
    event_id: string;
    device_id: string;
    scanned_at: string;
    code_hash: string | null;
    normalized_identity: string;
  }>(
    `SELECT event_id, device_id, scanned_at, code_hash, normalized_identity
       FROM inventory_scan_events_mirror
      WHERE inventory_id = ? AND snapshot_id = ?
        AND normalized_identity = ?
        AND commit_state IN ('pending', 'committed')
      ORDER BY device_sequence, device_id, event_id
      LIMIT 1`,
    [inventoryId, snapshotId, event.normalized_identity],
  );
  const winner = rows[0];
  if (!winner) return null;
  return {
    codeHash: winner.code_hash ?? winner.normalized_identity,
    eventId: winner.event_id,
    deviceId: winner.device_id,
    scannedAt: winner.scanned_at,
  };
}

async function firstProjectionWinner(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
  classification: Exclude<InventoryScanClassification, { kind: "invalid" }>,
): Promise<InventoryLocalClaim | null> {
  let rows: ClaimDbRow[] = [];
  if (classification.scanKind === "item") {
    rows = await exec.all<ClaimDbRow>(
      `SELECT code_hash, first_accepted_event_id, winning_device_id, winning_scanned_at
         FROM inventory_code_results_mirror
        WHERE inventory_id = ? AND snapshot_id = ? AND code_hash = ?`,
      [input.inventoryId, input.snapshotId, classification.codeHash],
    );
  } else if (classification.scanKind === "known_box") {
    rows = await exec.all<ClaimDbRow>(
      `SELECT result.code_hash, result.first_accepted_event_id,
              result.winning_device_id, result.winning_scanned_at
         FROM inventory_code_results_mirror result
         JOIN inventory_snapshot_codes_mirror snapshot
           ON snapshot.snapshot_id = result.snapshot_id AND snapshot.code_hash = result.code_hash
        WHERE result.inventory_id = ? AND result.snapshot_id = ? AND snapshot.parent_sscc = ?
        ORDER BY result.winning_scanned_at, result.winning_device_id,
                 result.first_accepted_event_id
        LIMIT 1`,
      [input.inventoryId, input.snapshotId, classification.sscc],
    );
  }
  return rows[0] ? localClaim(rows[0]) : null;
}

function verdictFromProjection(
  classification: Exclude<InventoryScanClassification, { kind: "invalid" }>,
  summary: ProjectionSummary,
): Exclude<InventoryLocalVerdict, "invalid"> | null {
  if (summary.expected > 0) return "expected";
  if (summary.protected > 0) return "protected";
  if (summary.ineligible > 0) return "known-ineligible";
  if (classification.scanKind === "known_box" || classification.kind === "duplicate") {
    return "duplicate";
  }
  if (classification.kind !== "unknown") return "duplicate";
  return null;
}

function eventPayload(event: ExistingEventRow, verdict: Exclude<InventoryLocalVerdict, "invalid">) {
  return JSON.stringify({
    eventId: event.event_id,
    deviceSequence: event.device_sequence,
    operatorId: event.operator_id,
    scannedAt: event.scanned_at,
    kind: event.kind,
    normalizedIdentity: event.normalized_identity,
    codeHash: event.code_hash,
    canonicalRaw: event.raw_payload,
    activeProductionDate: event.active_production_date,
    localVerdict: verdict,
  });
}

async function outboxRow(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  eventId: string,
): Promise<OutboxDbRow | null> {
  const rows = await exec.all<OutboxDbRow>(
    `SELECT device_sequence, payload_json FROM inventory_outbox
      WHERE inventory_id = ? AND snapshot_id = ? AND event_id = ?`,
    [inventoryId, snapshotId, eventId],
  );
  return rows[0] ?? null;
}

function projectionMatches(verdict: InventoryLocalVerdict, summary: ProjectionSummary): boolean {
  if (verdict === "expected") return summary.expected > 0;
  if (verdict === "protected") return summary.protected > 0;
  if (verdict === "known-ineligible") return summary.ineligible > 0;
  return (verdict === "unknown" || verdict === "duplicate") && summary.total === 0;
}

async function finalizePendingEvent(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  eventId: string,
): Promise<void> {
  await exec.run(
    `UPDATE inventory_scan_events_mirror
        SET commit_state = 'committed', legacy_audit_version = 1
      WHERE inventory_id = ? AND snapshot_id = ? AND event_id = ? AND commit_state = 'pending'`,
    [inventoryId, snapshotId, eventId],
  );
  const committed = await existingEvent(exec, inventoryId, snapshotId, eventId);
  if (!committed || commitState(committed.commit_state) !== "committed") {
    throw new Error("inventory event commit transition failed");
  }
}

async function reconcileOnePendingEvent(
  exec: SqlExecutor,
  event: ExistingEventRow,
  inventoryId: string,
  snapshotId: string,
): Promise<"committed" | "failed"> {
  const verdict = inventoryVerdict(event.local_verdict);
  if (verdict === "invalid") throw new Error("invalid inventory noise cannot be reserved");
  const queued = await outboxRow(exec, inventoryId, snapshotId, event.event_id);
  const summary = await ownedProjectionSummary(exec, inventoryId, snapshotId, event.event_id);
  if (queued) {
    if (
      queued.device_sequence !== event.device_sequence ||
      queued.payload_json !== eventPayload(event, verdict) ||
      !projectionMatches(verdict, summary)
    ) {
      throw new Error("inventory pending event has inconsistent durable output");
    }
    await finalizePendingEvent(exec, inventoryId, snapshotId, event.event_id);
    return "committed";
  }

  await exec.run(
    `DELETE FROM inventory_code_results_mirror
      WHERE inventory_id = ? AND snapshot_id = ? AND first_accepted_event_id = ?
        AND EXISTS (
          SELECT 1 FROM inventory_scan_events_mirror event
           WHERE event.inventory_id = ? AND event.snapshot_id = ? AND event.event_id = ?
             AND event.commit_state = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM inventory_outbox queued
           WHERE queued.inventory_id = ? AND queued.snapshot_id = ? AND queued.event_id = ?
        )`,
    [
      inventoryId,
      snapshotId,
      event.event_id,
      inventoryId,
      snapshotId,
      event.event_id,
      inventoryId,
      snapshotId,
      event.event_id,
    ],
  );
  await exec.run(
    `UPDATE inventory_scan_events_mirror
        SET commit_state = 'failed', legacy_audit_version = 1
      WHERE inventory_id = ? AND snapshot_id = ? AND event_id = ? AND commit_state = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM inventory_outbox queued
           WHERE queued.inventory_id = ? AND queued.snapshot_id = ? AND queued.event_id = ?
        )`,
    [inventoryId, snapshotId, event.event_id, inventoryId, snapshotId, event.event_id],
  );
  const reconciled = await existingEvent(exec, inventoryId, snapshotId, event.event_id);
  if (!reconciled) throw new Error("inventory pending event disappeared");
  if (commitState(reconciled.commit_state) === "pending") {
    return reconcileOnePendingEvent(exec, reconciled, inventoryId, snapshotId);
  }
  if (commitState(reconciled.commit_state) !== "failed") {
    throw new Error("inventory pending event compensation raced with an invalid transition");
  }
  return "failed";
}

async function reconcilePendingInventoryEventsInternal(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  excludingEventId?: string,
): Promise<InventoryJournalReconciliation> {
  const params: unknown[] = [inventoryId, snapshotId];
  const exclusion = excludingEventId ? " AND event_id <> ?" : "";
  if (excludingEventId) params.push(excludingEventId);
  const pending = await exec.all<ExistingEventRow>(
    `SELECT event_id, device_id, device_sequence, operator_id, scanned_at, kind,
            normalized_identity, code_hash, raw_payload, active_production_date,
            local_verdict, commit_state
       FROM inventory_scan_events_mirror
      WHERE inventory_id = ? AND snapshot_id = ? AND commit_state = 'pending'${exclusion}
      ORDER BY device_id, device_sequence, event_id`,
    params,
  );
  let recoveredCommitted = 0;
  for (const event of pending) {
    const state = await reconcileOnePendingEvent(exec, event, inventoryId, snapshotId);
    if (state === "committed") recoveredCommitted += 1;
  }
  const unresolved = await exec.all<{ failed_count: number }>(
    `SELECT COUNT(*) AS failed_count
       FROM inventory_scan_events_mirror failed
      WHERE failed.inventory_id = ? AND failed.snapshot_id = ?
        AND failed.commit_state = 'failed'
        AND NOT EXISTS (
          SELECT 1 FROM inventory_scan_events_mirror replacement
           WHERE replacement.inventory_id = failed.inventory_id
             AND replacement.snapshot_id = failed.snapshot_id
             AND replacement.normalized_identity = failed.normalized_identity
             AND replacement.commit_state = 'committed'
        )`,
    [inventoryId, snapshotId],
  );
  const failed = unresolved[0]?.failed_count ?? 0;
  return { requiresRescan: failed > 0, recoveredCommitted, failed };
}

/** Reconciles process-loss reservations before the work surface admits scanner input. */
export function reconcilePendingInventoryEvents(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
): Promise<InventoryJournalReconciliation> {
  return serializeJournal(() =>
    reconcilePendingInventoryEventsInternal(exec, inventoryId, snapshotId),
  );
}

function resultFrom(
  classification: InventoryScanClassification,
  verdict: InventoryLocalVerdict,
  claimedCount: number,
  firstWinning: InventoryLocalClaim | null,
): RecordInventoryScanResult {
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

async function recordInventoryScanInternal(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<RecordInventoryScanResult> {
  if (!input.eventId) throw new Error("inventory event id is required");
  let classification = classifyFromFacts(input, await loadClassifierFacts(exec, input));
  if (classification.kind === "invalid") return resultFrom(classification, "invalid", 0, null);

  let event = await existingEvent(exec, input.inventoryId, input.snapshotId, input.eventId);
  if (event) {
    ensureExactReservation(event, input, classification);
    const state = commitState(event.commit_state);
    if (state === "failed") throw new Error("inventory event failed; rescan with a new event id");
    if (state === "committed") {
      const verdict = inventoryVerdict(event.local_verdict);
      const summary = await ownedProjectionSummary(
        exec,
        input.inventoryId,
        input.snapshotId,
        input.eventId,
      );
      let winner: InventoryLocalClaim | null = null;
      if (verdict === "duplicate") {
        winner = await firstProjectionWinner(exec, input, classification);
        if (!winner && classification.kind === "unknown") {
          winner = await firstUnknownObservation(exec, event, input.inventoryId, input.snapshotId);
        }
      }
      return resultFrom(classification, verdict, summary.total, winner);
    }
  }

  await reconcilePendingInventoryEventsInternal(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.eventId,
  );
  classification = classifyFromFacts(input, await loadClassifierFacts(exec, input));
  if (classification.kind === "invalid") return resultFrom(classification, "invalid", 0, null);
  event ??= await reserveEvent(exec, input, classification);
  ensureExactReservation(event, input, classification);
  if (commitState(event.commit_state) !== "pending") {
    throw new Error("inventory event reservation is not pending");
  }
  if (!event.active_production_date) throw new Error("inventory event production date is missing");

  if (classification.scanKind === "known_box") {
    await insertKnownBoxProjections(exec, input, classification.sscc, event.active_production_date);
  } else {
    await insertItemProjection(exec, input, classification, event.active_production_date);
  }
  const summary = await ownedProjectionSummary(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.eventId,
  );
  let verdict = verdictFromProjection(classification, summary);
  let firstWinning: InventoryLocalClaim | null = null;
  if (verdict === null) {
    const firstUnknown = await firstUnknownObservation(
      exec,
      event,
      input.inventoryId,
      input.snapshotId,
    );
    if (!firstUnknown || firstUnknown.eventId === input.eventId) verdict = "unknown";
    else {
      verdict = "duplicate";
      firstWinning = firstUnknown;
    }
  } else if (verdict === "duplicate") {
    firstWinning = await firstProjectionWinner(exec, input, classification);
  }

  await exec.run(
    `UPDATE inventory_scan_events_mirror
        SET local_verdict = ?
      WHERE inventory_id = ? AND snapshot_id = ? AND event_id = ? AND commit_state = 'pending'`,
    [verdict, input.inventoryId, input.snapshotId, input.eventId],
  );
  event = await existingEvent(exec, input.inventoryId, input.snapshotId, input.eventId);
  if (
    !event ||
    inventoryVerdict(event.local_verdict) !== verdict ||
    commitState(event.commit_state) !== "pending"
  ) {
    throw new Error("inventory event verdict transition failed");
  }

  const payloadJson = eventPayload(event, verdict);
  await exec.run(
    `INSERT INTO inventory_outbox
       (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(inventory_id, snapshot_id, event_id) DO NOTHING`,
    [
      input.inventoryId,
      input.snapshotId,
      input.eventId,
      event.device_sequence,
      payloadJson,
      input.scannedAt,
    ],
  );
  const queued = await outboxRow(exec, input.inventoryId, input.snapshotId, input.eventId);
  if (
    !queued ||
    queued.device_sequence !== event.device_sequence ||
    queued.payload_json !== payloadJson
  ) {
    throw new Error("inventory outbox reservation mismatch");
  }
  await finalizePendingEvent(exec, input.inventoryId, input.snapshotId, input.eventId);
  return resultFrom(classification, verdict, summary.total, firstWinning);
}

/**
 * Durable reservation -> projection -> outbox -> committed protocol. Each SQL
 * call stands alone because tauri-plugin-sql uses a pool; restart reconciliation
 * converts only exact complete output to accepted history and fails incomplete
 * reservations with event-owned compensation.
 */
export function recordInventoryScan(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<RecordInventoryScanResult> {
  return serializeJournal(() => recordInventoryScanInternal(exec, input));
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
    `WITH committed_events AS (
       SELECT event_id, device_id, kind, normalized_identity, code_hash, local_verdict
         FROM inventory_scan_events_mirror
        WHERE inventory_id = ? AND snapshot_id = ? AND commit_state = 'committed'
     ), committed_results AS (
       SELECT result.*
         FROM inventory_code_results_mirror result
         JOIN committed_events event ON event.event_id = result.first_accepted_event_id
        WHERE result.inventory_id = ? AND result.snapshot_id = ?
     )
     SELECT
       (SELECT COUNT(*) FROM committed_results
         WHERE origin_classification = 'expected') AS verified,
       (SELECT COUNT(*) FROM committed_results
         WHERE origin_classification = 'known-ineligible')
       + (SELECT COUNT(*) FROM (
            SELECT unknown_event.normalized_identity
              FROM committed_events unknown_event
             WHERE unknown_event.local_verdict IN ('unknown', 'duplicate')
               AND (
                 unknown_event.kind = 'old_box'
                 OR (
                   unknown_event.kind = 'item'
                   AND NOT EXISTS (
                     SELECT 1 FROM inventory_snapshot_codes_mirror snapshot
                      WHERE snapshot.snapshot_id = ?
                        AND snapshot.code_hash = unknown_event.code_hash
                   )
                 )
               )
             GROUP BY unknown_event.normalized_identity
          )) AS discrepancies,
       (SELECT COUNT(*) FROM committed_results
         WHERE origin_classification = 'protected') AS protected_count,
       (SELECT COUNT(*) FROM committed_results WHERE winning_device_id = ?) AS claimed_by_device,
       (SELECT COUNT(*) FROM committed_events
         WHERE device_id = ? AND kind = 'known_box' AND local_verdict = 'expected') AS accepted_boxes,
       (SELECT COUNT(*) FROM committed_events
         WHERE device_id = ? AND kind = 'item' AND local_verdict = 'expected') AS accepted_items`,
    [inventoryId, snapshotId, inventoryId, snapshotId, snapshotId, deviceId, deviceId, deviceId],
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
  normalized_identity: string;
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
  const prefix = row.kind === "known_box" ? "known_box:" : "old_box:";
  if (
    (row.kind === "known_box" || row.kind === "old_box") &&
    row.normalized_identity.startsWith(prefix)
  ) {
    const candidate = row.normalized_identity.slice(prefix.length);
    const scan = classifyScan(candidate);
    if (scan.kind === "sscc" && scan.sscc === candidate) {
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
    normalized_identity: string;
    raw_payload: string | null;
    local_verdict: string;
    winning_code_hash: string | null;
    winning_event_id: string | null;
    winning_device_id: string | null;
    winning_scanned_at: string | null;
    claimed_count: number;
  }>(
    `SELECT e.event_id, e.scanned_at, e.kind, e.normalized_identity, e.raw_payload,
            e.local_verdict,
            COALESCE(winner.code_hash, observation.code_hash,
                     observation.normalized_identity) AS winning_code_hash,
            COALESCE(winner.first_accepted_event_id,
                     observation.event_id) AS winning_event_id,
            COALESCE(winner.winning_device_id,
                     observation.device_id) AS winning_device_id,
            COALESCE(winner.winning_scanned_at,
                     observation.scanned_at) AS winning_scanned_at,
            (SELECT COUNT(*) FROM inventory_code_results_mirror claimed
              WHERE claimed.inventory_id = e.inventory_id
                AND claimed.snapshot_id = e.snapshot_id
                AND claimed.first_accepted_event_id = e.event_id) AS claimed_count
       FROM inventory_scan_events_mirror e
       LEFT JOIN inventory_code_results_mirror winner
         ON winner.rowid = (
           SELECT candidate.rowid
             FROM inventory_code_results_mirror candidate
             LEFT JOIN inventory_snapshot_codes_mirror snapshot
               ON snapshot.snapshot_id = candidate.snapshot_id
              AND snapshot.code_hash = candidate.code_hash
            WHERE candidate.inventory_id = e.inventory_id
              AND candidate.snapshot_id = e.snapshot_id
              AND (
                (e.code_hash IS NOT NULL AND candidate.code_hash = e.code_hash)
                OR (
                  e.kind = 'known_box'
                  AND e.normalized_identity LIKE 'known_box:%'
                  AND snapshot.parent_sscc = substr(e.normalized_identity, 11)
                )
              )
            ORDER BY candidate.winning_scanned_at, candidate.winning_device_id,
                     candidate.first_accepted_event_id
            LIMIT 1
         )
       LEFT JOIN inventory_scan_events_mirror observation
         ON observation.rowid = (
           SELECT source.rowid
             FROM inventory_scan_events_mirror source
            WHERE source.inventory_id = e.inventory_id
              AND source.snapshot_id = e.snapshot_id
              AND source.normalized_identity = e.normalized_identity
              AND source.local_verdict IN ('unknown', 'duplicate')
              AND source.commit_state = 'committed'
              AND (
                source.kind = 'old_box'
                OR (
                  source.kind = 'item'
                  AND NOT EXISTS (
                    SELECT 1 FROM inventory_snapshot_codes_mirror known
                     WHERE known.snapshot_id = source.snapshot_id
                       AND known.code_hash = source.code_hash
                  )
                )
              )
            ORDER BY source.device_sequence, source.device_id, source.event_id
            LIMIT 1
         )
      WHERE e.inventory_id = ? AND e.snapshot_id = ? AND e.commit_state = 'committed'
      ORDER BY e.device_sequence DESC, e.event_id DESC
      LIMIT ?`,
    [inventoryId, snapshotId, RECENT_LIMIT],
  );
  return rows.map((row) => {
    const verdict = inventoryVerdict(row.local_verdict);
    if (verdict === "invalid") throw new Error("invalid inventory noise cannot be journalled");
    const firstWinning: InventoryLocalClaim | null =
      verdict === "duplicate" &&
      row.winning_code_hash !== null &&
      row.winning_event_id !== null &&
      row.winning_device_id !== null &&
      row.winning_scanned_at !== null
        ? {
            codeHash: row.winning_code_hash,
            eventId: row.winning_event_id,
            deviceId: row.winning_device_id,
            scannedAt: row.winning_scanned_at,
          }
        : null;
    return {
      eventId: row.event_id,
      verdict,
      scannedAt: Number.isNaN(Date.parse(row.scanned_at)) ? null : row.scanned_at,
      winningDeviceId: firstWinning?.deviceId ?? null,
      winningScannedAt: firstWinning?.scannedAt ?? null,
      claimedCount: row.claimed_count,
      firstWinning,
      ...safeRecentPresentation(row),
    };
  });
}
