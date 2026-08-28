import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { canonicalizeKm, kmHash } from "@markiro/domain";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";

import {
  listRecentInventoryOperations,
  readInventoryProgress,
  reconcilePendingInventoryEvents,
  recordInventoryScan,
} from "../src/lib/inventory-journal.js";
import {
  loadInventoryProductionDate,
  setInventoryProductionDate,
} from "../src/lib/inventory-date.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";
const GTIN = "04600000000015";
const SSCC = "346006820000000014";

function raw(serial: string): string {
  return `01${GTIN}21${serial}\u001d91KEY\u001d92SIGN`;
}

function seedCode(
  db: DatabaseSync,
  serial: string,
  values: {
    status?: string;
    state?: string | null;
    expected?: number;
    protected?: number;
    parentSscc?: string | null;
  } = {},
) {
  const km = canonicalizeKm(raw(serial));
  const codeHash = kmHash(km);
  db.prepare(
    `INSERT INTO inventory_snapshot_codes_mirror
       (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
        source_production_date, parent_sscc, expected, protected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SNAPSHOT_ID,
    codeHash,
    km.raw,
    km.gtin14,
    km.serial,
    values.status ?? "INTRODUCED",
    values.state ?? null,
    "2026-08-20",
    values.parentSscc ?? null,
    values.expected ?? 1,
    values.protected ?? 0,
  );
  return { km, codeHash };
}

function input(scannerRaw: string, eventId: string, scannedAt = "2026-08-25T10:00:00.000Z") {
  return {
    inventoryId: INVENTORY_ID,
    snapshotId: SNAPSHOT_ID,
    deviceId: DEVICE_ID,
    operatorId: OPERATOR_ID,
    taskGtin14: GTIN,
    raw: scannerRaw,
    eventId,
    scannedAt,
  };
}

async function setup() {
  const db = new DatabaseSync(":memory:");
  const exec = makeExec(db);
  await applyMigrations(exec);
  db.prepare(
    "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'IVN-26-0042', ?)",
  ).run(INVENTORY_ID, SNAPSHOT_ID);
  await setInventoryProductionDate(exec, {
    inventoryId: INVENTORY_ID,
    snapshotId: SNAPSHOT_ID,
    deviceId: DEVICE_ID,
    operatorId: OPERATOR_ID,
    productionDate: "2026-08-20",
    updatedAt: "2026-08-25T09:00:00.000Z",
  });
  return { db, exec };
}

function round1Db() {
  const commitStateMigration = STATION_MIGRATIONS.findIndex((statement) =>
    statement.includes("ADD COLUMN commit_state"),
  );
  expect(commitStateMigration).toBeGreaterThan(0);
  const db = new DatabaseSync(":memory:");
  for (const statement of STATION_MIGRATIONS.slice(0, commitStateMigration + 1)) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
  return db;
}

function failOnce(base: SqlExecutor, pattern: RegExp): SqlExecutor {
  let failed = false;
  return {
    run: async (sql, params) => {
      if (!failed && pattern.test(sql)) {
        failed = true;
        throw new Error("simulated durable write failure");
      }
      return base.run(sql, params);
    },
    all: async <T>(sql: string, params?: unknown[]) => {
      if (!failed && pattern.test(sql)) {
        failed = true;
        throw new Error("simulated durable write failure");
      }
      return base.all<T>(sql, params);
    },
  };
}

function suspendOnce(base: SqlExecutor, pattern: RegExp) {
  let held = false;
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wait = async (sql: string) => {
    if (!held && pattern.test(sql)) {
      held = true;
      markStarted();
      await gate;
    }
  };
  const exec: SqlExecutor = {
    run: async (sql, params) => {
      await wait(sql);
      return base.run(sql, params);
    },
    all: async <T>(sql: string, params?: unknown[]) => {
      await wait(sql);
      return base.all<T>(sql, params);
    },
  };
  return { exec, started, release };
}

describe("inventory journal", () => {
  it("repairs a round-1 committed orphan before it can be presented as accepted", async () => {
    const db = round1Db();
    const code = seedCode(db, "ROUND1-ORPHAN");
    db.prepare(
      "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'INV-R1', ?)",
    ).run(INVENTORY_ID, SNAPSHOT_ID);
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict)
       VALUES (?, ?, 'round1-orphan', ?, 1, ?, '2026-08-25T08:00:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'expected')`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${code.codeHash}`,
      code.codeHash,
      code.km.raw,
    );

    const exec = makeExec(db);
    await applyMigrations(exec);

    expect(db.prepare("SELECT commit_state FROM inventory_scan_events_mirror").get()).toEqual({
      commit_state: "pending",
    });
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toEqual([]);
    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: false, recoveredCommitted: 1, failed: 0 },
    );
    expect(
      db
        .prepare(
          `SELECT commit_state, legacy_audit_version FROM inventory_scan_events_mirror
           WHERE event_id = 'round1-orphan'`,
        )
        .get(),
    ).toEqual({ commit_state: "committed", legacy_audit_version: 1 });
    expect(
      db.prepare("SELECT first_accepted_event_id FROM inventory_code_results_mirror").get(),
    ).toEqual({ first_accepted_event_id: "round1-orphan" });
    expect(db.prepare("SELECT event_id FROM inventory_outbox").get()).toEqual({
      event_id: "round1-orphan",
    });

    db.prepare("DELETE FROM inventory_outbox WHERE event_id = 'round1-orphan'").run();
    await applyMigrations(exec);
    expect(
      db
        .prepare(
          `SELECT commit_state, legacy_audit_version FROM inventory_scan_events_mirror
           WHERE event_id = 'round1-orphan'`,
        )
        .get(),
    ).toEqual({ commit_state: "committed", legacy_audit_version: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 0,
    });
  });

  it("requeues unknown observations and rebuilds partial box projections from a round-2 schema", async () => {
    const db = round1Db();
    db.prepare(
      "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'INV-R2', ?)",
    ).run(INVENTORY_ID, SNAPSHOT_ID);
    const first = seedCode(db, "BOX-REPAIR-A", { parentSscc: SSCC });
    const second = seedCode(db, "BOX-REPAIR-B", { parentSscc: SSCC, protected: 1 });
    const foreign = seedCode(db, "BOX-FOREIGN", { parentSscc: "123456789012345675" });
    const unknown = canonicalizeKm(raw("ROUND2-UNKNOWN"));
    const unknownHash = kmHash(unknown);
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict)
       VALUES (?, ?, 'round2-box', ?, 1, ?, '2026-08-25T08:00:00.000Z',
               'known_box', ?, NULL, ?, '2026-08-20', 'expected'),
              (?, ?, 'round2-unknown', ?, 2, ?, '2026-08-25T08:01:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'unknown')`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `known_box:${SSCC}`,
      SSCC,
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${unknownHash}`,
      unknownHash,
      unknown.raw,
    );
    const addProjection = db.prepare(
      `INSERT INTO inventory_code_results_mirror
         (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
          winning_scanned_at, observed_production_date, classification, origin_classification,
          updated_at)
       VALUES (?, ?, ?, 'round2-box', ?, '2026-08-25T08:00:00.000Z', '2026-08-20',
               'expected', 'expected', '2026-08-25T08:00:00.000Z')`,
    );
    addProjection.run(INVENTORY_ID, SNAPSHOT_ID, first.codeHash, DEVICE_ID);
    addProjection.run(INVENTORY_ID, SNAPSHOT_ID, foreign.codeHash, DEVICE_ID);

    const exec = makeExec(db);
    await applyMigrations(exec);
    expect(
      db.prepare("SELECT DISTINCT commit_state FROM inventory_scan_events_mirror").all(),
    ).toEqual([{ commit_state: "pending" }]);
    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: false, recoveredCommitted: 2, failed: 0 },
    );
    expect(
      db
        .prepare(
          `SELECT code_hash, origin_classification FROM inventory_code_results_mirror
           ORDER BY code_hash`,
        )
        .all(),
    ).toEqual(
      [
        { code_hash: first.codeHash, origin_classification: "expected" },
        { code_hash: second.codeHash, origin_classification: "protected" },
      ].sort((a, b) => a.code_hash.localeCompare(b.code_hash)),
    );
    expect(db.prepare("SELECT event_id FROM inventory_outbox ORDER BY event_id").all()).toEqual([
      { event_id: "round2-box" },
      { event_id: "round2-unknown" },
    ]);
  });

  it("keeps a known-item duplicate immutable but unresolved when its owner failed", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "INVALID-OWNER");
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'invalid-owner', ?, 1, ?, '2026-08-25T08:00:00.000Z',
               'item', ?, ?, 'not-a-km', '2026-08-20', 'expected', 'failed', 1),
              (?, ?, 'dependent-duplicate', ?, 2, ?, '2026-08-25T08:01:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'duplicate', 'committed', 1)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${code.codeHash}`,
      code.codeHash,
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${code.codeHash}`,
      code.codeHash,
      code.km.raw,
    );
    db.prepare(
      `UPDATE inventory_terminal_state SET next_device_sequence = 3
        WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID);

    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: true, recoveredCommitted: 0, failed: 1 },
    );
    expect(
      db
        .prepare(
          "SELECT event_id, commit_state FROM inventory_scan_events_mirror ORDER BY device_sequence",
        )
        .all(),
    ).toEqual([
      { event_id: "invalid-owner", commit_state: "failed" },
      { event_id: "dependent-duplicate", commit_state: "committed" },
    ]);
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toMatchObject([
      { eventId: "dependent-duplicate", verdict: "duplicate", firstWinning: null },
    ]);
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 0,
    });
    await expect(
      recordInventoryScan(exec, input(code.km.raw, "replacement-item", "2026-08-25T08:02:00.000Z")),
    ).resolves.toMatchObject({ verdict: "expected", claimedCount: 1 });
    await applyMigrations(exec);
    const restarted = makeExec(db);
    expect(
      (await listRecentInventoryOperations(restarted, INVENTORY_ID, SNAPSHOT_ID)).find(
        (operation) => operation.eventId === "dependent-duplicate",
      ),
    ).toMatchObject({ verdict: "duplicate", firstWinning: null });
    await expect(
      recordInventoryScan(
        restarted,
        input(code.km.raw, "dependent-duplicate", "2026-08-25T08:01:00.000Z"),
      ),
    ).resolves.toMatchObject({ verdict: "duplicate", firstWinning: null });
  });

  it("keeps a known-box duplicate immutable and requires a new accepted box scan", async () => {
    const { db, exec } = await setup();
    seedCode(db, "BOX-INVALID-OWNER", { parentSscc: SSCC });
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'invalid-box-owner', ?, 1, ?, '2026-08-25T08:00:00.000Z',
               'known_box', ?, NULL, ?, '2026-08-20', 'expected', 'failed', 1),
              (?, ?, 'dependent-box-duplicate', ?, 2, ?, '2026-08-25T08:01:00.000Z',
               'known_box', ?, NULL, ?, '2026-08-20', 'duplicate', 'committed', 1)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `known_box:${SSCC}`,
      SSCC,
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `known_box:${SSCC}`,
      SSCC,
    );
    db.prepare(
      `UPDATE inventory_terminal_state SET next_device_sequence = 3
        WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID);

    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: true, recoveredCommitted: 0, failed: 1 },
    );
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 0,
      acceptedBoxes: 0,
    });
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toMatchObject([
      { eventId: "dependent-box-duplicate", verdict: "duplicate", firstWinning: null },
    ]);

    await expect(
      recordInventoryScan(exec, input(SSCC, "replacement-box", "2026-08-25T08:02:00.000Z")),
    ).resolves.toMatchObject({ verdict: "expected", claimedCount: 1 });
    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: false, recoveredCommitted: 0, failed: 0 },
    );
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 1,
      acceptedBoxes: 1,
    });
    expect(
      db.prepare("SELECT first_accepted_event_id FROM inventory_code_results_mirror").get(),
    ).toEqual({ first_accepted_event_id: "replacement-box" });
    await applyMigrations(exec);
    const restarted = makeExec(db);
    const duplicateHistory = (
      await listRecentInventoryOperations(restarted, INVENTORY_ID, SNAPSHOT_ID)
    ).find((operation) => operation.eventId === "dependent-box-duplicate");
    expect(duplicateHistory).toMatchObject({ verdict: "duplicate", firstWinning: null });
    await expect(
      recordInventoryScan(
        restarted,
        input(SSCC, "dependent-box-duplicate", "2026-08-25T08:01:00.000Z"),
      ),
    ).resolves.toMatchObject({ verdict: "duplicate", firstWinning: null });
  });

  it("requeues a legacy duplicate only when an exact prior winner remains valid", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "VALID-OWNER");
    await recordInventoryScan(exec, input(code.km.raw, "valid-owner"));
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'valid-dependent', ?, 2, ?, '2026-08-25T08:01:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'duplicate', 'pending', 0)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${code.codeHash}`,
      code.codeHash,
      code.km.raw,
    );

    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: false, recoveredCommitted: 1, failed: 0 },
    );
    expect(
      db
        .prepare(
          "SELECT commit_state, legacy_audit_version FROM inventory_scan_events_mirror WHERE event_id = 'valid-dependent'",
        )
        .get(),
    ).toEqual({ commit_state: "committed", legacy_audit_version: 1 });
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 1,
    });
  });

  it("never overwrites a pre-existing legacy outbox payload while repairing", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "LEGACY-PAYLOAD-BYTES");
    await recordInventoryScan(exec, input(code.km.raw, "legacy-payload-owner"));
    const payload = JSON.stringify(
      {
        eventId: "legacy-payload-duplicate",
        deviceSequence: 2,
        operatorId: OPERATOR_ID,
        scannedAt: "2026-08-25T08:01:00.000Z",
        kind: "item",
        normalizedIdentity: `item:${code.codeHash}`,
        codeHash: code.codeHash,
        canonicalRaw: code.km.raw,
        activeProductionDate: "2026-08-20",
        localVerdict: "duplicate",
      },
      null,
      2,
    );
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'legacy-payload-duplicate', ?, 2, ?, '2026-08-25T08:01:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'duplicate', 'pending', 0)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${code.codeHash}`,
      code.codeHash,
      code.km.raw,
    );
    db.prepare(
      `INSERT INTO inventory_outbox
         (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
       VALUES (?, ?, 'legacy-payload-duplicate', 2, ?, '2026-08-25T08:01:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, payload);

    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).rejects.toThrow(
      "inconsistent durable output",
    );
    expect(
      db
        .prepare(
          "SELECT commit_state FROM inventory_scan_events_mirror WHERE event_id = 'legacy-payload-duplicate'",
        )
        .get(),
    ).toEqual({ commit_state: "pending" });
    expect(
      db
        .prepare(
          "SELECT payload_json FROM inventory_outbox WHERE event_id = 'legacy-payload-duplicate'",
        )
        .get(),
    ).toEqual({ payload_json: payload });
  });

  it("keeps an audited committed event after its acknowledged outbox is drained and migrations rerun", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "ACK-DRAINED");
    await recordInventoryScan(exec, input(code.km.raw, "event-ack-drained"));
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 1,
    });

    db.prepare("DELETE FROM inventory_outbox WHERE event_id = 'event-ack-drained'").run();
    await applyMigrations(exec);

    expect(
      db
        .prepare(
          `SELECT commit_state, legacy_audit_version FROM inventory_scan_events_mirror
           WHERE event_id = 'event-ack-drained'`,
        )
        .get(),
    ).toEqual({ commit_state: "committed", legacy_audit_version: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 1,
      },
    );
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 1,
    });
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toMatchObject([
      { eventId: "event-ack-drained", verdict: "expected" },
    ]);
  });

  it("fails legacy orphan/mismatched events while preserving exact expected and unknown outboxes", async () => {
    const stateMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ADD COLUMN commit_state"),
    );
    expect(stateMigration).toBeGreaterThan(0);
    const db = new DatabaseSync(":memory:");
    for (const statement of STATION_MIGRATIONS.slice(0, stateMigration)) {
      try {
        db.exec(statement);
      } catch (error) {
        if (
          !/duplicate column name/i.test(error instanceof Error ? error.message : String(error))
        ) {
          throw error;
        }
      }
    }
    const facts = [
      {
        eventId: "legacy-orphan",
        sequence: 1,
        scannedAt: "2026-08-25T08:00:00.000Z",
        km: canonicalizeKm(raw("LEGACY-ORPHAN")),
        verdict: "expected",
      },
      {
        eventId: "legacy-success",
        sequence: 2,
        scannedAt: "2026-08-25T08:01:00.000Z",
        km: canonicalizeKm(raw("LEGACY-SUCCESS")),
        verdict: "expected",
      },
      {
        eventId: "legacy-unknown",
        sequence: 3,
        scannedAt: "2026-08-25T08:02:00.000Z",
        km: canonicalizeKm(raw("LEGACY-UNKNOWN")),
        verdict: "unknown",
      },
      {
        eventId: "legacy-mismatch",
        sequence: 4,
        scannedAt: "2026-08-25T08:03:00.000Z",
        km: canonicalizeKm(raw("LEGACY-MISMATCH")),
        verdict: "expected",
      },
    ] as const;
    const insertEvent = db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'item', ?, ?, ?, '2026-08-20', ?)`,
    );
    for (const fact of facts) {
      const codeHash = kmHash(fact.km);
      insertEvent.run(
        INVENTORY_ID,
        SNAPSHOT_ID,
        fact.eventId,
        DEVICE_ID,
        fact.sequence,
        OPERATOR_ID,
        fact.scannedAt,
        `item:${codeHash}`,
        codeHash,
        fact.km.raw,
        fact.verdict,
      );
      if (fact.verdict === "expected") {
        db.prepare(
          `INSERT INTO inventory_code_results_mirror
             (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
              winning_scanned_at, observed_production_date, classification,
              origin_classification, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '2026-08-20', 'expected', 'expected', ?)`,
        ).run(
          INVENTORY_ID,
          SNAPSHOT_ID,
          codeHash,
          fact.eventId,
          DEVICE_ID,
          fact.scannedAt,
          fact.scannedAt,
        );
      }
      if (fact.eventId !== "legacy-orphan") {
        db.prepare(
          `INSERT INTO inventory_outbox
             (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          INVENTORY_ID,
          SNAPSHOT_ID,
          fact.eventId,
          fact.sequence,
          JSON.stringify({
            eventId: fact.eventId,
            deviceSequence: fact.sequence,
            operatorId: OPERATOR_ID,
            scannedAt: fact.scannedAt,
            kind: "item",
            normalizedIdentity:
              fact.eventId === "legacy-mismatch" ? "item:wrong" : `item:${codeHash}`,
            codeHash,
            canonicalRaw: fact.km.raw,
            activeProductionDate: "2026-08-20",
            localVerdict: fact.verdict,
          }),
          fact.scannedAt,
        );
      }
    }

    const exec = makeExec(db);
    await applyMigrations(exec);
    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: true, recoveredCommitted: 0, failed: 2 },
    );
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 1,
      discrepancies: 1,
    });
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toMatchObject([
      { eventId: "legacy-unknown", verdict: "unknown" },
      { eventId: "legacy-success", verdict: "expected" },
    ]);
    expect(
      db
        .prepare(
          `SELECT first_accepted_event_id FROM inventory_code_results_mirror
           ORDER BY first_accepted_event_id`,
        )
        .all(),
    ).toEqual([{ first_accepted_event_id: "legacy-success" }]);

    db.prepare(
      `DELETE FROM inventory_outbox
        WHERE event_id IN ('legacy-success', 'legacy-unknown')`,
    ).run();
    await applyMigrations(exec);
    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: true, recoveredCommitted: 0, failed: 2 },
    );
    expect(
      db
        .prepare(
          `SELECT event_id, commit_state, legacy_audit_version
             FROM inventory_scan_events_mirror
            WHERE event_id IN ('legacy-success', 'legacy-unknown')
            ORDER BY event_id`,
        )
        .all(),
    ).toEqual([
      { event_id: "legacy-success", commit_state: "committed", legacy_audit_version: 1 },
      { event_id: "legacy-unknown", commit_state: "committed", legacy_audit_version: 1 },
    ]);
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 1,
      discrepancies: 1,
    });
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toMatchObject([
      { eventId: "legacy-unknown", verdict: "unknown" },
      { eventId: "legacy-success", verdict: "expected" },
    ]);
  });

  it("persists the active date across restart and applies a later change only to future observations", async () => {
    const { db, exec } = await setup();
    const first = seedCode(db, "DATE-A");
    const second = seedCode(db, "DATE-B");

    await recordInventoryScan(exec, input(first.km.raw, "event-date-a"));
    await setInventoryProductionDate(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      operatorId: OPERATOR_ID,
      productionDate: "2026-08-21",
      updatedAt: "2026-08-25T10:01:00.000Z",
    });
    const restartedExec = makeExec(db);
    expect(
      await loadInventoryProductionDate(restartedExec, {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
      }),
    ).toBe("2026-08-21");
    await recordInventoryScan(
      restartedExec,
      input(second.km.raw, "event-date-b", "2026-08-25T10:02:00.000Z"),
    );

    expect(
      db
        .prepare(
          `SELECT code_hash, observed_production_date FROM inventory_code_results_mirror
           ORDER BY winning_scanned_at`,
        )
        .all(),
    ).toEqual([
      { code_hash: first.codeHash, observed_production_date: "2026-08-20" },
      { code_hash: second.codeHash, observed_production_date: "2026-08-21" },
    ]);
  });

  it("expands a known box with one INSERT SELECT and preserves every child's origin", async () => {
    const { db, exec } = await setup();
    seedCode(db, "BOX-EXPECTED", { parentSscc: SSCC });
    seedCode(db, "BOX-PROTECTED", {
      parentSscc: SSCC,
      state: "MOVING_BY_UD",
      expected: 0,
      protected: 1,
    });
    seedCode(db, "BOX-INELIGIBLE", {
      parentSscc: SSCC,
      status: "APPLIED",
      expected: 0,
    });
    seedCode(db, "OUTSIDE", { parentSscc: "004600000000000015" });
    const statements: string[] = [];
    const traced: SqlExecutor = {
      run: (sql, params) => {
        statements.push(sql);
        return exec.run(sql, params);
      },
      all: <T>(sql: string, params?: unknown[]) => {
        statements.push(sql);
        return exec.all<T>(sql, params);
      },
    };

    const accepted = await recordInventoryScan(traced, input(`]C1(00)${SSCC}`, "event-box"));
    expect(accepted).toMatchObject({ verdict: "expected", claimedCount: 3, boxChildCount: 3 });
    expect(
      statements.filter(
        (sql) => /INSERT INTO inventory_code_results_mirror/i.test(sql) && /SELECT/i.test(sql),
      ),
    ).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT origin_classification, COUNT(*) AS count
             FROM inventory_code_results_mirror
            GROUP BY origin_classification ORDER BY origin_classification`,
        )
        .all(),
    ).toEqual([
      { origin_classification: "expected", count: 1 },
      { origin_classification: "known-ineligible", count: 1 },
      { origin_classification: "protected", count: 1 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });

    const duplicate = await recordInventoryScan(
      traced,
      input(SSCC, "event-box-rescan", "2026-08-25T10:01:00.000Z"),
    );
    expect(duplicate).toMatchObject({ verdict: "duplicate", claimedCount: 0, boxChildCount: 3 });
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toEqual({
      verified: 1,
      discrepancies: 1,
      protected: 1,
      claimedByDevice: 3,
      acceptedBoxes: 1,
      acceptedItems: 0,
    });
  });

  it("does not accept protected-only or ineligible-only boxes as expected", async () => {
    const protectedFixture = await setup();
    seedCode(protectedFixture.db, "BOX-PROTECTED-ONLY", {
      parentSscc: SSCC,
      state: "MOVING_BY_UD",
      expected: 1,
    });
    await expect(
      recordInventoryScan(protectedFixture.exec, input(SSCC, "event-protected-box")),
    ).resolves.toMatchObject({ verdict: "protected", claimedCount: 1 });
    await expect(
      readInventoryProgress(protectedFixture.exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID),
    ).resolves.toMatchObject({ verified: 0, protected: 1, acceptedBoxes: 0 });

    const ineligibleFixture = await setup();
    seedCode(ineligibleFixture.db, "BOX-INELIGIBLE-ONLY", {
      parentSscc: SSCC,
      status: "WRITTEN_OFF",
      expected: 0,
    });
    await expect(
      recordInventoryScan(ineligibleFixture.exec, input(SSCC, "event-ineligible-box")),
    ).resolves.toMatchObject({ verdict: "known-ineligible", claimedCount: 1 });
    await expect(
      readInventoryProgress(ineligibleFixture.exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID),
    ).resolves.toMatchObject({ verified: 0, discrepancies: 1, acceptedBoxes: 0 });
  });

  it("keeps a zero-child SSCC as a durable unknown discrepancy instead of an accepted box", async () => {
    const { db, exec } = await setup();
    const result = await recordInventoryScan(exec, input(SSCC, "event-unknown-box"));
    expect(result).toMatchObject({ verdict: "unknown", claimedCount: 0, boxChildCount: 0 });
    expect(
      db.prepare("SELECT kind, local_verdict FROM inventory_scan_events_mirror").get(),
    ).toEqual({
      kind: "old_box",
      local_verdict: "unknown",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
  });

  it("reconciles process loss after event reservation as failed and permits a fresh rescan", async () => {
    const { db, exec } = await setup();
    const afterReservation = seedCode(db, "LOSS-AFTER-EVENT");

    await expect(
      recordInventoryScan(
        failOnce(exec, /INSERT INTO inventory_code_results_mirror/i),
        input(afterReservation.km.raw, "event-loss-after-reservation"),
      ),
    ).rejects.toThrow("simulated durable write failure");
    expect(
      db.prepare("SELECT event_id, commit_state FROM inventory_scan_events_mirror").get(),
    ).toEqual({
      event_id: "event-loss-after-reservation",
      commit_state: "pending",
    });
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toEqual([]);
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 0,
      acceptedItems: 0,
    });

    const restarted = makeExec(db);
    await expect(
      reconcilePendingInventoryEvents(restarted, INVENTORY_ID, SNAPSHOT_ID),
    ).resolves.toEqual({ requiresRescan: true, recoveredCommitted: 0, failed: 1 });
    expect(
      db
        .prepare(
          `SELECT commit_state, COUNT(*) AS count FROM inventory_scan_events_mirror
           GROUP BY commit_state`,
        )
        .all(),
    ).toEqual([{ commit_state: "failed", count: 1 }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(await listRecentInventoryOperations(restarted, INVENTORY_ID, SNAPSHOT_ID)).toEqual([]);

    await expect(
      recordInventoryScan(
        restarted,
        input(afterReservation.km.raw, "event-fresh-rescan", "2026-08-25T10:02:00.000Z"),
      ),
    ).resolves.toMatchObject({ verdict: "expected", claimedCount: 1 });
  });

  it.each([
    ["reservation transition", /SET commit_state = 'pending'/i],
    ["event-owned cleanup", /DELETE FROM inventory_code_results_mirror/i],
    ["projection rebuild", /INSERT INTO inventory_code_results_mirror/i],
    ["outbox publication", /INSERT INTO inventory_outbox/i],
    ["commit transition", /SET commit_state = 'committed'/i],
  ])(
    "never exposes a repaired legacy event when reconciliation loses the %s write",
    async (_stage, failurePattern) => {
      const db = round1Db();
      const code = seedCode(db, `REPAIR-${_stage}`);
      db.prepare(
        "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'INV-LOSS', ?)",
      ).run(INVENTORY_ID, SNAPSHOT_ID);
      db.prepare(
        `INSERT INTO inventory_scan_events_mirror
           (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
            kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict)
         VALUES (?, ?, 'repair-loss', ?, 1, ?, '2026-08-25T08:00:00.000Z',
                 'item', ?, ?, ?, '2026-08-20', 'expected')`,
      ).run(
        INVENTORY_ID,
        SNAPSHOT_ID,
        DEVICE_ID,
        OPERATOR_ID,
        `item:${code.codeHash}`,
        code.codeHash,
        code.km.raw,
      );
      const exec = makeExec(db);
      await applyMigrations(exec);

      await expect(
        reconcilePendingInventoryEvents(failOnce(exec, failurePattern), INVENTORY_ID, SNAPSHOT_ID),
      ).rejects.toThrow("simulated durable write failure");
      const event = db
        .prepare(
          "SELECT commit_state FROM inventory_scan_events_mirror WHERE event_id = 'repair-loss'",
        )
        .get() as { commit_state: string };
      const queued = db
        .prepare("SELECT payload_json FROM inventory_outbox WHERE event_id = 'repair-loss'")
        .get() as { payload_json: string } | undefined;
      expect(event.commit_state).not.toBe("committed");
      expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toEqual([]);
      expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject(
        {
          verified: 0,
        },
      );
      if (queued) {
        expect(JSON.parse(queued.payload_json)).toMatchObject({
          eventId: "repair-loss",
          localVerdict: "expected",
        });
      }

      await expect(
        reconcilePendingInventoryEvents(makeExec(db), INVENTORY_ID, SNAPSHOT_ID),
      ).resolves.toEqual({ requiresRescan: false, recoveredCommitted: 1, failed: 0 });
    },
  );

  it("compensates only the orphan claim when process loss follows projection", async () => {
    const { db, exec } = await setup();
    const afterClaim = seedCode(db, "LOSS-AFTER-CLAIM");

    await expect(
      recordInventoryScan(
        failOnce(exec, /SET local_verdict/i),
        input(afterClaim.km.raw, "event-loss-after-claim"),
      ),
    ).rejects.toThrow("simulated durable write failure");
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 1,
      },
    );

    const restarted = makeExec(db);
    await expect(
      reconcilePendingInventoryEvents(restarted, INVENTORY_ID, SNAPSHOT_ID),
    ).resolves.toEqual({ requiresRescan: true, recoveredCommitted: 0, failed: 1 });
    expect(db.prepare("SELECT commit_state FROM inventory_scan_events_mirror").get()).toEqual({
      commit_state: "failed",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 0,
      },
    );
  });

  it("does not compensate a claim when an exact concurrent resume publishes its outbox", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "COMPENSATION-RACE");
    const event = input(code.km.raw, "event-compensation-race");

    await expect(recordInventoryScan(failOnce(exec, /SET local_verdict/i), event)).rejects.toThrow(
      "simulated durable write failure",
    );
    const payloadJson = JSON.stringify({
      eventId: event.eventId,
      deviceSequence: 1,
      operatorId: event.operatorId,
      scannedAt: event.scannedAt,
      kind: "item",
      normalizedIdentity: `item:${code.codeHash}`,
      codeHash: code.codeHash,
      canonicalRaw: code.km.raw,
      activeProductionDate: "2026-08-20",
      localVerdict: "expected",
    });
    let injected = false;
    const concurrentResume: SqlExecutor = {
      async run(sql, params) {
        if (!injected && /DELETE FROM inventory_code_results_mirror/i.test(sql)) {
          injected = true;
          await exec.run(
            `INSERT INTO inventory_outbox
               (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [INVENTORY_ID, SNAPSHOT_ID, event.eventId, 1, payloadJson, event.scannedAt],
          );
        }
        return exec.run(sql, params);
      },
      all: <T>(sql: string, params?: unknown[]) => exec.all<T>(sql, params),
    };

    await expect(
      reconcilePendingInventoryEvents(concurrentResume, INVENTORY_ID, SNAPSHOT_ID),
    ).resolves.toEqual({ requiresRescan: false, recoveredCommitted: 1, failed: 0 });
    expect(db.prepare("SELECT commit_state FROM inventory_scan_events_mirror").get()).toEqual({
      commit_state: "committed",
    });
    expect(
      db.prepare("SELECT first_accepted_event_id FROM inventory_code_results_mirror").get(),
    ).toEqual({ first_accepted_event_id: event.eventId });
  });

  it("resumes the exact pending event id without allocating another sequence", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "PENDING-EXACT-RETRY");
    const event = input(code.km.raw, "event-pending-exact");

    await expect(
      recordInventoryScan(failOnce(exec, /INSERT INTO inventory_code_results_mirror/i), event),
    ).rejects.toThrow("simulated durable write failure");
    await expect(recordInventoryScan(exec, event)).resolves.toMatchObject({
      verdict: "expected",
      claimedCount: 1,
    });
    expect(
      db.prepare("SELECT device_sequence, commit_state FROM inventory_scan_events_mirror").get(),
    ).toEqual({ device_sequence: 1, commit_state: "committed" });
    expect(
      db
        .prepare("SELECT next_device_sequence FROM inventory_terminal_state WHERE device_id = ?")
        .get(DEVICE_ID),
    ).toEqual({ next_device_sequence: 2 });
  });

  it("finalizes a pending event after process loss once its exact projection and outbox exist", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "LOSS-AFTER-OUTBOX");

    await expect(
      recordInventoryScan(
        failOnce(exec, /SET commit_state = 'committed'/i),
        input(code.km.raw, "event-loss-after-outbox"),
      ),
    ).rejects.toThrow("simulated durable write failure");
    expect(db.prepare("SELECT commit_state FROM inventory_scan_events_mirror").get()).toEqual({
      commit_state: "pending",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toEqual([]);

    const restarted = makeExec(db);
    await expect(
      reconcilePendingInventoryEvents(restarted, INVENTORY_ID, SNAPSHOT_ID),
    ).resolves.toEqual({ requiresRescan: false, recoveredCommitted: 1, failed: 0 });
    expect(await listRecentInventoryOperations(restarted, INVENTORY_ID, SNAPSHOT_ID)).toMatchObject(
      [{ eventId: "event-loss-after-outbox", verdict: "expected" }],
    );
    expect(
      await readInventoryProgress(restarted, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID),
    ).toMatchObject({
      verified: 1,
      acceptedItems: 1,
    });
  });

  it("rejects a concurrent same-event payload mismatch but safely resumes an exact replay", async () => {
    const { db, exec } = await setup();
    const first = seedCode(db, "SAME-EVENT-A");
    const second = seedCode(db, "SAME-EVENT-B");
    const suspended = suspendOnce(exec, /INSERT INTO inventory_scan_events_mirror/i);
    const eventA = input(first.km.raw, "event-concurrent-same");
    const firstCall = recordInventoryScan(suspended.exec, eventA);
    await suspended.started;
    const mismatchedCall = recordInventoryScan(
      suspended.exec,
      input(second.km.raw, "event-concurrent-same"),
    );
    suspended.release();

    const mismatchResults = await Promise.allSettled([firstCall, mismatchedCall]);
    expect(mismatchResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(mismatchResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(recordInventoryScan(exec, eventA)).resolves.toMatchObject({ verdict: "expected" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 1,
      },
    );
    expect(
      db
        .prepare("SELECT next_device_sequence FROM inventory_terminal_state WHERE device_id = ?")
        .get(DEVICE_ID),
    ).toEqual({ next_device_sequence: 2 });
  });

  it("coalesces concurrent exact same-event calls into one sequence, claim, and outbox", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "SAME-EVENT-EXACT");
    const suspended = suspendOnce(exec, /INSERT INTO inventory_scan_events_mirror/i);
    const event = input(code.km.raw, "event-concurrent-exact");
    const first = recordInventoryScan(suspended.exec, event);
    await suspended.started;
    const second = recordInventoryScan(suspended.exec, event);
    suspended.release();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { verdict: "expected" },
      { verdict: "expected" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 1,
      },
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare("SELECT next_device_sequence FROM inventory_terminal_state WHERE device_id = ?")
        .get(DEVICE_ID),
    ).toEqual({ next_device_sequence: 2 });
  });

  it("records the loser of a concurrent same-item race as duplicate without progress inflation", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "CONCURRENT-ITEM");
    const suspended = suspendOnce(exec, /INSERT INTO inventory_code_results_mirror/i);
    const first = recordInventoryScan(suspended.exec, input(code.km.raw, "event-item-a"));
    await suspended.started;
    const second = recordInventoryScan(
      suspended.exec,
      input(code.km.raw, "event-item-b", "2026-08-25T10:00:01.000Z"),
    );
    suspended.release();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.verdict).sort()).toEqual(["duplicate", "expected"]);
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 1,
      acceptedItems: 1,
    });
    expect(
      db
        .prepare(
          `SELECT local_verdict, COUNT(*) AS count FROM inventory_scan_events_mirror
           GROUP BY local_verdict ORDER BY local_verdict`,
        )
        .all(),
    ).toEqual([
      { local_verdict: "duplicate", count: 1 },
      { local_verdict: "expected", count: 1 },
    ]);
  });

  it("serializes concurrent known-box expansion and records exactly one accepted box", async () => {
    const { db, exec } = await setup();
    seedCode(db, "CONCURRENT-BOX-A", { parentSscc: SSCC });
    seedCode(db, "CONCURRENT-BOX-B", { parentSscc: SSCC });
    const suspended = suspendOnce(exec, /INSERT INTO inventory_code_results_mirror[\s\S]*SELECT/i);
    const first = recordInventoryScan(suspended.exec, input(SSCC, "event-box-a"));
    await suspended.started;
    const second = recordInventoryScan(
      suspended.exec,
      input(SSCC, "event-box-b", "2026-08-25T10:00:01.000Z"),
    );
    suspended.release();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.verdict).sort()).toEqual(["duplicate", "expected"]);
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 2,
      acceptedBoxes: 1,
    });
  });

  it("does not allocate another sequence or inflate progress when a completed event id is replayed", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "IDEMPOTENT");
    const event = input(code.km.raw, "event-idempotent");
    await recordInventoryScan(exec, event);
    await recordInventoryScan(exec, event);

    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare("SELECT next_device_sequence FROM inventory_terminal_state WHERE device_id = ?")
        .get(DEVICE_ID),
    ).toEqual({ next_device_sequence: 2 });
  });

  it("persists valid discrepancies but drops invalid scanner noise and presents only safe suffixes", async () => {
    const { db, exec } = await setup();
    const unknownRaw = raw("PHYSICAL-ONLY-SECRET");
    await recordInventoryScan(exec, input(unknownRaw, "event-unknown"));
    const invalidRaw = "operator-pin-000012345678-secret";
    expect(await recordInventoryScan(exec, input(invalidRaw, "event-invalid"))).toMatchObject({
      verdict: "invalid",
      claimedCount: 0,
    });

    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 0,
      },
    );
    const recent = await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID);
    expect(recent).toMatchObject([
      { verdict: "unknown", scanKind: "item", serialSuffix: "…CRET", ssccSuffix: null },
    ]);
    expect(JSON.stringify(recent)).not.toContain("PHYSICAL-ONLY");
    expect(JSON.stringify(recent)).not.toContain("operator-pin");
  });

  it("counts unknown source observations once without a result projection and keeps protected explicit", async () => {
    const { db, exec } = await setup();
    const protectedCode = seedCode(db, "PROTECTED-COUNT", {
      state: "MOVING_BY_UD",
      expected: 1,
    });
    const ineligible = seedCode(db, "INELIGIBLE-COUNT", { status: "APPLIED", expected: 0 });
    const unknownKm = raw("UNKNOWN-COUNT");

    await recordInventoryScan(exec, input(protectedCode.km.raw, "event-protected"));
    await recordInventoryScan(
      exec,
      input(ineligible.km.raw, "event-ineligible", "2026-08-25T10:00:01.000Z"),
    );
    await recordInventoryScan(
      exec,
      input(unknownKm, "event-unknown-km", "2026-08-25T10:00:02.000Z"),
    );
    await recordInventoryScan(exec, input(SSCC, "event-unknown-box", "2026-08-25T10:00:03.000Z"));
    await expect(
      recordInventoryScan(
        exec,
        input(unknownKm, "event-unknown-km-rescan", "2026-08-25T10:00:04.000Z"),
      ),
    ).resolves.toMatchObject({ verdict: "duplicate" });

    expect(
      db
        .prepare(
          `SELECT origin_classification, COUNT(*) AS count
             FROM inventory_code_results_mirror GROUP BY origin_classification
             ORDER BY origin_classification`,
        )
        .all(),
    ).toEqual([
      { origin_classification: "known-ineligible", count: 1 },
      { origin_classification: "protected", count: 1 },
    ]);
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 0,
      protected: 1,
      discrepancies: 3,
      acceptedBoxes: 0,
      acceptedItems: 0,
    });
    const restartedRecent = await listRecentInventoryOperations(
      makeExec(db),
      INVENTORY_ID,
      SNAPSHOT_ID,
    );
    expect(restartedRecent[0]).toMatchObject({
      eventId: "event-unknown-km-rescan",
      verdict: "duplicate",
      firstWinning: {
        eventId: "event-unknown-km",
        deviceId: DEVICE_ID,
        scannedAt: "2026-08-25T10:00:02.000Z",
      },
    });
  });

  it("uses reservation sequence rather than a rolled-back scanner clock for unknown duplicates", async () => {
    const { db, exec } = await setup();
    const unknownKm = raw("CLOCK-ROLLBACK");

    const [firstKm, laterKm] = await Promise.all([
      recordInventoryScan(exec, input(unknownKm, "event-clock-km-1", "2026-08-25T11:00:00.000Z")),
      recordInventoryScan(exec, input(unknownKm, "event-clock-km-2", "2026-08-25T10:00:00.000Z")),
    ]);
    const [firstBox, laterBox] = await Promise.all([
      recordInventoryScan(exec, input(SSCC, "event-clock-box-1", "2026-08-25T11:01:00.000Z")),
      recordInventoryScan(exec, input(SSCC, "event-clock-box-2", "2026-08-25T09:59:00.000Z")),
    ]);

    expect([firstKm.verdict, laterKm.verdict, firstBox.verdict, laterBox.verdict]).toEqual([
      "unknown",
      "duplicate",
      "unknown",
      "duplicate",
    ]);
    expect(
      db
        .prepare(
          `SELECT event_id, device_sequence FROM inventory_scan_events_mirror
           ORDER BY device_sequence`,
        )
        .all(),
    ).toEqual([
      { event_id: "event-clock-km-1", device_sequence: 1 },
      { event_id: "event-clock-km-2", device_sequence: 2 },
      { event_id: "event-clock-box-1", device_sequence: 3 },
      { event_id: "event-clock-box-2", device_sequence: 4 },
    ]);
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      discrepancies: 2,
    });
    const recent = await listRecentInventoryOperations(makeExec(db), INVENTORY_ID, SNAPSHOT_ID);
    expect(recent[0]).toMatchObject({
      eventId: "event-clock-box-2",
      verdict: "duplicate",
      firstWinning: { eventId: "event-clock-box-1", scannedAt: "2026-08-25T11:01:00.000Z" },
    });
    expect(recent[2]).toMatchObject({
      eventId: "event-clock-km-2",
      verdict: "duplicate",
      firstWinning: { eventId: "event-clock-km-1", scannedAt: "2026-08-25T11:00:00.000Z" },
    });
    await expect(
      recordInventoryScan(
        makeExec(db),
        input(unknownKm, "event-clock-km-2", "2026-08-25T10:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      verdict: "duplicate",
      firstWinning: { eventId: "event-clock-km-1" },
    });

    db.prepare(
      `UPDATE inventory_scan_events_mirror SET commit_state = 'failed'
        WHERE event_id IN ('event-clock-km-1', 'event-clock-box-1')`,
    ).run();
    await expect(
      recordInventoryScan(exec, input(unknownKm, "event-clock-km-3", "2026-08-25T09:00:00.000Z")),
    ).resolves.toMatchObject({ verdict: "unknown" });
    await expect(
      recordInventoryScan(exec, input(SSCC, "event-clock-box-3", "2026-08-25T08:59:00.000Z")),
    ).resolves.toMatchObject({ verdict: "unknown" });

    await applyMigrations(exec);
    const restarted = makeExec(db);
    const immutableRecent = await listRecentInventoryOperations(
      restarted,
      INVENTORY_ID,
      SNAPSHOT_ID,
    );
    expect(
      immutableRecent.find((operation) => operation.eventId === "event-clock-km-2"),
    ).toMatchObject({
      firstWinning: { eventId: "event-clock-km-1", scannedAt: "2026-08-25T11:00:00.000Z" },
    });
    expect(
      immutableRecent.find((operation) => operation.eventId === "event-clock-box-2"),
    ).toMatchObject({
      firstWinning: { eventId: "event-clock-box-1", scannedAt: "2026-08-25T11:01:00.000Z" },
    });
    await expect(
      recordInventoryScan(
        restarted,
        input(unknownKm, "event-clock-km-2", "2026-08-25T10:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      verdict: "duplicate",
      firstWinning: { eventId: "event-clock-km-1" },
    });
    await expect(
      recordInventoryScan(restarted, input(SSCC, "event-clock-box-2", "2026-08-25T09:59:00.000Z")),
    ).resolves.toMatchObject({
      verdict: "duplicate",
      firstWinning: { eventId: "event-clock-box-1" },
    });
  });

  it("requires a new physical scan when an acknowledged duplicate's unknown predecessor failed", async () => {
    const { db, exec } = await setup();
    const km = canonicalizeKm(raw("EARLIER-FAILED"));
    const codeHash = kmHash(km);
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'event-unknown-failed', ?, 1, ?, '2026-08-25T11:00:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'unknown', 'failed', 1),
              (?, ?, 'event-unknown-durable', ?, 2, ?, '2026-08-25T10:00:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'duplicate', 'committed', 1)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${codeHash}`,
      codeHash,
      km.raw,
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${codeHash}`,
      codeHash,
      km.raw,
    );
    db.prepare(
      `UPDATE inventory_terminal_state SET next_device_sequence = 3
        WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID);
    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: true, recoveredCommitted: 0, failed: 1 },
    );
    expect(
      db
        .prepare(
          "SELECT local_verdict FROM inventory_scan_events_mirror WHERE event_id = 'event-unknown-durable'",
        )
        .get(),
    ).toEqual({ local_verdict: "duplicate" });
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      verified: 0,
      discrepancies: 0,
    });
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toMatchObject([
      { eventId: "event-unknown-durable", verdict: "duplicate", firstWinning: null },
    ]);

    await expect(
      recordInventoryScan(exec, input(km.raw, "event-unknown-future", "2026-08-25T09:00:00.000Z")),
    ).resolves.toMatchObject({
      verdict: "unknown",
      firstWinning: null,
    });
    const replacementPayload = db
      .prepare("SELECT payload_json FROM inventory_outbox WHERE event_id = 'event-unknown-future'")
      .get() as { payload_json: string };
    expect(JSON.parse(replacementPayload.payload_json)).toMatchObject({
      eventId: "event-unknown-future",
      localVerdict: "unknown",
    });
    await expect(reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID)).resolves.toEqual(
      { requiresRescan: false, recoveredCommitted: 0, failed: 0 },
    );
    expect(await readInventoryProgress(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID)).toMatchObject({
      discrepancies: 1,
    });
    await applyMigrations(exec);
    const restarted = makeExec(db);
    const duplicateHistory = (
      await listRecentInventoryOperations(restarted, INVENTORY_ID, SNAPSHOT_ID)
    ).find((operation) => operation.eventId === "event-unknown-durable");
    expect(duplicateHistory).toMatchObject({ verdict: "duplicate", firstWinning: null });
    await expect(
      recordInventoryScan(
        restarted,
        input(km.raw, "event-unknown-durable", "2026-08-25T10:00:00.000Z"),
      ),
    ).resolves.toMatchObject({ verdict: "duplicate", firstWinning: null });
  });

  it("never rewrites a committed duplicate verdict or payload during reconciliation", async () => {
    const { db, exec } = await setup();
    const km = canonicalizeKm(raw("ACK-DUPLICATE"));
    const codeHash = kmHash(km);
    const payload = JSON.stringify({
      eventId: "ack-duplicate",
      deviceSequence: 2,
      operatorId: OPERATOR_ID,
      scannedAt: "2026-08-25T10:00:00.000Z",
      kind: "item",
      normalizedIdentity: `item:${codeHash}`,
      codeHash,
      canonicalRaw: km.raw,
      activeProductionDate: "2026-08-20",
      localVerdict: "duplicate",
    });
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'failed-before-duplicate', ?, 1, ?, '2026-08-25T09:00:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'unknown', 'failed', 1),
              (?, ?, 'ack-duplicate', ?, 2, ?, '2026-08-25T10:00:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'duplicate', 'committed', 1)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${codeHash}`,
      codeHash,
      km.raw,
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${codeHash}`,
      codeHash,
      km.raw,
    );
    db.prepare(
      `INSERT INTO inventory_outbox
         (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
       VALUES (?, ?, 'ack-duplicate', 2, ?, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, payload);

    await reconcilePendingInventoryEvents(exec, INVENTORY_ID, SNAPSHOT_ID);
    await applyMigrations(exec);
    await reconcilePendingInventoryEvents(makeExec(db), INVENTORY_ID, SNAPSHOT_ID);

    expect(
      db
        .prepare(
          `SELECT local_verdict, commit_state FROM inventory_scan_events_mirror
           WHERE event_id = 'ack-duplicate'`,
        )
        .get(),
    ).toEqual({ local_verdict: "duplicate", commit_state: "committed" });
    expect(
      db
        .prepare("SELECT payload_json FROM inventory_outbox WHERE event_id = 'ack-duplicate'")
        .get(),
    ).toEqual({ payload_json: payload });

    db.prepare("DELETE FROM inventory_outbox WHERE event_id = 'ack-duplicate'").run();
    await applyMigrations(exec);
    await reconcilePendingInventoryEvents(makeExec(db), INVENTORY_ID, SNAPSHOT_ID);
    expect(
      db
        .prepare(
          `SELECT local_verdict, commit_state FROM inventory_scan_events_mirror
           WHERE event_id = 'ack-duplicate'`,
        )
        .get(),
    ).toEqual({ local_verdict: "duplicate", commit_state: "committed" });
    expect(
      db
        .prepare("SELECT payload_json FROM inventory_outbox WHERE event_id = 'ack-duplicate'")
        .get(),
    ).toBeUndefined();
  });

  it("stores a known-item duplicate winner independently of later projection ownership", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "ITEM-CHRONOLOGY");
    await recordInventoryScan(exec, input(code.km.raw, "item-owner", "2026-08-25T08:00:00.000Z"));
    await expect(
      recordInventoryScan(exec, input(code.km.raw, "item-duplicate", "2026-08-25T08:01:00.000Z")),
    ).resolves.toMatchObject({
      verdict: "duplicate",
      firstWinning: {
        eventId: "item-owner",
        deviceId: DEVICE_ID,
        scannedAt: "2026-08-25T08:00:00.000Z",
      },
    });
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'item-later-owner', 'STA-LATER', 1, ?, '2026-08-25T08:02:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'expected', 'committed', 1)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      OPERATOR_ID,
      `item:${code.codeHash}`,
      code.codeHash,
      code.km.raw,
    );
    db.prepare(
      `UPDATE inventory_code_results_mirror
          SET first_accepted_event_id = 'item-later-owner', winning_device_id = 'STA-LATER',
              winning_scanned_at = '2026-08-25T08:02:00.000Z'
        WHERE inventory_id = ? AND snapshot_id = ? AND code_hash = ?`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, code.codeHash);

    await applyMigrations(exec);
    const restarted = makeExec(db);
    const stored = {
      eventId: "item-owner",
      deviceId: DEVICE_ID,
      scannedAt: "2026-08-25T08:00:00.000Z",
    };
    expect(
      (await listRecentInventoryOperations(restarted, INVENTORY_ID, SNAPSHOT_ID)).find(
        (operation) => operation.eventId === "item-duplicate",
      ),
    ).toMatchObject({ verdict: "duplicate", firstWinning: stored });
    await expect(
      recordInventoryScan(
        restarted,
        input(code.km.raw, "item-duplicate", "2026-08-25T08:01:00.000Z"),
      ),
    ).resolves.toMatchObject({ verdict: "duplicate", firstWinning: stored });
  });

  it("hydrates a duplicate known box with the exact first winning terminal and time", async () => {
    const { db, exec } = await setup();
    const child = seedCode(db, "BOX-WON-ELSEWHERE", { parentSscc: SSCC });
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'remote-event', 'STA-REMOTE', 1, ?, '2026-08-25T08:30:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'expected', 'committed', 1)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      OPERATOR_ID,
      `item:${child.codeHash}`,
      child.codeHash,
      child.km.raw,
    );
    db.prepare(
      `INSERT INTO inventory_code_results_mirror
         (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
          winning_scanned_at, observed_production_date, classification, origin_classification,
          updated_at)
       VALUES (?, ?, ?, 'remote-event', 'STA-REMOTE', '2026-08-25T08:30:00.000Z',
               '2026-08-20', 'expected', 'expected', '2026-08-25T08:30:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, child.codeHash);

    await recordInventoryScan(exec, input(SSCC, "event-box-duplicate"));
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'remote-event-later', 'STA-REMOTE', 2, ?, '2026-08-25T08:45:00.000Z',
               'item', ?, ?, ?, '2026-08-20', 'expected', 'committed', 1)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      OPERATOR_ID,
      `item:${child.codeHash}`,
      child.codeHash,
      child.km.raw,
    );
    db.prepare(
      `UPDATE inventory_code_results_mirror
          SET first_accepted_event_id = 'remote-event-later', winning_device_id = 'STA-REMOTE',
              winning_scanned_at = '2026-08-25T08:45:00.000Z'
        WHERE inventory_id = ? AND snapshot_id = ? AND code_hash = ?`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, child.codeHash);
    await applyMigrations(exec);
    const restarted = makeExec(db);
    const recent = await listRecentInventoryOperations(restarted, INVENTORY_ID, SNAPSHOT_ID);
    expect(recent.find((operation) => operation.eventId === "event-box-duplicate")).toMatchObject({
      verdict: "duplicate",
      scanKind: "known_box",
      firstWinning: {
        eventId: "remote-event",
        deviceId: "STA-REMOTE",
        scannedAt: "2026-08-25T08:30:00.000Z",
      },
    });
    await expect(
      recordInventoryScan(restarted, input(SSCC, "event-box-duplicate")),
    ).resolves.toMatchObject({
      verdict: "duplicate",
      firstWinning: {
        eventId: "remote-event",
        deviceId: "STA-REMOTE",
        scannedAt: "2026-08-25T08:30:00.000Z",
      },
    });
  });

  it("does not derive a displayed box suffix from a corrupt legacy raw payload", async () => {
    const { db, exec } = await setup();
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
       (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
        kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
        commit_state)
       VALUES (?, ?, 'legacy-corrupt', ?, 99, ?, '2026-08-25T11:00:00.000Z',
               'old_box', 'old_box:corrupt', NULL, 'operator-secret', '2026-08-20', 'unknown',
               'committed')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);

    const recent = await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID);
    expect(recent[0]).toMatchObject({
      verdict: "unknown",
      scanKind: "invalid",
      serialSuffix: null,
      ssccSuffix: null,
    });
    expect(JSON.stringify(recent)).not.toContain("cret");
  });
});
