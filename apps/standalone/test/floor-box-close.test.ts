import { readFileSync } from "node:fs";

import { boxMembershipDigestV1, buildSscc } from "@markiro/domain";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { boxClosedRecord } from "../src/floor/facts.js";
import {
  boxIsFull,
  closeIfFull,
  closeOpenBox,
  readClosedBox,
  type ClosingBox,
  type CloseStep,
} from "../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../src/local/executor.js";
import {
  enteredShift,
  holdingWrites,
  km,
  OPERATOR_ID,
  PAIRING,
  PREFIX,
  rows,
  scanContext,
  SECOND,
  seedBlock,
  SHIFT_ID,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const BLOCK_A = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const BLOCK_B = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b";
const BLOCK_USED = "7f6e5d4c-3b2a-4f1e-8d9c-8b7a6f5e4d3c";
const OTHER_HOST = "6e5d4c3b-2a19-4f8e-9d7c-0b1a2c3d4e5f";
const OTHER_DEVICE = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const OTHER_BOX = "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f";
const OTHER_BOX_2 = "4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a";
const DIGEST_BOX = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

// Bind the module URL before use: the jsdom environment rewrites a literal
// `new URL(..., import.meta.url)` (see test/protocol.test.ts).
const testModuleUrl = import.meta.url;

async function station() {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor);
  return { db, local: executor, shift };
}

/** Accepts `serials` into the shift's open box. */
async function fill(context: ScanContext, serials: readonly string[]): Promise<void> {
  for (const serial of serials) await processScan(context, km(serial));
}

function codeHashes(db: ReturnType<typeof openLocalDb>["db"]): string[] {
  return rows(db, "SELECT code_hash FROM floor_codes ORDER BY code_hash").map((row) =>
    String(row["code_hash"]),
  );
}

describe("the close of a box", () => {
  it("takes the next serial of the earliest block with room, with its record in the same write", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_USED, from: 1, to: 10, next: 11 });
    seedBlock(db, { blockId: BLOCK_B, from: 3500, to: 5499 });
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2", "A3"]);
    const sscc = buildSscc(0, PREFIX, 1500);
    const result = await closeOpenBox(context);
    expect(result).toMatchObject({
      kind: "closed",
      box: {
        sscc,
        blockId: BLOCK_A,
        serial: 1500,
        itemCount: 3,
        openedAt: "2026-10-08T06:15:00.000Z",
        closedAt: "2026-10-08T06:15:03.000Z",
      },
    });
    const box = rows(
      db,
      "SELECT id, closed_at, sscc, block_id, serial, closed_by, item_count FROM floor_boxes",
    );
    expect(box).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000002",
        closed_at: "2026-10-08T06:15:03.000Z",
        sscc,
        block_id: BLOCK_A,
        serial: 1500,
        closed_by: OPERATOR_ID,
        item_count: 3,
      },
    ]);
    expect(
      rows(db, "SELECT block_id, next_serial FROM floor_sscc_blocks ORDER BY from_serial"),
    ).toEqual([
      { block_id: BLOCK_USED, next_serial: 11 },
      { block_id: BLOCK_A, next_serial: 1501 },
      { block_id: BLOCK_B, next_serial: 3500 },
    ]);
    const [outbox] = rows(db, "SELECT id, kind, payload FROM outbox WHERE kind = 'box_closed'");
    expect(JSON.parse(String(outbox?.["payload"]))).toEqual(
      boxClosedRecord(
        { id: String(outbox?.["id"]), shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
        {
          boxId: "00000000-0000-4000-8000-000000000002",
          sscc,
          blockId: BLOCK_A,
          serial: 1500,
          openedAt: "2026-10-08T06:15:00.000Z",
          closedAt: "2026-10-08T06:15:03.000Z",
          itemCount: 3,
          membershipDigest: boxMembershipDigestV1(codeHashes(db)),
        },
      ),
    );
  });

  it("spends no serial on a shift without an open box or with an empty one", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "empty" });
    db.prepare(
      "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, item_count) " +
        "VALUES ('9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', ?, ?, ?, '2026-10-08T06:10:00.000Z', 0)",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "empty" });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 0 }]);
  });

  it("has no serials without a block of the snapshot's prefix and box extension, of this pairing, with room", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_USED, from: 1, to: 10, next: 11 });
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499, prefix: "460068201" });
    seedBlock(db, { blockId: BLOCK_B, from: 0, to: 199, extension: 1 });
    seedBlock(db, {
      blockId: "8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d",
      from: 4000,
      to: 5999,
      deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f",
    });
    const context = scanContext(local, shift);
    await fill(context, ["B1"]);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "no_serials" });
    expect(rows(db, "SELECT closed_at, item_count FROM floor_boxes")).toEqual([
      { closed_at: null, item_count: 1 },
    ]);
    // The last serial of a block is still a serial.
    seedBlock(db, { blockId: "9c8d7e6f-5a4b-4c3d-9e2f-1a0b9c8d7e6f", from: 20, to: 20 });
    await expect(closeOpenBox(context)).resolves.toMatchObject({
      kind: "closed",
      box: { serial: 20 },
    });
  });

  it("loses a serial past the prefix's range, keeps the box open, and takes the next one after", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 9_999_999, to: 10_000_001, next: 10_000_000 });
    const context = scanContext(local, shift);
    await fill(context, ["C1"]);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "invalid_serial" });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([
      { next_serial: 10_000_001 },
    ]);
    expect(rows(db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 0 },
    ]);
  });

  it("never gives one SSCC to two boxes: a close racing another for its serial writes nothing", async () => {
    const { db, local, shift } = await station();
    const second = await enteredShift(local, SECOND);
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const held = holdingWrites(local);
    const first = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    const other = scanContext(held.executor, second, { newId: () => crypto.randomUUID() });
    await fill(first, ["D1"]);
    await fill(other, ["D2"]);
    held.holdNext();
    const racing = closeOpenBox(first);
    await held.reached();
    await expect(closeOpenBox(other)).resolves.toMatchObject({
      kind: "closed",
      box: { serial: 1500 },
    });
    held.release();
    await expect(racing).resolves.toEqual({ kind: "stale" });
    expect(
      rows(db, "SELECT shift_id, closed_at FROM floor_boxes WHERE shift_id = ?", SHIFT_ID),
    ).toEqual([{ shift_id: SHIFT_ID, closed_at: null }]);
    await expect(closeOpenBox(first)).resolves.toMatchObject({
      kind: "closed",
      box: { serial: 1501 },
    });
    expect(rows(db, "SELECT serial FROM floor_boxes ORDER BY serial")).toEqual([
      { serial: 1500 },
      { serial: 1501 },
    ]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1502 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 2 },
    ]);
  });

  it("does not close a box that took another code while the close was on its way", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["E1"]);
    held.holdNext();
    const closing = closeOpenBox(context);
    await held.reached();
    db.prepare("UPDATE floor_boxes SET item_count = item_count + 1").run();
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(rows(db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
  });

  it("commits what a later plan adds with the close, or nothing at all", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["F1"]);
    const failing: CloseStep = async () => ({
      statements: [{ sql: "INSERT INTO floor_boxes (id) VALUES (NULL)" }],
    });
    await expect(closeOpenBox(context, [failing])).rejects.toMatchObject({
      code: "statement_failed",
    });
    expect(rows(db, "SELECT closed_at, needs_fix FROM floor_boxes")).toEqual([
      { closed_at: null, needs_fix: 0 },
    ]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 0 },
    ]);
    const seen: string[] = [];
    const marking: CloseStep = async (box) => {
      seen.push(box.sscc);
      return {
        statements: [
          {
            sql: "UPDATE floor_boxes SET needs_fix = 1 WHERE id = ?",
            values: [box.boxId],
            expectedChanges: 1,
          },
        ],
        data: { itemCount: 99 },
      };
    };
    await expect(closeOpenBox(context, [marking])).resolves.toMatchObject({
      kind: "closed",
      box: { itemCount: 1 },
    });
    expect(seen).toEqual([buildSscc(0, PREFIX, 1500)]);
    expect(rows(db, "SELECT needs_fix FROM floor_boxes")).toEqual([{ needs_fix: 1 }]);
    const [outbox] = rows(db, "SELECT payload FROM outbox WHERE kind = 'box_closed'");
    expect(JSON.parse(String(outbox?.["payload"]))).toMatchObject({ data: { itemCount: 1 } });
  });

  it("refuses a field the record does not know, and writes nothing", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["G1"]);
    const unknown: CloseStep = async () => ({ statements: [], data: { palletId: "x" } });
    await expect(closeOpenBox(context, [unknown])).rejects.toThrow();
    expect(rows(db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
  });
});

describe("a full box", () => {
  async function filled(local: LocalExecutor, count: number) {
    const shift = await enteredShift(local);
    const context = scanContext(local, shift);
    await fill(
      context,
      Array.from({ length: count }, (_, index) => `H${index}`),
    );
    return context;
  }

  it("calls a box full from its capacity on, the one rule the pipeline and the screen share", () => {
    expect(boxIsFull(0, 12)).toBe(false);
    expect(boxIsFull(11, 12)).toBe(false);
    expect(boxIsFull(12, 12)).toBe(true);
    expect(boxIsFull(13, 12)).toBe(true);
    expect(boxIsFull(1, 1)).toBe(true);
  });

  it("closes once it holds the shift's box capacity, and not one code before", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = await filled(executor, 11);
    expect(context.shift.copy.boxCapacity).toBe(12);
    await expect(closeIfFull(context)).resolves.toBeNull();
    await processScan(context, km("H11"));
    await expect(closeIfFull(context)).resolves.toMatchObject({
      kind: "closed",
      box: { itemCount: 12, serial: 1500 },
    });
    await expect(closeIfFull(context)).resolves.toBeNull();
  });

  it("found full when the work screen opens, closes first", async () => {
    const { db, executor } = openLocalDb();
    const context = await filled(executor, 12);
    await expect(closeIfFull(context)).resolves.toEqual({ kind: "no_serials" });
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    await expect(closeIfFull(context)).resolves.toMatchObject({ kind: "closed" });
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 0 },
    ]);
  });
});

interface BoxSeed {
  id: string;
  items: number;
  shift?: string;
  hostId?: string;
  deviceId?: string;
  /** Closed with this SSCC; open when absent. */
  closed?: { sscc: string; blockId: string; serial: number };
}

function insertBox(db: DatabaseSync, box: BoxSeed): void {
  db.prepare(
    "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
      "block_id, serial, item_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    box.id,
    box.hostId ?? PAIRING.hostId,
    box.deviceId ?? PAIRING.deviceId,
    box.shift ?? SHIFT_ID,
    "2026-10-08T06:10:00.000Z",
    box.closed === undefined ? null : "2026-10-08T06:11:00.000Z",
    box.closed?.sscc ?? null,
    box.closed?.blockId ?? null,
    box.closed?.serial ?? null,
    box.items,
  );
}

function insertCode(
  db: DatabaseSync,
  hash: string,
  boxId: string,
  scope: { hostId?: string; deviceId?: string; shift?: string } = {},
): void {
  db.prepare(
    "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, " +
      "scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    scope.hostId ?? PAIRING.hostId,
    scope.deviceId ?? PAIRING.deviceId,
    hash,
    scope.shift ?? SHIFT_ID,
    boxId,
    crypto.randomUUID(),
    "2026-10-08T06:12:00.000Z",
  );
}

/** The box digests the host's own test reads (`proto/fixtures/box-digest.json`). */
function digestCases(): { hashes: string[]; digest: string }[] {
  const text = readFileSync(new URL("../proto/fixtures/box-digest.json", testModuleUrl), "utf8");
  const parsed = z
    .object({ cases: z.array(z.object({ hashes: z.array(z.string()), digest: z.string() })) })
    .parse(JSON.parse(text));
  return parsed.cases;
}

/**
 * An executor whose next write, once armed, fails; with `committed` it fails
 * after the transaction was committed, as a lost answer does.
 */
function failingOnce(local: LocalExecutor, committed: boolean) {
  let armed = false;
  const executor: LocalExecutor = {
    query: (sql, params, row) => local.query(sql, params, row),
    transaction: async (statements: readonly LocalStatement[]) => {
      if (!armed) return local.transaction(statements);
      armed = false;
      if (committed) await local.transaction(statements);
      throw new LocalDbError("statement_failed", "the write did not answer");
    },
  };
  return {
    executor,
    arm: () => {
      armed = true;
    },
  };
}

function boxCloses(db: DatabaseSync): number {
  return Number(rows(db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")[0]?.["n"]);
}

describe("a serial whose SSCC another box already holds", () => {
  it("is lost like a serial past the range: the box stays open and the next close takes the next serial", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    // A box of another device (a forget keeps it) holds the SSCC of serial 1500;
    // one holding the SSCC of 1499 is nothing to this close.
    insertBox(db, {
      id: OTHER_BOX,
      items: 5,
      shift: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      hostId: OTHER_HOST,
      deviceId: OTHER_DEVICE,
      closed: { sscc: buildSscc(0, PREFIX, 1500), blockId: BLOCK_B, serial: 1500 },
    });
    insertBox(db, {
      id: OTHER_BOX_2,
      items: 5,
      shift: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      hostId: OTHER_HOST,
      deviceId: OTHER_DEVICE,
      closed: { sscc: buildSscc(0, PREFIX, 1499), blockId: BLOCK_B, serial: 1499 },
    });
    const context = scanContext(local, shift);
    await fill(context, ["K1"]);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "invalid_serial" });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1501 }]);
    expect(
      rows(db, "SELECT closed_at, sscc FROM floor_boxes WHERE shift_id = ?", SHIFT_ID),
    ).toEqual([{ closed_at: null, sscc: null }]);
    expect(boxCloses(db)).toBe(0);
    await expect(closeOpenBox(context)).resolves.toMatchObject({
      kind: "closed",
      box: { serial: 1501, sscc: buildSscc(0, PREFIX, 1501) },
    });
    expect(boxCloses(db)).toBe(1);
  });
});

describe("a serial past the range", () => {
  it("is spent by the same comparison: a cursor moved meanwhile writes nothing", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 9_999_999, to: 10_000_005, next: 10_000_000 });
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["L1"]);
    held.holdNext();
    const losing = closeOpenBox(context);
    await held.reached();
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = next_serial + 1").run();
    held.release();
    await expect(losing).resolves.toEqual({ kind: "stale" });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([
      { next_serial: 10_000_001 },
    ]);
  });
});

describe("the serials of the blocks", () => {
  it("runs a block through its last serial, then takes the next block, then has none", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 20, to: 21 });
    const context = scanContext(local, shift);
    const taken: number[] = [];
    for (const serial of ["M1", "M2"]) {
      await fill(context, [serial]);
      const result = await closeOpenBox(context);
      if (result.kind !== "closed") throw new Error(`the close ended as ${result.kind}`);
      taken.push(result.box.serial);
    }
    expect(taken).toEqual([20, 21]);
    // The block is used up: its cursor is one past its last serial.
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 22 }]);
    await fill(context, ["M3"]);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "no_serials" });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 22 }]);
    seedBlock(db, { blockId: BLOCK_B, from: 30, to: 40 });
    await expect(closeOpenBox(context)).resolves.toMatchObject({
      kind: "closed",
      box: { serial: 30, blockId: BLOCK_B },
    });
    expect(
      rows(db, "SELECT block_id, next_serial FROM floor_sscc_blocks ORDER BY from_serial"),
    ).toEqual([
      { block_id: BLOCK_A, next_serial: 22 },
      { block_id: BLOCK_B, next_serial: 31 },
    ]);
  });

  it("takes none from a block of another host", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499, hostId: OTHER_HOST });
    const context = scanContext(local, shift);
    await fill(context, ["N1"]);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "no_serials" });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
  });
});

describe("the record of a close", () => {
  it("is kept unsent after the scans it closes, stamped with the closing time, and nothing else is kept", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["O1", "O2"]);
    const result = await closeOpenBox(context);
    if (result.kind !== "closed") throw new Error(`the close ended as ${result.kind}`);
    expect(result.box.closedAt).toBe("2026-10-08T06:15:02.000Z");
    expect(
      rows(
        db,
        "SELECT kind, host_id, device_id, shift_id, created_at, attempts, acked_at, outcome " +
          "FROM outbox ORDER BY seq",
      ),
    ).toEqual([
      expect.objectContaining({ kind: "scan", created_at: "2026-10-08T06:15:00.000Z" }),
      expect.objectContaining({ kind: "scan", created_at: "2026-10-08T06:15:01.000Z" }),
      {
        kind: "box_closed",
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        shift_id: SHIFT_ID,
        created_at: "2026-10-08T06:15:02.000Z",
        attempts: 0,
        acked_at: null,
        outcome: null,
      },
    ]);
    // With no step added, the close writes the box, the block's cursor and the record: no more.
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
  });

  it("digests the codes of this box as the host does, and no other code", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const three = digestCases().find((digestCase) => digestCase.hashes.length === 3);
    if (three === undefined) throw new Error("the fixture has no case of three hashes");
    insertBox(db, { id: DIGEST_BOX, items: 3 });
    for (const hash of three.hashes) insertCode(db, hash, DIGEST_BOX);
    // Codes that are not this box's: a closed box of the same shift, an open box of
    // another shift, and rows of another host and of another device that carry this box's id.
    insertBox(db, {
      id: OTHER_BOX,
      items: 1,
      closed: { sscc: buildSscc(0, PREFIX, 7), blockId: BLOCK_USED, serial: 7 },
    });
    insertCode(db, "c1".repeat(32), OTHER_BOX);
    insertBox(db, { id: OTHER_BOX_2, items: 1, shift: SECOND.id });
    insertCode(db, "c2".repeat(32), OTHER_BOX_2, { shift: SECOND.id });
    insertCode(db, "c3".repeat(32), DIGEST_BOX, { hostId: OTHER_HOST });
    insertCode(db, "c4".repeat(32), DIGEST_BOX, { deviceId: OTHER_DEVICE });
    const result = await closeOpenBox(scanContext(local, shift));
    expect(result).toMatchObject({ kind: "closed", box: { boxId: DIGEST_BOX, itemCount: 3 } });
    const [record] = rows(db, "SELECT payload FROM outbox WHERE kind = 'box_closed'");
    expect(JSON.parse(String(record?.["payload"]))).toMatchObject({
      data: { membershipDigest: three.digest, itemCount: 3 },
    });
  });
});

describe("a close that is tried again", () => {
  it("wrote nothing when its write failed, and takes the same serial on the retry", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const flaky = failingOnce(local, false);
    const context = scanContext(flaky.executor, shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["P1", "P2"]);
    flaky.arm();
    await expect(closeOpenBox(context)).rejects.toMatchObject({ code: "statement_failed" });
    expect(rows(db, "SELECT closed_at, sscc FROM floor_boxes")).toEqual([
      { closed_at: null, sscc: null },
    ]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
    expect(boxCloses(db)).toBe(0);
    await expect(closeOpenBox(context)).resolves.toMatchObject({
      kind: "closed",
      box: { serial: 1500, sscc: buildSscc(0, PREFIX, 1500), itemCount: 2 },
    });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1501 }]);
    expect(boxCloses(db)).toBe(1);
  });

  it("finds the box closed when the answer of a committed write was lost: no second close, no second serial", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const flaky = failingOnce(local, true);
    const context = scanContext(flaky.executor, shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["Q1"]);
    flaky.arm();
    await expect(closeOpenBox(context)).rejects.toMatchObject({ code: "statement_failed" });
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "empty" });
    await expect(closeIfFull(context)).resolves.toBeNull();
    expect(rows(db, "SELECT serial, sscc FROM floor_boxes")).toEqual([
      { serial: 1500, sscc: buildSscc(0, PREFIX, 1500) },
    ]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1501 }]);
    expect(boxCloses(db)).toBe(1);
  });

  it("closes a box once: the second close of it finds nothing to close", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["R1"]);
    await expect(closeOpenBox(context)).resolves.toMatchObject({ kind: "closed" });
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "empty" });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1501 }]);
    expect(boxCloses(db)).toBe(1);
  });

  it("writes nothing when its record cannot be kept: the serial is not spent either", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["S1"]);
    const [kept] = rows(db, "SELECT id FROM outbox LIMIT 1");
    const colliding: ScanContext = { ...context, newId: () => String(kept?.["id"]) };
    await expect(closeOpenBox(colliding)).rejects.toMatchObject({ code: "statement_failed" });
    expect(rows(db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
    expect(boxCloses(db)).toBe(0);
  });

  it("refuses a field the record does not know without spending the serial", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["T1"]);
    const unknown: CloseStep = async () => ({ statements: [], data: { palletId: "x" } });
    await expect(closeOpenBox(context, [unknown])).rejects.toThrow();
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
    expect(boxCloses(db)).toBe(0);
    await expect(closeOpenBox(context)).resolves.toMatchObject({ kind: "closed" });
  });

  it("does not close a box that was closed while the close was on its way", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["U1"]);
    held.holdNext();
    const closing = closeOpenBox(context);
    await held.reached();
    // Closed by another path, under another block's serial: the cursor this close compares is unmoved.
    db.prepare(
      "UPDATE floor_boxes SET closed_at = '2026-10-08T06:30:00.000Z', sscc = ?, block_id = ?, " +
        "serial = 3, closed_by = ?",
    ).run(buildSscc(0, PREFIX, 3), BLOCK_USED, OPERATOR_ID);
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(rows(db, "SELECT sscc, block_id, serial FROM floor_boxes")).toEqual([
      { sscc: buildSscc(0, PREFIX, 3), block_id: BLOCK_USED, serial: 3 },
    ]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
    expect(boxCloses(db)).toBe(0);
  });
});

describe("the steps a later plan adds to a close", () => {
  it("get the box as it will be written, in order, before anything is written", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["V1", "V2"]);
    const seen: { step: string; box: ClosingBox; closedAt: string | null }[] = [];
    const step = (name: string): CloseStep => {
      return async (box) => {
        const [row] = await local.query(
          "SELECT closed_at FROM floor_boxes",
          [],
          z.object({ closed_at: z.string().nullable() }),
        );
        seen.push({ step: name, box, closedAt: row?.closed_at ?? null });
        return { statements: [] };
      };
    };
    await closeOpenBox(context, [step("first"), step("second")]);
    expect(seen.map((entry) => entry.step)).toEqual(["first", "second"]);
    expect(seen.map((entry) => entry.closedAt)).toEqual([null, null]);
    const hashes = codeHashes(db);
    expect(seen[0]?.box).toEqual({
      boxId: "00000000-0000-4000-8000-000000000002",
      shiftId: SHIFT_ID,
      sscc: buildSscc(0, PREFIX, 1500),
      blockId: BLOCK_A,
      serial: 1500,
      openedAt: "2026-10-08T06:15:00.000Z",
      closedAt: "2026-10-08T06:15:02.000Z",
      itemCount: 2,
      codeHashes: hashes,
      operatorId: OPERATOR_ID,
    });
    expect(seen[1]?.box).toEqual(seen[0]?.box);
  });

  it("stop the close when one throws, with nothing written", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["W1"]);
    const throwing: CloseStep = async () => {
      throw new Error("no label for this box");
    };
    await expect(closeOpenBox(context, [throwing])).rejects.toThrow("no label for this box");
    expect(rows(db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
    expect(boxCloses(db)).toBe(0);
  });

  it("commit their statements in the order of the steps, after the close's own", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["X1"]);
    // The second step's statement needs the first one's row, and both need the closed box.
    const first: CloseStep = async (box) => ({
      statements: [
        {
          sql: "UPDATE floor_boxes SET needs_fix = 1 WHERE id = ? AND closed_at IS NOT NULL",
          values: [box.boxId],
          expectedChanges: 1,
        },
      ],
    });
    const second: CloseStep = async (box) => ({
      statements: [
        {
          sql: "UPDATE floor_boxes SET item_count = item_count + 10 WHERE id = ? AND needs_fix = 1",
          values: [box.boxId],
          expectedChanges: 1,
        },
      ],
    });
    await expect(closeOpenBox(context, [first, second])).resolves.toMatchObject({
      kind: "closed",
    });
    expect(rows(db, "SELECT needs_fix, item_count FROM floor_boxes")).toEqual([
      { needs_fix: 1, item_count: 11 },
    ]);
  });
});

describe("a full box, beyond the capacity", () => {
  it("is none to close when the shift has no open box", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    await expect(closeIfFull(scanContext(local, shift))).resolves.toBeNull();
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
  });

  it("closes a box that holds more than the capacity as well", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(
      context,
      Array.from({ length: 12 }, (_, index) => `Y${index}`),
    );
    db.prepare("UPDATE floor_boxes SET item_count = 13").run();
    await expect(closeIfFull(context)).resolves.toMatchObject({
      kind: "closed",
      box: { itemCount: 13 },
    });
  });
});

describe("the statements a close repeats", () => {
  // node:sqlite's planner (3.53); the shell's own (3.46) is pinned in
  // `tests/local_db.rs` (`the_floors_repeating_reads_search_an_index`), whose
  // list carries the same statements.
  it("search an index of the floor's tables, never scan one", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const reads = new Map<string, readonly unknown[]>();
    const writes = new Map<string, readonly unknown[]>();
    const recorder: LocalExecutor = {
      query: (sql, params, row) => {
        reads.set(sql, params);
        return local.query(sql, params, row);
      },
      transaction: (statements) => {
        for (const statement of statements) writes.set(statement.sql, statement.values ?? []);
        return local.transaction(statements);
      },
    };
    await fill(scanContext(local, shift, { newId: () => crypto.randomUUID() }), ["Z1", "Z2"]);
    await closeOpenBox(scanContext(recorder, shift, { newId: () => crypto.randomUUID() }));
    const plan = (sql: string, values: readonly unknown[]): string[] =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...values.map((value) => (typeof value === "number" ? value : String(value))))
        .map((step) => String(step["detail"]));
    const statements = [...reads, ...writes].filter(([sql]) => /^(SELECT|UPDATE)/.test(sql));
    const expected: [string, string][] = [
      [
        "SELECT id, opened_at, item_count FROM floor_boxes",
        "INDEX floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
      ],
      [
        "SELECT code_hash FROM floor_codes",
        "INDEX floor_codes_box (host_id=? AND device_id=? AND box_id=?)",
      ],
      [
        "SELECT block_id, next_serial FROM floor_sscc_blocks",
        "INDEX floor_sscc_blocks_prefix (host_id=? AND device_id=? AND issuer_prefix=? AND extension=?)",
      ],
      ["SELECT 1 AS n FROM floor_boxes WHERE sscc", "INDEX floor_boxes_sscc (sscc=?)"],
      [
        "UPDATE floor_sscc_blocks SET next_serial",
        "INDEX sqlite_autoindex_floor_sscc_blocks_1 (block_id=?)",
      ],
      ["UPDATE floor_boxes SET closed_at", "INDEX sqlite_autoindex_floor_boxes_1 (id=?)"],
    ];
    expect(statements.length).toBe(expected.length);
    for (const [prefix, index] of expected) {
      const found = statements.filter(([sql]) => sql.startsWith(prefix));
      expect(found, prefix).toHaveLength(1);
      const [sql, values] = found[0] ?? ["", []];
      const steps = plan(sql, values);
      expect(steps.join("\n"), sql).toContain(index);
      expect(
        steps.filter((step) => step.startsWith("SCAN ")),
        sql,
      ).toEqual([]);
    }
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NOT NULL")).toEqual([
      { n: 1 },
    ]);
  });
});

describe("the read of a box that is closed", () => {
  it("gives the box exactly as its close wrote it, whoever asks later", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["R1", "R2", "R3"]);
    const result = await closeOpenBox(context);
    if (result.kind !== "closed") throw new Error(`the close went ${result.kind}`);
    await expect(readClosedBox(local, PAIRING, result.box.boxId, OPERATOR_ID)).resolves.toEqual(
      result.box,
    );
  });

  it("is nothing for a box still open, an unknown one and a box of another pairing", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["S1"]);
    const open = rows(db, "SELECT id FROM floor_boxes WHERE closed_at IS NULL")[0]?.["id"];
    await expect(readClosedBox(local, PAIRING, String(open), OPERATOR_ID)).resolves.toBeNull();
    await expect(readClosedBox(local, PAIRING, OTHER_BOX, OPERATOR_ID)).resolves.toBeNull();
    const result = await closeOpenBox(context);
    if (result.kind !== "closed") throw new Error(`the close went ${result.kind}`);
    // The same box id under another host or device is no box of this pairing.
    for (const other of [
      { hostId: OTHER_HOST, deviceId: PAIRING.deviceId },
      { hostId: PAIRING.hostId, deviceId: OTHER_DEVICE },
    ]) {
      await expect(readClosedBox(local, other, result.box.boxId, OPERATOR_ID)).resolves.toBeNull();
    }
    await expect(
      readClosedBox(local, PAIRING, result.box.boxId, OPERATOR_ID),
    ).resolves.not.toBeNull();
  });

  it("names the operator who closed it, and the asking one only when the box does not", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["T1"]);
    const result = await closeOpenBox(context);
    if (result.kind !== "closed") throw new Error(`the close went ${result.kind}`);
    const asked = "5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8a9b";
    await expect(readClosedBox(local, PAIRING, result.box.boxId, asked)).resolves.toMatchObject({
      operatorId: OPERATOR_ID,
    });
    db.prepare("UPDATE floor_boxes SET closed_by = NULL WHERE id = ?").run(result.box.boxId);
    await expect(readClosedBox(local, PAIRING, result.box.boxId, asked)).resolves.toMatchObject({
      operatorId: asked,
    });
  });
});
