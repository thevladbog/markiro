import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";

import {
  acknowledgeInventoryOutboxBatch,
  prepareInventoryOutboxBatch,
} from "../src/lib/inventory-outbox.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";

function payload(eventId: string, deviceSequence: number) {
  return JSON.stringify({
    eventId,
    deviceSequence,
    operatorId: OPERATOR_ID,
    scannedAt: `2026-08-25T10:00:0${deviceSequence}.000Z`,
    kind: "item",
    normalizedIdentity: `item:${String(deviceSequence).repeat(64)}`,
    codeHash: String(deviceSequence).repeat(64),
    canonicalRaw: `010460000000001521SERIAL-${deviceSequence}`,
    activeProductionDate: "2026-08-20",
    localVerdict: "expected",
  });
}

async function setup() {
  const db = new DatabaseSync(":memory:");
  const exec = makeExec(db);
  await applyMigrations(exec);
  db.prepare(
    `INSERT INTO inventory_task_mirror
       (inventory_id, inventory_number, active_snapshot_id, active_snapshot_revision)
     VALUES (?, 'INV-1', ?, 1)`,
  ).run(INVENTORY_ID, SNAPSHOT_ID);
  db.prepare(
    `INSERT INTO inventory_terminal_state
       (inventory_id, snapshot_id, device_id, operator_id, next_device_sequence, updated_at)
     VALUES (?, ?, ?, ?, 3, '2026-08-25T10:00:00.000Z')`,
  ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
  return { db, exec };
}

function queue(db: DatabaseSync, eventId: string, sequence: number) {
  db.prepare(
    `INSERT INTO inventory_scan_events_mirror
       (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
        kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
        commit_state, legacy_audit_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'item', ?, ?, ?, '2026-08-20', 'expected', 'committed', 1)`,
  ).run(
    INVENTORY_ID,
    SNAPSHOT_ID,
    eventId,
    DEVICE_ID,
    sequence,
    OPERATOR_ID,
    `2026-08-25T10:00:0${sequence}.000Z`,
    `item:${String(sequence).repeat(64)}`,
    String(sequence).repeat(64),
    `010460000000001521SERIAL-${sequence}`,
  );
  db.prepare(
    `INSERT INTO inventory_outbox
       (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-08-25T10:00:00.000Z')`,
  ).run(INVENTORY_ID, SNAPSHOT_ID, eventId, sequence, payload(eventId, sequence));
}

describe("inventory outbox transport", () => {
  it("pins one exact ordered range and reuses its batch id, digest, and payload after restart", async () => {
    const { db, exec } = await setup();
    queue(db, "55555555-5555-4555-8555-555555555555", 1);
    const first = await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "batch-pinned",
    });
    queue(db, "66666666-6666-4666-8666-666666666666", 2);
    const restarted = await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "must-not-be-used",
    });
    expect(restarted).toEqual(first);
    expect(restarted?.request.events.map((item) => item.eventId)).toEqual([
      "55555555-5555-4555-8555-555555555555",
    ]);
  });

  it("fails closed when a pinned event payload is mutated", async () => {
    const { db, exec } = await setup();
    const eventId = "55555555-5555-4555-8555-555555555555";
    queue(db, eventId, 1);
    await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "batch-pinned",
    });
    db.prepare("UPDATE inventory_outbox SET payload_json = '{}' WHERE event_id = ?").run(eventId);
    await expect(
      prepareInventoryOutboxBatch(exec, { inventoryId: INVENTORY_ID, snapshotId: SNAPSHOT_ID }),
    ).rejects.toThrow("inventory outbox payload changed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
  });

  it("persists conflict evidence before deleting only exactly acknowledged rows", async () => {
    const { db, exec } = await setup();
    const eventId = "55555555-5555-4555-8555-555555555555";
    queue(db, eventId, 1);
    const batch = await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "batch-pinned",
    });
    if (!batch) throw new Error("expected batch");
    await acknowledgeInventoryOutboxBatch(exec, batch, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      batchId: batch.request.batchId,
      payloadDigest: batch.request.payloadDigest,
      sequenceCeiling: 1,
      resultRevision: 1,
      outcomes: [
        {
          eventId,
          status: "duplicate",
          reasonCode: "CLAIM_LOST",
          winner: {
            codeHash: "1".repeat(64),
            eventId: "77777777-7777-4777-8777-777777777777",
            deviceId: "88888888-8888-4888-8888-888888888888",
            scannedAt: "2026-08-25T09:00:00.000Z",
          },
        },
      ],
    });
    expect(db.prepare("SELECT winning_event_id FROM inventory_conflicts_mirror").get()).toEqual({
      winning_event_id: "77777777-7777-4777-8777-777777777777",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 0,
    });
  });

  it("refuses to acknowledge a row whose pinned payload changed after the request", async () => {
    const { db, exec } = await setup();
    const eventId = "55555555-5555-4555-8555-555555555555";
    queue(db, eventId, 1);
    const batch = await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "batch-pinned",
    });
    if (!batch) throw new Error("expected batch");
    db.prepare("UPDATE inventory_outbox SET payload_json = '{}' WHERE event_id = ?").run(eventId);

    await expect(
      acknowledgeInventoryOutboxBatch(exec, batch, {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        snapshotRevision: 1,
        batchId: batch.request.batchId,
        payloadDigest: batch.request.payloadDigest,
        sequenceCeiling: 1,
        resultRevision: 1,
        outcomes: [{ eventId, status: "applied", reasonCode: "CLAIM_APPLIED" }],
      }),
    ).rejects.toThrow("inventory outbox payload changed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare(
          "SELECT authoritative_verdict FROM inventory_scan_events_mirror WHERE event_id = ?",
        )
        .get(eventId),
    ).toEqual({ authoritative_verdict: null });
  });
});

it("keeps authoritative outcome columns in forward SQLite migrations", () => {
  expect(STATION_MIGRATIONS.some((sql) => sql.includes("authoritative_verdict"))).toBe(true);
});
