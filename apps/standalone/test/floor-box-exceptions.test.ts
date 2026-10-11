import { buildSscc } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import {
  BoxUnavailableError,
  clearOpenBox,
  disassembleBox,
  InvalidReasonError,
  LabelWaitingError,
  readClosedBoxes,
  reasonWords,
  reprintBox,
  TemplateChangedError,
  undoLastCode,
} from "../src/floor/exceptions/box-exceptions.js";
import { checkLabel, skipLabel } from "../src/floor/print/print-resolution.js";
import { readPrintJob, sendLabelJob, StaleJobError } from "../src/floor/print/print-jobs.js";
import { closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import { readWorkTotals } from "../src/floor/work/work-reads.js";
import {
  enteredShift,
  failingWrites,
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
  steppingClock,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import {
  closeBoxWithLabel,
  fakeRender,
  FIRST_SSCC,
  jobRows,
  manualRuntime,
  printStation,
  renderedText,
  resolveContext,
  spyRender,
  ZEBRA,
} from "./support/printing.js";

const BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const OTHER_HOST = "6e5d4c3b-2a19-4f8e-9d7c-0b1a2c3d4e5f";
const OTHER_DEVICE = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const OTHER_BOX = "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f";
const OTHER_BOX_2 = "4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a";

/** Two pairings that differ from this station's in ONE of host and device each. */
const FOREIGN = [
  { hostId: OTHER_HOST, deviceId: PAIRING.deviceId },
  { hostId: PAIRING.hostId, deviceId: OTHER_DEVICE },
] as const;

type Db = ReturnType<typeof openLocalDb>["db"];

async function station() {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor);
  seedBlock(db, { blockId: BLOCK, from: 1500, to: 3499 });
  return { db, local: executor, shift };
}

async function fill(context: ScanContext, serials: readonly string[]): Promise<void> {
  for (const serial of serials) await processScan(context, km(serial));
}

/** A context for the work that lands while another waits: its own ids and a later clock. */
function meanwhile(
  local: ReturnType<typeof openLocalDb>["executor"],
  shift: Awaited<ReturnType<typeof enteredShift>>,
) {
  return scanContext(local, shift, {
    newId: () => crypto.randomUUID(),
    now: steppingClock(Date.parse("2026-10-08T07:00:00.000Z")),
  });
}

/** The outbox's `box_exception` records, oldest first, as they will be sent. */
function exceptionRecords(db: Db): unknown[] {
  return rows(db, "SELECT payload FROM outbox WHERE kind = 'box_exception' ORDER BY seq").map(
    (row) => JSON.parse(String(row["payload"])),
  );
}

function freeCodes(db: Db): string[] {
  return rows(db, "SELECT scan_id FROM floor_codes ORDER BY scanned_at").map((row) =>
    String(row["scan_id"]),
  );
}

/**
 * The invariant every exception keeps in the same transaction: a box that is
 * not taken apart holds as many codes as its counter says (a box taken apart
 * holds none).
 */
function expectCountsAgree(db: Db): void {
  expect(
    rows(
      db,
      "SELECT b.id, b.item_count AS counted, b.disassembled_at, " +
        "(SELECT count(*) FROM floor_codes c WHERE c.box_id = b.id) AS held FROM floor_boxes b",
    ).map((box) => ({
      counted: box["disassembled_at"] === null ? box["counted"] : 0,
      held: box["held"],
    })),
  ).toSatisfy((boxes: { counted: unknown; held: unknown }[]) =>
    boxes.every((box) => box.counted === box.held),
  );
}

/** A closed or open box of another pairing in the SAME shift, with a code of it. */
function seedForeignBox(
  db: Db,
  boxId: string,
  owner: { hostId: string; deviceId: string },
  options: { open: boolean },
): void {
  db.prepare(
    "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
      "block_id, serial, item_count, closed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
  ).run(
    boxId,
    owner.hostId,
    owner.deviceId,
    SHIFT_ID,
    "2026-10-08T05:00:00.000Z",
    options.open ? null : "2026-10-08T05:10:00.000Z",
    options.open ? null : buildSscc(0, PREFIX, owner.hostId === OTHER_HOST ? 77 : 78),
    options.open ? null : BLOCK,
    options.open ? null : 77,
    options.open ? null : OPERATOR_ID,
  );
}

/**
 * A code under `boxId` for each pairing of `FOREIGN`, newer than every code of
 * this station's: what a read or a delete that forgets the host or the device
 * would take as its own.
 */
function seedForeignCodes(db: Db, boxId: string): void {
  FOREIGN.forEach((owner, index) => {
    db.prepare(
      "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, " +
        "scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      owner.hostId,
      owner.deviceId,
      `${index}${boxId.replaceAll("-", "")}`.repeat(2).slice(0, 64),
      SHIFT_ID,
      boxId,
      `00000000-0000-4000-8000-0000000000f${index}`,
      "2026-10-08T05:05:00.000Z",
    );
  });
}

/** The codes left, as `host_id/device_id`, in the order they were written. */
function codeOwners(db: Db): string[] {
  return rows(db, "SELECT host_id, device_id FROM floor_codes ORDER BY rowid").map(
    (row) => `${String(row["host_id"])}/${String(row["device_id"])}`,
  );
}

const FOREIGN_OWNERS = FOREIGN.map((owner) => `${owner.hostId}/${owner.deviceId}`);

describe("the words of a reason", () => {
  it("are trimmed, at most 200 code points, and never hold a control character", () => {
    expect(reasonWords(null)).toBeNull();
    expect(reasonWords("   ")).toBeNull();
    expect(reasonWords("  Смята  ")).toBe("Смята");
    expect(reasonWords("Я".repeat(200))).toBe("Я".repeat(200));
    expect(reasonWords(` ${"Я".repeat(200)} `)).toBe("Я".repeat(200));
    expect(() => reasonWords("Я".repeat(201))).toThrow(InvalidReasonError);
    expect(() => reasonWords("в две\nстроки")).toThrow(InvalidReasonError);
    expect(() => reasonWords("a\u0000b")).toThrow(InvalidReasonError);
    expect(() => reasonWords("a\u0085b")).toThrow(InvalidReasonError);
    // Code points, not UTF-16 units: the host counts characters.
    expect(reasonWords("😀".repeat(200))).toBe("😀".repeat(200));
    expect(() => reasonWords("😀".repeat(201))).toThrow(InvalidReasonError);
  });
});

describe("«Снять последний код»", () => {
  it("takes out the code accepted last with the instant of its scan, in one write with its record", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2", "A3"]);
    const [scanOfA3] = rows(
      db,
      "SELECT id, scanned_at, code_hash FROM floor_scans WHERE serial = 'A3'",
    );
    const result = await undoLastCode(context);
    const box = rows(db, "SELECT id, item_count, closed_at FROM floor_boxes");
    expect(result).toEqual({ kind: "done", boxId: box[0]?.["id"], itemCount: 2 });
    expect(box).toEqual([{ id: box[0]?.["id"], item_count: 2, closed_at: null }]);
    expect(
      rows(
        db,
        "SELECT serial FROM floor_scans s JOIN floor_codes c ON c.scan_id = s.id ORDER BY serial",
      ),
    ).toEqual([{ serial: "A1" }, { serial: "A2" }]);
    expect(exceptionRecords(db)).toEqual([
      {
        id: expect.any(String),
        kind: "box_exception",
        shiftId: SHIFT_ID,
        operatorId: OPERATOR_ID,
        data: {
          exception: "undo",
          boxId: box[0]?.["id"],
          codeHash: scanOfA3?.["code_hash"],
          targetScannedAt: scanOfA3?.["scanned_at"],
          reasonCode: null,
          reasonText: null,
          occurredAt: "2026-10-08T06:15:03.000Z",
        },
      },
    ]);
    expect(
      rows(
        db,
        "SELECT host_id, device_id, shift_id, kind, box_id, code_hash, target_scanned_at, " +
          "reason_code, reason_text, occurred_at, operator_id FROM floor_exceptions",
      ),
    ).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        shift_id: SHIFT_ID,
        kind: "undo",
        box_id: box[0]?.["id"],
        code_hash: scanOfA3?.["code_hash"],
        target_scanned_at: scanOfA3?.["scanned_at"],
        reason_code: null,
        reason_text: null,
        occurred_at: "2026-10-08T06:15:03.000Z",
        operator_id: OPERATOR_ID,
      },
    ]);
    // The record in the outbox is stamped with the exception's instant, unsent.
    expect(
      rows(db, "SELECT created_at, acked_at FROM outbox WHERE kind = 'box_exception'"),
    ).toEqual([{ created_at: "2026-10-08T06:15:03.000Z", acked_at: null }]);
    expectCountsAgree(db);
  });

  it("takes out the code accepted last even when the clock went back between the scans", async () => {
    const { db, local, shift } = await station();
    const times = ["2026-10-08T06:20:00.000Z", "2026-10-08T06:10:00.000Z"];
    const context = scanContext(local, shift, {
      now: () => new Date(times.shift() ?? "2026-10-08T06:30:00.000Z"),
    });
    await fill(context, ["A1", "A2"]);
    await undoLastCode(context);
    expect(
      rows(db, "SELECT serial FROM floor_scans s JOIN floor_codes c ON c.scan_id = s.id"),
    ).toEqual([{ serial: "A1" }]);
    expect(rows(db, "SELECT target_scanned_at FROM floor_exceptions")).toEqual([
      { target_scanned_at: "2026-10-08T06:10:00.000Z" },
    ]);
  });

  it("frees the code: scanned again, it is accepted, not a duplicate", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2"]);
    await undoLastCode(context);
    expect(await processScan(context, km("A2"))).toMatchObject({ kind: "accepted", itemCount: 2 });
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
    expectCountsAgree(db);
  });

  it("writes nothing for an empty box or none", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    expect(await undoLastCode(context)).toEqual({ kind: "empty" });
    await fill(context, ["A1"]);
    await undoLastCode(context);
    expect(await undoLastCode(context)).toEqual({ kind: "empty" });
    expect(exceptionRecords(db)).toHaveLength(1);
  });

  it("writes nothing when a scan lands between its read and its write", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    await fill(scanContext(local, shift), ["A1", "A2"]);
    held.holdNext();
    const undo = undoLastCode(
      scanContext(held.executor, shift, { newId: () => crypto.randomUUID() }),
    );
    await held.reached();
    await processScan(meanwhile(local, shift), km("A3"));
    held.release();
    expect(await undo).toEqual({ kind: "stale" });
    expect(exceptionRecords(db)).toEqual([]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 3 }]);
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 3 }]);
  });

  it("writes nothing when the box closes between its read and its write", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    await fill(scanContext(local, shift), ["A1", "A2"]);
    held.holdNext();
    const undo = undoLastCode(
      scanContext(held.executor, shift, { newId: () => crypto.randomUUID() }),
    );
    await held.reached();
    // The count the undo read is still the box's count: only the close differs.
    expect(await closeOpenBox(meanwhile(local, shift))).toMatchObject({ kind: "closed" });
    held.release();
    expect(await undo).toEqual({ kind: "stale" });
    expect(exceptionRecords(db)).toEqual([]);
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
    expectCountsAgree(db);
  });

  it("writes nothing when the code it read is gone and the count came back to the same", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    await fill(scanContext(local, shift), ["A1", "A2"]);
    held.holdNext();
    const undo = undoLastCode(
      scanContext(held.executor, shift, { newId: () => crypto.randomUUID() }),
    );
    await held.reached();
    // A clear and two scans leave the box with two codes again — A2 among them,
    // but from another scan, and not the last.
    const other = meanwhile(local, shift);
    await clearOpenBox(other);
    await fill(other, ["A2", "A9"]);
    held.release();
    expect(await undo).toEqual({ kind: "stale" });
    expect(rows(db, "SELECT count(*) AS n FROM floor_exceptions WHERE kind = 'undo'")).toEqual([
      { n: 0 },
    ]);
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
    expectCountsAgree(db);
  });

  it("rejects, rather than call it stale, when the write itself fails", async () => {
    const { db, local, shift } = await station();
    await fill(scanContext(local, shift), ["A1"]);
    await expect(undoLastCode(scanContext(failingWrites(local), shift))).rejects.toThrow(
      "disk is full",
    );
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 1 }]);
  });

  it("takes the last code of this pairing, not a newer row of another's under the same box id", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2"]);
    const [box] = rows(db, "SELECT id FROM floor_boxes");
    seedForeignCodes(db, String(box?.["id"]));
    await undoLastCode(context);
    expect(codeOwners(db)).toEqual([`${PAIRING.hostId}/${PAIRING.deviceId}`, ...FOREIGN_OWNERS]);
    expect(
      rows(
        db,
        "SELECT e.code_hash = s.code_hash AS same FROM floor_exceptions e, floor_scans s WHERE s.serial = 'A2'",
      ),
    ).toEqual([{ same: 1 }]);
    expect(
      rows(db, "SELECT serial FROM floor_scans s JOIN floor_codes c ON c.scan_id = s.id"),
    ).toEqual([{ serial: "A1" }]);
  });
});

describe("«Очистить короб»", () => {
  it("takes every code out of the open box, which stays open for the next one", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2", "A3"]);
    const result = await clearOpenBox(context);
    const [box] = rows(db, "SELECT id, item_count, closed_at FROM floor_boxes");
    expect(result).toEqual({ kind: "done", boxId: box?.["id"], itemCount: 0 });
    expect(box).toMatchObject({ item_count: 0, closed_at: null });
    expect(freeCodes(db)).toEqual([]);
    expect(exceptionRecords(db)).toEqual([
      expect.objectContaining({
        data: {
          exception: "clear",
          boxId: box?.["id"],
          codeHash: null,
          targetScannedAt: null,
          reasonCode: null,
          reasonText: null,
          occurredAt: "2026-10-08T06:15:03.000Z",
        },
      }),
    ]);
    expectCountsAgree(db);
    expect(await processScan(context, km("A1"))).toEqual({
      kind: "accepted",
      boxId: box?.["id"],
      itemCount: 1,
    });
  });

  it("is stamped no earlier than the newest code it takes out, whatever the clock did", async () => {
    const { db, local, shift } = await station();
    const times = [
      "2026-10-08T06:20:00.000Z",
      "2026-10-08T06:21:00.000Z",
      // The computer's time was corrected back before the clear.
      "2026-10-08T06:10:00.000Z",
    ];
    const context = scanContext(local, shift, {
      now: () => new Date(times.shift() ?? "2026-10-08T06:30:00.000Z"),
    });
    await fill(context, ["A1", "A2"]);
    await clearOpenBox(context);
    expect(exceptionRecords(db)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ occurredAt: "2026-10-08T06:21:00.000Z" }),
      }),
    ]);
    expect(rows(db, "SELECT occurred_at FROM floor_exceptions")).toEqual([
      { occurred_at: "2026-10-08T06:21:00.000Z" },
    ]);
  });

  it("writes nothing for an empty box or none", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    expect(await clearOpenBox(context)).toEqual({ kind: "empty" });
    await fill(context, ["A1"]);
    await clearOpenBox(context);
    expect(await clearOpenBox(context)).toEqual({ kind: "empty" });
    expect(exceptionRecords(db)).toHaveLength(1);
  });

  it("writes nothing when a scan lands between its read and its write", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    await fill(scanContext(local, shift), ["A1", "A2"]);
    held.holdNext();
    const clear = clearOpenBox(
      scanContext(held.executor, shift, { newId: () => crypto.randomUUID() }),
    );
    await held.reached();
    await processScan(meanwhile(local, shift), km("A3"));
    held.release();
    expect(await clear).toEqual({ kind: "stale" });
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 3 }]);
    expect(exceptionRecords(db)).toEqual([]);
    expectCountsAgree(db);
  });

  it("writes nothing when the box closes between its read and its write", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    await fill(scanContext(local, shift), ["A1", "A2"]);
    held.holdNext();
    const clear = clearOpenBox(
      scanContext(held.executor, shift, { newId: () => crypto.randomUUID() }),
    );
    await held.reached();
    expect(await closeOpenBox(meanwhile(local, shift))).toMatchObject({ kind: "closed" });
    held.release();
    expect(await clear).toEqual({ kind: "stale" });
    expect(exceptionRecords(db)).toEqual([]);
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
  });

  it("rejects, rather than call it stale, when the write itself fails", async () => {
    const { db, local, shift } = await station();
    await fill(scanContext(local, shift), ["A1"]);
    await expect(clearOpenBox(scanContext(failingWrites(local), shift))).rejects.toThrow(
      "disk is full",
    );
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 1 }]);
  });

  it("takes the codes of this pairing only, though another's lie under the same box id", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const [box] = rows(db, "SELECT id FROM floor_boxes");
    seedForeignCodes(db, String(box?.["id"]));
    await clearOpenBox(context);
    expect(codeOwners(db)).toEqual(FOREIGN_OWNERS);
  });
});

describe("«Расформировать короб»", () => {
  it("takes a closed box apart with its reason: its codes are free, its SSCC stays spent", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    const result = await disassembleBox(context, closed.box.boxId, {
      code: "wrong_quantity",
      text: null,
    });
    expect(result).toEqual({ kind: "done", freed: 2 });
    expect(rows(db, "SELECT sscc, disassembled_at FROM floor_boxes")).toEqual([
      { sscc: buildSscc(0, PREFIX, 1500), disassembled_at: "2026-10-08T06:15:03.000Z" },
    ]);
    expect(freeCodes(db)).toEqual([]);
    expect(exceptionRecords(db)).toEqual([
      expect.objectContaining({
        data: {
          exception: "disassemble",
          boxId: closed.box.boxId,
          codeHash: null,
          targetScannedAt: null,
          reasonCode: "wrong_quantity",
          reasonText: null,
          occurredAt: "2026-10-08T06:15:03.000Z",
        },
      }),
    ]);
    expectCountsAgree(db);
    const totals = await readWorkTotals(local, PAIRING, SHIFT_ID);
    expect([totals.accepted, totals.closedBoxes]).toEqual([0, 0]);
    expect(await readClosedBoxes(local, PAIRING, SHIFT_ID)).toEqual([]);
    // The freed codes go into a new box, whose close takes the next serial.
    await fill(context, ["A1", "A2"]);
    const next = await closeOpenBox(context);
    expect(next).toMatchObject({ kind: "closed", box: { serial: 1501 } });
  });

  it("keeps the words of `other`, trimmed, and refuses words of any other reason or a code of the other list", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    await expect(
      disassembleBox(context, closed.box.boxId, { code: "wrong_product", text: "сам выбрал" }),
    ).rejects.toThrow(InvalidReasonError);
    await expect(
      disassembleBox(context, closed.box.boxId, {
        // A reprint's reason is no reason of a disassembly.
        code: "printer_jam" as "other",
        text: null,
      }),
    ).rejects.toThrow(InvalidReasonError);
    await expect(
      disassembleBox(context, closed.box.boxId, { code: "other", text: "Я".repeat(201) }),
    ).rejects.toThrow(InvalidReasonError);
    expect(exceptionRecords(db)).toEqual([]);
    await disassembleBox(context, closed.box.boxId, { code: "other", text: "  Смят угол  " });
    expect(exceptionRecords(db)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ reasonCode: "other", reasonText: "Смят угол" }),
      }),
    ]);
    expect(rows(db, "SELECT reason_code, reason_text FROM floor_exceptions")).toEqual([
      { reason_code: "other", reason_text: "Смят угол" },
    ]);
  });

  it("keeps no words for an `other` reason typed as blanks", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    await disassembleBox(context, closed.box.boxId, { code: "other", text: "   " });
    expect(rows(db, "SELECT reason_code, reason_text FROM floor_exceptions")).toEqual([
      { reason_code: "other", reason_text: null },
    ]);
  });

  it("takes a box apart once when two disassemblies of it race", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    const held = holdingWrites(local);
    const reason = { code: "damaged_package" as const, text: null };
    held.holdNext();
    const first = disassembleBox(
      scanContext(held.executor, shift, { newId: () => crypto.randomUUID() }),
      closed.box.boxId,
      reason,
    );
    await held.reached();
    await disassembleBox(
      scanContext(local, shift, { newId: () => crypto.randomUUID() }),
      closed.box.boxId,
      reason,
    );
    held.release();
    expect(await first).toEqual({ kind: "stale" });
    expect(exceptionRecords(db)).toHaveLength(1);
  });

  it("refuses an open box, a box taken apart and another shift's box, writing nothing", async () => {
    const { db, local, shift } = await station();
    const second = await enteredShift(local, SECOND);
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    await fill(context, ["A2"]);
    const [open] = rows(db, "SELECT id FROM floor_boxes WHERE closed_at IS NULL");
    const reason = { code: "wrong_product" as const, text: null };
    await expect(disassembleBox(context, String(open?.["id"]), reason)).rejects.toThrow(
      BoxUnavailableError,
    );
    await expect(
      disassembleBox(scanContext(local, second), closed.box.boxId, reason),
    ).rejects.toThrow(BoxUnavailableError);
    await disassembleBox(context, closed.box.boxId, reason);
    await expect(disassembleBox(context, closed.box.boxId, reason)).rejects.toThrow(
      BoxUnavailableError,
    );
    expect(exceptionRecords(db)).toHaveLength(1);
  });

  it("refuses a box of another pairing, though it is closed in this very shift", async () => {
    const { db, local, shift } = await station();
    const boxes = [OTHER_BOX, OTHER_BOX_2];
    boxes.forEach((boxId, index) => {
      const owner = FOREIGN[index];
      if (owner === undefined) throw new Error("a foreign pairing");
      seedForeignBox(db, boxId, owner, { open: false });
      seedForeignCodes(db, boxId);
    });
    for (const boxId of boxes) {
      await expect(
        disassembleBox(scanContext(local, shift), boxId, { code: "wrong_product", text: null }),
      ).rejects.toThrow(BoxUnavailableError);
    }
    expect(rows(db, "SELECT disassembled_at FROM floor_boxes")).toEqual([
      { disassembled_at: null },
      { disassembled_at: null },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 4 }]);
    expect(exceptionRecords(db)).toEqual([]);
  });

  it("rejects, rather than call it stale, when the write itself fails", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    await expect(
      disassembleBox(scanContext(failingWrites(local), shift), closed.box.boxId, {
        code: "wrong_product",
        text: null,
      }),
    ).rejects.toThrow("disk is full");
    expect(rows(db, "SELECT disassembled_at FROM floor_boxes")).toEqual([
      { disassembled_at: null },
    ]);
  });

  it("frees the codes of this pairing only, though another's lie under the same box id", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    seedForeignCodes(db, closed.box.boxId);
    await disassembleBox(context, closed.box.boxId, { code: "wrong_product", text: null });
    expect(codeOwners(db)).toEqual(FOREIGN_OWNERS);
  });
});

describe("the closed boxes of a shift", () => {
  it("are listed with the box closed last first, without a box taken apart, an open one or another's", async () => {
    const { db, local, shift } = await station();
    const second = await enteredShift(local, SECOND);
    const context = scanContext(local, shift);
    const reason = { code: "wrong_product" as const, text: null };
    const closedBoxes: string[] = [];
    for (const serial of ["B1", "B2", "B3"]) {
      await fill(context, [serial]);
      const closed = await closeOpenBox(context);
      if (closed.kind !== "closed") throw new Error(closed.kind);
      closedBoxes.push(closed.box.boxId);
    }
    await fill(context, ["B4"]);
    await fill(meanwhile(local, second), ["C1"]);
    await closeOpenBox(meanwhile(local, second));
    seedForeignBox(db, OTHER_BOX, FOREIGN[0], { open: false });
    seedForeignBox(db, OTHER_BOX_2, FOREIGN[1], { open: false });
    await disassembleBox(context, String(closedBoxes[1]), reason);
    expect(await readClosedBoxes(local, PAIRING, SHIFT_ID)).toEqual([
      {
        id: closedBoxes[2],
        sscc: buildSscc(0, PREFIX, 1502),
        itemCount: 1,
        closedAt: expect.any(String),
      },
      {
        id: closedBoxes[0],
        sscc: buildSscc(0, PREFIX, 1500),
        itemCount: 1,
        closedAt: expect.any(String),
      },
    ]);
    const [newest, oldest] = await readClosedBoxes(local, PAIRING, SHIFT_ID);
    expect((newest?.closedAt ?? "") > (oldest?.closedAt ?? "")).toBe(true);
    expect(await readClosedBoxes(local, PAIRING, second.copy.id)).toHaveLength(1);
    // Each pairing that differs in the host or in the device sees its own box only.
    expect((await readClosedBoxes(local, FOREIGN[0], SHIFT_ID)).map((box) => box.id)).toEqual([
      OTHER_BOX,
    ]);
    expect((await readClosedBoxes(local, FOREIGN[1], SHIFT_ID)).map((box) => box.id)).toEqual([
      OTHER_BOX_2,
    ]);
  });
});

describe("«Перепечатать этикетку» of a box whose label is done with", () => {
  it("prints the same label again: a new job with the box's SSCC and fields, its reason in the same write", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const first = await sendLabelJob(context, await closeBoxWithLabel(at));
    expect(first.state).toBe("sent");
    const job = await reprintBox(
      { ...context, shift: at.shift },
      first.subjectId,
      { code: "damaged_label", text: null },
      at.settings,
      fakeRender,
    );
    expect(job).toMatchObject({
      purpose: "box",
      subjectId: first.subjectId,
      sscc: FIRST_SSCC,
      state: "sent",
      attempts: 1,
      fields: first.fields,
      templateId: first.templateId,
      templateRev: first.templateRev,
    });
    expect(job.id).not.toBe(first.id);
    expect(shell.sends.map((send) => send.text)).toEqual([
      renderedText(ZEBRA, FIRST_SSCC),
      renderedText(ZEBRA, FIRST_SSCC),
    ]);
    expect(
      rows(
        at.db,
        "SELECT host_id, device_id, shift_id, kind, box_id, reason_code, reason_text, operator_id " +
          "FROM floor_exceptions",
      ),
    ).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        shift_id: SHIFT_ID,
        kind: "reprint",
        box_id: first.subjectId,
        reason_code: "damaged_label",
        reason_text: null,
        operator_id: OPERATOR_ID,
      },
    ]);
    const [record] = rows(at.db, "SELECT payload FROM outbox WHERE kind = 'box_exception'");
    expect(JSON.parse(String(record?.["payload"]))).toMatchObject({
      data: { exception: "reprint", boxId: first.subjectId, reasonCode: "damaged_label" },
    });
  });

  it("keeps the words of `other` in the row and in the record", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const first = await sendLabelJob(context, await closeBoxWithLabel(at));
    await reprintBox(
      { ...context, shift: at.shift },
      first.subjectId,
      { code: "other", text: "  Порвана при упаковке  " },
      at.settings,
      fakeRender,
    );
    expect(rows(at.db, "SELECT reason_code, reason_text FROM floor_exceptions")).toEqual([
      { reason_code: "other", reason_text: "Порвана при упаковке" },
    ]);
    expect(exceptionRecords(at.db)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          reasonCode: "other",
          reasonText: "Порвана при упаковке",
        }),
      }),
    ]);
  });

  it("refuses a reason of the other list or words of another reason, before it reads or writes anything", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const first = await sendLabelJob(context, await closeBoxWithLabel(at));
    const reprint = (reason: { code: "damaged_label"; text: string | null }) =>
      reprintBox({ ...context, shift: at.shift }, first.subjectId, reason, at.settings, fakeRender);
    await expect(reprint({ code: "damaged_label", text: "сам выбрал" })).rejects.toThrow(
      InvalidReasonError,
    );
    await expect(
      reprintBox(
        { ...context, shift: at.shift },
        first.subjectId,
        // A disassembly's reason is no reason of a reprint.
        { code: "wrong_product" as "other", text: null },
        at.settings,
        fakeRender,
      ),
    ).rejects.toThrow(InvalidReasonError);
    expect(jobRows(at.db)).toHaveLength(1);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
    expect(shell.sends).toHaveLength(1);
  });

  it.each(["verified", "skipped"] as const)("prints again a label that was %s", async (outcome) => {
    const at = await printStation({ verifyPrintedLabel: true });
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const sent = await sendLabelJob(context, await closeBoxWithLabel(at));
    expect(sent.state).toBe("sent");
    if (outcome === "verified") {
      await checkLabel(context, sent, FIRST_SSCC);
    } else {
      await skipLabel(context, sent);
    }
    const settled = await readPrintJob(at.local, PAIRING, sent.id);
    expect(settled?.state).toBe(outcome);
    const job = await reprintBox(
      { ...context, shift: at.shift },
      sent.subjectId,
      { code: "quality_request", text: null },
      at.settings,
      fakeRender,
    );
    // With the check on, the new label waits for the scan of its own.
    expect(job).toMatchObject({ sscc: FIRST_SSCC, state: "sent", verify: true });
    expect(rows(at.db, "SELECT reason_code FROM floor_exceptions")).toEqual([
      { reason_code: "quality_request" },
    ]);
  });

  it("writes the job and the reprint's record in one transaction, before the send", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    shell.holdSends();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const first = await sendLabelJobSettled(at, context, shell);
    const reprint = reprintBox(
      { ...context, shift: at.shift },
      first.subjectId,
      { code: "unreadable_label", text: null },
      at.settings,
      fakeRender,
    );
    await waitForSend(shell, 2);
    expect(jobRows(at.db).map((row) => row["state"])).toEqual(["sent", "sending"]);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_exception'")).toEqual([
      { n: 1 },
    ]);
    shell.releaseSend({ sent: true });
    expect((await reprint).state).toBe("sent");
  });

  it("refuses a box whose label still waits, a box taken apart and a box without a job, writing nothing", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const failed = await sendLabelJob(context, await closeBoxWithLabel(at));
    expect(failed.state).toBe("failed");
    const reason = { code: "damaged_label" as const, text: null };
    await expect(
      reprintBox({ ...context, shift: at.shift }, failed.subjectId, reason, at.settings),
    ).rejects.toThrow(LabelWaitingError);
    await expect(
      reprintBox({ ...context, shift: at.shift }, crypto.randomUUID(), reason, at.settings),
    ).rejects.toThrow(BoxUnavailableError);
    expect(jobRows(at.db)).toHaveLength(1);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
  });

  it("refuses a box whose label waits for its check", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const sent = await sendLabelJob(context, await closeBoxWithLabel(at));
    expect(sent).toMatchObject({ state: "sent", verify: true });
    await expect(
      reprintBox(
        { ...context, shift: at.shift },
        sent.subjectId,
        { code: "damaged_label", text: null },
        at.settings,
        fakeRender,
      ),
    ).rejects.toThrow(LabelWaitingError);
    expect(jobRows(at.db)).toHaveLength(1);
  });

  it("refuses a box taken apart, an open box, a box without a job and another pairing's box", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const reprintContext = { ...context, shift: at.shift };
    const reason = { code: "damaged_label" as const, text: null };
    const first = await sendLabelJob(context, await closeBoxWithLabel(at));
    // A box closed with no label step has no job to print again.
    const filling = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(filling, ["B1"]);
    const bare = await closeOpenBox(
      scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() }),
    );
    if (bare.kind !== "closed") throw new Error(bare.kind);
    await fill(filling, ["B2"]);
    const [open] = rows(at.db, "SELECT id FROM floor_boxes WHERE closed_at IS NULL");
    seedForeignBox(at.db, OTHER_BOX, FOREIGN[0], { open: false });
    seedForeignBox(at.db, OTHER_BOX_2, FOREIGN[1], { open: false });
    for (const boxId of [bare.box.boxId, String(open?.["id"]), OTHER_BOX, OTHER_BOX_2]) {
      await expect(reprintBox(reprintContext, boxId, reason, at.settings)).rejects.toThrow(
        BoxUnavailableError,
      );
    }
    await disassembleBox(
      scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() }),
      first.subjectId,
      {
        code: "wrong_product",
        text: null,
      },
    );
    // A box taken apart is refused before its label is rendered again.
    const render = spyRender();
    await expect(
      reprintBox(reprintContext, first.subjectId, reason, at.settings, render),
    ).rejects.toThrow(BoxUnavailableError);
    expect(render).not.toHaveBeenCalled();
    expect(jobRows(at.db)).toHaveLength(1);
    expect(rows(at.db, "SELECT kind FROM floor_exceptions")).toEqual([{ kind: "disassemble" }]);
  });

  it("refuses a box whose job was made from another revision of the template than the snapshot holds", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const first = await sendLabelJob(context, await closeBoxWithLabel(at));
    const newer = {
      ...at.shift,
      snapshot: {
        ...at.shift.snapshot,
        boxTemplate: {
          ...at.shift.snapshot.boxTemplate,
          rev: at.shift.snapshot.boxTemplate.rev + 1,
        },
      },
    };
    await expect(
      reprintBox(
        { ...context, shift: newer },
        first.subjectId,
        { code: "damaged_label", text: null },
        at.settings,
        fakeRender,
      ),
    ).rejects.toThrow(TemplateChangedError);
    expect(jobRows(at.db)).toHaveLength(1);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
  });

  it("writes nothing when the box is taken apart between its read and its write", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const runtime = manualRuntime(shell.hardware).runtime;
    const first = await sendLabelJob(
      resolveContext(at.local, runtime),
      await closeBoxWithLabel(at),
    );
    const held = holdingWrites(at.local);
    held.holdNext();
    const reprint = reprintBox(
      { ...resolveContext(held.executor, runtime), shift: at.shift },
      first.subjectId,
      { code: "damaged_label", text: null },
      at.settings,
      fakeRender,
    );
    await held.reached();
    await disassembleBox(meanwhile(at.local, at.shift), first.subjectId, {
      code: "damaged_package",
      text: null,
    });
    held.release();
    await expect(reprint).rejects.toThrow(BoxUnavailableError);
    expect(jobRows(at.db)).toHaveLength(1);
    expect(rows(at.db, "SELECT kind FROM floor_exceptions")).toEqual([{ kind: "disassemble" }]);
    expect(shell.sends).toHaveLength(1);
  });

  it("prints once when two reprints of one box race", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const runtime = manualRuntime(shell.hardware).runtime;
    const first = await sendLabelJob(
      resolveContext(at.local, runtime),
      await closeBoxWithLabel(at),
    );
    const held = holdingWrites(at.local);
    held.holdNext();
    const second = reprintBox(
      { ...resolveContext(held.executor, runtime), shift: at.shift },
      first.subjectId,
      { code: "damaged_label", text: null },
      at.settings,
      fakeRender,
    );
    await held.reached();
    const winner = {
      ...resolveContext(at.local, runtime),
      newId: () => crypto.randomUUID(),
      shift: at.shift,
    };
    await reprintBox(
      winner,
      first.subjectId,
      { code: "printer_jam", text: null },
      at.settings,
      fakeRender,
    );
    held.release();
    await expect(second).rejects.toThrow(StaleJobError);
    expect(jobRows(at.db)).toHaveLength(2);
    expect(rows(at.db, "SELECT reason_code FROM floor_exceptions")).toEqual([
      { reason_code: "printer_jam" },
    ]);
    expect(shell.sends).toHaveLength(2);
  });

  it("takes the newest job of the box by the order they were made in, whatever the clock did", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const runtime = manualRuntime(shell.hardware).runtime;
    const context = resolveContext(at.local, runtime);
    const first = await sendLabelJob(context, await closeBoxWithLabel(at));
    // The computer's time was corrected back: this reprint's job is stamped
    // before the first label's, and, with no printer, waits as `failed`.
    const earlier = { ...context, now: () => new Date("2026-10-08T05:00:00.000Z") };
    const noPrinter = { ...at.settings, assignments: { box: null, pallet: null, duplicate: null } };
    const waiting = await reprintBox(
      { ...earlier, shift: at.shift },
      first.subjectId,
      { code: "printer_jam", text: null },
      noPrinter,
      fakeRender,
    );
    expect(waiting.state).toBe("failed");
    expect(waiting.createdAt < first.createdAt).toBe(true);
    // The waiting job is the box's newest, though it is the oldest by its clock.
    await expect(
      reprintBox(
        { ...context, shift: at.shift },
        first.subjectId,
        { code: "damaged_label", text: null },
        at.settings,
        fakeRender,
      ),
    ).rejects.toThrow(LabelWaitingError);
    expect(jobRows(at.db)).toHaveLength(2);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 1 }]);
  });

  it("rejects, rather than call it stale, when the write itself fails", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const runtime = manualRuntime(shell.hardware).runtime;
    const first = await sendLabelJob(
      resolveContext(at.local, runtime),
      await closeBoxWithLabel(at),
    );
    await expect(
      reprintBox(
        { ...resolveContext(failingWrites(at.local), runtime), shift: at.shift },
        first.subjectId,
        { code: "damaged_label", text: null },
        at.settings,
        fakeRender,
      ),
    ).rejects.toThrow("disk is full");
    expect(jobRows(at.db)).toHaveLength(1);
  });

  it("keeps the job `failed` when no printer is assigned now, for the label's panel", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const first = await sendLabelJob(context, await closeBoxWithLabel(at));
    const job = await reprintBox(
      { ...context, shift: at.shift },
      first.subjectId,
      { code: "printer_jam", text: null },
      { ...at.settings, assignments: { box: null, pallet: null, duplicate: null } },
      fakeRender,
    );
    expect(job).toMatchObject({ state: "failed", errorCode: "printer_unconfigured" });
    expect(shell.sends).toHaveLength(1);
    expect(await readPrintJob(at.local, PAIRING, job.id)).toMatchObject({ state: "failed" });
    // The reason is on record all the same: a second label may exist.
    expect(rows(at.db, "SELECT reason_code FROM floor_exceptions")).toEqual([
      { reason_code: "printer_jam" },
    ]);
  });
});

/** The first label of a box, sent and taken by the printer. */
async function sendLabelJobSettled(
  at: Awaited<ReturnType<typeof printStation>>,
  context: ReturnType<typeof resolveContext>,
  shell: ReturnType<typeof fakeHardware>,
) {
  const sending = sendLabelJob(context, await closeBoxWithLabel(at));
  await waitForSend(shell, 1);
  shell.releaseSend({ sent: true });
  shell.holdSends();
  return sending;
}

/** Resolves once the fake printer holds `count` sends in all. */
async function waitForSend(shell: ReturnType<typeof fakeHardware>, count: number): Promise<void> {
  for (let turn = 0; turn < 200 && shell.sends.length < count; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (shell.sends.length < count) throw new Error(`the printer took ${shell.sends.length} sends`);
}
