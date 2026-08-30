import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";

import {
  acknowledgeInventoryOutboxBatch,
  prepareInventoryOutboxBatch,
} from "../src/lib/inventory-outbox.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeExec, makeRotatingExec, openFileDatabase } from "./support/sqlite-exec.js";

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

async function rotatingSetup(hooks: Parameters<typeof makeRotatingExec>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), `inventory-outbox-${randomUUID()}-`));
  const path = join(directory, "mirror.sqlite");
  const databases = [openFileDatabase(path), openFileDatabase(path)];
  const exec = makeRotatingExec(databases, hooks);
  await applyMigrations(exec);
  const db = databases[0]!;
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
  return {
    db,
    exec,
    dispose() {
      for (const database of databases) database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
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

  it("acknowledges a deterministic replay after the original durable pin is lost", async () => {
    const { db, exec } = await setup();
    const eventId = "55555555-5555-4555-8555-555555555555";
    queue(db, eventId, 1);
    const original = await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "original-batch",
    });
    if (!original) throw new Error("expected batch");
    db.prepare("DELETE FROM station_meta WHERE key LIKE 'inventory_sync_batch_v1:%'").run();
    const recovered = await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "recovered-batch",
    });
    if (!recovered) throw new Error("expected recovered batch");
    expect(recovered.request.payloadDigest).toBe(original.request.payloadDigest);
    expect(recovered.request.batchId).toBe("recovered-batch");

    await acknowledgeInventoryOutboxBatch(exec, recovered, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      batchId: recovered.request.batchId,
      payloadDigest: recovered.request.payloadDigest,
      sequenceCeiling: 1,
      resultRevision: 1,
      outcomes: [
        {
          eventId,
          status: "replay",
          reasonCode: "BATCH_REPLAY",
          claimedCount: 1,
          conflictCount: 0,
          claims: [
            {
              codeHash: "1".repeat(64),
              status: "claimed",
              winner: {
                codeHash: "1".repeat(64),
                eventId,
                deviceId: DEVICE_ID,
                scannedAt: "2026-08-25T10:00:01.000Z",
              },
            },
          ],
        },
      ],
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 0,
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
          claimedCount: 0,
          conflictCount: 1,
          claims: [
            {
              codeHash: "1".repeat(64),
              status: "duplicate",
              winner: {
                codeHash: "1".repeat(64),
                eventId: "77777777-7777-4777-8777-777777777777",
                deviceId: "88888888-8888-4888-8888-888888888888",
                scannedAt: "2026-08-25T09:00:00.000Z",
              },
            },
          ],
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

  it("atomically persists evidence and exact acknowledgement through rotating pooled connections", async () => {
    const fixture = await rotatingSetup();
    try {
      const eventId = "55555555-5555-4555-8555-555555555555";
      queue(fixture.db, eventId, 1);
      const batch = await prepareInventoryOutboxBatch(fixture.exec, {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        createBatchId: () => "rotating-ack",
      });
      if (!batch) throw new Error("expected batch");
      await acknowledgeInventoryOutboxBatch(fixture.exec, batch, {
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
            claimedCount: 0,
            conflictCount: 1,
            claims: [
              {
                codeHash: "1".repeat(64),
                status: "duplicate",
                winner: {
                  codeHash: "1".repeat(64),
                  eventId: "77777777-7777-4777-8777-777777777777",
                  deviceId: "88888888-8888-4888-8888-888888888888",
                  scannedAt: "2026-08-25T09:00:00.000Z",
                },
              },
            ],
          },
        ],
      });
      expect(
        fixture.db.prepare("SELECT winning_event_id FROM inventory_conflicts_mirror").get(),
      ).toEqual({
        winning_event_id: "77777777-7777-4777-8777-777777777777",
      });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
        count: 0,
      });
    } finally {
      fixture.dispose();
    }
  });

  it("keeps rows intact on a fault before atomic acknowledgement and repairs on retry", async () => {
    let armed = false;
    const fixture = await rotatingSetup({
      beforeRun() {
        if (!armed) return;
        armed = false;
        throw new Error("simulated storage fault before acknowledgement");
      },
    });
    try {
      const eventId = "55555555-5555-4555-8555-555555555555";
      queue(fixture.db, eventId, 1);
      const batch = await prepareInventoryOutboxBatch(fixture.exec, {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        createBatchId: () => "faulted-ack",
      });
      if (!batch) throw new Error("expected batch");
      const response = {
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
            status: "applied",
            reasonCode: "CLAIM_APPLIED",
            claimedCount: 1,
            conflictCount: 0,
            claims: [
              {
                codeHash: "1".repeat(64),
                status: "claimed",
                winner: {
                  codeHash: "1".repeat(64),
                  eventId,
                  deviceId: DEVICE_ID,
                  scannedAt: "2026-08-25T10:00:01.000Z",
                },
              },
            ],
          },
        ],
      };
      armed = true;
      await expect(acknowledgeInventoryOutboxBatch(fixture.exec, batch, response)).rejects.toThrow(
        "simulated storage fault before acknowledgement",
      );
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
        count: 1,
      });
      expect(
        fixture.db.prepare("SELECT authoritative_verdict FROM inventory_scan_events_mirror").get(),
      ).toEqual({ authoritative_verdict: null });

      await acknowledgeInventoryOutboxBatch(fixture.exec, batch, response);
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
        count: 0,
      });
      expect(
        fixture.db.prepare("SELECT authoritative_verdict FROM inventory_scan_events_mirror").get(),
      ).toEqual({ authoritative_verdict: "applied" });
    } finally {
      fixture.dispose();
    }
  });

  it("reconciles an acknowledgement retry after the receipt committed before the caller observed it", async () => {
    let armed = false;
    const fixture = await rotatingSetup({
      afterRun(sql) {
        if (!armed || !sql.includes("INSERT INTO inventory_sync_ack_receipts")) return;
        armed = false;
        throw new Error("simulated crash after acknowledgement commit");
      },
    });
    try {
      const eventId = "55555555-5555-4555-8555-555555555555";
      queue(fixture.db, eventId, 1);
      const batch = await prepareInventoryOutboxBatch(fixture.exec, {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        createBatchId: () => "committed-ack",
      });
      if (!batch) throw new Error("expected batch");
      const response = {
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
            status: "applied",
            reasonCode: "CLAIM_APPLIED",
            claimedCount: 1,
            conflictCount: 0,
            claims: [
              {
                codeHash: "1".repeat(64),
                status: "claimed",
                winner: {
                  codeHash: "1".repeat(64),
                  eventId,
                  deviceId: DEVICE_ID,
                  scannedAt: "2026-08-25T10:00:01.000Z",
                },
              },
            ],
          },
        ],
      };
      armed = true;
      await expect(acknowledgeInventoryOutboxBatch(fixture.exec, batch, response)).rejects.toThrow(
        "simulated crash after acknowledgement commit",
      );
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
        count: 0,
      });
      expect(
        fixture.db
          .prepare("SELECT COUNT(*) AS count FROM inventory_event_claim_outcomes_mirror")
          .get(),
      ).toEqual({ count: 1 });
      await expect(acknowledgeInventoryOutboxBatch(fixture.exec, batch, response)).resolves.toEqual(
        response,
      );
    } finally {
      fixture.dispose();
    }
  });

  it("persists every per-code outcome from a mixed known-box acknowledgement", async () => {
    const { db, exec } = await setup();
    const eventId = "55555555-5555-4555-8555-555555555555";
    queue(db, eventId, 1);
    const boxEvent = {
      eventId,
      deviceSequence: 1,
      operatorId: OPERATOR_ID,
      scannedAt: "2026-08-25T10:00:01.000Z",
      kind: "known_box",
      normalizedIdentity: "known_box:346006820000000014",
      codeHash: null,
      canonicalRaw: "346006820000000014",
      activeProductionDate: "2026-08-20",
      localVerdict: "expected",
    };
    db.prepare(
      `UPDATE inventory_scan_events_mirror
          SET kind = 'known_box', normalized_identity = ?, code_hash = NULL, raw_payload = ?
        WHERE event_id = ?`,
    ).run(boxEvent.normalizedIdentity, boxEvent.canonicalRaw, eventId);
    db.prepare("UPDATE inventory_outbox SET payload_json = ? WHERE event_id = ?").run(
      JSON.stringify(boxEvent),
      eventId,
    );
    const batch = await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "mixed-box",
    });
    if (!batch) throw new Error("expected batch");
    const losingHash = "1".repeat(64);
    const claimedHash = "2".repeat(64);
    const remoteEventId = "77777777-7777-4777-8777-777777777777";
    await acknowledgeInventoryOutboxBatch(exec, batch, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      batchId: batch.request.batchId,
      payloadDigest: batch.request.payloadDigest,
      sequenceCeiling: 1,
      resultRevision: 4,
      outcomes: [
        {
          eventId,
          status: "applied",
          reasonCode: "CLAIM_APPLIED",
          claimedCount: 1,
          conflictCount: 1,
          claims: [
            {
              codeHash: losingHash,
              status: "duplicate",
              winner: {
                codeHash: losingHash,
                eventId: remoteEventId,
                deviceId: "88888888-8888-4888-8888-888888888888",
                scannedAt: "2026-08-25T09:00:00.000Z",
              },
            },
            {
              codeHash: claimedHash,
              status: "claimed",
              winner: {
                codeHash: claimedHash,
                eventId,
                deviceId: DEVICE_ID,
                scannedAt: boxEvent.scannedAt,
              },
            },
          ],
        },
      ],
    });
    expect(
      db
        .prepare(
          `SELECT code_hash, status, winning_event_id
             FROM inventory_event_claim_outcomes_mirror ORDER BY code_hash`,
        )
        .all(),
    ).toEqual([
      { code_hash: losingHash, status: "duplicate", winning_event_id: remoteEventId },
      { code_hash: claimedHash, status: "claimed", winning_event_id: eventId },
    ]);
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
        outcomes: [
          {
            eventId,
            status: "applied",
            reasonCode: "CLAIM_APPLIED",
            claimedCount: 1,
            conflictCount: 0,
            claims: [
              {
                codeHash: "1".repeat(64),
                status: "claimed",
                winner: {
                  codeHash: "1".repeat(64),
                  eventId,
                  deviceId: DEVICE_ID,
                  scannedAt: "2026-08-25T10:00:01.000Z",
                },
              },
            ],
          },
        ],
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
