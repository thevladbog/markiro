import { canonicalizeKm, kmHash } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { readShiftStock } from "../src/floor/outbox-status.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import { readValidationCounts } from "../src/floor/work/work-reads.js";
import { factRecordSchema, type CodeCheck } from "../src/host/protocol.js";
import {
  countingIds,
  enteredShift,
  GTIN,
  km,
  OPERATOR_ID,
  OTHER_GTIN,
  PAIRING,
  rows,
  scanContext,
  seedBlock,
  SHIFT_ID,
  steppingClock,
  VALIDATION_ENTERED,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

/*
 * The scan path of a validation shift (plan РЕЖ, A7, Р8): the same reading, product check and
 * duplicate checks as aggregation, and an accepted code is taken without a box — its place in
 * `floor_codes` and its journal row name none, and so does its `scan` record (`boxId: null`).
 */

const VALIDATION_ID = VALIDATION_ENTERED.id;
const TAKEN: CodeCheck = {
  status: "taken",
  owner: {
    shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    shiftNumber: "OCT26-003",
    deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    scannedAt: "2026-10-08T05:58:41.090Z",
    sameDevice: false,
  },
};

async function station() {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor, VALIDATION_ENTERED);
  return { db, local: executor, shift };
}

function payloads(db: ReturnType<typeof openLocalDb>["db"]): unknown[] {
  return rows(db, "SELECT payload FROM outbox ORDER BY seq").map((row) =>
    JSON.parse(String(row["payload"])),
  );
}

describe("a scan of a validation shift", () => {
  it("is worked from a validation shift's copy", async () => {
    const { shift } = await station();
    expect(shift.copy.mode).toBe("validation");
    expect(shift.copy.palletsEnabled).toBe(false);
  });

  it("takes a code without a box: its place, its journal row and its record name none", async () => {
    const { db, local, shift } = await station();
    const raw = km("5Yq'Ct;");
    const scanId = "00000000-0000-4000-8000-000000000001";
    await expect(processScan(scanContext(local, shift), raw)).resolves.toEqual({
      kind: "accepted",
      boxId: null,
      acceptedCount: 1,
    });
    const codeHash = kmHash(canonicalizeKm(raw));
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes")).toEqual([{ n: 0 }]);
    expect(
      rows(db, "SELECT code_hash, shift_id, box_id, scan_id, scanned_at FROM floor_codes"),
    ).toEqual([
      {
        code_hash: codeHash,
        shift_id: VALIDATION_ID,
        box_id: null,
        scan_id: scanId,
        scanned_at: "2026-10-08T06:15:00.000Z",
      },
    ]);
    expect(
      rows(
        db,
        "SELECT id, shift_id, box_id, verdict, duplicate_source, raw_kind, code_hash, operator_id " +
          "FROM floor_scans",
      ),
    ).toEqual([
      {
        id: scanId,
        shift_id: VALIDATION_ID,
        box_id: null,
        verdict: "ok",
        duplicate_source: null,
        raw_kind: "km",
        code_hash: codeHash,
        operator_id: OPERATOR_ID,
      },
    ]);
    const [record] = payloads(db);
    // The record is one the host takes: checked against the wire's schema as it is sent.
    expect(factRecordSchema.parse(record)).toMatchObject({
      id: scanId,
      kind: "scan",
      shiftId: VALIDATION_ID,
      operatorId: OPERATOR_ID,
      data: { verdict: "ok", duplicateSource: null, boxId: null, code: { codeHash, gtin14: GTIN } },
    });
  });

  it("counts the shift's accepted codes with every accepted one", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await processScan(context, km("V1"));
    await expect(processScan(context, km("V2"))).resolves.toMatchObject({
      kind: "accepted",
      boxId: null,
      acceptedCount: 2,
    });
    // A refused scan is not counted.
    await processScan(context, km("V1"));
    await expect(processScan(context, km("V3"))).resolves.toMatchObject({ acceptedCount: 3 });
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes WHERE box_id IS NULL")).toEqual([
      { n: 3 },
    ]);
  });

  it("refuses a code it took already as a local duplicate, with the time of its first scan", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await processScan(context, km("D1"));
    await expect(processScan(context, km("D1"))).resolves.toEqual({
      kind: "duplicate",
      source: "local",
      firstScannedAt: "2026-10-08T06:15:00.000Z",
    });
    expect(rows(db, "SELECT verdict, duplicate_source, box_id FROM floor_scans")).toEqual([
      { verdict: "ok", duplicate_source: null, box_id: null },
      { verdict: "duplicate", duplicate_source: "local", box_id: null },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 1 }]);
  });

  it("refuses a code another device's scan owns on the host as a host duplicate", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift, {
      online: () => true,
      checkCode: async () => TAKEN,
    });
    await expect(processScan(context, km("H1"))).resolves.toEqual({
      kind: "duplicate",
      source: "host",
      firstScannedAt: TAKEN.owner.scannedAt,
      shiftNumber: "OCT26-003",
    });
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
    expect(payloads(db)).toMatchObject([
      { data: { verdict: "duplicate", duplicateSource: "host", boxId: null } },
    ]);
  });

  it("refuses a code of another product and a scan that is no code", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await expect(processScan(context, km("W1", { gtin: OTHER_GTIN }))).resolves.toEqual({
      kind: "wrong_gtin",
      gtin14: OTHER_GTIN,
    });
    await expect(processScan(context, "MRK-000742")).resolves.toEqual({
      kind: "invalid",
      rawKind: "unknown",
    });
    expect(rows(db, "SELECT verdict, box_id FROM floor_scans")).toEqual([
      { verdict: "wrong_gtin", box_id: null },
      { verdict: "invalid", box_id: null },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
  });

  it("keeps a code it took in a validation shift from an aggregation shift of the station", async () => {
    const { db, local, shift } = await station();
    // One clock and one source of ids for the station's two shifts.
    const shared = { now: steppingClock(), newId: countingIds() };
    const validation = scanContext(local, shift, shared);
    await processScan(validation, km("X1"));
    const aggregation = scanContext(local, await enteredShift(local), shared);
    await expect(processScan(aggregation, km("X1"))).resolves.toMatchObject({
      kind: "duplicate",
      source: "local",
    });
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes")).toEqual([{ n: 0 }]);
    // And the other way round: an aggregation shift's code is a duplicate in a validation shift.
    await processScan(aggregation, km("X2"));
    await expect(processScan(validation, km("X2"))).resolves.toMatchObject({
      kind: "duplicate",
      source: "local",
    });
    expect(rows(db, "SELECT shift_id, box_id IS NULL AS unboxed FROM floor_codes")).toEqual([
      { shift_id: VALIDATION_ID, unboxed: 1 },
      { shift_id: SHIFT_ID, unboxed: 0 },
    ]);
  });

  it("counts the shift's duplicates and errors, not another shift's", async () => {
    const { local, shift } = await station();
    const shared = { now: steppingClock(), newId: countingIds() };
    const context = scanContext(local, shift, shared);
    await expect(readValidationCounts(local, PAIRING, VALIDATION_ID)).resolves.toEqual({
      duplicates: 0,
      errors: 0,
    });
    await processScan(context, km("C1"));
    await processScan(context, km("C1"));
    await processScan(context, km("C1"));
    await processScan(context, km("C2", { gtin: OTHER_GTIN }));
    await processScan(context, "MRK-000742");
    // Another shift's refusals are its own.
    await processScan(scanContext(local, await enteredShift(local), shared), "MRK-000743");
    await expect(readValidationCounts(local, PAIRING, VALIDATION_ID)).resolves.toEqual({
      duplicates: 2,
      errors: 2,
    });
  });

  it("has no SSCC stock to show: it numbers no box and no pallet", async () => {
    const { db, local } = await station();
    seedBlock(db, { blockId: "00000000-0000-4000-8000-0000000000a1", from: 1, to: 100 });
    await expect(readShiftStock(local, PAIRING, VALIDATION_ID)).resolves.toBeNull();
    // An aggregation shift of the same prefix still has its stock.
    await enteredShift(local);
    await expect(readShiftStock(local, PAIRING, SHIFT_ID)).resolves.toMatchObject({
      boxes: { left: 100 },
    });
  });
});
