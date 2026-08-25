import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  applyInventoryProgressPage,
  createInventorySyncEngine,
  leaveInventoryTask,
} from "../src/lib/inventory-sync.js";
import {
  createCredentialGeneration,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";

async function setup(): Promise<{ db: DatabaseSync; exec: SqlExecutor }> {
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
     VALUES (?, ?, ?, ?, 2, '2026-08-25T10:00:00.000Z')`,
  ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
  const event = {
    eventId: EVENT_ID,
    deviceSequence: 1,
    operatorId: OPERATOR_ID,
    scannedAt: "2026-08-25T10:00:01.000Z",
    kind: "item",
    normalizedIdentity: `item:${"a".repeat(64)}`,
    codeHash: "a".repeat(64),
    canonicalRaw: "010460000000001521SERIAL",
    activeProductionDate: "2026-08-20",
    localVerdict: "expected",
  };
  db.prepare(
    `INSERT INTO inventory_scan_events_mirror
       (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
        kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
        commit_state, legacy_audit_version)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'item', ?, ?, ?, '2026-08-20', 'expected', 'committed', 1)`,
  ).run(
    INVENTORY_ID,
    SNAPSHOT_ID,
    EVENT_ID,
    DEVICE_ID,
    OPERATOR_ID,
    event.scannedAt,
    event.normalizedIdentity,
    event.codeHash,
    event.canonicalRaw,
  );
  db.prepare(
    `INSERT INTO inventory_outbox
       (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
     VALUES (?, ?, ?, 1, ?, '2026-08-25T10:00:01.000Z')`,
  ).run(INVENTORY_ID, SNAPSHOT_ID, EVENT_ID, JSON.stringify(event));
  return { db, exec };
}

describe("inventory sync engine", () => {
  it.each([
    ["network failure", () => Promise.reject(new Error("offline"))],
    ["captive portal response", () => Promise.resolve("<html>login</html>")],
    ["partial response", () => Promise.resolve({ outcomes: [] })],
  ])("retains the exact batch on %s", async (_name, response) => {
    const { db, exec } = await setup();
    const engine = createInventorySyncEngine({
      exec,
      client: { post: vi.fn((_path: string, _body?: unknown) => response()) },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      onState: () => undefined,
      retry: false,
    });
    engine.nudge();
    await engine.idle();
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
  });

  it("is single-flight when nudged during an active drain", async () => {
    const { exec } = await setup();
    let release!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      release = resolve;
    });
    const post = vi.fn((_path: string, _body?: unknown) => response);
    const engine = createInventorySyncEngine({
      exec,
      client: { post },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      onState: () => undefined,
      retry: false,
    });
    engine.nudge();
    engine.nudge();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0]![1] as { batchId: string; payloadDigest: string };
    release({
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      batchId: body.batchId,
      payloadDigest: body.payloadDigest,
      sequenceCeiling: 1,
      resultRevision: 1,
      outcomes: [{ eventId: EVENT_ID, status: "applied", reasonCode: "CLAIM_APPLIED" }],
    });
    await engine.idle();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a successful response after its credential generation is sealed", async () => {
    const { db, exec } = await setup();
    const generation = createCredentialGeneration("credential-a");
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const post = vi.fn((_path: string, _body?: unknown) => pending);
    const engine = createInventorySyncEngine({
      exec,
      client: { post },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      credentialGeneration: generation,
      onState: () => undefined,
      retry: false,
    });
    engine.nudge();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0]![1] as {
      batchId: string;
      payloadDigest: string;
    };
    await sealCredentialGeneration(generation);
    release({
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      batchId: body.batchId,
      payloadDigest: body.payloadDigest,
      sequenceCeiling: 1,
      resultRevision: 1,
      outcomes: [{ eventId: EVENT_ID, status: "applied", reasonCode: "CLAIM_APPLIED" }],
    });
    await engine.idle();
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare(
          "SELECT authoritative_verdict FROM inventory_scan_events_mirror WHERE event_id = ?",
        )
        .get(EVENT_ID),
    ).toEqual({ authoritative_verdict: null });
  });

  it("treats quarantined as a strict terminal acknowledgement", async () => {
    const { db, exec } = await setup();
    const post = vi.fn(async (_path: string, bodyValue?: unknown) => {
      const body = bodyValue as { batchId: string; payloadDigest: string };
      return {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        snapshotRevision: 1,
        batchId: body.batchId,
        payloadDigest: body.payloadDigest,
        sequenceCeiling: 1,
        resultRevision: 8,
        outcomes: [{ eventId: EVENT_ID, status: "quarantined", reasonCode: "INVENTORY_CLOSED" }],
      };
    });
    const engine = createInventorySyncEngine({
      exec,
      client: { post },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      onState: () => undefined,
      retry: false,
    });
    engine.nudge();
    await engine.idle();
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 0,
    });
    expect(
      db
        .prepare(
          "SELECT authoritative_verdict FROM inventory_scan_events_mirror WHERE event_id = ?",
        )
        .get(EVENT_ID),
    ).toEqual({ authoritative_verdict: "quarantined" });
  });

  it("retains the row if local outcome persistence fails", async () => {
    const { db, exec } = await setup();
    const failingExec: SqlExecutor = {
      all: (sql, params) => exec.all(sql, params),
      run: async (sql, params) => {
        if (sql.includes("UPDATE inventory_scan_events_mirror SET")) {
          throw new Error("sqlite unavailable");
        }
        await exec.run(sql, params);
      },
    };
    const engine = createInventorySyncEngine({
      exec: failingExec,
      client: {
        post: vi.fn(async (_path: string, bodyValue?: unknown) => {
          const body = bodyValue as { batchId: string; payloadDigest: string };
          return {
            inventoryId: INVENTORY_ID,
            snapshotId: SNAPSHOT_ID,
            snapshotRevision: 1,
            batchId: body.batchId,
            payloadDigest: body.payloadDigest,
            sequenceCeiling: 1,
            resultRevision: 1,
            outcomes: [{ eventId: EVENT_ID, status: "applied", reasonCode: "CLAIM_APPLIED" }],
          };
        }),
      },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      onState: () => undefined,
      retry: false,
    });
    engine.nudge();
    await engine.idle();
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
  });

  it("drains a row appended while the pinned batch is in flight as the next exact batch", async () => {
    const { db, exec } = await setup();
    const secondEventId = "66666666-6666-4666-8666-666666666666";
    const post = vi.fn(async (_path: string, bodyValue?: unknown) => {
      const body = bodyValue as {
        batchId: string;
        payloadDigest: string;
        sequenceCeiling: number;
        events: Array<{ eventId: string }>;
      };
      if (post.mock.calls.length === 1) {
        const second = {
          eventId: secondEventId,
          deviceSequence: 2,
          operatorId: OPERATOR_ID,
          scannedAt: "2026-08-25T10:00:02.000Z",
          kind: "item",
          normalizedIdentity: `item:${"b".repeat(64)}`,
          codeHash: "b".repeat(64),
          canonicalRaw: "010460000000001521SECOND",
          activeProductionDate: "2026-08-20",
          localVerdict: "expected",
        };
        db.prepare(
          `INSERT INTO inventory_scan_events_mirror
             (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
              scanned_at, kind, normalized_identity, code_hash, raw_payload,
              active_production_date, local_verdict, commit_state, legacy_audit_version)
           VALUES (?, ?, ?, ?, 2, ?, ?, 'item', ?, ?, ?, '2026-08-20', 'expected',
                   'committed', 1)`,
        ).run(
          INVENTORY_ID,
          SNAPSHOT_ID,
          secondEventId,
          DEVICE_ID,
          OPERATOR_ID,
          second.scannedAt,
          second.normalizedIdentity,
          second.codeHash,
          second.canonicalRaw,
        );
        db.prepare(
          `INSERT INTO inventory_outbox
             (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
           VALUES (?, ?, ?, 2, ?, '2026-08-25T10:00:02.000Z')`,
        ).run(INVENTORY_ID, SNAPSHOT_ID, secondEventId, JSON.stringify(second));
      }
      return {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        snapshotRevision: 1,
        batchId: body.batchId,
        payloadDigest: body.payloadDigest,
        sequenceCeiling: body.sequenceCeiling,
        resultRevision: post.mock.calls.length,
        outcomes: body.events.map((item) => ({
          eventId: item.eventId,
          status: "applied",
          reasonCode: "CLAIM_APPLIED",
        })),
      };
    });
    const engine = createInventorySyncEngine({
      exec,
      client: { post },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      onState: () => undefined,
      retry: false,
    });
    engine.nudge();
    await engine.idle();
    expect(post).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 0,
    });
  });
});

describe("inventory progress and leave", () => {
  it("persists a remote winner before its cursor and replays a correction idempotently", async () => {
    const { db, exec } = await setup();
    const winnerEventId = "77777777-7777-4777-8777-777777777777";
    const winnerDeviceId = "88888888-8888-4888-8888-888888888888";
    const claimId = "99999999-9999-4999-8999-999999999999";
    const claim = {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      cursor: null,
      resultRevision: 1,
      items: [
        {
          id: claimId,
          revision: 1,
          kind: "claim",
          codeHash: "a".repeat(64),
          classification: "expected",
          observedProductionDate: "2026-08-20",
          winner: {
            codeHash: "a".repeat(64),
            eventId: winnerEventId,
            deviceId: winnerDeviceId,
            scannedAt: "2026-08-25T09:00:00.000Z",
          },
          correctedAt: "2026-08-25T10:01:00.000Z",
        },
      ],
      nextCursor: `1:${claimId}`,
    };
    const cursorFailingExec: SqlExecutor = {
      all: (sql, params) => exec.all(sql, params),
      run: async (sql, params) => {
        if (sql.includes("SET progress_cursor")) throw new Error("cursor write failed");
        await exec.run(sql, params);
      },
    };
    await expect(
      applyInventoryProgressPage(
        cursorFailingExec,
        {
          inventoryId: INVENTORY_ID,
          snapshotId: SNAPSHOT_ID,
          deviceId: DEVICE_ID,
        },
        claim,
      ),
    ).rejects.toThrow("cursor write failed");
    expect(
      db
        .prepare(
          "SELECT first_accepted_event_id FROM inventory_code_results_mirror WHERE code_hash = ?",
        )
        .get("a".repeat(64)),
    ).toEqual({ first_accepted_event_id: winnerEventId });
    expect(db.prepare("SELECT progress_cursor FROM inventory_terminal_state").get()).toEqual({
      progress_cursor: null,
    });

    await applyInventoryProgressPage(
      exec,
      {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
      },
      claim,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_conflicts_mirror").get()).toEqual({
      count: 1,
    });
    const correctionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const correction = {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      cursor: `1:${claimId}`,
      resultRevision: 2,
      items: [
        {
          id: correctionId,
          revision: 2,
          kind: "correction",
          codeHash: "a".repeat(64),
          classification: "voided",
          observedProductionDate: null,
          winner: null,
          correctedAt: "2026-08-25T10:02:00.000Z",
        },
      ],
      nextCursor: `2:${correctionId}`,
    };
    await applyInventoryProgressPage(
      exec,
      {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
      },
      correction,
    );
    await applyInventoryProgressPage(
      exec,
      {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
      },
      correction,
    );
    expect(
      db
        .prepare("SELECT classification FROM inventory_code_results_mirror WHERE code_hash = ?")
        .get("a".repeat(64)),
    ).toEqual({ classification: "voided" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_conflicts_mirror").get()).toEqual({
      count: 1,
    });
  });

  it("never calls leave with pending local work and deletes only the exact pointer after success", async () => {
    const { db, exec } = await setup();
    db.prepare(
      "INSERT INTO station_meta (key, value) VALUES ('active_inventory_floor_task_v1', ?)",
    ).run(JSON.stringify({ inventoryId: INVENTORY_ID, snapshotId: SNAPSHOT_ID }));
    const post = vi.fn(async () => ({ outcome: "left" }));
    const order: string[] = [];
    const deps = {
      exec,
      client: { post },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      closeScanner: async () => {
        order.push("scanner");
      },
      scanQueueIdle: async () => {
        order.push("queue");
      },
      sync: {
        nudge: () => {
          order.push("outbox");
        },
        idle: async () => undefined,
      },
    };
    await expect(leaveInventoryTask(deps)).rejects.toThrow("inventory task still has pending work");
    expect(post).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM station_meta WHERE key = 'active_inventory_floor_task_v1'",
        )
        .get(),
    ).toEqual({ count: 1 });

    db.prepare("DELETE FROM inventory_outbox").run();
    await leaveInventoryTask(deps);
    expect(order).toEqual(["scanner", "queue", "outbox", "scanner", "queue", "outbox"]);
    expect(post).toHaveBeenCalledWith(`/station/inventories/${INVENTORY_ID}/leave`, {
      pendingEventCount: 0,
      openBoxCount: 0,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM station_meta WHERE key = 'active_inventory_floor_task_v1'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("retains the exact floor pointer when leave gets a network or malformed response", async () => {
    for (const post of [
      vi.fn(async () => {
        throw new Error("offline");
      }),
      vi.fn(async () => ({ outcome: "left", extra: true })),
    ]) {
      const { db, exec } = await setup();
      db.prepare("DELETE FROM inventory_outbox").run();
      db.prepare(
        "INSERT INTO station_meta (key, value) VALUES ('active_inventory_floor_task_v1', ?)",
      ).run(JSON.stringify({ inventoryId: INVENTORY_ID, snapshotId: SNAPSHOT_ID }));
      await expect(
        leaveInventoryTask({
          exec,
          client: { post },
          inventoryId: INVENTORY_ID,
          snapshotId: SNAPSHOT_ID,
          deviceId: DEVICE_ID,
          closeScanner: async () => undefined,
          scanQueueIdle: async () => undefined,
          sync: { nudge: () => undefined, idle: async () => undefined },
        }),
      ).rejects.toThrow();
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM station_meta WHERE key = 'active_inventory_floor_task_v1'",
          )
          .get(),
      ).toEqual({ count: 1 });
    }
  });
});
