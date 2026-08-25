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
  readonly inventoryId: string;
  readonly snapshotId: string;
  readonly deviceId: string;
  readonly pinValue: string;
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

function parsePinned(
  value: string,
  expected: { inventoryId: string; snapshotId: string; deviceId: string },
): PreparedInventoryOutboxBatch {
  const parsed = parseJson(value, "inventory outbox pin is invalid");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("inventory outbox pin is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    (record.inventoryId !== undefined && record.inventoryId !== expected.inventoryId) ||
    (record.snapshotId !== undefined && record.snapshotId !== expected.snapshotId) ||
    (record.deviceId !== undefined && record.deviceId !== expected.deviceId)
  ) {
    throw new Error("inventory outbox pin is invalid");
  }
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
  return {
    ...expected,
    pinValue: value,
    request,
    outboxRows,
  };
}

async function readPin(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
): Promise<PreparedInventoryOutboxBatch | null> {
  const rows = await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key = ?", [
    pinKey(inventoryId, snapshotId),
  ]);
  if (!rows[0]) return null;
  const terminals = await exec.all<{ device_id: string }>(
    `SELECT device_id FROM inventory_terminal_state
      WHERE inventory_id = ? AND snapshot_id = ?`,
    [inventoryId, snapshotId],
  );
  const deviceId = terminals[0]?.device_id;
  if (!deviceId) throw new Error("inventory outbox pin is invalid");
  return parsePinned(rows[0].value, { inventoryId, snapshotId, deviceId });
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
  const batch = {
    inventoryId: input.inventoryId,
    snapshotId: input.snapshotId,
    deviceId: terminal.device_id,
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
  const response = parseInventoryEventBatchResponse(
    value,
    batch.request,
    batch.inventoryId,
    batch.deviceId,
  );
  await verifyPinnedRows(exec, batch);
  const receiptId = `${response.inventoryId}:${response.snapshotId}:${response.batchId}:${response.payloadDigest}`;
  const responseJson = JSON.stringify(response);
  const outboxRowsJson = JSON.stringify(batch.outboxRows);
  const expectedPinKey = pinKey(response.inventoryId, response.snapshotId);
  const existingReceipts = await exec.all<{
    inventory_id: string;
    snapshot_id: string;
    batch_id: string;
    payload_digest: string;
    response_json: string;
    outbox_rows_json: string;
    pin_key: string;
    pin_value: string;
    applied_at: string;
  }>(
    `SELECT inventory_id, snapshot_id, batch_id, payload_digest, response_json,
            outbox_rows_json, pin_key, pin_value, applied_at
       FROM inventory_sync_ack_receipts_v2 WHERE receipt_id = ?`,
    [receiptId],
  );
  const appliedAt = batch.request.events.at(-1)?.scannedAt;
  if (!appliedAt) throw new Error("inventory acknowledgement batch is empty");
  if (existingReceipts[0]) {
    const receipt = existingReceipts[0];
    if (
      receipt.inventory_id !== response.inventoryId ||
      receipt.snapshot_id !== response.snapshotId ||
      receipt.batch_id !== response.batchId ||
      receipt.payload_digest !== response.payloadDigest ||
      receipt.response_json !== responseJson ||
      receipt.outbox_rows_json !== outboxRowsJson ||
      receipt.pin_key !== expectedPinKey ||
      receipt.pin_value !== batch.pinValue ||
      receipt.applied_at !== appliedAt
    ) {
      throw new Error("inventory acknowledgement receipt changed");
    }
    return response;
  }
  await exec.run(
    `INSERT INTO inventory_sync_ack_receipts_v2
       (receipt_id, inventory_id, snapshot_id, batch_id, payload_digest,
        response_json, outbox_rows_json, pin_key, pin_value, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(receipt_id) DO NOTHING`,
    [
      receiptId,
      response.inventoryId,
      response.snapshotId,
      response.batchId,
      response.payloadDigest,
      responseJson,
      outboxRowsJson,
      expectedPinKey,
      batch.pinValue,
      appliedAt,
    ],
  );
  const receipts = await exec.all<{
    receipt_id: string;
    inventory_id: string;
    snapshot_id: string;
    batch_id: string;
    payload_digest: string;
    response_json: string;
    outbox_rows_json: string;
    pin_key: string;
    pin_value: string;
    applied_at: string;
  }>(
    `SELECT receipt_id, inventory_id, snapshot_id, batch_id, payload_digest, response_json,
            outbox_rows_json, pin_key, pin_value, applied_at
       FROM inventory_sync_ack_receipts_v2 WHERE receipt_id = ?`,
    [receiptId],
  );
  const stored = receipts[0];
  if (
    receipts.length !== 1 ||
    stored?.receipt_id !== receiptId ||
    stored.inventory_id !== response.inventoryId ||
    stored.snapshot_id !== response.snapshotId ||
    stored.batch_id !== response.batchId ||
    stored.payload_digest !== response.payloadDigest ||
    stored.response_json !== responseJson ||
    stored.outbox_rows_json !== outboxRowsJson ||
    stored.pin_key !== expectedPinKey ||
    stored.pin_value !== batch.pinValue ||
    stored.applied_at !== appliedAt
  ) {
    throw new Error("inventory acknowledgement persistence failed");
  }
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
