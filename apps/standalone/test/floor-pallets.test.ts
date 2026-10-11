import { buildSscc, palletLabelFields } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { closeShift, readCloseSummary } from "../src/floor/close/shift-close.js";
import {
  closeOpenPallet,
  closePalletIfFull,
  openPalletGuard,
  PALLET_EXTENSION,
  palletStep,
  readOpenPallet,
  shiftPallets,
} from "../src/floor/pallets/pallets.js";
import { readOpenJob } from "../src/floor/print/print-jobs.js";
import { remainingSerials } from "../src/floor/work/block-supply.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import {
  enteredShift,
  OPERATOR_ID,
  PAIRING,
  PREFIX,
  holdingWrites,
  km,
  rows,
  seedBlock,
} from "./support/floor-work.js";
import {
  closeBoxOnPallet,
  PALLET_BLOCK,
  PALLETS_ENTERED,
  palletContext,
  palletStation,
  type PalletStation,
} from "./support/pallets.js";
import { renderedBase64, ZEBRA } from "./support/printing.js";

function pallets(at: PalletStation) {
  return rows(
    at.db,
    "SELECT id, opened_at, closed_at, sscc, block_id, serial, disassembled_at FROM floor_pallets " +
      "ORDER BY opened_at, id",
  );
}

function outbox(at: PalletStation) {
  return rows(at.db, "SELECT kind, payload FROM outbox ORDER BY seq").map((row) => ({
    kind: row["kind"],
    data: (JSON.parse(String(row["payload"])) as { data: Record<string, unknown> }).data,
  }));
}

function boxesOn(at: PalletStation, palletId: unknown) {
  return rows(
    at.db,
    "SELECT id FROM floor_boxes WHERE pallet_id = ? ORDER BY closed_at",
    String(palletId),
  );
}

/** Closes `count` boxes of one code each, the codes `<prefix>1`, `<prefix>2`, …. */
async function closeBoxes(at: PalletStation, prefix: string, count: number) {
  for (let index = 1; index <= count; index += 1) {
    const closed = await closeBoxOnPallet(at, [`${prefix}${index}`]);
    if (closed.kind !== "closed") throw new Error(`box ${index}: ${closed.kind}`);
  }
}

describe("a box joins the shift's open pallet as it closes (plan ПЛ-Ц)", () => {
  it("opens a pallet with the first box, in the box's own transaction, and names it in the box's record", async () => {
    const at = await palletStation();
    const closed = await closeBoxOnPallet(at, ["A1", "A2"]);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    const [pallet] = pallets(at);
    expect(pallet).toMatchObject({ opened_at: closed.box.closedAt, closed_at: null, sscc: null });
    expect(boxesOn(at, pallet?.["id"])).toEqual([{ id: closed.box.boxId }]);
    const records = outbox(at);
    expect(records.map((record) => record.kind)).toEqual(["scan", "scan", "box_closed"]);
    expect(records[2]?.data).toMatchObject({ boxId: closed.box.boxId, palletId: pallet?.["id"] });
    await expect(readOpenPallet(at.local, PAIRING, at.shift.copy.id)).resolves.toEqual({
      id: pallet?.["id"],
      openedAt: closed.box.closedAt,
      boxCount: 1,
      itemCount: 2,
    });
  });

  it("closes the pallet with the box that fills it, in that box's transaction: the pallet serial, the record after the box's, the label", async () => {
    const at = await palletStation({ capacity: 3 });
    await closeBoxOnPallet(at, ["A1"]);
    await closeBoxOnPallet(at, ["B1", "B2"]);
    const third = await closeBoxOnPallet(at, ["C1", "C2", "C3"]);
    if (third.kind !== "closed") throw new Error(third.kind);
    const sscc = buildSscc(PALLET_EXTENSION, PREFIX, 0);
    const [pallet] = pallets(at);
    expect(pallet).toMatchObject({
      closed_at: third.box.closedAt,
      sscc,
      block_id: PALLET_BLOCK,
      serial: 0,
    });
    expect(boxesOn(at, pallet?.["id"])).toHaveLength(3);
    const kinds = outbox(at).map((record) => record.kind);
    expect(kinds.slice(-2)).toEqual(["box_closed", "pallet_closed"]);
    expect(outbox(at).at(-1)?.data).toEqual({
      palletId: pallet?.["id"],
      sscc,
      blockId: PALLET_BLOCK,
      serial: 0,
      openedAt: pallet?.["opened_at"],
      closedAt: third.box.closedAt,
      boxCount: 3,
    });
    await expect(remainingSerials(at.local, PAIRING, PREFIX, PALLET_EXTENSION)).resolves.toBe(199);
    // The pallet's label: its own job, from the snapshot's pallet layout, on the
    // printer of the purpose «Паллета»; the box's label goes first.
    const jobs = rows(
      at.db,
      "SELECT id, purpose, subject_id, sscc, state, template_id, template_rev, bytes_base64, " +
        "fields FROM floor_print_jobs WHERE purpose = 'pallet'",
    );
    expect(jobs).toEqual([
      expect.objectContaining({
        subject_id: pallet?.["id"],
        sscc,
        state: "prepared",
        template_id: at.pallets.template.id,
        template_rev: 63,
        bytes_base64: renderedBase64(ZEBRA, sscc, "100x150"),
      }),
    ]);
    expect(JSON.parse(String(jobs[0]?.["fields"]))).toMatchObject({
      sscc,
      "qty.boxes": "3",
      qty: "6",
      operator: "Анна Кузнецова",
    });
    // Of the two jobs of one moment the box's is read first, whatever their ids.
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'sent' WHERE subject_id <> ? AND purpose = 'box'",
      )
      .run(third.box.boxId);
    at.db
      .prepare("UPDATE floor_print_jobs SET id = ? WHERE purpose = ?")
      .run("00000000-0000-4000-8000-000000000001", "pallet");
    at.db
      .prepare("UPDATE floor_print_jobs SET id = ? WHERE subject_id = ?")
      .run("ffffffff-ffff-4fff-8fff-ffffffffffff", third.box.boxId);
    const first = await readOpenJob(at.local, PAIRING, at.shift.copy.id);
    expect(first).toMatchObject({ purpose: "box", subjectId: third.box.boxId });
    // The next box opens the next pallet.
    const fourth = await closeBoxOnPallet(at, ["D1"]);
    if (fourth.kind !== "closed") throw new Error(fourth.kind);
    expect(rows(at.db, "SELECT opened_at FROM floor_pallets WHERE closed_at IS NULL")).toEqual([
      { opened_at: fourth.box.closedAt },
    ]);
  });

  it("never closes a box without its pallet: a pallet serial taken meanwhile leaves both as they were", async () => {
    const at = await palletStation({ capacity: 1 });
    const held = holdingWrites(at.local);
    const context = palletContext({ ...at, local: held.executor });
    const station = { ...at, local: held.executor };
    // The codes go in first; the box's close is the transaction held.
    for (const serial of ["A1", "A2"]) await processScan(context, km(serial));
    held.holdNext();
    const closing = closeBoxOnPallet(station, [], context);
    await held.reached();
    at.db
      .prepare("UPDATE floor_sscc_blocks SET next_serial = 1 WHERE block_id = ?")
      .run(PALLET_BLOCK);
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(pallets(at)).toEqual([]);
    expect(rows(at.db, "SELECT closed_at, pallet_id FROM floor_boxes")).toEqual([
      { closed_at: null, pallet_id: null },
    ]);
    expect(outbox(at).map((record) => record.kind)).toEqual(["scan", "scan"]);
  });
});

describe("a full pallet without pallet serials (plan ПЛ-Ц)", () => {
  it("stays open, takes the next boxes, and closes once a pallet block comes", async () => {
    const at = await palletStation({ capacity: 2, palletBlock: false });
    await closeBoxes(at, "A", 3);
    const context = palletContext(at);
    await expect(readOpenPallet(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      boxCount: 3,
    });
    expect(outbox(at).map((record) => record.kind)).not.toContain("pallet_closed");
    await expect(closePalletIfFull(context, at.pallets)).resolves.toEqual({ kind: "no_serials" });
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 0, to: 199, extension: 1 });
    const closed = await closePalletIfFull(context, at.pallets);
    expect(closed).toMatchObject({ kind: "closed", pallet: { boxCount: 3, serial: 0 } });
    await expect(closePalletIfFull(context, at.pallets)).resolves.toBeNull();
  });

  it("keeps a pallet with room open", async () => {
    const at = await palletStation({ capacity: 3 });
    await closeBoxes(at, "A", 2);
    await expect(closePalletIfFull(palletContext(at), at.pallets)).resolves.toBeNull();
  });
});

describe("«Закрыть паллету досрочно» (plan ПЛ-Ц)", () => {
  it("closes the open pallet with the boxes it holds", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 2);
    const result = await closeOpenPallet(palletContext(at), at.pallets);
    if (result.kind !== "closed") throw new Error(result.kind);
    expect(result.pallet).toMatchObject({ boxCount: 2, itemCount: 2, serial: 0 });
    expect(outbox(at).at(-1)).toMatchObject({ kind: "pallet_closed", data: { boxCount: 2 } });
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ n: 1 }]);
  });

  it("refuses an empty pallet, or one whose boxes were all taken apart, before spending a serial", async () => {
    const at = await palletStation({ capacity: 40 });
    const context = palletContext(at);
    await expect(closeOpenPallet(context, at.pallets)).resolves.toEqual({ kind: "empty" });
    await closeBoxes(at, "A", 1);
    at.db.prepare("UPDATE floor_boxes SET disassembled_at = closed_at").run();
    await expect(closeOpenPallet(context, at.pallets)).resolves.toEqual({ kind: "empty" });
    await expect(remainingSerials(at.local, PAIRING, PREFIX, PALLET_EXTENSION)).resolves.toBe(200);
  });

  it("writes nothing when a box joins between its read and its write", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 2);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeOpenPallet(palletContext({ ...at, local: held.executor }), at.pallets);
    await held.reached();
    // A box taken apart meanwhile: the pallet no longer holds what was counted.
    at.db
      .prepare(
        "UPDATE floor_boxes SET disassembled_at = closed_at WHERE rowid = (SELECT min(rowid) FROM floor_boxes)",
      )
      .run();
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(pallets(at)).toEqual([expect.objectContaining({ closed_at: null })]);
    await expect(remainingSerials(at.local, PAIRING, PREFIX, PALLET_EXTENSION)).resolves.toBe(200);
  });

  it("spends a serial past the prefix's range and keeps the pallet open", async () => {
    const at = await palletStation({ capacity: 40, palletBlock: false });
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 10_000_000, to: 10_000_009, extension: 1 });
    await closeBoxes(at, "A", 1);
    await expect(closeOpenPallet(palletContext(at), at.pallets)).resolves.toEqual({
      kind: "invalid_serial",
    });
    expect(rows(at.db, "SELECT next_serial FROM floor_sscc_blocks WHERE extension = 1")).toEqual([
      { next_serial: 10_000_001 },
    ]);
    expect(pallets(at)).toEqual([expect.objectContaining({ closed_at: null })]);
  });
});

describe("the shift's close and its open pallet (plan ПЛ-Ц)", () => {
  it("is kept open by a pallet with boxes, and not by an empty one", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 2);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: { kind: "open_pallet", boxes: 2 },
    });
    at.db.prepare("UPDATE floor_boxes SET disassembled_at = closed_at").run();
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: null,
    });
  });

  it("checks in its own transaction that no open pallet holds a box", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 1);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    // The box is loose and the open pallet empty: the summary lets the shift close…
    const [pallet] = pallets(at);
    at.db.prepare("UPDATE floor_boxes SET pallet_id = NULL").run();
    const held = holdingWrites(at.local);
    held.holdNext();
    const context = palletContext({ ...at, local: held.executor });
    const closing = closeShift(context, "production_defect", [
      openPalletGuard(PAIRING, at.shift.copy.id),
    ]);
    await held.reached();
    // …and the box joins the pallet before the close writes.
    at.db.prepare("UPDATE floor_boxes SET pallet_id = ?").run(String(pallet?.["id"]));
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(rows(at.db, "SELECT local_state FROM floor_shifts")).toEqual([{ local_state: null }]);
    at.db.prepare("UPDATE floor_boxes SET pallet_id = NULL").run();
    await expect(
      closeShift(palletContext(at), "production_defect", [
        openPalletGuard(PAIRING, at.shift.copy.id),
      ]),
    ).resolves.toMatchObject({ kind: "closed" });
  });
});

// The tests below go beyond the plan's: each pins one guard of the pallet model that a
// one-line mutant would otherwise remove unnoticed (the report lists the mutants).

const OTHER_SHIFT = "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a";
/** Sorts before every real id, so a read that forgets its pairing meets it first. */
const FOREIGN = "00000000-0000-4000-8000-000000000000";

/** A second shift with pallets on the same station: its own open pallet, the same blocks. */
async function secondShift(at: PalletStation): Promise<PalletStation> {
  const shift = await enteredShift(at.local, {
    ...PALLETS_ENTERED,
    id: OTHER_SHIFT,
    number: "OCT26-006/S",
    palletBoxCapacity: 40,
  });
  const second = shiftPallets(shift);
  if (second === null) throw new Error("the second shift has no pallets");
  return { ...at, shift, pallets: second };
}

/** Closes a pallet by hand, as a close that landed meanwhile would. */
function closeByHand(at: PalletStation, palletId: string, serial: number) {
  at.db
    .prepare(
      "UPDATE floor_pallets SET closed_at = ?, sscc = ?, block_id = ?, serial = ?, closed_by = ? " +
        "WHERE id = ?",
    )
    .run(
      "2026-10-08T07:00:00.000Z",
      buildSscc(PALLET_EXTENSION, PREFIX, serial),
      PALLET_BLOCK,
      serial,
      OPERATOR_ID,
      palletId,
    );
}

describe("a pallet of one box, and the pallet's own fields (plan ПЛ-Ц)", () => {
  it("opens and closes with its only box: its record follows the box's, the moments are the box's, the operator is the one closing", async () => {
    const at = await palletStation({ capacity: 1 });
    const closed = await closeBoxOnPallet(at, ["A1", "A2"]);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    const [pallet] = pallets(at);
    expect(pallet).toMatchObject({
      opened_at: closed.box.closedAt,
      closed_at: closed.box.closedAt,
      sscc: buildSscc(PALLET_EXTENSION, PREFIX, 0),
      serial: 0,
    });
    const kinds = outbox(at).map((record) => record.kind);
    expect(kinds).toEqual(["scan", "scan", "box_closed", "pallet_closed"]);
    expect(outbox(at).at(-1)?.data).toMatchObject({
      palletId: pallet?.["id"],
      openedAt: closed.box.closedAt,
      closedAt: closed.box.closedAt,
      boxCount: 1,
    });
    const head = rows(at.db, "SELECT payload FROM outbox WHERE kind = 'pallet_closed'")[0];
    expect(JSON.parse(String(head?.["payload"]))).toMatchObject({
      operatorId: OPERATOR_ID,
      shiftId: at.shift.copy.id,
    });
    expect(rows(at.db, "SELECT closed_by FROM floor_pallets")).toEqual([
      { closed_by: OPERATOR_ID },
    ]);
    // The label's job is the pallet's, made at the box's moment by the operator closing.
    expect(
      rows(
        at.db,
        "SELECT shift_id, operator_id, created_at, updated_at FROM floor_print_jobs WHERE purpose = 'pallet'",
      ),
    ).toEqual([
      {
        shift_id: at.shift.copy.id,
        operator_id: OPERATOR_ID,
        created_at: closed.box.closedAt,
        updated_at: closed.box.closedAt,
      },
    ]);
  });

  it("counts the units of every box it holds into its label, and the boxes taken apart not at all", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxOnPallet(at, ["A1"]);
    await closeBoxOnPallet(at, ["B1", "B2"]);
    await closeBoxOnPallet(at, ["C1", "C2", "C3"]);
    await expect(readOpenPallet(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      boxCount: 3,
      itemCount: 6,
    });
    at.db
      .prepare(
        "UPDATE floor_boxes SET disassembled_at = closed_at WHERE rowid = (SELECT max(rowid) FROM floor_boxes)",
      )
      .run();
    await expect(readOpenPallet(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      boxCount: 2,
      itemCount: 3,
    });
    const closeAt = "2026-10-08T07:30:00.000Z";
    const result = await closeOpenPallet(
      palletContext(at, { now: () => new Date(closeAt) }),
      at.pallets,
    );
    if (result.kind !== "closed") throw new Error(result.kind);
    // It closes at the moment of its own close, after its boxes, and says so everywhere.
    expect(result.pallet.closedAt).toBe(closeAt);
    expect(rows(at.db, "SELECT opened_at, closed_at FROM floor_pallets")).toEqual([
      { opened_at: expect.not.stringMatching(closeAt), closed_at: closeAt },
    ]);
    expect(outbox(at).at(-1)).toMatchObject({ kind: "pallet_closed", data: { closedAt: closeAt } });
    expect(result.pallet).toMatchObject({ boxCount: 2, itemCount: 3 });
    const [job] = rows(at.db, "SELECT fields FROM floor_print_jobs WHERE purpose = 'pallet'");
    const { product, counterpartyName } = at.shift.snapshot;
    expect(JSON.parse(String(job?.["fields"]))).toEqual(
      palletLabelFields({
        sscc: result.pallet.sscc,
        boxCount: 2,
        itemCount: 3,
        productName: product.name,
        productPrintName: product.printName,
        gtin14: product.gtin14,
        egaisCode: null,
        shelfLifeDays: product.shelfLifeDays,
        operatorName: "Анна Кузнецова",
        counterpartyName,
        closedAt: result.pallet.closedAt,
        productionDate: at.shift.copy.productionDate,
        shiftNumber: at.shift.copy.number,
      }),
    );
    expect(JSON.parse(String(job?.["fields"]))).toMatchObject({
      "qty.boxes": "2",
      qty: "3",
      "shift.no": at.shift.copy.number,
    });
    expect(rows(at.db, "SELECT closed_by FROM floor_pallets")).toEqual([
      { closed_by: OPERATOR_ID },
    ]);
    expect(
      rows(at.db, "SELECT operator_id, created_at FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ operator_id: OPERATOR_ID, created_at: result.pallet.closedAt }]);
    // The next box opens the next pallet.
    const next = await closeBoxOnPallet(at, ["D1"]);
    if (next.kind !== "closed") throw new Error(next.kind);
    expect(rows(at.db, "SELECT opened_at FROM floor_pallets WHERE closed_at IS NULL")).toEqual([
      { opened_at: next.box.closedAt },
    ]);
  });

  it("closes its pallet all the same when no printer is assigned to pallets, or the label does not render", async () => {
    const unassigned = await palletStation({
      capacity: 1,
      settings: { assignments: { box: "zebra", pallet: null, duplicate: null } },
    });
    await closeBoxes(unassigned, "A", 1);
    expect(
      rows(unassigned.db, "SELECT closed_at IS NOT NULL AS closed FROM floor_pallets"),
    ).toEqual([{ closed: 1 }]);
    expect(
      rows(
        unassigned.db,
        "SELECT state, error_code, bytes_base64 FROM floor_print_jobs WHERE purpose = 'pallet'",
      ),
    ).toEqual([{ state: "failed", error_code: "printer_unconfigured", bytes_base64: null }]);
    const broken = await palletStation({ capacity: 1 });
    await closeBoxOnPallet(
      broken,
      ["B1"],
      palletContext(broken, {
        render: async () => {
          throw new Error("no raster");
        },
      }),
    );
    expect(
      rows(broken.db, "SELECT state, error_code FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ state: "failed", error_code: "render_failed" }]);
  });
});

describe("a box never joins a second pallet, nor a closed one (plan ПЛ-Ц)", () => {
  it("refuses to move a box that is already on a pallet, or to put an open box on one", async () => {
    const at = await palletStation({ capacity: 1 });
    const closed = await closeBoxOnPallet(at, ["A1"]);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    const [first] = pallets(at);
    // The box is on its closed pallet; asked again, the step would open another and move it.
    const again = await palletStep(palletContext(at), at.pallets)(closed.box);
    await expect(at.local.transaction(again.statements)).rejects.toMatchObject({
      code: "changes_mismatch",
    });
    expect(pallets(at)).toEqual([first]);
    expect(boxesOn(at, first?.["id"])).toEqual([{ id: closed.box.boxId }]);
    // An open box is not on any pallet: the pallet's open, the box's not closed.
    const roomy = await palletStation({ capacity: 40 });
    await closeBoxOnPallet(roomy, ["B1"]);
    const context = palletContext(roomy);
    await processScan(context, km("B2"));
    const [open] = rows(roomy.db, "SELECT id FROM floor_boxes WHERE closed_at IS NULL");
    const addition = await palletStep(
      context,
      roomy.pallets,
    )({
      ...closed.box,
      boxId: String(open?.["id"]),
      shiftId: roomy.shift.copy.id,
    });
    await expect(roomy.local.transaction(addition.statements)).rejects.toMatchObject({
      code: "changes_mismatch",
    });
    expect(rows(roomy.db, "SELECT pallet_id FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { pallet_id: null },
    ]);
  });

  it("leaves the box and the pallet as they were when the pallet closes between the read and the write", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxOnPallet(at, ["A1"]);
    const [pallet] = pallets(at);
    const held = holdingWrites(at.local);
    const station = { ...at, local: held.executor };
    const context = palletContext(station);
    await processScan(context, km("A2"));
    held.holdNext();
    const closing = closeBoxOnPallet(station, [], context);
    await held.reached();
    closeByHand(at, String(pallet?.["id"]), 150);
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(rows(at.db, "SELECT closed_at, pallet_id FROM floor_boxes ORDER BY rowid")).toEqual([
      { closed_at: expect.any(String), pallet_id: pallet?.["id"] },
      { closed_at: null, pallet_id: null },
    ]);
    expect(boxesOn(at, pallet?.["id"])).toHaveLength(1);
    await expect(remainingSerials(at.local, PAIRING, PREFIX, PALLET_EXTENSION)).resolves.toBe(200);
  });

  it("never has two open pallets: a pallet opened meanwhile fails the box's close whole", async () => {
    const at = await palletStation({ capacity: 40 });
    const held = holdingWrites(at.local);
    const station = { ...at, local: held.executor };
    const context = palletContext(station);
    await processScan(context, km("A1"));
    held.holdNext();
    const closing = closeBoxOnPallet(station, [], context);
    await held.reached();
    at.db
      .prepare(
        "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("rival", PAIRING.hostId, PAIRING.deviceId, at.shift.copy.id, "2026-10-08T06:59:00.000Z");
    held.release();
    await expect(closing).rejects.toMatchObject({ code: "statement_failed" });
    expect(rows(at.db, "SELECT id FROM floor_pallets")).toEqual([{ id: "rival" }]);
    expect(rows(at.db, "SELECT closed_at, pallet_id FROM floor_boxes")).toEqual([
      { closed_at: null, pallet_id: null },
    ]);
    expect(outbox(at).map((record) => record.kind)).toEqual(["scan"]);
    await expect(remainingSerials(at.local, PAIRING, PREFIX, 0)).resolves.toBe(2000);
  });
});

describe("the pallet's serial (plan ПЛ-Ц)", () => {
  it("is the earliest live pallet block of the shift's prefix and pairing, of extension 1", async () => {
    const at = await palletStation({ capacity: 40, palletBlock: false });
    const decoys = [
      { blockId: "a0000000-0000-4000-8000-000000000001", prefix: "460068201" },
      { blockId: "a0000000-0000-4000-8000-000000000002", deviceId: FOREIGN },
      { blockId: "a0000000-0000-4000-8000-000000000003", hostId: FOREIGN },
      { blockId: "a0000000-0000-4000-8000-000000000004", next: 14 },
    ];
    for (const [index, decoy] of decoys.entries()) {
      seedBlock(at.db, { from: index, to: index + 10, extension: 1, ...decoy });
    }
    // Two live blocks: the earlier by serial wins over the earlier by id.
    seedBlock(at.db, {
      blockId: "00000000-0000-4000-8000-0000000000bb",
      from: 300,
      to: 399,
      extension: 1,
    });
    seedBlock(at.db, {
      blockId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      from: 100,
      to: 199,
      extension: 1,
    });
    await closeBoxes(at, "A", 1);
    const result = await closeOpenPallet(palletContext(at), at.pallets);
    if (result.kind !== "closed") throw new Error(result.kind);
    expect(result.pallet).toMatchObject({
      blockId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      serial: 100,
      sscc: buildSscc(PALLET_EXTENSION, PREFIX, 100),
    });
    // Only that block moved: the decoys keep their cursors.
    expect(
      rows(
        at.db,
        "SELECT block_id FROM floor_sscc_blocks WHERE extension = 1 AND next_serial = from_serial + 1",
      ),
    ).toEqual([{ block_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }]);
  });

  it("is lost, with the pallet left open, when taken meanwhile: a close that finds its serial gone writes nothing", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 2);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeOpenPallet(palletContext({ ...at, local: held.executor }), at.pallets);
    await held.reached();
    at.db
      .prepare("UPDATE floor_sscc_blocks SET next_serial = 1 WHERE block_id = ?")
      .run(PALLET_BLOCK);
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(pallets(at)).toEqual([expect.objectContaining({ closed_at: null, sscc: null })]);
    expect(outbox(at).map((record) => record.kind)).not.toContain("pallet_closed");
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ n: 0 }]);
    expect(rows(at.db, "SELECT next_serial FROM floor_sscc_blocks WHERE extension = 1")).toEqual([
      { next_serial: 1 },
    ]);
  });

  it("is not spent on a pallet that another close finished meanwhile: it closes once, with one label", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 2);
    const [pallet] = pallets(at);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeOpenPallet(palletContext({ ...at, local: held.executor }), at.pallets);
    await held.reached();
    // The pallet closes by another path with the boxes the first read counted; the cursor is
    // untouched, so only the pallet's own guard can see it.
    closeByHand(at, String(pallet?.["id"]), 150);
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(rows(at.db, "SELECT sscc, serial FROM floor_pallets")).toEqual([
      { sscc: buildSscc(PALLET_EXTENSION, PREFIX, 150), serial: 150 },
    ]);
    expect(outbox(at).map((record) => record.kind)).not.toContain("pallet_closed");
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ n: 0 }]);
    expect(rows(at.db, "SELECT next_serial FROM floor_sscc_blocks WHERE extension = 1")).toEqual([
      { next_serial: 0 },
    ]);
  });

  it("is spent alone, and a serial taken meanwhile makes that stale, not lost", async () => {
    const at = await palletStation({ capacity: 40, palletBlock: false });
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 10_000_000, to: 10_000_009, extension: 1 });
    await closeBoxes(at, "A", 1);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeOpenPallet(palletContext({ ...at, local: held.executor }), at.pallets);
    await held.reached();
    at.db
      .prepare("UPDATE floor_sscc_blocks SET next_serial = 10000005 WHERE block_id = ?")
      .run(PALLET_BLOCK);
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(rows(at.db, "SELECT next_serial FROM floor_sscc_blocks WHERE extension = 1")).toEqual([
      { next_serial: 10_000_005 },
    ]);
  });

  it("leaves a full pallet open, the serial unspent, when its SSCC lies past the prefix's range", async () => {
    const at = await palletStation({ capacity: 1, palletBlock: false });
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 10_000_000, to: 10_000_009, extension: 1 });
    const closed = await closeBoxOnPallet(at, ["A1"]);
    expect(closed.kind).toBe("closed");
    expect(pallets(at)).toEqual([expect.objectContaining({ closed_at: null })]);
    expect(rows(at.db, "SELECT next_serial FROM floor_sscc_blocks WHERE extension = 1")).toEqual([
      { next_serial: 10_000_000 },
    ]);
    expect(outbox(at).map((record) => record.kind)).toEqual(["scan", "box_closed"]);
  });

  it("closes a pallet that is exactly full once serials come", async () => {
    const at = await palletStation({ capacity: 2, palletBlock: false });
    await closeBoxes(at, "A", 2);
    const context = palletContext(at);
    await expect(closePalletIfFull(context, at.pallets)).resolves.toEqual({ kind: "no_serials" });
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 0, to: 199, extension: 1 });
    await expect(closePalletIfFull(context, at.pallets)).resolves.toMatchObject({
      kind: "closed",
      pallet: { boxCount: 2 },
    });
  });
});

describe("the open pallet is the shift's own, of this pairing (plan ПЛ-Ц)", () => {
  it("is read per shift and per pairing, with its own boxes", async () => {
    const at = await palletStation({ capacity: 40 });
    const other = await secondShift(at);
    at.db
      .prepare(
        "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("foreign-device", PAIRING.hostId, FOREIGN, at.shift.copy.id, "2026-10-08T05:00:00.000Z");
    at.db
      .prepare(
        "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("foreign-host", FOREIGN, PAIRING.deviceId, at.shift.copy.id, "2026-10-08T05:00:00.000Z");
    await closeBoxOnPallet(at, ["A1", "A2"]);
    await closeBoxOnPallet(at, ["B1"]);
    await closeBoxOnPallet(other, ["C1", "C2", "C3"]);
    await expect(readOpenPallet(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      boxCount: 2,
      itemCount: 3,
    });
    await expect(readOpenPallet(at.local, PAIRING, OTHER_SHIFT)).resolves.toMatchObject({
      boxCount: 1,
      itemCount: 3,
    });
    // A pallet closes with the boxes of its own, and the other shift's stays open.
    const result = await closeOpenPallet(palletContext(at), at.pallets);
    expect(result).toMatchObject({ kind: "closed", pallet: { boxCount: 2, itemCount: 3 } });
    await expect(readOpenPallet(at.local, PAIRING, at.shift.copy.id)).resolves.toBeNull();
    await expect(readOpenPallet(at.local, PAIRING, OTHER_SHIFT)).resolves.toMatchObject({
      boxCount: 1,
    });
    expect(
      rows(
        at.db,
        "SELECT id FROM floor_pallets WHERE closed_at IS NULL AND shift_id = ? ORDER BY id",
        at.shift.copy.id,
      ),
    ).toEqual([{ id: "foreign-device" }, { id: "foreign-host" }]);
  });

  it("is worked by a shift with pallets alone: the station's shifts without them, or half set up, have no pallets", async () => {
    const at = await palletStation();
    const { copy, snapshot } = at.shift;
    expect(shiftPallets(at.shift)).toEqual({ capacity: 3, template: at.pallets.template });
    expect(shiftPallets({ ...at.shift, copy: { ...copy, palletsEnabled: false } })).toBeNull();
    expect(shiftPallets({ ...at.shift, copy: { ...copy, palletBoxCapacity: null } })).toBeNull();
    expect(
      shiftPallets({ ...at.shift, snapshot: { ...snapshot, palletTemplate: null } }),
    ).toBeNull();
  });
});

describe("the close of a shift with pallets, in the order its blockers come (plan ПЛ-Ц)", () => {
  it("names an open box before a waiting label before an open pallet", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 1);
    // A label waits (the box's), the pallet holds a box: the label first.
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: { kind: "label" },
    });
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: { kind: "open_pallet", boxes: 1 },
    });
    // An open box with codes, on top of both.
    await processScan(palletContext(at), km("B1"));
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: { kind: "open_box", items: 1 },
    });
  });

  it("is kept by the shift's own pallet alone, and by an open one alone", async () => {
    const at = await palletStation({ capacity: 40 });
    const other = await secondShift(at);
    await closeBoxOnPallet(other, ["C1"]);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    // The other shift's open pallet does not keep this shift open.
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: null,
    });
    await closeBoxes(at, "A", 2);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: { kind: "open_pallet", boxes: 2 },
    });
    // Closed, the pallet holds its boxes and keeps nothing open.
    const result = await closeOpenPallet(palletContext(at), at.pallets);
    expect(result.kind).toBe("closed");
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: null,
    });
    await expect(readCloseSummary(at.local, PAIRING, OTHER_SHIFT)).resolves.toMatchObject({
      blocker: { kind: "open_pallet", boxes: 1 },
    });
  });

  it("checks in the close's transaction the shift's own open pallet, and that pallet while it is open and holds a box", async () => {
    const at = await palletStation({ capacity: 40 });
    const other = await secondShift(at);
    await closeBoxOnPallet(other, ["C1"]);
    await closeBoxes(at, "A", 2);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    const guard = (shiftId: string) => at.local.transaction([openPalletGuard(PAIRING, shiftId)]);
    // The shift's open pallet holds boxes; the other shift's holds one too.
    await expect(guard(at.shift.copy.id)).rejects.toMatchObject({ code: "changes_mismatch" });
    await expect(guard(OTHER_SHIFT)).rejects.toMatchObject({ code: "changes_mismatch" });
    // All its boxes taken apart: it holds nothing and lets the shift close.
    at.db
      .prepare("UPDATE floor_boxes SET disassembled_at = closed_at WHERE shift_id = ?")
      .run(at.shift.copy.id);
    await expect(guard(at.shift.copy.id)).resolves.toEqual([1]);
    // Closed with its boxes: it does not keep the shift either.
    at.db
      .prepare("UPDATE floor_boxes SET disassembled_at = NULL WHERE shift_id = ?")
      .run(at.shift.copy.id);
    const [pallet] = rows(
      at.db,
      "SELECT id FROM floor_pallets WHERE shift_id = ?",
      at.shift.copy.id,
    );
    closeByHand(at, String(pallet?.["id"]), 150);
    await expect(guard(at.shift.copy.id)).resolves.toEqual([1]);
    // A shift this pairing does not have is no shift to close.
    await expect(guard("unknown")).rejects.toMatchObject({ code: "changes_mismatch" });
  });
});
