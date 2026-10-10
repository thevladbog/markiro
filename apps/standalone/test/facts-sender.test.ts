import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { processScan } from "../src/floor/work/scan-pipeline.js";
import { HostError } from "../src/host/client.js";
import type { FactReceipt } from "../src/host/protocol.js";
import { LocalDbError } from "../src/local/executor.js";
import { MAX_BATCH_BYTES, ReceiptMismatchError, sendFactBatch } from "../src/local/facts-sender.js";
import {
  countingIds,
  enteredShift,
  SECOND,
  km,
  PAIRING,
  rows,
  SHIFT_ID,
  scanContext,
  steppingClock,
  unsentScans,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };
const WINNER = {
  shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  shiftNumber: "OCT26-003",
  deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  scannedAt: "2026-10-08T05:58:41.090Z",
  sameDevice: false,
};

/** Accepts every record it is sent. */
function acceptingAll() {
  return vi.fn(async (records: readonly unknown[]): Promise<FactReceipt[]> =>
    records.map((record) => ({
      id: (record as { id: string }).id,
      outcome: "accepted" as const,
    })),
  );
}

function batches(send: ReturnType<typeof acceptingAll>): string[][] {
  return send.mock.calls.map((_call, index) => sentIds(send, index));
}

function sentIds(send: ReturnType<typeof acceptingAll>, call: number): string[] {
  return (send.mock.calls[call]?.[0] ?? []).map((record) => (record as { id: string }).id);
}

describe("a batch of the outbox", () => {
  it("is this pairing's oldest records without a receipt, up to 100, in their order, as kept", async () => {
    const { db, executor } = openLocalDb();
    const ids = await unsentScans(executor, 102);
    await unsentScans(executor, 3, OTHER_PAIRING, 500);
    db.prepare(
      "UPDATE outbox SET outcome = 'accepted', acked_at = '2026-10-08T06:16:00.000Z' WHERE id = ?",
    ).run(ids[0] ?? "");
    const send = acceptingAll();
    const now = steppingClock();
    await expect(sendFactBatch(executor, PAIRING, send, now)).resolves.toEqual({
      sent: 100,
      more: true,
    });
    expect(sentIds(send, 0)).toEqual(ids.slice(1, 101));
    const [kept] = rows(db, "SELECT payload FROM outbox WHERE id = ?", ids[1] ?? "");
    expect(send.mock.calls[0]?.[0][0]).toEqual(JSON.parse(String(kept?.["payload"])));
    await expect(sendFactBatch(executor, PAIRING, send, now)).resolves.toEqual({
      sent: 1,
      more: false,
    });
    expect(sentIds(send, 1)).toEqual(ids.slice(101));
    await expect(sendFactBatch(executor, PAIRING, send, now)).resolves.toEqual({
      sent: 0,
      more: false,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([{ n: 3 }]);
  });

  it("counts every attempt and keeps no receipt when the send fails", async () => {
    const { db, executor } = openLocalDb();
    const [id] = await unsentScans(executor, 1);
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const failing = vi.fn(async (): Promise<FactReceipt[]> => {
      throw down;
    });
    const now = steppingClock();
    await expect(sendFactBatch(executor, PAIRING, failing, now)).rejects.toBe(down);
    expect(rows(db, "SELECT attempts, sent_at, outcome, acked_at FROM outbox")).toEqual([
      { attempts: 1, sent_at: "2026-10-08T06:15:00.000Z", outcome: null, acked_at: null },
    ]);
    await sendFactBatch(executor, PAIRING, acceptingAll(), now);
    expect(rows(db, "SELECT id, attempts, outcome, acked_at FROM outbox")).toEqual([
      { id, attempts: 2, outcome: "accepted", acked_at: "2026-10-08T06:15:02.000Z" },
    ]);
  });

  it("applies each receipt to its record in one write, by its id or, without one, by its place", async () => {
    const { db, executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const context = scanContext(executor, shift);
    await processScan(context, km("A1"));
    await processScan(context, km("A2"));
    await processScan(context, "MRK-000742");
    const records = rows(db, "SELECT id, kind FROM outbox ORDER BY seq");
    const [first, second, third] = records.map((row) => String(row["id"]));
    const send = vi.fn(async (): Promise<FactReceipt[]> => [
      { id: first ?? "", outcome: "accepted" },
      { id: second ?? "", outcome: "conflict", details: { winner: WINNER } },
      { id: null, outcome: "rejected", code: "invalid_record" },
    ]);
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).resolves.toEqual({
      sent: 3,
      more: false,
    });
    expect(
      rows(
        db,
        "SELECT id, outcome, outcome_code, outcome_details, acked_at FROM outbox ORDER BY seq",
      ),
    ).toEqual([
      {
        id: first,
        outcome: "accepted",
        outcome_code: null,
        outcome_details: null,
        acked_at: "2026-10-08T06:15:01.000Z",
      },
      {
        id: second,
        outcome: "conflict",
        outcome_code: null,
        outcome_details: JSON.stringify({ winner: WINNER }),
        acked_at: "2026-10-08T06:15:01.000Z",
      },
      {
        id: third,
        outcome: "rejected",
        outcome_code: "invalid_record",
        outcome_details: null,
        acked_at: "2026-10-08T06:15:01.000Z",
      },
    ]);
    expect(rows(db, "SELECT id, conflict FROM floor_scans ORDER BY scanned_at")).toEqual([
      { id: first, conflict: 0 },
      { id: second, conflict: 1 },
      { id: third, conflict: 0 },
    ]);
    expect(rows(db, "SELECT needs_fix FROM floor_boxes")).toEqual([{ needs_fix: 1 }]);
    // A refused record is never sent again under its id: the host keeps its
    // refusal for good, and only a person sends it again, under a new id.
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).resolves.toEqual({
      sent: 0,
      more: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps nothing when the receipts do not answer the records sent", async () => {
    const { db, executor } = openLocalDb();
    const [first, second] = await unsentScans(executor, 2);
    for (const answer of [
      [{ id: first ?? "", outcome: "accepted" as const }],
      [
        { id: second ?? "", outcome: "accepted" as const },
        { id: first ?? "", outcome: "accepted" as const },
      ],
      [
        { id: first ?? "", outcome: "accepted" as const },
        { id: second ?? "", outcome: "accepted" as const },
        { id: null, outcome: "accepted" as const },
      ],
    ]) {
      await expect(
        sendFactBatch(executor, PAIRING, async () => answer, steppingClock()),
      ).rejects.toBeInstanceOf(ReceiptMismatchError);
    }
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([{ n: 2 }]);
  });
});

/** Records straight into the outbox: `ids` in the order they are kept, whatever their ids or times say. */
function keep(db: DatabaseSync, ids: readonly string[], createdAt: (index: number) => string) {
  ids.forEach((id, index) => {
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES (?, ?, ?, 'scan', ?, ?, ?)",
    ).run(
      id,
      PAIRING.hostId,
      PAIRING.deviceId,
      SHIFT_ID,
      JSON.stringify({ id, n: index }),
      createdAt(index),
    );
  });
}

describe("what a batch leaves alone", () => {
  it("goes in the order the records were kept, not in the order of their ids or times", async () => {
    const { db, executor } = openLocalDb();
    keep(db, ["ccc", "bbb", "aaa"], (index) => `2026-10-08T0${9 - index}:00:00.000Z`);
    const send = acceptingAll();
    await sendFactBatch(executor, PAIRING, send, steppingClock());
    expect(sentIds(send, 0)).toEqual(["ccc", "bbb", "aaa"]);
  });

  it("counts a send only on the records it carries", async () => {
    const { db, executor } = openLocalDb();
    const ids = await unsentScans(executor, 102);
    const [other] = await unsentScans(executor, 1, OTHER_PAIRING, 500);
    db.prepare(
      "UPDATE outbox SET outcome = 'accepted', acked_at = '2026-10-08T06:16:00.000Z' WHERE id = ?",
    ).run(ids[0] ?? "");
    await sendFactBatch(executor, PAIRING, acceptingAll(), steppingClock());
    const attempts = (id: string | undefined) =>
      rows(db, "SELECT attempts, sent_at FROM outbox WHERE id = ?", id ?? "")[0];
    expect(attempts(ids[0])).toEqual({ attempts: 0, sent_at: null });
    expect(attempts(ids[1])).toEqual({ attempts: 1, sent_at: "2026-10-08T06:15:00.000Z" });
    expect(attempts(ids[100])).toEqual({ attempts: 1, sent_at: "2026-10-08T06:15:00.000Z" });
    expect(attempts(ids[101])).toEqual({ attempts: 0, sent_at: null });
    expect(attempts(other)).toEqual({ attempts: 0, sent_at: null });
  });

  it("does not overwrite a receipt that arrived while the batch was away", async () => {
    const { db, executor } = openLocalDb();
    const [first, second] = await unsentScans(executor, 2);
    const send = vi.fn(async (records: readonly unknown[]): Promise<FactReceipt[]> => {
      db.prepare(
        "UPDATE outbox SET outcome = 'rejected', outcome_code = 'invalid_record', " +
          "acked_at = '2026-10-08T05:00:00.000Z' WHERE id = ?",
      ).run(first ?? "");
      return records.map((record) => ({
        id: (record as { id: string }).id,
        outcome: "accepted" as const,
      }));
    });
    await sendFactBatch(executor, PAIRING, send, steppingClock());
    expect(rows(db, "SELECT id, outcome, outcome_code, acked_at FROM outbox ORDER BY seq")).toEqual(
      [
        {
          id: first,
          outcome: "rejected",
          outcome_code: "invalid_record",
          acked_at: "2026-10-08T05:00:00.000Z",
        },
        {
          id: second,
          outcome: "accepted",
          outcome_code: null,
          acked_at: "2026-10-08T06:15:01.000Z",
        },
      ],
    );
  });

  it("keeps the details of a receipt as the host wrote them, a refusal's and an accepted close's alike", async () => {
    const { db, executor } = openLocalDb();
    const [first, second, third] = await unsentScans(executor, 3);
    const send = vi.fn(async (): Promise<FactReceipt[]> => [
      {
        id: first ?? "",
        outcome: "rejected",
        code: "invalid_record",
        details: { field: "data.code" },
      },
      { id: second ?? "", outcome: "accepted", details: { alreadyClosed: true } },
      { id: third ?? "", outcome: "rejected", code: "sscc_taken" },
    ]);
    await sendFactBatch(executor, PAIRING, send, steppingClock());
    expect(
      rows(db, "SELECT outcome, outcome_code, outcome_details FROM outbox ORDER BY seq"),
    ).toEqual([
      {
        outcome: "rejected",
        outcome_code: "invalid_record",
        outcome_details: '{"field":"data.code"}',
      },
      { outcome: "accepted", outcome_code: null, outcome_details: '{"alreadyClosed":true}' },
      { outcome: "rejected", outcome_code: "sscc_taken", outcome_details: null },
    ]);
    // No record leaves the outbox, whatever the host said of it.
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 3 }]);
  });

  it("marks only the box of the scan in conflict, not the pairing's other boxes", async () => {
    const { db, executor } = openLocalDb();
    const newId = countingIds();
    const shiftA = await enteredShift(executor);
    const shiftB = await enteredShift(executor, SECOND);
    const contextA = scanContext(executor, shiftA, { newId });
    const contextB = scanContext(executor, shiftB, { newId });
    await processScan(contextA, km("A1"));
    await processScan(contextA, km("A2"));
    await processScan(contextB, km("B1"));
    const ids = rows(db, "SELECT id FROM outbox ORDER BY seq").map((row) => String(row["id"]));
    const send = vi.fn(async (): Promise<FactReceipt[]> => [
      { id: ids[0] ?? "", outcome: "accepted" },
      { id: ids[1] ?? "", outcome: "conflict", details: { winner: WINNER } },
      { id: ids[2] ?? "", outcome: "accepted" },
    ]);
    await sendFactBatch(executor, PAIRING, send, steppingClock());
    expect(
      rows(db, "SELECT shift_id, needs_fix FROM floor_boxes ORDER BY opened_at, shift_id"),
    ).toEqual([
      { shift_id: SHIFT_ID, needs_fix: 1 },
      { shift_id: SECOND.id, needs_fix: 0 },
    ]);
    expect(rows(db, "SELECT id FROM floor_scans WHERE conflict = 1")).toEqual([{ id: ids[1] }]);
  });

  it("marks a conflict of a scan that has no box on the scan alone", async () => {
    const { db, executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const context = scanContext(executor, shift);
    await processScan(context, km("A1"));
    await processScan(context, "MRK-000742");
    const [first, second] = rows(db, "SELECT id FROM outbox ORDER BY seq").map((row) =>
      String(row["id"]),
    );
    const send = vi.fn(async (): Promise<FactReceipt[]> => [
      { id: first ?? "", outcome: "accepted" },
      { id: second ?? "", outcome: "conflict" },
    ]);
    await sendFactBatch(executor, PAIRING, send, steppingClock());
    expect(rows(db, "SELECT id, conflict FROM floor_scans ORDER BY scanned_at")).toEqual([
      { id: first, conflict: 0 },
      { id: second, conflict: 1 },
    ]);
    expect(rows(db, "SELECT needs_fix FROM floor_boxes")).toEqual([{ needs_fix: 0 }]);
  });

  it("writes the receipts and the marks of a conflict in one transaction", async () => {
    const { db, executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const context = scanContext(executor, shift);
    await processScan(context, km("A1"));
    await processScan(context, km("A2"));
    const ids = rows(db, "SELECT id FROM outbox ORDER BY seq").map((row) => String(row["id"]));
    const send = vi.fn(async (): Promise<FactReceipt[]> => [
      { id: ids[0] ?? "", outcome: "accepted" },
      { id: ids[1] ?? "", outcome: "conflict", details: { winner: WINNER } },
    ]);
    // The last write of the transaction fails, as a full disk would fail it.
    db.exec(
      "CREATE TRIGGER no_fix BEFORE UPDATE OF needs_fix ON floor_boxes " +
        "BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).rejects.toBeInstanceOf(
      LocalDbError,
    );
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([{ n: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans WHERE conflict = 1")).toEqual([
      { n: 0 },
    ]);
    // The same batch goes again and is kept whole.
    db.exec("DROP TRIGGER no_fix");
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).resolves.toEqual({
      sent: 2,
      more: false,
    });
    expect(rows(db, "SELECT attempts, outcome FROM outbox ORDER BY seq")).toEqual([
      { attempts: 2, outcome: "accepted" },
      { attempts: 2, outcome: "conflict" },
    ]);
    expect(rows(db, "SELECT needs_fix FROM floor_boxes")).toEqual([{ needs_fix: 1 }]);
  });

  it("sends nothing it could not count: a failed count stops the send", async () => {
    const { db, executor } = openLocalDb();
    await unsentScans(executor, 1);
    db.exec(
      "CREATE TRIGGER no_count BEFORE UPDATE OF attempts ON outbox " +
        "BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const send = acceptingAll();
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).rejects.toBeInstanceOf(
      LocalDbError,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

/** A record of exactly `bytes` bytes of JSON, padded with two-byte letters (and one plain byte when odd). */
function ofBytes(id: string, bytes: number): { id: string; payload: string } {
  const bare = new TextEncoder().encode(JSON.stringify({ id, pad: "" })).length;
  const room = bytes - bare;
  const pad = "я".repeat(Math.floor(room / 2)) + (room % 2 === 1 ? "x" : "");
  const payload = JSON.stringify({ id, pad });
  expect(new TextEncoder().encode(payload).length).toBe(bytes);
  return { id, payload };
}

function keepRecords(db: DatabaseSync, records: readonly { id: string; payload: string }[]) {
  for (const { id, payload } of records) {
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES (?, ?, ?, 'scan', ?, ?, '2026-10-08T06:15:00.000Z')",
    ).run(id, PAIRING.hostId, PAIRING.deviceId, SHIFT_ID, payload);
  }
}

describe("what a batch weighs", () => {
  it("is cut after the last record that fits together with the ones before it, counted in bytes", async () => {
    const { db, executor } = openLocalDb();
    const half = MAX_BATCH_BYTES / 2;
    keepRecords(db, [ofBytes("a", half), ofBytes("b", half), ofBytes("c", 200)]);
    const send = acceptingAll();
    // Exactly the budget goes; the next record waits for the next batch.
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).resolves.toEqual({
      sent: 2,
      more: true,
    });
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).resolves.toEqual({
      sent: 1,
      more: false,
    });
    expect([sentIds(send, 0), sentIds(send, 1)]).toEqual([["a", "b"], ["c"]]);
  });

  it("counts bytes, not letters, and takes one byte past the budget for the next batch", async () => {
    const { db, executor } = openLocalDb();
    // Two records of 600,000 letters are 1.2 million letters but 2.4 million bytes.
    keepRecords(db, [
      ofBytes("a", 1_200_050),
      ofBytes("b", 1_200_050),
      ofBytes("c", MAX_BATCH_BYTES - 1_200_050 + 1),
    ]);
    const send = acceptingAll();
    await sendFactBatch(executor, PAIRING, send, steppingClock());
    await sendFactBatch(executor, PAIRING, send, steppingClock());
    await sendFactBatch(executor, PAIRING, send, steppingClock());
    expect(batches(send)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("carries a record larger than the budget alone, rather than never", async () => {
    const { db, executor } = openLocalDb();
    keepRecords(db, [ofBytes("big", 2 * 1_048_576 + 10), ofBytes("small", 200)]);
    const send = acceptingAll();
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).resolves.toEqual({
      sent: 1,
      more: true,
    });
    expect(sentIds(send, 0)).toEqual(["big"]);
  });
});
