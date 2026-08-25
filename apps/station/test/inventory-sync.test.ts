import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  applyInventoryProgressPage,
  createInventorySyncEngine,
  leaveInventoryTask,
} from "../src/lib/inventory-sync.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import { makeExec, makeRotatingExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";

function appliedOutcome(
  eventId = EVENT_ID,
  codeHash = "a".repeat(64),
  scannedAt = "2026-08-25T10:00:01.000Z",
) {
  return {
    eventId,
    status: "applied" as const,
    reasonCode: "CLAIM_APPLIED",
    claimedCount: 1,
    conflictCount: 0,
    claims: [
      {
        codeHash,
        status: "claimed" as const,
        winner: {
          codeHash,
          eventId,
          deviceId: DEVICE_ID,
          scannedAt,
        },
      },
    ],
  };
}

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

async function rotatingProgressSetup(hooks: Parameters<typeof makeRotatingExec>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), `inventory-progress-${randomUUID()}-`));
  const path = join(directory, "mirror.sqlite");
  const databases = [new DatabaseSync(path), new DatabaseSync(path)];
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
     VALUES (?, ?, ?, ?, 2, '2026-08-25T10:00:00.000Z')`,
  ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
  db.prepare(
    `INSERT INTO inventory_scan_events_mirror
       (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
        kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
        commit_state, legacy_audit_version)
     VALUES (?, ?, ?, ?, 1, ?, '2026-08-25T10:00:01.000Z', 'item', ?, ?,
       '010460000000001521SERIAL', '2026-08-20', 'expected', 'committed', 1)`,
  ).run(
    INVENTORY_ID,
    SNAPSHOT_ID,
    EVENT_ID,
    DEVICE_ID,
    OPERATOR_ID,
    `item:${"a".repeat(64)}`,
    "a".repeat(64),
  );
  return {
    db,
    exec,
    dispose() {
      for (const database of databases) database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("inventory sync engine", () => {
  it("uses bounded exponential retry and resets the delay after a successful acknowledgement", async () => {
    vi.useFakeTimers();
    try {
      const { db, exec } = await setup();
      let attempts = 0;
      const post = vi.fn(async (_path: string, bodyValue?: unknown) => {
        attempts += 1;
        if (attempts === 1 || attempts === 2 || attempts === 4) throw new Error("offline");
        const body = bodyValue as {
          batchId: string;
          payloadDigest: string;
          sequenceCeiling: number;
          events: Array<{ eventId: string; codeHash: string; scannedAt: string }>;
        };
        if (attempts === 3) {
          const secondEventId = "66666666-6666-4666-8666-666666666666";
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
          resultRevision: 1,
          outcomes: body.events.map((item) => ({
            eventId: item.eventId,
            status: "applied",
            reasonCode: "CLAIM_APPLIED",
            claimedCount: 1,
            conflictCount: 0,
            claims: [
              {
                codeHash: item.codeHash,
                status: "claimed",
                winner: {
                  codeHash: item.codeHash,
                  eventId: item.eventId,
                  deviceId: DEVICE_ID,
                  scannedAt: item.scannedAt,
                },
              },
            ],
          })),
        };
      });
      const engine = createInventorySyncEngine({
        exec,
        client: { post },
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        onState: () => undefined,
      });
      engine.nudge();
      await vi.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(post).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(post).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(post).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(5);
      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps exponential retry at sixty seconds", async () => {
    vi.useFakeTimers();
    try {
      const { exec } = await setup();
      const post = vi.fn(async () => {
        throw new Error("offline");
      });
      const engine = createInventorySyncEngine({
        exec,
        client: { post },
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        onState: () => undefined,
      });
      engine.nudge();
      await vi.advanceTimersByTimeAsync(0);
      for (const [index, delay] of [
        2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
      ].entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(post).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(post).toHaveBeenCalledTimes(index + 2);
      }
      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("retains durable work on a structurally valid but contradictory 200 response", async () => {
    const { db, exec } = await setup();
    const engine = createInventorySyncEngine({
      exec,
      client: {
        post: vi.fn(async (_path: string, bodyValue?: unknown) => {
          const body = bodyValue as { batchId: string; payloadDigest: string };
          return {
            inventoryId: "66666666-6666-4666-8666-666666666666",
            snapshotId: SNAPSHOT_ID,
            snapshotRevision: 1,
            batchId: body.batchId,
            payloadDigest: body.payloadDigest,
            sequenceCeiling: 1,
            resultRevision: 1,
            outcomes: [appliedOutcome()],
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
    expect(
      db.prepare("SELECT authoritative_verdict FROM inventory_scan_events_mirror").get(),
    ).toEqual({ authoritative_verdict: null });
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
      outcomes: [appliedOutcome()],
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
      outcomes: [appliedOutcome()],
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
        outcomes: [
          {
            eventId: EVENT_ID,
            status: "quarantined",
            reasonCode: "INVENTORY_CLOSED",
            claimedCount: 0,
            conflictCount: 0,
            claims: [],
          },
        ],
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
        if (sql.includes("INSERT INTO inventory_sync_ack_receipts")) {
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
            outcomes: [appliedOutcome()],
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
        events: Array<{ eventId: string; codeHash: string; scannedAt: string }>;
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
        outcomes: body.events.map((item) =>
          appliedOutcome(item.eventId, item.codeHash, item.scannedAt),
        ),
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
  it("keeps progress single-flight and cannot commit a deferred response after stop", async () => {
    const { db, exec } = await setup();
    let release!: (value: unknown) => void;
    const deferred = new Promise((resolve) => {
      release = resolve;
    });
    const get = vi.fn(async () => deferred);
    const engine = createInventorySyncEngine({
      exec,
      client: { get, post: vi.fn(async () => ({})) },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      onState: () => undefined,
      retry: false,
    });
    const first = engine.pollProgress();
    const second = engine.pollProgress();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    engine.stop();
    release({
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      cursor: null,
      resultRevision: 1,
      items: [],
      nextCursor: null,
    });
    await Promise.all([first, second]);
    expect(
      db
        .prepare("SELECT progress_cursor, progress_result_revision FROM inventory_terminal_state")
        .get(),
    ).toEqual({ progress_cursor: null, progress_result_revision: 0 });
  });

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
        if (sql.includes("INSERT INTO inventory_progress_receipts")) {
          throw new Error("cursor write failed");
        }
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
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      { count: 0 },
    );
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
    await expect(
      applyInventoryProgressPage(
        exec,
        {
          inventoryId: INVENTORY_ID,
          snapshotId: SNAPSHOT_ID,
          deviceId: DEVICE_ID,
        },
        correction,
      ),
    ).rejects.toThrow("Invalid inventory progress page");
    expect(
      db
        .prepare("SELECT classification FROM inventory_code_results_mirror WHERE code_hash = ?")
        .get("a".repeat(64)),
    ).toEqual({ classification: "voided" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_conflicts_mirror").get()).toEqual({
      count: 1,
    });
  });

  it("atomically applies a projection and cursor through rotating pooled connections", async () => {
    const fixture = await rotatingProgressSetup();
    try {
      const claimId = "99999999-9999-4999-8999-999999999999";
      await applyInventoryProgressPage(
        fixture.exec,
        { inventoryId: INVENTORY_ID, snapshotId: SNAPSHOT_ID, deviceId: DEVICE_ID },
        {
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
                eventId: "77777777-7777-4777-8777-777777777777",
                deviceId: "88888888-8888-4888-8888-888888888888",
                scannedAt: "2026-08-25T09:00:00.000Z",
              },
              correctedAt: "2026-08-25T10:01:00.000Z",
            },
          ],
          nextCursor: `1:${claimId}`,
        },
      );
      expect(
        fixture.db
          .prepare(
            `SELECT result.code_hash, terminal.progress_cursor
               FROM inventory_code_results_mirror result
               JOIN inventory_terminal_state terminal
                 ON terminal.inventory_id = result.inventory_id
                AND terminal.snapshot_id = result.snapshot_id`,
          )
          .get(),
      ).toEqual({ code_hash: "a".repeat(64), progress_cursor: `1:${claimId}` });
    } finally {
      fixture.dispose();
    }
  });

  it("cannot advance the cursor on a pre-apply fault and repairs the whole page on retry", async () => {
    let armed = false;
    const fixture = await rotatingProgressSetup({
      beforeRun() {
        if (!armed) return;
        armed = false;
        throw new Error("simulated storage fault before progress apply");
      },
    });
    try {
      const claimId = "99999999-9999-4999-8999-999999999999";
      const page = {
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
              eventId: "77777777-7777-4777-8777-777777777777",
              deviceId: "88888888-8888-4888-8888-888888888888",
              scannedAt: "2026-08-25T09:00:00.000Z",
            },
            correctedAt: "2026-08-25T10:01:00.000Z",
          },
        ],
        nextCursor: `1:${claimId}`,
      };
      armed = true;
      await expect(
        applyInventoryProgressPage(
          fixture.exec,
          { inventoryId: INVENTORY_ID, snapshotId: SNAPSHOT_ID, deviceId: DEVICE_ID },
          page,
        ),
      ).rejects.toThrow("simulated storage fault before progress apply");
      expect(
        fixture.db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get(),
      ).toEqual({
        count: 0,
      });
      expect(
        fixture.db.prepare("SELECT progress_cursor FROM inventory_terminal_state").get(),
      ).toEqual({
        progress_cursor: null,
      });

      await applyInventoryProgressPage(
        fixture.exec,
        { inventoryId: INVENTORY_ID, snapshotId: SNAPSHOT_ID, deviceId: DEVICE_ID },
        page,
      );
      expect(
        fixture.db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get(),
      ).toEqual({
        count: 1,
      });
      expect(
        fixture.db.prepare("SELECT progress_cursor FROM inventory_terminal_state").get(),
      ).toEqual({
        progress_cursor: `1:${claimId}`,
      });
    } finally {
      fixture.dispose();
    }
  });

  it("never calls leave with pending local work and deletes only the exact pointer after success", async () => {
    const { db, exec } = await setup();
    const generation = createCredentialGeneration("leave-credential");
    const ownership = await credentialGenerationOwnership(generation);
    if (!ownership) throw new Error("expected ownership");
    const pointerValue = JSON.stringify({
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      credentialOwnership: ownership,
      activationId: "leave-activation",
    });
    db.prepare(
      "INSERT INTO station_meta (key, value) VALUES ('active_inventory_floor_task_v1', ?)",
    ).run(pointerValue);
    const post = vi.fn(async () => ({ outcome: "left" }));
    const order: string[] = [];
    const deps = {
      exec,
      client: { post },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      pointerValue,
      credentialGeneration: generation,
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
      const generation = createCredentialGeneration("leave-credential");
      const ownership = await credentialGenerationOwnership(generation);
      if (!ownership) throw new Error("expected ownership");
      const pointerValue = JSON.stringify({
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        credentialOwnership: ownership,
        activationId: "leave-activation",
      });
      db.prepare("DELETE FROM inventory_outbox").run();
      db.prepare(
        "INSERT INTO station_meta (key, value) VALUES ('active_inventory_floor_task_v1', ?)",
      ).run(pointerValue);
      await expect(
        leaveInventoryTask({
          exec,
          client: { post },
          inventoryId: INVENTORY_ID,
          snapshotId: SNAPSHOT_ID,
          deviceId: DEVICE_ID,
          pointerValue,
          credentialGeneration: generation,
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

  it("does not clear a replacement activation when an older leave response arrives", async () => {
    const { db, exec } = await setup();
    db.prepare("DELETE FROM inventory_outbox").run();
    const generation = createCredentialGeneration("old-credential");
    const ownership = await credentialGenerationOwnership(generation);
    if (!ownership) throw new Error("expected ownership");
    const oldPointer = JSON.stringify({
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      credentialOwnership: ownership,
      activationId: "old",
    });
    const replacementPointer = JSON.stringify({
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      credentialOwnership: "b".repeat(64),
      activationId: "new",
    });
    db.prepare(
      "INSERT INTO station_meta (key, value) VALUES ('active_inventory_floor_task_v1', ?)",
    ).run(oldPointer);
    let release!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      release = resolve;
    });
    const leaving = leaveInventoryTask({
      exec,
      client: { post: vi.fn(async () => response) },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      pointerValue: oldPointer,
      credentialGeneration: generation,
      closeScanner: async () => undefined,
      scanQueueIdle: async () => undefined,
      sync: { nudge: () => undefined, idle: async () => undefined },
    });
    await vi.waitFor(() =>
      expect(
        db
          .prepare("SELECT value FROM station_meta WHERE key = ?")
          .get("active_inventory_floor_task_v1"),
      ).toEqual({ value: oldPointer }),
    );
    db.prepare("UPDATE station_meta SET value = ? WHERE key = ?").run(
      replacementPointer,
      "active_inventory_floor_task_v1",
    );
    release({ outcome: "left" });
    await expect(leaving).rejects.toThrow("inventory floor task ownership changed");
    expect(
      db
        .prepare("SELECT value FROM station_meta WHERE key = ?")
        .get("active_inventory_floor_task_v1"),
    ).toEqual({ value: replacementPointer });
  });

  it("keeps the owned pointer when credentials retire while leave is in flight", async () => {
    const { db, exec } = await setup();
    db.prepare("DELETE FROM inventory_outbox").run();
    const generation = createCredentialGeneration("leave-retired");
    const ownership = await credentialGenerationOwnership(generation);
    if (!ownership) throw new Error("expected ownership");
    const pointerValue = JSON.stringify({
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      credentialOwnership: ownership,
      activationId: "retired-in-flight",
    });
    db.prepare(
      "INSERT INTO station_meta (key, value) VALUES ('active_inventory_floor_task_v1', ?)",
    ).run(pointerValue);
    let release!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      release = resolve;
    });
    const post = vi.fn(async () => response);
    const leaving = leaveInventoryTask({
      exec,
      client: { post },
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      pointerValue,
      credentialGeneration: generation,
      closeScanner: async () => undefined,
      scanQueueIdle: async () => undefined,
      sync: { nudge: () => undefined, idle: async () => undefined },
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    await sealCredentialGeneration(generation);
    release({ outcome: "left" });
    await expect(leaving).rejects.toThrow("credential retired");
    expect(
      db
        .prepare("SELECT value FROM station_meta WHERE key = ?")
        .get("active_inventory_floor_task_v1"),
    ).toEqual({ value: pointerValue });
  });
});
