import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { closeShift } from "../src/floor/close/shift-close.js";
import {
  clearOpenBox,
  disassembleBox,
  reprintBox,
  undoLastCode,
  type ReprintContext,
} from "../src/floor/exceptions/box-exceptions.js";
import { disassemblePallet, reprintPallet } from "../src/floor/exceptions/pallet-exceptions.js";
import {
  closeOpenPallet,
  openPalletGuard,
  palletStep,
  shiftPallets,
  type PalletContext,
} from "../src/floor/pallets/pallets.js";
import {
  boxLabelStep,
  readOpenJob,
  sendLabelJob,
  type PrintJob,
} from "../src/floor/print/print-jobs.js";
import { checkLabel } from "../src/floor/print/print-resolution.js";
import { closeIfFull, closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import { readWorkTotals } from "../src/floor/work/work-reads.js";
import { HostError } from "../src/host/client.js";
import type { FactReceipt } from "../src/host/protocol.js";
import { sendFactBatch } from "../src/local/facts-sender.js";
import {
  countingIds,
  enteredShift,
  km,
  OPERATOR_ID,
  PAIRING,
  rows,
  scanContext,
  seedBlock,
  steppingClock,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { PALLET_BLOCK, PALLETS_ENTERED } from "./support/pallets.js";
import { fakeRender, manualRuntime, setUpPrinting } from "./support/printing.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/** The block the station holds: the host's first block of a new site, 1500–3499. */
const BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
/** The pallet block it holds (plan ПЛ-Ц): the host's first pallet block of a new site, 40–239. */
const PALLET_FROM = 40;
const PALLET_TO = 239;

/** How a send of the outbox ended: the host's receipts, no host at all, or an answer lost on its way back. */
type Answer = "receipts" | "unreachable" | "lost";

/**
 * The scenario both sides read (`proto/fixtures/floor-scenario.json`): the
 * station's ids of the shift and the block, the numbers it ends with, every
 * record it wrote, in the outbox's order, and every send of the outbox — the
 * records' ids and how the send ended. `host/tests/floor_scenario.rs` sends
 * the same batches to the host's router and checks that it takes every
 * record and ends with the same numbers. The shift has pallets (plan ПЛ-Ц):
 * the station's pallet block and its closed pallets are named too.
 */
const scenarioSchema = z.object({
  station: z.object({
    shiftId: z.string(),
    blockId: z.string(),
    palletBlockId: z.string(),
    acceptedUnits: z.number(),
    closedBoxes: z.number(),
    closedPallets: z.number(),
  }),
  records: z.array(z.object({ id: z.string() }).loose()),
  sends: z.array(
    z.object({ ids: z.array(z.string()), answer: z.enum(["receipts", "unreachable", "lost"]) }),
  ),
});
type Scenario = z.infer<typeof scenarioSchema>;

/**
 * The host of the scenario, from the station's side: it answers each send
 * as told next — receipts `accepted` for every record (what the host's
 * router answers, `host/tests/floor_scenario.rs` checks), no answer at all,
 * or an answer lost after the host took the batch — and keeps every send.
 */
function scenarioHost() {
  const sends: { ids: string[]; answer: Answer }[] = [];
  let next: Answer = "receipts";
  return {
    sends,
    answerNext: (answer: Answer) => {
      next = answer;
    },
    send: async (records: readonly unknown[]): Promise<FactReceipt[]> => {
      const ids = records.map((record) => z.object({ id: z.string() }).parse(record).id);
      const answer = next;
      next = "receipts";
      sends.push({ ids, answer });
      if (answer === "receipts") return ids.map((id) => ({ id, outcome: "accepted" }));
      throw new HostError({
        kind: "transport",
        code: "unreachable",
        message: answer === "lost" ? "the answer was lost" : "no host",
      });
    },
  };
}

/**
 * One shift with pallets of two boxes on one PC, with a stepping clock and
 * counting ids so that it writes the same records every time: three codes
 * fill a box, which opens a pallet, whose label is printed and checked, and
 * the outbox goes to the host. Then the host is away: two codes, the last
 * one taken out and scanned again, the box cleared; three more codes fill
 * it, it fills the pallet, which closes with it, and both labels are printed
 * and checked; the first box taken apart; the second box's label printed
 * again with a reason, and checked; the pallet's label printed again with a
 * reason, and checked; two of the freed codes in a third box, closed
 * incomplete with its label, on a second pallet; «Закрыть паллету и смену»:
 * the second pallet closed early with its label, then taken apart, and the
 * shift closed with a reason — all on this station alone. The host comes
 * back: a send that finds no host, one whose answer is lost, and one that
 * is answered.
 */
async function runScenario() {
  const { db, executor: local } = openLocalDb();
  const shift = await enteredShift(local, {
    ...PALLETS_ENTERED,
    boxCapacity: 3,
    palletBoxCapacity: 2,
  });
  const pallets = shiftPallets(shift);
  if (pallets === null) throw new Error("the shift has no pallets");
  seedBlock(db, { blockId: BLOCK, from: 1500, to: 3499 });
  seedBlock(db, { blockId: PALLET_BLOCK, from: PALLET_FROM, to: PALLET_TO, extension: 1 });
  const settings = await setUpPrinting(local, {
    verifyPrintedLabel: true,
    assignments: { box: "zebra", pallet: "zebra", duplicate: null },
  });
  const now = steppingClock();
  const newId = countingIds();
  const context = scanContext(local, shift, { now, newId });
  const palletContext: PalletContext = {
    ...context,
    operatorName: "Анна Кузнецова",
    render: fakeRender,
  };
  const { runtime } = manualRuntime(fakeHardware().hardware);
  const print: ReprintContext = {
    local,
    pairing: PAIRING,
    runtime,
    now,
    operatorId: OPERATOR_ID,
    newId,
    shift,
  };
  const steps = [
    boxLabelStep({
      local,
      pairing: PAIRING,
      shift,
      operatorName: "Анна Кузнецова",
      newId,
      render: fakeRender,
    }),
    palletStep(palletContext, pallets),
  ];
  const host = scenarioHost();

  /** The label that waits goes to the printer and is checked by a scan of its SSCC. */
  const printAndCheck = async (job: PrintJob | null) => {
    const waiting = job ?? (await readOpenJob(local, PAIRING, shift.copy.id));
    if (waiting === null) throw new Error("no label waits");
    const sent = waiting.state === "prepared" ? await sendLabelJob(print, waiting) : waiting;
    const checked = await checkLabel(print, sent, `]C100${sent.sscc}`);
    if (checked.kind !== "verified") throw new Error(checked.kind);
  };
  /** Every label that waits, the box's before its pallet's. */
  const printAndCheckAll = async () => {
    while ((await readOpenJob(local, PAIRING, shift.copy.id)) !== null) await printAndCheck(null);
  };
  const scan = async (serial: string) => {
    const outcome = await processScan(context, km(serial));
    if (outcome.kind !== "accepted") throw new Error(`${serial}: ${outcome.kind}`);
    const closed = await closeIfFull(context, steps);
    if (closed !== null) {
      if (closed.kind !== "closed") throw new Error(closed.kind);
      await printAndCheckAll();
    }
  };
  const deliver = async () => {
    try {
      await sendFactBatch(local, PAIRING, host.send, now);
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
    }
  };

  for (const serial of ["A1", "A2", "A3"]) await scan(serial);
  await deliver();
  const [firstBox] = rows(db, "SELECT id FROM floor_boxes WHERE serial = 1500");

  for (const serial of ["B1", "B2"]) await scan(serial);
  expect(await undoLastCode(context)).toMatchObject({ kind: "done" });
  await scan("B2");
  expect(await clearOpenBox(context)).toMatchObject({ kind: "done" });
  for (const serial of ["C1", "C2", "C3"]) await scan(serial);
  expect(
    await disassembleBox(context, String(firstBox?.["id"]), { code: "wrong_quantity", text: null }),
  ).toMatchObject({ kind: "done" });
  const [secondBox] = rows(db, "SELECT id FROM floor_boxes WHERE serial = 1501");
  const reprinted = await reprintBox(
    print,
    String(secondBox?.["id"]),
    { code: "damaged_label", text: null },
    settings,
    fakeRender,
  );
  await printAndCheck(reprinted);
  const [firstPallet] = rows(db, "SELECT id FROM floor_pallets WHERE serial = ?", PALLET_FROM);
  const reprintedPallet = await reprintPallet(
    print,
    pallets,
    String(firstPallet?.["id"]),
    { code: "unreadable_label", text: null },
    settings,
    fakeRender,
  );
  await printAndCheck(reprintedPallet);
  for (const serial of ["A1", "A2"]) await scan(serial);
  const third = await closeOpenBox(context, steps);
  if (third.kind !== "closed") throw new Error(third.kind);
  await printAndCheckAll();
  // «Закрыть паллету и смену»: the second pallet first, with its label.
  const secondPallet = await closeOpenPallet(palletContext, pallets);
  if (secondPallet.kind !== "closed") throw new Error(secondPallet.kind);
  await printAndCheckAll();
  expect(
    await disassemblePallet(context, secondPallet.pallet.palletId, {
      code: "other",
      text: "Собрана не на тот заказ",
    }),
  ).toMatchObject({ kind: "done" });
  expect(
    await closeShift(
      context,
      "production_order_changed",
      [openPalletGuard(PAIRING, shift.copy.id)],
      false,
    ),
  ).toMatchObject({ kind: "closed" });

  host.answerNext("unreachable");
  await deliver();
  host.answerNext("lost");
  await deliver();
  await deliver();

  const records = rows(db, "SELECT payload FROM outbox ORDER BY seq").map((row) =>
    z
      .object({ id: z.string() })
      .loose()
      .parse(JSON.parse(String(row["payload"]))),
  );
  const totals = await readWorkTotals(local, PAIRING, shift.copy.id);
  const [closedPallets] = rows(
    db,
    "SELECT count(*) AS n FROM floor_pallets WHERE closed_at IS NOT NULL AND disassembled_at IS NULL",
  );
  const scenario: Scenario = {
    station: {
      shiftId: shift.copy.id,
      blockId: BLOCK,
      palletBlockId: PALLET_BLOCK,
      acceptedUnits: totals.accepted,
      closedBoxes: totals.closedBoxes,
      closedPallets: Number(closedPallets?.["n"]),
    },
    records,
    sends: host.sends,
  };
  return { db, scenario };
}

describe("one shift with pallets on one PC, from the first code to the close, with the host away", () => {
  it("writes the records of the shared scenario, sends them in its batches, and ends closed", async () => {
    const { db, scenario } = await runScenario();
    const fixture = scenarioSchema.parse(
      JSON.parse(
        readFileSync(new URL("../proto/fixtures/floor-scenario.json", testModuleUrl), "utf8"),
      ),
    );
    expect(scenario).toEqual(fixture);
    expect(rows(db, "SELECT local_state FROM floor_shifts")).toEqual([{ local_state: "closed" }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([{ n: 0 }]);
    expect(scenario.records.map((record) => record["kind"])).toEqual([
      "scan",
      "scan",
      "scan",
      "box_closed",
      "box_label",
      "scan",
      "scan",
      "box_exception",
      "scan",
      "box_exception",
      "scan",
      "scan",
      "scan",
      "box_closed",
      "pallet_closed",
      "box_label",
      "pallet_label",
      "box_exception",
      "box_exception",
      "box_label",
      "pallet_exception",
      "pallet_label",
      "scan",
      "scan",
      "box_closed",
      "box_label",
      "pallet_closed",
      "pallet_label",
      "pallet_exception",
      "shift_closed",
    ]);
  });

  it("sends again, with the same ids, a batch that found no host or whose answer was lost", async () => {
    const { scenario } = await runScenario();
    const [online, unreachable, lost, answered] = scenario.sends;
    expect(online).toEqual({
      ids: scenario.records.slice(0, 5).map((r) => r.id),
      answer: "receipts",
    });
    expect(unreachable?.answer).toBe("unreachable");
    expect(lost).toEqual({ ids: unreachable?.ids, answer: "lost" });
    expect(answered).toEqual({ ids: unreachable?.ids, answer: "receipts" });
    expect(unreachable?.ids).toEqual(scenario.records.slice(5).map((r) => r.id));
    expect(scenario.sends).toHaveLength(4);
  });
});
