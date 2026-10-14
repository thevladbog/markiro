import type { DatabaseSync } from "node:sqlite";

import { canonicalizeKm, kmHash } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import { processScan } from "../src/floor/work/scan-pipeline.js";
import type { ChangeItem, ChangesResponse } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { FROM_ZERO_SQL, syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import {
  ENTERED,
  enteredShift,
  km,
  rows,
  scanContext,
  SECOND,
  SHIFT_ID,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

/** Ids that never repeat across the scan contexts of one test (each context counts from 1). */
let issued = 1000;
function laterIds() {
  return () => `00000000-0000-4000-8000-${String(++issued).padStart(12, "0")}`;
}

const DOCUMENT_ID = "6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c";
const OTHER_HOST = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

function release(boxId: string, shiftId: string, rev = 44, data: object = {}): ChangeItem {
  return {
    entity: "code_releases",
    id: boxId,
    rev,
    deleted: false,
    data: {
      shiftId,
      documentId: DOCUMENT_ID,
      releasedAt: "2026-10-13T09:05:00.000Z",
      codeCount: 1,
      ...data,
    },
  };
}

function page(rev: number, items: ChangeItem[]): ChangesResponse {
  return { hostId: HOST_ID, rev, hasMore: false, items };
}

async function sync(local: LocalExecutor, items: ChangeItem[], since = 0, rev = 44) {
  return syncReferences({
    changes: vi.fn(async (asked: number) => {
      if (asked !== since) throw new Error(`unexpected since=${asked}`);
      return page(rev, items);
    }),
    local,
    hostId: HOST_ID,
    deviceId: DEVICE_ID,
    now: () => 1_790_000_000_000,
  });
}

/** Close the station's open box as a box close would (not the shift). */
function closeBox(db: DatabaseSync, boxId: string, serial: number) {
  db.prepare(
    "UPDATE floor_boxes SET closed_at = '2026-10-08T06:20:00.000Z', sscc = ?, block_id = ?, serial = ? WHERE id = ?",
  ).run(
    `0460068200000${serial}0`.slice(0, 18),
    "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
    serial,
    boxId,
  );
}

/** The host closed the shift (the station's copy follows only when it hears). */
function closeShiftCopy(db: DatabaseSync, shiftId: string) {
  db.prepare(
    "UPDATE floor_shifts SET status = 'closed', closed_at = '2026-10-08T07:00:00Z' WHERE id = ?",
  ).run(shiftId);
}

const codeRows = (db: DatabaseSync, shiftId: string) =>
  rows(db, "SELECT code_hash FROM floor_codes WHERE shift_id = ?", shiftId);

/** A shift with one scanned code in an open box; returns the box id and the raw code. */
async function oneBox(local: LocalExecutor) {
  const first = await enteredShift(local, ENTERED);
  const raw = km("5Yq'Ct;");
  const accepted = await processScan(scanContext(local, first), raw);
  if (accepted.kind !== "accepted") throw new Error(accepted.kind);
  return { first, raw, boxId: accepted.boxId };
}

describe("code releases on the station (plan ДЗГ)", () => {
  it("a code freed by a document is accepted in a new shift on the same station", async () => {
    const { db, executor } = openLocalDb();
    const { raw, boxId } = await oneBox(executor);
    closeBox(db, boxId, 1500);
    closeShiftCopy(db, SHIFT_ID);

    const second = await enteredShift(executor, SECOND);
    // Before the release the station holds the code: a local duplicate.
    await expect(
      processScan(scanContext(executor, second, { newId: laterIds() }), raw),
    ).resolves.toMatchObject({
      kind: "duplicate",
      source: "local",
    });

    await expect(sync(executor, [release(boxId, SHIFT_ID)])).resolves.toMatchObject({
      kind: "synced",
      rev: 44,
      quarantined: 0,
    });
    expect(codeRows(db, SHIFT_ID)).toEqual([]);

    await expect(
      processScan(scanContext(executor, second, { newId: laterIds() }), raw),
    ).resolves.toMatchObject({
      kind: "accepted",
    });
    expect(
      rows(db, "SELECT shift_id FROM floor_codes WHERE code_hash = ?", kmHash(canonicalizeKm(raw))),
    ).toEqual([{ shift_id: SECOND.id }]);
  });

  it("never touches a box that is still open here", async () => {
    const { db, executor } = openLocalDb();
    const { boxId } = await oneBox(executor);
    await sync(executor, [release(boxId, SHIFT_ID)]);
    expect(codeRows(db, SHIFT_ID)).toHaveLength(1);
  });

  it("leaves the codes of a closed box of another shift than the release names", async () => {
    const { db, executor } = openLocalDb();
    const { boxId } = await oneBox(executor);
    closeBox(db, boxId, 1500);
    await sync(executor, [release(boxId, SECOND.id)]);
    expect(codeRows(db, SHIFT_ID)).toHaveLength(1);
  });

  it("deletes nothing for a box this station does not have", async () => {
    const { db, executor } = openLocalDb();
    const { boxId } = await oneBox(executor);
    closeBox(db, boxId, 1500);
    await expect(
      sync(executor, [release("b0000000-0000-4000-8000-000000000099", SHIFT_ID)]),
    ).resolves.toMatchObject({ kind: "synced", quarantined: 0 });
    expect(codeRows(db, SHIFT_ID)).toHaveLength(1);
  });

  it("leaves the codes this station holds under another pairing", async () => {
    const { db, executor } = openLocalDb();
    const { boxId } = await oneBox(executor);
    closeBox(db, boxId, 1500);
    db.prepare(
      "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, scanned_at) " +
        "SELECT ?, device_id, code_hash, shift_id, box_id, scan_id, scanned_at FROM floor_codes",
    ).run(OTHER_HOST);
    await sync(executor, [release(boxId, SHIFT_ID)]);
    expect(rows(db, "SELECT host_id FROM floor_codes")).toEqual([{ host_id: OTHER_HOST }]);
  });

  it("applies the same page again, and the whole feed from zero, without harm", async () => {
    const { db, executor } = openLocalDb();
    const { raw, boxId } = await oneBox(executor);
    closeBox(db, boxId, 1500);
    await sync(executor, [release(boxId, SHIFT_ID)]);
    expect(codeRows(db, SHIFT_ID)).toEqual([]);
    // The same revision again.
    await expect(sync(executor, [release(boxId, SHIFT_ID)], 44, 44)).resolves.toMatchObject({
      kind: "synced",
    });
    // A code the station has accepted since, in a new shift: the whole feed
    // from zero (a restore) does not take it away, the box is another one.
    const second = await enteredShift(executor, SECOND);
    await expect(
      processScan(scanContext(executor, second, { newId: laterIds() }), raw),
    ).resolves.toMatchObject({
      kind: "accepted",
    });
    await executor.transaction([{ sql: FROM_ZERO_SQL, values: ["5d2c8e1a"] }]);
    await expect(sync(executor, [release(boxId, SHIFT_ID)])).resolves.toMatchObject({
      kind: "synced",
    });
    expect(codeRows(db, SECOND.id)).toHaveLength(1);
  });

  it("quarantines a release with bad data, and lifts it when a good one comes", async () => {
    const { db, executor } = openLocalDb();
    const { boxId } = await oneBox(executor);
    closeBox(db, boxId, 1500);
    const other = "b0000000-0000-4000-8000-0000000000aa";
    const bad = [
      release(boxId, SHIFT_ID, 44, { codeCount: -1 }),
      release(other, SHIFT_ID, 44, { shiftId: "x" }),
      release("not-a-uuid", SHIFT_ID),
    ];
    await expect(sync(executor, bad, 0, 44)).resolves.toMatchObject({
      kind: "synced",
      quarantined: 3,
    });
    expect(codeRows(db, SHIFT_ID)).toHaveLength(1);
    expect(rows(db, "SELECT id FROM sync_quarantine ORDER BY id").map((row) => row["id"])).toEqual(
      [other, boxId, "not-a-uuid"].sort(),
    );
    // The corrected release of the same box, newer.
    await expect(sync(executor, [release(boxId, SHIFT_ID, 45)], 44, 45)).resolves.toMatchObject({
      kind: "synced",
      // The two other releases stay in quarantine.
      quarantined: 2,
    });
    expect(codeRows(db, SHIFT_ID)).toEqual([]);
    expect(rows(db, "SELECT id FROM sync_quarantine WHERE id = ?", boxId)).toEqual([]);
    expect(rows(db, "SELECT id FROM sync_quarantine").map((row) => row["id"])).toHaveLength(2);
  });

  it("frees the codes of a closed box although its shift is still active in the station's copy", async () => {
    const { db, executor } = openLocalDb();
    const { boxId } = await oneBox(executor);
    closeBox(db, boxId, 1500);
    expect(rows(db, "SELECT status FROM floor_shifts WHERE id = ?", SHIFT_ID)).toEqual([
      { status: "active" },
    ]);
    await sync(executor, [release(boxId, SHIFT_ID)]);
    expect(codeRows(db, SHIFT_ID)).toEqual([]);
  });
});
