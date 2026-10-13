import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  boxClosedRecord,
  boxLabelRecord,
  outboxStatement,
  palletLabelRecord,
  MAX_RECORD_BYTES,
  scanRecord,
  shiftClosedRecord,
} from "../src/floor/facts.js";
import {
  dismissDisplacement,
  dismissRecord,
  dismissShiftRefusals,
  QUEUE_LISTED_PER_SHIFT,
  readQueue,
  readStrandedRecords,
  RESEND_CHUNK,
  RESEND_INSERT_SQL,
  RESEND_MARK_SQL,
  resendRefused,
  StaleQueueError,
  UnreadableRecordError,
  type RecoveryContext,
} from "../src/floor/queue/outbox-recovery.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import type { FactRecord, FactReceipt } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { LocalDbError } from "../src/local/executor.js";
import { receiptStatements, sendFactBatch } from "../src/local/facts-sender.js";
import {
  ENTERED,
  OPERATOR_ID,
  PAIRING,
  rows,
  SHIFT_ID,
  steppingClock,
  unsentScans,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const AT = "2026-10-11T08:00:00.000Z";
const NOW = new Date("2026-10-11T09:00:00.000Z");
const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };
const CLOSE_ID = "00000000-0000-4000-8000-c00000000001";

/** Ids `…f00000000001`, `…f00000000002`, … */
function counting(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-f${String(n).padStart(11, "0")}`;
  };
}

function settle(
  db: DatabaseSync,
  ids: readonly string[],
  outcome: "rejected" | "conflict" | "accepted",
  code: string | null = null,
): void {
  const statement = db.prepare(
    "UPDATE outbox SET outcome = ?, outcome_code = ?, acked_at = ? WHERE id = ?",
  );
  for (const id of ids) statement.run(outcome, code, AT, id);
}

async function station() {
  const { db, executor } = openLocalDb();
  await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
  return { db, local: executor };
}

function context(local: LocalExecutor, newId = counting()): RecoveryContext {
  return { local, pairing: PAIRING, operatorId: OPERATOR_ID, newId, now: () => NOW };
}

function payloadOf(db: DatabaseSync, id: string): string {
  return String(rows(db, "SELECT payload FROM outbox WHERE id = ?", id)[0]?.["payload"]);
}

describe("the queue screen's reads", () => {
  it("list what waits by kind with its oldest record, and the unresolved refused and conflicting records with their shift", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = "", waiting = "", resolved = ""] = await unsentScans(local, 4);
    settle(db, [refused, resolved], "rejected", "gtin_mismatch");
    settle(db, [conflict], "conflict");
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ?",
    ).run(AT, OPERATOR_ID, resolved);
    const created = String(
      rows(db, "SELECT created_at FROM outbox WHERE id = ?", waiting)[0]?.["created_at"],
    );
    const view = await readQueue(local, PAIRING);
    expect(view.unsent).toEqual([{ kind: "scan", count: 1, oldest: created }]);
    expect(view.settled.map((record) => [record.id, record.outcome, record.code])).toEqual([
      [refused, "rejected", "gtin_mismatch"],
      [conflict, "conflict", null],
    ]);
    expect(view.settled[0]).toMatchObject({
      kind: "scan",
      shiftId: SHIFT_ID,
      shiftNumber: ENTERED.number,
      sscc: null,
    });
    expect(view.stranded).toBe(0);
  });

  it("count the unsent records other pairings of this computer left, and show none of them as this pairing's", async () => {
    const { local } = await station();
    await unsentScans(local, 2, OTHER_PAIRING, 50);
    await expect(readStrandedRecords(local, PAIRING)).resolves.toBe(2);
    const view = await readQueue(local, PAIRING);
    expect(view.unsent).toEqual([]);
    expect(view.stranded).toBe(2);
  });
});

describe("sending refused records again", () => {
  it("writes the shift's refused records after everything, under new ids, with the same data, and marks them resent", async () => {
    const { db, local } = await station();
    const [one = "", two = "", three = ""] = await unsentScans(local, 3);
    settle(db, [one, three], "rejected", "not_entered");
    settle(db, [two], "accepted");
    const before = { one: payloadOf(db, one), three: payloadOf(db, three) };
    await expect(resendRefused(context(local), SHIFT_ID)).resolves.toBe(2);
    const first = "00000000-0000-4000-8000-f00000000001";
    const second = "00000000-0000-4000-8000-f00000000002";
    expect(rows(db, "SELECT id FROM outbox ORDER BY seq").map((row) => row["id"])).toEqual([
      one,
      two,
      three,
      first,
      second,
    ]);
    // Byte for byte but the id: the host matches an exception by its instants (plan 2a2).
    expect(payloadOf(db, first)).toBe(before.one.replace(one, first));
    expect(payloadOf(db, second)).toBe(before.three.replace(three, second));
    expect(
      rows(
        db,
        "SELECT id, kind, shift_id, created_at, outcome, resolution, resent_as, resolved_at, " +
          "resolved_by FROM outbox WHERE id IN (?, ?, ?, ?) ORDER BY seq",
        one,
        three,
        first,
        second,
      ),
    ).toEqual([
      {
        id: one,
        kind: "scan",
        shift_id: SHIFT_ID,
        created_at: expect.any(String),
        outcome: "rejected",
        resolution: "resent",
        resent_as: first,
        resolved_at: NOW.toISOString(),
        resolved_by: OPERATOR_ID,
      },
      {
        id: three,
        kind: "scan",
        shift_id: SHIFT_ID,
        created_at: expect.any(String),
        outcome: "rejected",
        resolution: "resent",
        resent_as: second,
        resolved_at: NOW.toISOString(),
        resolved_by: OPERATOR_ID,
      },
      {
        id: first,
        kind: "scan",
        shift_id: SHIFT_ID,
        created_at: NOW.toISOString(),
        outcome: null,
        resolution: null,
        resent_as: null,
        resolved_at: null,
        resolved_by: null,
      },
      {
        id: second,
        kind: "scan",
        shift_id: SHIFT_ID,
        created_at: NOW.toISOString(),
        outcome: null,
        resolution: null,
        resent_as: null,
        resolved_at: null,
        resolved_by: null,
      },
    ]);
    const view = await readQueue(local, PAIRING);
    expect(view.settled).toEqual([]);
    expect(view.unsent).toEqual([{ kind: "scan", count: 2, oldest: NOW.toISOString() }]);
  });

  it("carries a refused close of a shift this station closed, and the host's acceptance closes the shift", async () => {
    const { db, local } = await station();
    const [scan = ""] = await unsentScans(local, 1);
    await local.transaction([
      outboxStatement(
        shiftClosedRecord(
          { id: CLOSE_ID, shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
          {
            plannedQtySnapshot: 1200,
            actualQty: 0,
            closedBoxCount: 0,
            reasonCode: null,
            closedAt: AT,
          },
        ),
        PAIRING,
        AT,
      ),
    ]);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(SHIFT_ID);
    settle(db, [scan], "rejected", "not_entered");
    settle(db, [CLOSE_ID], "rejected", "box_state");
    await expect(resendRefused(context(local), SHIFT_ID)).resolves.toBe(2);
    const carried = rows(db, "SELECT id, kind FROM outbox WHERE outcome IS NULL ORDER BY seq").map(
      (row) => ({ id: String(row["id"]), kind: String(row["kind"]), outcome: "accepted" }),
    );
    expect(carried.map((record) => record.kind)).toEqual(["scan", "shift_closed"]);
    await local.transaction(receiptStatements(PAIRING, JSON.stringify(carried), NOW.toISOString()));
    expect(rows(db, "SELECT local_state FROM floor_shifts WHERE id = ?", SHIFT_ID)).toEqual([
      { local_state: "closed" },
    ]);
  });

  it("goes in parts of RESEND_CHUNK, in the order the records were kept", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, RESEND_CHUNK * 2 + 3);
    settle(db, ids, "rejected", "not_entered");
    const transaction = vi.spyOn(local, "transaction");
    await expect(resendRefused(context(local), SHIFT_ID)).resolves.toBe(ids.length);
    expect(transaction).toHaveBeenCalledTimes(3);
    const pairs = rows(
      db,
      "SELECT o.seq AS old, n.seq AS new FROM outbox o JOIN outbox n ON n.id = o.resent_as " +
        "ORDER BY o.seq",
    ).map((row) => Number(row["new"]));
    expect(pairs).toEqual([...pairs].sort((a, b) => a - b));
    expect(pairs).toHaveLength(ids.length);
  });

  it("writes nothing when a refused record of the shift was resolved meanwhile", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    settle(db, [one, two], "rejected", "not_entered");
    const racing: LocalExecutor = {
      query: (sql, params, row) => local.query(sql, params, row),
      transaction: async (statements) => {
        db.prepare(
          "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ?",
        ).run(AT, OPERATOR_ID, two);
        return local.transaction(statements);
      },
    };
    await expect(
      resendRefused({ ...context(local), local: racing }, SHIFT_ID),
    ).rejects.toBeInstanceOf(StaleQueueError);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
    expect(rows(db, "SELECT resolution FROM outbox WHERE id = ?", one)).toEqual([
      { resolution: null },
    ]);
  });

  it("refuses a shift with a record this build cannot read, before writing anything", async () => {
    const { db, local } = await station();
    const [one = ""] = await unsentScans(local, 1);
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        'VALUES (\'old-build\', ?, ?, \'scan\', ?, \'{"id":"old-build","kind":"scan"}\', ?)',
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID, AT);
    settle(db, [one, "old-build"], "rejected", "invalid_record");
    const error = await resendRefused(context(local), SHIFT_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnreadableRecordError);
    expect(error instanceof UnreadableRecordError ? error.recordId : null).toBe("old-build");
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE resolution IS NOT NULL")).toEqual([
      { n: 0 },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
  });

  it("never takes another pairing's refusals for this pairing's", async () => {
    const { db, local } = await station();
    const [theirs = ""] = await unsentScans(local, 1, OTHER_PAIRING, 50);
    settle(db, [theirs], "rejected", "not_entered");
    await expect(resendRefused(context(local), SHIFT_ID)).rejects.toBeInstanceOf(StaleQueueError);
    expect(rows(db, "SELECT resolution FROM outbox")).toEqual([{ resolution: null }]);
  });
});

describe("taking a record off the queue", () => {
  it("marks a refused record and a conflict as taken off by the operator, never a close", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = ""] = await unsentScans(local, 2);
    await local.transaction([
      outboxStatement(
        shiftClosedRecord(
          { id: CLOSE_ID, shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
          {
            plannedQtySnapshot: 1200,
            actualQty: 0,
            closedBoxCount: 0,
            reasonCode: null,
            closedAt: AT,
          },
        ),
        PAIRING,
        AT,
      ),
    ]);
    settle(db, [refused, CLOSE_ID], "rejected", "box_state");
    settle(db, [conflict], "conflict");
    await dismissRecord(context(local), refused);
    await dismissRecord(context(local), conflict);
    await expect(dismissRecord(context(local), CLOSE_ID)).rejects.toBeInstanceOf(StaleQueueError);
    await expect(dismissRecord(context(local), refused)).rejects.toBeInstanceOf(StaleQueueError);
    expect(
      rows(db, "SELECT id, resolution, resolved_by, resolved_at FROM outbox ORDER BY seq"),
    ).toEqual([
      {
        id: refused,
        resolution: "dismissed",
        resolved_by: OPERATOR_ID,
        resolved_at: NOW.toISOString(),
      },
      {
        id: conflict,
        resolution: "dismissed",
        resolved_by: OPERATOR_ID,
        resolved_at: NOW.toISOString(),
      },
      { id: CLOSE_ID, resolution: null, resolved_by: null, resolved_at: null },
    ]);
    expect((await readQueue(local, PAIRING)).settled.map((record) => record.id)).toEqual([
      CLOSE_ID,
    ]);
  });
});

// Beyond the plan's examples: every guard of the module and of its statements, and the
// integrity of what a person's decision leaves behind (resolution, time and operator written
// together; a record sent again exists once; a record taken off is never sent).
const OTHER_SHIFT = "00000000-0000-4000-8000-0000000000aa";
const OTHER_HOST_PAIRING = { ...PAIRING, hostId: "5c3b2a19-8e7d-4f6c-9b0a-1d2e3f4a5b6c" };
const BOX_ID = "00000000-0000-4000-8000-0000000000b1";
const BOX_CLOSED_ID = "00000000-0000-4000-8000-0000000000b2";
const PALLET_ID = "00000000-0000-4000-8000-0000000000c1";

function head(id: string, shiftId = SHIFT_ID) {
  return { id, shiftId, operatorId: OPERATOR_ID };
}

function scanOf(id: string, shiftId = SHIFT_ID): FactRecord {
  return scanRecord(head(id, shiftId), {
    scannedAt: "2026-10-08T06:15:00.000Z",
    verdict: "invalid",
    duplicateSource: null,
    rawKind: "unknown",
    rawLength: 10,
    code: null,
    boxId: null,
  });
}

async function keep(
  local: LocalExecutor,
  record: FactRecord,
  createdAt = AT,
  pairing = PAIRING,
): Promise<string> {
  await local.transaction([outboxStatement(record, pairing, createdAt)]);
  return record.id;
}

/** A person's decision writes `resolution`, `resolved_at` and `resolved_by` together, `resent_as` only with `resent`. */
function expectTied(db: DatabaseSync): void {
  expect(
    rows(
      db,
      "SELECT id FROM outbox WHERE (resolution IS NULL) <> (resolved_at IS NULL) " +
        "OR (resolution IS NULL) <> (resolved_by IS NULL) " +
        "OR (resolution = 'resent') <> (resent_as IS NOT NULL)",
    ),
  ).toEqual([]);
}

function count(db: DatabaseSync, where = "1 = 1"): number {
  return Number(rows(db, `SELECT count(*) AS n FROM outbox WHERE ${where}`)[0]?.["n"]);
}

describe("the queue screen's reads, beyond the plan's example", () => {
  it("lists the kinds by their oldest record, then by name, and the records to resolve in the order kept, a conflict first too", async () => {
    const { db, local } = await station();
    await keep(local, scanOf("00000000-0000-4000-8000-0000000000d1"), "2026-10-11T05:00:00.000Z");
    await keep(
      local,
      boxLabelRecord(head("00000000-0000-4000-8000-0000000000d2"), {
        boxId: BOX_ID,
        outcome: "verified",
        at: AT,
      }),
      "2026-10-11T06:00:00.000Z",
    );
    await keep(
      local,
      palletLabelRecord(head("00000000-0000-4000-8000-0000000000d3"), {
        palletId: PALLET_ID,
        outcome: "verified",
        at: AT,
      }),
      "2026-10-11T06:00:00.000Z",
    );
    const [conflict = "", refused = ""] = await unsentScans(local, 2, PAIRING, 700);
    settle(db, [conflict], "conflict");
    settle(db, [refused], "rejected", "not_entered");
    // A refused record of another pairing is not this pairing's to resolve.
    const theirs = await keep(
      local,
      scanOf("00000000-0000-4000-8000-0000000000d4"),
      AT,
      OTHER_HOST_PAIRING,
    );
    settle(db, [theirs], "rejected", "not_entered");
    const view = await readQueue(local, PAIRING);
    expect(view.unsent.map((entry) => [entry.kind, entry.count, entry.oldest])).toEqual([
      ["scan", 1, "2026-10-11T05:00:00.000Z"],
      ["box_label", 1, "2026-10-11T06:00:00.000Z"],
      ["pallet_label", 1, "2026-10-11T06:00:00.000Z"],
    ]);
    expect(view.settled.map((record) => record.id)).toEqual([conflict, refused]);
    expect(view.settled.map((record) => record.outcome)).toEqual(["conflict", "rejected"]);
    // Its refusal is settled, so it is no unsent record either.
    expect(view.stranded).toBe(0);
  });

  it("names the SSCC of the box or pallet a record is about: its own, the box's or the pallet's", async () => {
    const { db, local } = await station();
    db.prepare(
      "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
        "block_id, serial, item_count, closed_by) VALUES (?, ?, ?, ?, ?, ?, '000000000000000001', " +
        "'block', 1, 1, 'op')",
    ).run(BOX_ID, PAIRING.hostId, PAIRING.deviceId, SHIFT_ID, AT, AT);
    db.prepare(
      "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
        "block_id, serial, closed_by) VALUES (?, ?, ?, ?, ?, ?, '100000000000000011', 'block', 1, 'op')",
    ).run(PALLET_ID, PAIRING.hostId, PAIRING.deviceId, SHIFT_ID, AT, AT);
    const label = await keep(
      local,
      boxLabelRecord(head("00000000-0000-4000-8000-0000000000e1"), {
        boxId: BOX_ID,
        outcome: "verified",
        at: AT,
      }),
    );
    const pallet = await keep(
      local,
      palletLabelRecord(head("00000000-0000-4000-8000-0000000000e2"), {
        palletId: PALLET_ID,
        outcome: "skipped",
        at: AT,
      }),
    );
    const closed = await keep(
      local,
      boxClosedRecord(head("00000000-0000-4000-8000-0000000000e3"), {
        boxId: BOX_CLOSED_ID,
        sscc: "000000000000000002",
        blockId: "00000000-0000-4000-8000-0000000000f1",
        serial: 2,
        openedAt: AT,
        closedAt: AT,
        itemCount: 1,
        membershipDigest: "digest",
      }),
    );
    const [scan = ""] = await unsentScans(local, 1, PAIRING, 800);
    settle(db, [label, pallet, closed, scan], "rejected", "box_state");
    const view = await readQueue(local, PAIRING);
    expect(view.settled.map((record) => [record.id, record.sscc])).toEqual([
      [label, "000000000000000001"],
      [pallet, "100000000000000011"],
      [closed, "000000000000000002"],
      [scan, null],
    ]);
  });

  it("counts the unsent records of any other host or device, and no receipted one", async () => {
    const { db, local } = await station();
    await unsentScans(local, 2, OTHER_PAIRING, 50);
    const [otherHost = ""] = await unsentScans(local, 1, OTHER_HOST_PAIRING, 60);
    const [receipted = ""] = await unsentScans(local, 1, OTHER_PAIRING, 70);
    settle(db, [receipted], "accepted");
    await unsentScans(local, 3, PAIRING, 80);
    expect(otherHost).not.toBe("");
    await expect(readStrandedRecords(local, PAIRING)).resolves.toBe(3);
  });
});

describe("«Отправить снова», beyond the plan's examples", () => {
  it("sends again only the refused records of the shift named, never a conflict, a waiting or an accepted record", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = "", waiting = "", accepted = ""] = await unsentScans(
      local,
      4,
      PAIRING,
      900,
    );
    const elsewhere = await keep(
      local,
      scanOf("00000000-0000-4000-8000-0000000000a1", OTHER_SHIFT),
    );
    settle(db, [refused, elsewhere], "rejected", "not_entered");
    settle(db, [conflict], "conflict");
    settle(db, [accepted], "accepted");
    await expect(resendRefused(context(local), SHIFT_ID)).resolves.toBe(1);
    expect(
      rows(
        db,
        "SELECT id, resolution FROM outbox WHERE id IN (?, ?, ?, ?, ?) ORDER BY seq",
        refused,
        conflict,
        waiting,
        accepted,
        elsewhere,
      ),
    ).toEqual([
      { id: refused, resolution: "resent" },
      { id: conflict, resolution: null },
      { id: waiting, resolution: null },
      { id: accepted, resolution: null },
      { id: elsewhere, resolution: null },
    ]);
    expectTied(db);
    expect((await readQueue(local, PAIRING)).settled.map((record) => record.id)).toEqual([
      conflict,
      elsewhere,
    ]);
  });

  it("sends a record again once: the second press finds nothing, and two presses together write one copy", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, 3);
    settle(db, ids, "rejected", "not_entered");
    const results = await Promise.allSettled([
      resendRefused(context(local, counting()), SHIFT_ID),
      resendRefused(context(local, counting()), SHIFT_ID),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected");
    expect(lost?.status === "rejected" ? lost.reason : null).toBeInstanceOf(StaleQueueError);
    await expect(resendRefused(context(local), SHIFT_ID)).rejects.toBeInstanceOf(StaleQueueError);
    expect(count(db)).toBe(6);
    expect(count(db, "acked_at IS NULL")).toBe(3);
    expectTied(db);
  });

  it("sends a copy that is refused again once more, and the first copy stays resolved", async () => {
    const { db, local } = await station();
    const [one = ""] = await unsentScans(local, 1);
    settle(db, [one], "rejected", "not_entered");
    await resendRefused(context(local), SHIFT_ID);
    const first = "00000000-0000-4000-8000-f00000000001";
    settle(db, [first], "rejected", "not_entered");
    await resendRefused(
      context(local, () => "00000000-0000-4000-8000-f00000000002"),
      SHIFT_ID,
    );
    expect(rows(db, "SELECT id, resolution, resent_as FROM outbox ORDER BY seq")).toEqual([
      { id: one, resolution: "resent", resent_as: first },
      { id: first, resolution: "resent", resent_as: "00000000-0000-4000-8000-f00000000002" },
      { id: "00000000-0000-4000-8000-f00000000002", resolution: null, resent_as: null },
    ]);
    expectTied(db);
  });

  it("leaves nothing doubled when a later part fails: the next press carries only what is left, in the same order", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, RESEND_CHUNK + 5);
    settle(db, ids, "rejected", "not_entered");
    let transactions = 0;
    const crashing: LocalExecutor = {
      query: (sql, params, row) => local.query(sql, params, row),
      transaction: async (statements) => {
        transactions += 1;
        if (transactions === 2) throw new LocalDbError("statement_failed", "the disk went away");
        return local.transaction(statements);
      },
    };
    await expect(
      resendRefused({ ...context(local), local: crashing }, SHIFT_ID),
    ).rejects.toBeInstanceOf(LocalDbError);
    expect(count(db, "resolution = 'resent'")).toBe(RESEND_CHUNK);
    expect(count(db, "acked_at IS NULL")).toBe(RESEND_CHUNK);
    expectTied(db);
    await expect(resendRefused(context(local, counting2()), SHIFT_ID)).resolves.toBe(5);
    expect(count(db, "acked_at IS NULL")).toBe(RESEND_CHUNK + 5);
    expect(count(db, "resolution = 'resent'")).toBe(RESEND_CHUNK + 5);
    const pairs = rows(
      db,
      "SELECT o.seq AS old, n.seq AS new FROM outbox o JOIN outbox n ON n.id = o.resent_as ORDER BY o.seq",
    ).map((row) => Number(row["new"]));
    expect(pairs).toHaveLength(RESEND_CHUNK + 5);
    expect(pairs).toEqual([...pairs].sort((a, b) => a - b));
    expect(new Set(pairs).size).toBe(pairs.length);
    expectTied(db);
  });

  it("writes the new copy and the mark in one transaction: a mark that fails takes the copy back", async () => {
    const { db, local } = await station();
    const [one = ""] = await unsentScans(local, 1);
    settle(db, [one], "rejected", "not_entered");
    db.exec(
      "CREATE TRIGGER mark_fails BEFORE UPDATE OF resolution ON outbox " +
        "WHEN NEW.resolution = 'resent' BEGIN SELECT RAISE(ABORT, 'no mark'); END",
    );
    await expect(resendRefused(context(local), SHIFT_ID)).rejects.toBeInstanceOf(LocalDbError);
    expect(count(db)).toBe(1);
    expect(count(db, "resolution IS NOT NULL")).toBe(0);
  });

  it("takes the new copy back when the mark changes no row, and reports the queue changed", async () => {
    const { db, local } = await station();
    const [one = ""] = await unsentScans(local, 1);
    settle(db, [one], "rejected", "not_entered");
    db.exec(
      "CREATE TRIGGER mark_ignored BEFORE UPDATE OF resolution ON outbox " +
        "WHEN NEW.resolution = 'resent' BEGIN SELECT RAISE(IGNORE); END",
    );
    await expect(resendRefused(context(local), SHIFT_ID)).rejects.toBeInstanceOf(StaleQueueError);
    expect(count(db)).toBe(1);
    expect(count(db, "acked_at IS NULL")).toBe(0);
  });

  it("refuses a record whose data this build would rewrite, before writing anything", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    // The same data, its keys in another order: byte for byte is lost on the way through the schema.
    const stored = JSON.parse(payloadOf(db, two)) as { data: Record<string, unknown> };
    const reversed = { ...stored, data: Object.fromEntries(Object.entries(stored.data).reverse()) };
    db.prepare("UPDATE outbox SET payload = ? WHERE id = ?").run(JSON.stringify(reversed), two);
    settle(db, [one, two], "rejected", "not_entered");
    const error = await resendRefused(context(local), SHIFT_ID).catch((caught: unknown) => caught);
    expect(error instanceof UnreadableRecordError ? error.recordId : null).toBe(two);
    expect(count(db)).toBe(2);
    expect(count(db, "resolution IS NOT NULL")).toBe(0);
  });

  it("refuses a record without data, a record that is no fact, before writing anything", async () => {
    const { db, local } = await station();
    const [one = ""] = await unsentScans(local, 1);
    const { id, kind, shiftId, operatorId } = JSON.parse(payloadOf(db, one)) as Record<
      string,
      string
    >;
    db.prepare("UPDATE outbox SET payload = ? WHERE id = ?").run(
      JSON.stringify({ id, kind, shiftId, operatorId }),
      one,
    );
    settle(db, [one], "rejected", "not_entered");
    await expect(resendRefused(context(local), SHIFT_ID)).rejects.toBeInstanceOf(
      UnreadableRecordError,
    );
    expect(count(db)).toBe(1);
  });

  it("carries at most a megabyte of payloads in a part, whatever the records weigh", () => {
    // Each record at most MAX_RECORD_BYTES; the JSON list around them adds their escaping.
    expect(RESEND_CHUNK * MAX_RECORD_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });

  it("refuses a record that carries data but is no fact of this build, before writing anything", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    const stored = JSON.parse(payloadOf(db, two)) as Record<string, unknown>;
    db.prepare("UPDATE outbox SET payload = ? WHERE id = ?").run(
      JSON.stringify({ ...stored, kind: "a_kind_of_a_newer_build" }),
      two,
    );
    settle(db, [one, two], "rejected", "invalid_record");
    const error = await resendRefused(context(local), SHIFT_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnreadableRecordError);
    expect(count(db)).toBe(2);
    expect(count(db, "resolution IS NOT NULL")).toBe(0);
  });

  it("gives each statement the same guards: a refused record of another pairing, a resolved, an accepted, a conflicting and a waiting one are not taken", async () => {
    const { db, local } = await station();
    const [mine = "", resolved = "", accepted = "", conflict = "", waiting = ""] =
      await unsentScans(local, 5, PAIRING, 950);
    const [theirs = ""] = await unsentScans(local, 1, OTHER_PAIRING, 990);
    const [otherHost = ""] = await unsentScans(local, 1, OTHER_HOST_PAIRING, 991);
    settle(db, [mine, resolved, theirs, otherHost], "rejected", "not_entered");
    settle(db, [accepted], "accepted");
    settle(db, [conflict], "conflict");
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ?",
    ).run(AT, OPERATOR_ID, resolved);
    const list = JSON.stringify(
      [resolved, accepted, conflict, waiting, theirs, otherHost].map((oldId, index) => ({
        oldId,
        newId: `00000000-0000-4000-8000-f0000000010${index}`,
        payload: payloadOf(db, oldId),
      })),
    );
    const before = rows(db, "SELECT * FROM outbox ORDER BY seq");
    const inserted = db
      .prepare(RESEND_INSERT_SQL)
      .run(AT, list, PAIRING.hostId, PAIRING.deviceId).changes;
    const marked = db
      .prepare(RESEND_MARK_SQL)
      .run(AT, OPERATOR_ID, list, PAIRING.hostId, PAIRING.deviceId).changes;
    expect([Number(inserted), Number(marked)]).toEqual([0, 0]);
    expect(rows(db, "SELECT * FROM outbox ORDER BY seq")).toEqual(before);
  });
});

describe("«Снять с очереди», beyond the plan's example", () => {
  it("takes off nothing that is not this pairing's refused or conflicting, unresolved record", async () => {
    const { db, local } = await station();
    const [accepted = "", waiting = "", resent = ""] = await unsentScans(local, 3, PAIRING, 400);
    const [theirs = ""] = await unsentScans(local, 1, OTHER_PAIRING, 450);
    const [otherHost = ""] = await unsentScans(local, 1, OTHER_HOST_PAIRING, 460);
    settle(db, [accepted], "accepted");
    settle(db, [resent, theirs, otherHost], "rejected", "not_entered");
    await resendRefused(context(local), SHIFT_ID);
    const before = rows(db, "SELECT * FROM outbox ORDER BY seq");
    for (const id of [accepted, waiting, resent, theirs, otherHost, "no-such-record"]) {
      await expect(dismissRecord(context(local), id), id).rejects.toBeInstanceOf(StaleQueueError);
    }
    expect(rows(db, "SELECT * FROM outbox ORDER BY seq")).toEqual(before);
    expectTied(db);
  });

  it("writes who, when and what together, and the record is never sent: the sender takes what waits and the copies, not what a person resolved", async () => {
    const { db, local } = await station();
    const [dismissed = "", resent = "", waiting = "", conflict = ""] = await unsentScans(
      local,
      4,
      PAIRING,
      500,
    );
    settle(db, [dismissed, resent], "rejected", "not_entered");
    settle(db, [conflict], "conflict");
    await dismissRecord(context(local), dismissed);
    await dismissRecord(context(local), conflict);
    await resendRefused(context(local), SHIFT_ID);
    expect(
      rows(
        db,
        "SELECT id, resolution, resolved_at, resolved_by FROM outbox WHERE resolution IS NOT NULL ORDER BY seq",
      ),
    ).toEqual([
      {
        id: dismissed,
        resolution: "dismissed",
        resolved_at: NOW.toISOString(),
        resolved_by: OPERATOR_ID,
      },
      {
        id: resent,
        resolution: "resent",
        resolved_at: NOW.toISOString(),
        resolved_by: OPERATOR_ID,
      },
      {
        id: conflict,
        resolution: "dismissed",
        resolved_at: NOW.toISOString(),
        resolved_by: OPERATOR_ID,
      },
    ]);
    expectTied(db);
    const sent: string[][] = [];
    const send = vi.fn(async (records: readonly unknown[]): Promise<FactReceipt[]> => {
      const batch = records.map((record) => String((record as { id: string }).id));
      sent.push(batch);
      return batch.map((id) => ({ id, outcome: "accepted" }));
    });
    await sendFactBatch(local, PAIRING, send, steppingClock());
    await sendFactBatch(local, PAIRING, send, steppingClock());
    expect(sent).toEqual([[waiting, "00000000-0000-4000-8000-f00000000001"]]);
  });
});

// The final review's I-1: after a restore of the host a shift the copy does not know is refused
// on every record. The screen lists a bounded part of it and counts the rest; one decision takes
// off all of a shift's refusals but its close.
async function keepClose(local: LocalExecutor, id = CLOSE_ID, shiftId = SHIFT_ID): Promise<string> {
  return keep(
    local,
    shiftClosedRecord(
      { id, shiftId, operatorId: OPERATOR_ID },
      {
        plannedQtySnapshot: 1200,
        actualQty: 0,
        closedBoxCount: 0,
        reasonCode: null,
        closedAt: AT,
      },
    ),
  );
}

describe("the queue screen's bounded list and its counts (final review I-1)", () => {
  it("lists the first QUEUE_LISTED_PER_SHIFT refused records of each shift in the order kept, and counts every one by kind", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, QUEUE_LISTED_PER_SHIFT + 5, PAIRING, 1000);
    const close = await keepClose(local);
    const elsewhere = await keep(
      local,
      scanOf("00000000-0000-4000-8000-0000000000a1", OTHER_SHIFT),
    );
    settle(db, [...ids, close, elsewhere], "rejected", "unknown_shift");
    const view = await readQueue(local, PAIRING);
    expect(view.settled.map((record) => record.id)).toEqual([
      ...ids.slice(0, QUEUE_LISTED_PER_SHIFT),
      elsewhere,
    ]);
    expect(
      [...view.tallies].sort(
        (a, b) => a.shiftId.localeCompare(b.shiftId) || a.kind.localeCompare(b.kind),
      ),
    ).toEqual(
      [
        { shiftId: OTHER_SHIFT, outcome: "rejected", kind: "scan", count: 1 },
        { shiftId: SHIFT_ID, outcome: "rejected", kind: "scan", count: ids.length },
        { shiftId: SHIFT_ID, outcome: "rejected", kind: "shift_closed", count: 1 },
      ].sort((a, b) => a.shiftId.localeCompare(b.shiftId) || a.kind.localeCompare(b.kind)),
    );
  });

  it("bounds the refused records and the conflicts of a shift each on their own", async () => {
    const { db, local } = await station();
    const refused = await unsentScans(local, QUEUE_LISTED_PER_SHIFT + 1, PAIRING, 1100);
    // Kept after every refusal: bound together with them it would be the 22nd of the shift.
    const conflicts = await unsentScans(local, QUEUE_LISTED_PER_SHIFT + 1, PAIRING, 1200);
    settle(db, refused, "rejected", "not_entered");
    settle(db, conflicts, "conflict");
    const view = await readQueue(local, PAIRING);
    expect(view.settled.map((record) => record.id)).toEqual([
      ...refused.slice(0, QUEUE_LISTED_PER_SHIFT),
      ...conflicts.slice(0, QUEUE_LISTED_PER_SHIFT),
    ]);
    expect(view.tallies.map((tally) => [tally.outcome, tally.count]).sort()).toEqual([
      ["conflict", QUEUE_LISTED_PER_SHIFT + 1],
      ["rejected", QUEUE_LISTED_PER_SHIFT + 1],
    ]);
  });

  it("counts nothing resolved, nothing waiting or accepted, and nothing of another pairing", async () => {
    const { db, local } = await station();
    const [refused = "", resolved = "", accepted = ""] = await unsentScans(local, 4, PAIRING, 1300);
    const [theirs = ""] = await unsentScans(local, 1, OTHER_PAIRING, 1350);
    const [otherHost = ""] = await unsentScans(local, 1, OTHER_HOST_PAIRING, 1360);
    settle(db, [refused, resolved, theirs, otherHost], "rejected", "not_entered");
    settle(db, [accepted], "accepted");
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ?",
    ).run(AT, OPERATOR_ID, resolved);
    const view = await readQueue(local, PAIRING);
    expect(view.tallies).toEqual([
      { shiftId: SHIFT_ID, outcome: "rejected", kind: "scan", count: 1 },
    ]);
    expect(view.settled.map((record) => record.id)).toEqual([refused]);
  });
});

describe("«Снять с очереди все отказы смены» (final review I-1)", () => {
  it("takes off every refused record of the shift in one statement, with who and when, and leaves its close", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, QUEUE_LISTED_PER_SHIFT + 5, PAIRING, 2000);
    const close = await keepClose(local);
    settle(db, [...ids, close], "rejected", "unknown_shift");
    const transaction = vi.spyOn(local, "transaction");
    await dismissShiftRefusals(context(local), SHIFT_ID, ids.length);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]?.[0]).toHaveLength(1);
    expect(
      rows(
        db,
        "SELECT DISTINCT resolution, resent_as, resolved_at, resolved_by FROM outbox WHERE kind = 'scan'",
      ),
    ).toEqual([
      {
        resolution: "dismissed",
        resent_as: null,
        resolved_at: NOW.toISOString(),
        resolved_by: OPERATOR_ID,
      },
    ]);
    expect(
      rows(db, "SELECT resolution, resolved_at, resolved_by FROM outbox WHERE id = ?", close),
    ).toEqual([{ resolution: null, resolved_at: null, resolved_by: null }]);
    expectTied(db);
    const view = await readQueue(local, PAIRING);
    expect(view.settled.map((record) => record.id)).toEqual([close]);
    expect(view.tallies).toEqual([
      { shiftId: SHIFT_ID, outcome: "rejected", kind: "shift_closed", count: 1 },
    ]);
  });

  it("takes nothing of another pairing or another shift, nothing resolved, waiting, accepted or in conflict", async () => {
    const { db, local } = await station();
    const [mine = "", resent = "", dismissed = "", waiting = "", accepted = "", conflict = ""] =
      await unsentScans(local, 6, PAIRING, 2100);
    const [theirs = ""] = await unsentScans(local, 1, OTHER_PAIRING, 2150);
    const [otherHost = ""] = await unsentScans(local, 1, OTHER_HOST_PAIRING, 2160);
    const elsewhere = await keep(
      local,
      scanOf("00000000-0000-4000-8000-0000000000a1", OTHER_SHIFT),
    );
    settle(db, [mine, resent, dismissed, theirs, otherHost, elsewhere], "rejected", "not_entered");
    settle(db, [accepted], "accepted");
    settle(db, [conflict], "conflict");
    db.prepare(
      "UPDATE outbox SET resolution = 'resent', resent_as = 'copy', resolved_at = ?, resolved_by = 'earlier' WHERE id = ?",
    ).run(AT, resent);
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = 'earlier' WHERE id = ?",
    ).run(AT, dismissed);
    const before = rows(db, "SELECT * FROM outbox WHERE id <> ? ORDER BY seq", mine);
    await dismissShiftRefusals(context(local), SHIFT_ID, 1);
    expect(rows(db, "SELECT * FROM outbox WHERE id <> ? ORDER BY seq", mine)).toEqual(before);
    expect(rows(db, "SELECT resolution FROM outbox WHERE id = ?", mine)).toEqual([
      { resolution: "dismissed" },
    ]);
    // The record still waiting for its receipt is among the untouched.
    expect(rows(db, "SELECT outcome, resolution FROM outbox WHERE id = ?", waiting)).toEqual([
      { outcome: null, resolution: null },
    ]);
  });

  it("writes nothing when the number confirmed no longer holds: a refusal arrived since, or one was resolved", async () => {
    const { db, local } = await station();
    const [one = "", two = "", three = ""] = await unsentScans(local, 3, PAIRING, 2200);
    settle(db, [one, two], "rejected", "unknown_shift");
    // The person saw two; a third refusal landed before the press.
    settle(db, [three], "rejected", "unknown_shift");
    await expect(dismissShiftRefusals(context(local), SHIFT_ID, 2)).rejects.toBeInstanceOf(
      StaleQueueError,
    );
    expect(count(db, "resolution IS NOT NULL")).toBe(0);
    // And one fewer than confirmed.
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ?",
    ).run(AT, OPERATOR_ID, three);
    await expect(dismissShiftRefusals(context(local), SHIFT_ID, 3)).rejects.toBeInstanceOf(
      StaleQueueError,
    );
    expect(count(db, "resolution IS NOT NULL")).toBe(1);
    expectTied(db);
  });

  it("takes off a shift's refusals once: two presses together write one decision, the second finds the queue changed", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, 3, PAIRING, 2300);
    settle(db, ids, "rejected", "unknown_shift");
    const results = await Promise.allSettled([
      dismissShiftRefusals(context(local), SHIFT_ID, 3),
      dismissShiftRefusals({ ...context(local), operatorId: "someone-else" }, SHIFT_ID, 3),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = results.find((result) => result.status === "rejected");
    expect(lost?.status === "rejected" ? lost.reason : null).toBeInstanceOf(StaleQueueError);
    expect(rows(db, "SELECT DISTINCT resolved_by FROM outbox")).toHaveLength(1);
    expectTied(db);
  });

  it("is never a success for nothing: a shift with only its refused close, or a number below one, writes nothing", async () => {
    const { db, local } = await station();
    const close = await keepClose(local);
    settle(db, [close], "rejected", "unknown_shift");
    for (const expected of [0, -1]) {
      await expect(
        dismissShiftRefusals(context(local), SHIFT_ID, expected),
        String(expected),
      ).rejects.toBeInstanceOf(StaleQueueError);
    }
    await expect(dismissShiftRefusals(context(local), SHIFT_ID, 1)).rejects.toBeInstanceOf(
      StaleQueueError,
    );
    expect(count(db, "resolution IS NOT NULL")).toBe(0);
  });

  it("passes a failure of the database on as it is", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, 2, PAIRING, 2400);
    settle(db, ids, "rejected", "unknown_shift");
    const failing: LocalExecutor = {
      query: (sql, params, row) => local.query(sql, params, row),
      transaction: async () => {
        throw new LocalDbError("statement_failed", "the disk went away");
      },
    };
    await expect(
      dismissShiftRefusals({ ...context(local), local: failing }, SHIFT_ID, 2),
    ).rejects.toBeInstanceOf(LocalDbError);
    expect(count(db, "resolution IS NOT NULL")).toBe(0);
  });

  it("never sends what it took off", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, 2, PAIRING, 2500);
    settle(db, ids, "rejected", "unknown_shift");
    await dismissShiftRefusals(context(local), SHIFT_ID, 2);
    const send = vi.fn(async (): Promise<FactReceipt[]> => []);
    await sendFactBatch(local, PAIRING, send, steppingClock());
    expect(send).not.toHaveBeenCalled();
    expect(count(db, "acked_at IS NULL")).toBe(0);
  });
});

/** Ids `…f00000000101`, … : a second run's ids never meet the first's. */
function counting2(): () => string {
  let n = 100;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-f${String(n).padStart(11, "0")}`;
  };
}

describe("displaced scans on the queue screen (plan КНФ)", () => {
  const HASH = "0".repeat(63) + "7";

  function displaced(
    db: DatabaseSync,
    conflictId: string,
    fields: {
      pairing?: typeof PAIRING;
      boxId?: string | null;
      detectedAt?: string;
      resolved?: boolean;
    } = {},
  ): void {
    const pairing = fields.pairing ?? PAIRING;
    db.prepare(
      "INSERT INTO floor_displacements (host_id, device_id, conflict_id, record_id, shift_id, " +
        "code_hash, box_id, detected_at, winner_shift_number, winner_same_device, " +
        "winner_scanned_at, learned_at, resolved_at, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, " +
        "'OCT26-005/S', 0, '2026-10-08T06:00:50.000Z', ?, ?, ?)",
    ).run(
      pairing.hostId,
      pairing.deviceId,
      conflictId,
      `r-${conflictId}`,
      SHIFT_ID,
      HASH,
      fields.boxId ?? null,
      fields.detectedAt ?? "2026-10-08T07:12:03Z",
      AT,
      fields.resolved === true ? AT : null,
      fields.resolved === true ? OPERATOR_ID : null,
    );
  }

  it("lists the pairing's open displacements oldest first, with their shift's number and their box's SSCC", async () => {
    const { db, local } = await station();
    db.prepare(
      "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
        "block_id, serial, item_count, closed_by) VALUES ('box-1', ?, ?, ?, ?, ?, " +
        "'046006820000015001', 'block-1', 1500, 1, NULL)",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID, AT, AT);
    displaced(db, "c-2", { detectedAt: "2026-10-08T08:00:00Z" });
    displaced(db, "c-1", { boxId: "box-1" });
    displaced(db, "c-3", { resolved: true });
    displaced(db, "c-4", { pairing: OTHER_PAIRING });
    const view = await readQueue(local, PAIRING);
    expect(view.displaced).toEqual([
      {
        conflictId: "c-1",
        shiftId: SHIFT_ID,
        shiftNumber: ENTERED.number,
        sscc: "046006820000015001",
        detectedAt: "2026-10-08T07:12:03Z",
        winnerShiftNumber: "OCT26-005/S",
        winnerSameDevice: false,
      },
      {
        conflictId: "c-2",
        shiftId: SHIFT_ID,
        shiftNumber: ENTERED.number,
        sscc: null,
        detectedAt: "2026-10-08T08:00:00Z",
        winnerShiftNumber: "OCT26-005/S",
        winnerSameDevice: false,
      },
    ]);
  });

  it("settles a displacement with who and when, once", async () => {
    const { db, local } = await station();
    displaced(db, "c-1");
    await dismissDisplacement(context(local), "c-1");
    expect(
      rows(db, "SELECT resolved_at, resolved_by, office_reviewed_at FROM floor_displacements"),
    ).toEqual([
      { resolved_at: NOW.toISOString(), resolved_by: OPERATOR_ID, office_reviewed_at: null },
    ]);
    await expect(dismissDisplacement(context(local), "c-1")).rejects.toBeInstanceOf(
      StaleQueueError,
    );
    // Another pairing's displacement of the same id is not this pairing's to settle.
    displaced(db, "c-9", { pairing: OTHER_PAIRING });
    await expect(dismissDisplacement(context(local), "c-9")).rejects.toBeInstanceOf(
      StaleQueueError,
    );
    expect((await readQueue(local, PAIRING)).displaced).toEqual([]);
  });

  it("shows a displacement's shift number and box SSCC from the row once the shift's copy is gone", async () => {
    const { db, local } = await station();
    displaced(db, "c-1", { boxId: "box-gone" });
    db.prepare(
      "UPDATE floor_displacements SET shift_number = 'OCT26-004', box_sscc = '046006820000015001'",
    ).run();
    db.prepare("DELETE FROM floor_shifts").run();
    const [record] = (await readQueue(local, PAIRING)).displaced;
    expect(record).toMatchObject({ shiftNumber: "OCT26-004", sscc: "046006820000015001" });
  });
});
