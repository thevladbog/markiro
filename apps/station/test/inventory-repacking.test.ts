import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  buildSscc,
  canonicalizeKm,
  kmHash,
  type StationInventoryBundleManifest,
} from "@markiro/domain";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";

import {
  clearOpenInventoryRepackBox,
  closeIncompleteInventoryRepackBox,
  readInventoryRepackState,
  recordInventoryRepackScan,
  removeLastInventoryRepackItem,
  resolveInvalidatedInventoryRepackBox,
} from "../src/lib/inventory-repacking.js";
import { attemptInventoryBoxPrint } from "../src/lib/inventory-box-printing.js";
import { listRecentInventoryOperations } from "../src/lib/inventory-journal.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  acknowledgeInventoryOutboxBatch,
  inventoryOutboxDepth,
  prepareInventoryOutboxBatch,
} from "../src/lib/inventory-outbox.js";
import { addRange } from "../src/lib/sscc-pool.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";
const BOX_ID = "55555555-5555-4555-8555-555555555555";
const ITEM_ID = "66666666-6666-4666-8666-666666666666";
const GTIN = "04600000000015";
const OLD_SSCC = "346006820000000014";
const ISSUER_PREFIX = "460123456";

function raw(serial: string): string {
  return `01${GTIN}21${serial}\u001d91KEY\u001d92SIGN`;
}

async function setup(capacity = 2) {
  const db = new DatabaseSync(":memory:");
  const exec = makeExec(db);
  await applyMigrations(exec);
  db.prepare(
    `INSERT INTO inventory_task_mirror
       (inventory_id, inventory_number, active_snapshot_id, active_snapshot_revision)
     VALUES (?, 'IVN-26-0042', ?, 1)`,
  ).run(INVENTORY_ID, SNAPSHOT_ID);
  db.prepare(
    `INSERT INTO inventory_terminal_state
       (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
        next_device_sequence, updated_at)
     VALUES (?, ?, ?, ?, '2026-08-20', 1, '2026-08-25T09:00:00.000Z')`,
  ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
  await addRange(exec, {
    issuerPrefix: ISSUER_PREFIX,
    extensionDigit: 0,
    fromSerial: 1,
    toSerial: 3,
    consumedThroughSerial: null,
  });
  const seed = (
    serial: string,
    values: { expected?: number; state?: string | null; parent?: string | null } = {},
  ) => {
    const km = canonicalizeKm(raw(serial));
    const hash = kmHash(km);
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
          source_production_date, parent_sscc, expected, protected)
       VALUES (?, ?, ?, ?, ?, 'INTRODUCED', ?, '2026-08-20', ?, ?, ?)`,
    ).run(
      SNAPSHOT_ID,
      hash,
      km.raw,
      GTIN,
      serial,
      values.state ?? null,
      values.parent ?? OLD_SSCC,
      values.expected ?? 1,
      values.state === "MOVING_BY_UD" ? 1 : 0,
    );
    return { km, hash };
  };
  return { db, exec, capacity, seed };
}

function input(rawValue: string, eventId: string, capacity: number) {
  return {
    inventoryId: INVENTORY_ID,
    snapshotId: SNAPSHOT_ID,
    deviceId: DEVICE_ID,
    operatorId: OPERATOR_ID,
    taskGtin14: GTIN,
    issuerPrefix: ISSUER_PREFIX,
    capacity,
    raw: rawValue,
    eventId,
    scannedAt: "2026-08-25T10:00:00.000Z",
    createBoxId: () => BOX_ID,
    createItemId: () => ITEM_ID,
  };
}

describe("durable inventory repacking", () => {
  it("reserves one SSCC while atomically journalling an old-box context and open box", async () => {
    const { db, exec, capacity } = await setup();
    const result = await recordInventoryRepackScan(
      exec,
      input(OLD_SSCC, "77777777-7777-4777-8777-777777777777", capacity),
    );
    expect(result).toMatchObject({ verdict: "old-box-selected", boxId: BOX_ID, itemCount: 0 });
    expect(
      await readInventoryRepackState(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID),
    ).toMatchObject({
      phase: "scanning",
      box: { boxId: BOX_ID, oldSsccContext: OLD_SSCC, newSscc: expect.stringMatching(/^0\d{17}$/) },
    });
    expect(db.prepare("SELECT next_serial FROM sscc_pool").get()).toEqual({ next_serial: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM inventory_outbox").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM inventory_repack_journal").get()).toEqual({
      n: 1,
    });
  });

  it("never reuses a burned serial when the journal write fails", async () => {
    const { db, exec, capacity } = await setup();
    const failing: SqlExecutor = {
      run: (sql, params) => {
        if (sql.includes("INSERT INTO inventory_repack_journal")) {
          throw new Error("simulated box write failure");
        }
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    await expect(
      recordInventoryRepackScan(
        failing,
        input(OLD_SSCC, "77777777-7777-4777-8777-777777777777", capacity),
      ),
    ).rejects.toThrow("simulated box write failure");
    expect(db.prepare("SELECT next_serial FROM sscc_pool").get()).toEqual({ next_serial: 2 });
    const retry = await recordInventoryRepackScan(
      exec,
      input(OLD_SSCC, "88888888-8888-4888-8888-888888888888", capacity),
    );
    expect(retry.newSscc).not.toBe("046012345600000012");
    expect(db.prepare("SELECT next_serial FROM sscc_pool").get()).toEqual({ next_serial: 3 });
  });

  it("scans every bottle, admits only eligible membership, and capacity-closes pending print", async () => {
    const { db, exec, capacity, seed } = await setup();
    const first = seed("ELIGIBLE-1");
    const protectedItem = seed("PROTECTED", { state: "MOVING_BY_UD" });
    const second = seed("ELIGIBLE-2", { parent: "046006820000000017" });
    await recordInventoryRepackScan(
      exec,
      input(OLD_SSCC, "77777777-7777-4777-8777-777777777777", capacity),
    );
    const protectedResult = await recordInventoryRepackScan(exec, {
      ...input(protectedItem.km.raw, "88888888-8888-4888-8888-888888888888", capacity),
      createItemId: () => "99999999-9999-4999-8999-999999999999",
    });
    expect(protectedResult).toMatchObject({ verdict: "protected", itemCount: 0 });
    await recordInventoryRepackScan(exec, {
      ...input(first.km.raw, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", capacity),
      createItemId: () => ITEM_ID,
    });
    const closed = await recordInventoryRepackScan(exec, {
      ...input(second.km.raw, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", capacity),
      createItemId: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(closed).toMatchObject({
      verdict: "capacity-closed",
      itemCount: 2,
      printState: "pending",
    });
    expect(
      db
        .prepare(
          "SELECT code_hash, position, source_parent_mismatch FROM inventory_repack_items_mirror ORDER BY position",
        )
        .all(),
    ).toEqual([
      { code_hash: first.hash, position: 1, source_parent_mismatch: 0 },
      { code_hash: second.hash, position: 2, source_parent_mismatch: 1 },
    ]);
    await expect(
      recordInventoryRepackScan(
        exec,
        input(first.km.raw, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", capacity),
      ),
    ).rejects.toThrow("inventory repack printing is pending");
  });

  it("starts a second box after successful print and restart without reusing the historical box", async () => {
    const { db, exec, seed } = await setup(1);
    const first = seed("FIRST-BOX");
    const firstOpenEventId = "77777777-7777-4777-8777-777777777777";
    await recordInventoryRepackScan(exec, input(OLD_SSCC, firstOpenEventId, 1));
    await recordInventoryRepackScan(exec, {
      ...input(first.km.raw, "88888888-8888-4888-8888-888888888888", 1),
      createItemId: () => ITEM_ID,
    });
    const manifest = {
      inventoryId: INVENTORY_ID,
      inventoryNumber: "IVN-26-0042",
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      snapshotFixedAt: "2026-08-25T01:00:00.000Z",
      combinedDigest: "a".repeat(64),
      contentDigest: "b".repeat(64),
      codeCount: 1,
      productId: "99999999-9999-4999-8999-999999999999",
      productName: "Пиво",
      productPrintName: "Пиво",
      gtin14: GTIN,
      egaisCode: null,
      shelfLifeDays: 180,
      boxCapacity: 1,
      mode: "repack",
      lineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      lineName: "Линия",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      boxLabelTemplate: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "Короб",
        spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
      },
      limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
      sscc: null,
      ssccRevokedFrom: [],
      ssccRevokedBlocks: [],
    } as unknown as StationInventoryBundleManifest & { mode: "repack" };
    await attemptInventoryBoxPrint({
      exec,
      manifest,
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      operatorId: OPERATOR_ID,
      boxId: BOX_ID,
      attemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      attemptedAt: "2026-08-25T10:01:00.000Z",
      completedAt: () => "2026-08-25T10:01:01.000Z",
      printing: {
        target: { kind: "tcp", host: "10.0.0.5", port: 9100 },
        language: "zpl",
        print: vi.fn(async () => undefined),
      },
      render: vi.fn(async () => new Uint8Array([1, 2, 3])),
    });

    const restarted = makeExec(db);
    await expect(
      readInventoryRepackState(restarted, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID),
    ).resolves.toEqual({ phase: "awaiting-old-box", box: null });
    const secondBoxId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const secondOldSscc = buildSscc(3, "460068200", 1);
    const second = await recordInventoryRepackScan(restarted, {
      ...input(secondOldSscc, "ffffffff-ffff-4fff-8fff-ffffffffffff", 1),
      createBoxId: () => secondBoxId,
    });
    expect(second).toMatchObject({
      verdict: "old-box-selected",
      boxId: secondBoxId,
      itemCount: 0,
    });
    expect(second.newSscc).not.toBe(
      db.prepare("SELECT new_sscc FROM inventory_repack_boxes_mirror WHERE box_id = ?").get(BOX_ID)
        ?.new_sscc,
    );
    expect(db.prepare("SELECT next_serial FROM sscc_pool").get()).toEqual({ next_serial: 3 });
  });

  it("journals an owner-scoped conflict resolution, preserves conflict evidence, and drains it after acknowledgement", async () => {
    const { db, exec, capacity, seed } = await setup();
    const item = seed("CONFLICTED");
    const openEventId = "77777777-7777-4777-8777-777777777777";
    const itemEventId = "88888888-8888-4888-8888-888888888888";
    await recordInventoryRepackScan(exec, input(OLD_SSCC, openEventId, capacity));
    await recordInventoryRepackScan(exec, {
      ...input(item.km.raw, itemEventId, capacity),
      createItemId: () => ITEM_ID,
    });
    const losingBatch = await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "losing-batch",
    });
    if (!losingBatch) throw new Error("expected losing batch");
    const remoteEventId = "99999999-9999-4999-8999-999999999999";
    await acknowledgeInventoryOutboxBatch(exec, losingBatch, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      batchId: losingBatch.request.batchId,
      payloadDigest: losingBatch.request.payloadDigest,
      sequenceCeiling: losingBatch.request.sequenceCeiling,
      resultRevision: 2,
      outcomes: [
        {
          eventId: openEventId,
          status: "applied",
          reasonCode: "CLAIM_APPLIED",
          claimedCount: 0,
          conflictCount: 0,
          claims: [],
        },
        {
          eventId: itemEventId,
          status: "duplicate",
          reasonCode: "CLAIM_LOST",
          claimedCount: 0,
          conflictCount: 1,
          claims: [
            {
              codeHash: item.hash,
              status: "duplicate",
              winner: {
                codeHash: item.hash,
                eventId: remoteEventId,
                deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                scannedAt: "2026-08-25T09:00:00.000Z",
              },
            },
          ],
        },
      ],
    });
    await expect(
      readInventoryRepackState(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID),
    ).resolves.toMatchObject({
      phase: "invalidated",
      box: { itemCount: 1, invalidationSource: "claim_lost" },
    });

    const resolution = {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      operatorId: OPERATOR_ID,
      eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      changedAt: "2026-08-25T11:00:00.000Z",
      reason: "claim-lost" as const,
    };
    await resolveInvalidatedInventoryRepackBox(exec, resolution);
    await resolveInvalidatedInventoryRepackBox(exec, resolution);
    await expect(
      readInventoryRepackState(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID),
    ).resolves.toMatchObject({ phase: "scanning", box: { boxId: BOX_ID, itemCount: 0 } });
    expect(
      db
        .prepare("SELECT state FROM inventory_conflicts_mirror WHERE losing_event_id = ?")
        .get(itemEventId),
    ).toEqual({ state: "resolved" });
    expect(await inventoryOutboxDepth(exec, INVENTORY_ID, SNAPSHOT_ID)).toBe(1);

    const resolutionBatch = await prepareInventoryOutboxBatch(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      createBatchId: () => "resolution-batch",
    });
    if (!resolutionBatch) throw new Error("expected resolution batch");
    await acknowledgeInventoryOutboxBatch(exec, resolutionBatch, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      batchId: resolutionBatch.request.batchId,
      payloadDigest: resolutionBatch.request.payloadDigest,
      sequenceCeiling: resolutionBatch.request.sequenceCeiling,
      resultRevision: 2,
      outcomes: [
        {
          eventId: resolution.eventId,
          status: "applied",
          reasonCode: "CLAIM_APPLIED",
          claimedCount: 0,
          conflictCount: 0,
          claims: [],
        },
      ],
    });
    expect(await inventoryOutboxDepth(exec, INVENTORY_ID, SNAPSHOT_ID)).toBe(0);
    expect(
      db
        .prepare(
          "SELECT authoritative_verdict, server_reason_code FROM inventory_scan_events_mirror WHERE event_id = ?",
        )
        .get(resolution.eventId),
    ).toEqual({ authoritative_verdict: "applied", server_reason_code: "CLAIM_APPLIED" });

    db.prepare(
      `UPDATE inventory_repack_boxes_mirror
          SET state = 'invalidated', invalidated_at = ?, invalidation_source = 'admin'
        WHERE inventory_id = ? AND snapshot_id = ? AND box_id = ?`,
    ).run("2026-08-25T11:01:00.000Z", INVENTORY_ID, SNAPSHOT_ID, BOX_ID);
    await expect(
      resolveInvalidatedInventoryRepackBox(exec, {
        ...resolution,
        eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        changedAt: "2026-08-25T11:02:00.000Z",
      }),
    ).rejects.toThrow("not a claim-lost conflict");
  });

  it("replays a post-commit crash exactly and survives restart without duplicating membership", async () => {
    const { db, exec, capacity, seed } = await setup();
    const item = seed("RESTART");
    await recordInventoryRepackScan(
      exec,
      input(OLD_SSCC, "77777777-7777-4777-8777-777777777777", capacity),
    );
    let thrown = false;
    const postCommit: SqlExecutor = {
      all: (sql, params) => exec.all(sql, params),
      run: async (sql, params) => {
        const result = await exec.run(sql, params);
        if (!thrown && sql.includes("INSERT INTO inventory_repack_journal")) {
          thrown = true;
          throw new Error("simulated process loss after commit");
        }
        return result;
      },
    };
    const eventInput = {
      ...input(item.km.raw, "88888888-8888-4888-8888-888888888888", capacity),
      createItemId: () => ITEM_ID,
    };
    await expect(recordInventoryRepackScan(postCommit, eventInput)).rejects.toThrow("process loss");
    await expect(recordInventoryRepackScan(exec, eventInput)).resolves.toMatchObject({
      itemCount: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM inventory_repack_items_mirror").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM inventory_outbox").get()).toEqual({ n: 2 });
  });

  it("restores recent scanner operations after a durable correction and restart", async () => {
    const { db, exec, capacity, seed } = await setup();
    const item = seed("RECENT-CORRECTION");
    await recordInventoryRepackScan(
      exec,
      input(OLD_SSCC, "77777777-7777-4777-8777-777777777777", capacity),
    );
    await recordInventoryRepackScan(exec, {
      ...input(item.km.raw, "88888888-8888-4888-8888-888888888888", capacity),
      createItemId: () => ITEM_ID,
    });
    await removeLastInventoryRepackItem(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      operatorId: OPERATOR_ID,
      eventId: "99999999-9999-4999-8999-999999999999",
      changedAt: "2026-08-25T11:00:00.000Z",
    });

    const expected = expect.arrayContaining([
      expect.objectContaining({ eventId: "77777777-7777-4777-8777-777777777777" }),
      expect.objectContaining({ eventId: "88888888-8888-4888-8888-888888888888" }),
    ]);
    expect(await listRecentInventoryOperations(exec, INVENTORY_ID, SNAPSHOT_ID)).toEqual(expected);
    expect(await listRecentInventoryOperations(makeExec(db), INVENTORY_ID, SNAPSHOT_ID)).toEqual(
      expected,
    );
  });

  it("rejects empty incomplete close before allocating a sequence or journalling", async () => {
    const { db, exec, capacity } = await setup();
    await recordInventoryRepackScan(
      exec,
      input(OLD_SSCC, "77777777-7777-4777-8777-777777777777", capacity),
    );
    const before = db
      .prepare("SELECT next_device_sequence FROM inventory_terminal_state WHERE device_id = ?")
      .get(DEVICE_ID);

    await expect(
      closeIncompleteInventoryRepackBox(exec, {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
        operatorId: OPERATOR_ID,
        eventId: "88888888-8888-4888-8888-888888888888",
        changedAt: "2026-08-25T11:00:00.000Z",
        confirmed: true,
      }),
    ).rejects.toThrow("inventory repack box is empty");
    expect(
      db
        .prepare("SELECT next_device_sequence FROM inventory_terminal_state WHERE device_id = ?")
        .get(DEVICE_ID),
    ).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM inventory_repack_journal").get()).toEqual({
      n: 1,
    });
    expect(
      await readInventoryRepackState(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID),
    ).toMatchObject({
      phase: "scanning",
      box: { itemCount: 0 },
    });
  });

  it("records remove-last, clear, and explicit incomplete close without replacing the SSCC", async () => {
    const { exec, capacity, seed } = await setup(20);
    const first = seed("ONE");
    const second = seed("TWO");
    await recordInventoryRepackScan(
      exec,
      input(OLD_SSCC, "77777777-7777-4777-8777-777777777777", capacity),
    );
    await recordInventoryRepackScan(exec, {
      ...input(first.km.raw, "88888888-8888-4888-8888-888888888888", capacity),
      createItemId: () => ITEM_ID,
    });
    await recordInventoryRepackScan(exec, {
      ...input(second.km.raw, "99999999-9999-4999-8999-999999999999", capacity),
      createItemId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const before = await readInventoryRepackState(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID);
    await removeLastInventoryRepackItem(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      operatorId: OPERATOR_ID,
      eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      changedAt: "2026-08-25T11:00:00.000Z",
    });
    await clearOpenInventoryRepackBox(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      operatorId: OPERATOR_ID,
      eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      changedAt: "2026-08-25T11:01:00.000Z",
    });
    await recordInventoryRepackScan(exec, {
      ...input(first.km.raw, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", capacity),
      createItemId: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    await closeIncompleteInventoryRepackBox(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      operatorId: OPERATOR_ID,
      eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      changedAt: "2026-08-25T11:02:00.000Z",
      confirmed: true,
    });
    const after = await readInventoryRepackState(exec, INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID);
    expect(after).toMatchObject({
      phase: "closed-pending-print",
      box: { newSscc: before.box?.newSscc, itemCount: 1, printState: "pending" },
    });
  });
});

it("keeps repack migrations rerunnable after the receipt trigger is installed", () => {
  const db = new DatabaseSync(":memory:");
  for (const statement of [...STATION_MIGRATIONS, ...STATION_MIGRATIONS]) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error)))
        throw error;
    }
  }
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'inventory_repack_apply_journal_v1'",
      )
      .get(),
  ).toEqual({ n: 1 });
});
