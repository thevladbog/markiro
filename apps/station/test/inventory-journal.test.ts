import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { canonicalizeKm, kmHash } from "@markiro/domain";

import {
  listRecentInventoryOperations,
  readInventoryProgress,
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
    "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'ИНВ-42', ?)",
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

describe("inventory journal", () => {
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

  it("compensates only projections owned by a failed event and never reuses its sequence", async () => {
    const { db, exec } = await setup();
    const first = seedCode(db, "EVENT-FAIL");

    await expect(
      recordInventoryScan(
        failOnce(exec, /INSERT INTO inventory_scan_events_mirror/i),
        input(first.km.raw, "event-failed"),
      ),
    ).rejects.toThrow("simulated durable write failure");
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 0,
      },
    );

    await recordInventoryScan(exec, input(first.km.raw, "event-retry", "2026-08-25T10:01:00.000Z"));
    expect(db.prepare("SELECT device_sequence FROM inventory_scan_events_mirror").get()).toEqual({
      device_sequence: 2,
    });
  });

  it("preserves the honest event, compensates its claims on outbox failure, and permits retry", async () => {
    const { db, exec } = await setup();
    const code = seedCode(db, "OUTBOX-FAIL");

    await expect(
      recordInventoryScan(
        failOnce(exec, /INSERT INTO inventory_outbox/i),
        input(code.km.raw, "event-outbox"),
      ),
    ).rejects.toThrow("simulated durable write failure");
    expect(db.prepare("SELECT event_id FROM inventory_scan_events_mirror").get()).toEqual({
      event_id: "event-outbox",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 0,
      },
    );

    const retry = await recordInventoryScan(exec, input(code.km.raw, "event-outbox"));
    expect(retry).toMatchObject({ verdict: "expected", claimedCount: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
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
        count: 1,
      },
    );
    const recent = await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID);
    expect(recent).toMatchObject([
      { verdict: "unknown", scanKind: "item", serialSuffix: "…CRET", ssccSuffix: null },
    ]);
    expect(JSON.stringify(recent)).not.toContain("PHYSICAL-ONLY");
    expect(JSON.stringify(recent)).not.toContain("operator-pin");
  });

  it("does not derive a displayed box suffix from a corrupt legacy raw payload", async () => {
    const { db, exec } = await setup();
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
       (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
        kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict)
       VALUES (?, ?, 'legacy-corrupt', ?, 99, ?, '2026-08-25T11:00:00.000Z',
               'old_box', 'old_box:corrupt', NULL, 'operator-secret', '2026-08-20', 'unknown')`,
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
