import {
  INVENTORY_EVENT_BATCH_SIZE,
  inventoryEventBatchDigest,
  inventoryEventSchema,
  parseInventoryEventBatch,
  parseInventoryEventBatchResponse,
  type InventoryEventBatch,
  type InventoryEventBatchResponse,
} from "@markiro/domain";

import type { SqlExecutor } from "./mirror.js";

interface OutboxRow {
  id: number;
  event_id: string;
  device_sequence: number;
  payload_json: string;
}

export interface PreparedInventoryOutboxBatch {
  readonly request: InventoryEventBatch;
  readonly outboxRows: ReadonlyArray<{
    readonly id: number;
    readonly eventId: string;
    readonly payloadJson: string;
  }>;
}

export interface PrepareInventoryOutboxBatchInput {
  inventoryId: string;
  snapshotId: string;
  createBatchId?: () => string;
}

const pinKey = (inventoryId: string, snapshotId: string) =>
  `inventory_sync_batch_v1:${inventoryId}:${snapshotId}`;

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(message);
  }
}

function parsePinned(value: string): PreparedInventoryOutboxBatch {
  const parsed = parseJson(value, "inventory outbox pin is invalid");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("inventory outbox pin is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const request = parseInventoryEventBatch(record.request);
  if (!Array.isArray(record.outboxRows) || record.outboxRows.length !== request.events.length) {
    throw new Error("inventory outbox pin is invalid");
  }
  const outboxRows = record.outboxRows.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("inventory outbox pin is invalid");
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "number" ||
      !Number.isSafeInteger(row.id) ||
      row.id < 1 ||
      typeof row.eventId !== "string" ||
      typeof row.payloadJson !== "string"
    ) {
      throw new Error("inventory outbox pin is invalid");
    }
    return { id: row.id, eventId: row.eventId, payloadJson: row.payloadJson };
  });
  return { request, outboxRows };
}

async function readPin(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
): Promise<PreparedInventoryOutboxBatch | null> {
  const rows = await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key = ?", [
    pinKey(inventoryId, snapshotId),
  ]);
  return rows[0] ? parsePinned(rows[0].value) : null;
}

async function verifyPinnedRows(
  exec: SqlExecutor,
  batch: PreparedInventoryOutboxBatch,
): Promise<void> {
  for (const pinned of batch.outboxRows) {
    const rows = await exec.all<OutboxRow>(
      "SELECT id, event_id, device_sequence, payload_json FROM inventory_outbox WHERE id = ?",
      [pinned.id],
    );
    const row = rows[0];
    if (!row) {
      const outcomes = await exec.all<{ authoritative_verdict: string | null }>(
        `SELECT authoritative_verdict FROM inventory_scan_events_mirror
          WHERE event_id = ? AND authoritative_verdict IS NOT NULL`,
        [pinned.eventId],
      );
      if (outcomes.length === 1) continue;
      throw new Error("inventory outbox pinned row is missing");
    }
    if (row.event_id !== pinned.eventId || row.payload_json !== pinned.payloadJson) {
      throw new Error("inventory outbox payload changed");
    }
  }
}

export async function prepareInventoryOutboxBatch(
  exec: SqlExecutor,
  input: PrepareInventoryOutboxBatchInput,
): Promise<PreparedInventoryOutboxBatch | null> {
  const pinned = await readPin(exec, input.inventoryId, input.snapshotId);
  if (pinned) {
    await verifyPinnedRows(exec, pinned);
    return pinned;
  }
  const rows = await exec.all<OutboxRow>(
    `SELECT id, event_id, device_sequence, payload_json FROM inventory_outbox
      WHERE inventory_id = ? AND snapshot_id = ?
      ORDER BY device_sequence, id LIMIT ?`,
    [input.inventoryId, input.snapshotId, INVENTORY_EVENT_BATCH_SIZE],
  );
  if (rows.length === 0) return null;
  const taskRows = await exec.all<{ active_snapshot_revision: number | null }>(
    `SELECT active_snapshot_revision FROM inventory_task_mirror
      WHERE inventory_id = ? AND active_snapshot_id = ?`,
    [input.inventoryId, input.snapshotId],
  );
  if (taskRows[0]?.active_snapshot_revision !== 1) {
    throw new Error("inventory outbox snapshot is not active");
  }
  const terminalRows = await exec.all<{ device_id: string; operator_id: string | null }>(
    `SELECT device_id, operator_id FROM inventory_terminal_state
      WHERE inventory_id = ? AND snapshot_id = ?`,
    [input.inventoryId, input.snapshotId],
  );
  const terminal = terminalRows[0];
  if (!terminal?.operator_id) throw new Error("inventory terminal identity is missing");
  const events = rows.map((row) => {
    const parsed = inventoryEventSchema.safeParse(
      parseJson(row.payload_json, "inventory outbox payload is invalid"),
    );
    if (!parsed.success) throw new Error("inventory outbox payload is invalid");
    if (
      parsed.data.eventId !== row.event_id ||
      parsed.data.deviceSequence !== row.device_sequence ||
      parsed.data.operatorId !== terminal.operator_id
    ) {
      throw new Error("inventory outbox payload changed");
    }
    return parsed.data;
  });
  const last = rows.at(-1);
  if (!last) return null;
  const pendingRows = await exec.all<{ count: number }>(
    `SELECT COUNT(*) AS count FROM inventory_outbox
      WHERE inventory_id = ? AND snapshot_id = ? AND id > ?`,
    [input.inventoryId, input.snapshotId, last.id],
  );
  const openRows = await exec.all<{ count: number }>(
    `SELECT COUNT(*) AS count FROM inventory_repack_boxes_mirror
      WHERE inventory_id = ? AND snapshot_id = ? AND owner_device_id = ? AND state = 'open'`,
    [input.inventoryId, input.snapshotId, terminal.device_id],
  );
  const payload = {
    snapshotId: input.snapshotId,
    snapshotRevision: 1 as const,
    sequenceCeiling: last.device_sequence,
    pendingEventCount: pendingRows[0]?.count ?? 0,
    openBoxCount: openRows[0]?.count ?? 0,
    events,
  };
  const request = parseInventoryEventBatch({
    batchId: input.createBatchId?.() ?? crypto.randomUUID(),
    payloadDigest: inventoryEventBatchDigest(payload),
    ...payload,
  });
  const batch: PreparedInventoryOutboxBatch = {
    request,
    outboxRows: rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      payloadJson: row.payload_json,
    })),
  };
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`,
    [pinKey(input.inventoryId, input.snapshotId), JSON.stringify(batch)],
  );
  const stored = await readPin(exec, input.inventoryId, input.snapshotId);
  if (!stored) throw new Error("inventory outbox pin was not persisted");
  await verifyPinnedRows(exec, stored);
  return stored;
}

export async function acknowledgeInventoryOutboxBatch(
  exec: SqlExecutor,
  batch: PreparedInventoryOutboxBatch,
  value: unknown,
): Promise<InventoryEventBatchResponse> {
  const response = parseInventoryEventBatchResponse(value, batch.request);
  await verifyPinnedRows(exec, batch);
  const outcomeByEvent = new Map(response.outcomes.map((outcome) => [outcome.eventId, outcome]));
  for (const row of batch.outboxRows) {
    const outcome = outcomeByEvent.get(row.eventId);
    if (!outcome) throw new Error("Invalid inventory event batch response");
    await exec.run(
      `UPDATE inventory_scan_events_mirror SET
         authoritative_verdict = ?, server_reason_code = ?, server_result_revision = ?,
         server_winner_code_hash = ?, server_winner_event_id = ?,
         server_winner_device_id = ?, server_winner_scanned_at = ?
       WHERE inventory_id = ? AND snapshot_id = ? AND event_id = ?
         AND authoritative_verdict IS NULL`,
      [
        outcome.status,
        outcome.reasonCode,
        response.resultRevision,
        outcome.winner?.codeHash ?? null,
        outcome.winner?.eventId ?? null,
        outcome.winner?.deviceId ?? null,
        outcome.winner?.scannedAt ?? null,
        response.inventoryId,
        response.snapshotId,
        row.eventId,
      ],
    );
    const stored = await exec.all<{ authoritative_verdict: string; server_reason_code: string }>(
      `SELECT authoritative_verdict, server_reason_code FROM inventory_scan_events_mirror
        WHERE inventory_id = ? AND snapshot_id = ? AND event_id = ?`,
      [response.inventoryId, response.snapshotId, row.eventId],
    );
    if (
      stored[0]?.authoritative_verdict !== outcome.status ||
      stored[0]?.server_reason_code !== outcome.reasonCode
    ) {
      throw new Error("inventory acknowledgement persistence failed");
    }
    if (outcome.winner) {
      await exec.run(
        `INSERT INTO inventory_conflicts_mirror
           (inventory_id, snapshot_id, conflict_id, code_hash, losing_event_id,
            winning_event_id, winning_device_id, winning_scanned_at, detected_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
         ON CONFLICT(inventory_id, snapshot_id, conflict_id) DO UPDATE SET
           code_hash = excluded.code_hash, losing_event_id = excluded.losing_event_id,
           winning_event_id = excluded.winning_event_id,
           winning_device_id = excluded.winning_device_id,
           winning_scanned_at = excluded.winning_scanned_at`,
        [
          response.inventoryId,
          response.snapshotId,
          `${row.eventId}:${outcome.winner.eventId}`,
          outcome.winner.codeHash,
          row.eventId,
          outcome.winner.eventId,
          outcome.winner.deviceId,
          outcome.winner.scannedAt,
          new Date().toISOString(),
        ],
      );
    }
  }
  for (const row of batch.outboxRows) {
    await exec.run(
      `DELETE FROM inventory_outbox
        WHERE id = ? AND inventory_id = ? AND snapshot_id = ?
          AND event_id = ? AND payload_json = ?`,
      [row.id, response.inventoryId, response.snapshotId, row.eventId, row.payloadJson],
    );
    const remaining = await exec.all<{ id: number }>(
      "SELECT id FROM inventory_outbox WHERE id = ?",
      [row.id],
    );
    if (remaining.length > 0) throw new Error("inventory outbox payload changed");
  }
  await exec.run("DELETE FROM station_meta WHERE key = ?", [
    pinKey(response.inventoryId, response.snapshotId),
  ]);
  return response;
}

export async function inventoryOutboxDepth(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
): Promise<number> {
  const rows = await exec.all<{ count: number }>(
    "SELECT COUNT(*) AS count FROM inventory_outbox WHERE inventory_id = ? AND snapshot_id = ?",
    [inventoryId, snapshotId],
  );
  return rows[0]?.count ?? 0;
}
