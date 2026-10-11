import { buildSscc } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  disassembleBox,
  InvalidReasonError,
  LabelWaitingError,
} from "../src/floor/exceptions/box-exceptions.js";
import {
  DISASSEMBLE_PALLET_SQL,
  disassemblePallet,
  LAST_PALLET_JOB_SQL,
  NEWEST_PALLET_JOB_GUARD_SQL,
  PalletTemplateChangedError,
  PalletUnavailableError,
  readClosedPallets,
  reprintPallet,
} from "../src/floor/exceptions/pallet-exceptions.js";
import { PALLET_EXTENSION, PALLET_LIVE_GUARD_SQL } from "../src/floor/pallets/pallets.js";
import {
  readPrintJob,
  sendLabelJob,
  StaleJobError,
  type PrintJob,
} from "../src/floor/print/print-jobs.js";
import { checkLabel, printAgain, skipLabel } from "../src/floor/print/print-resolution.js";
import {
  enteredShift,
  failingWrites,
  holdingWrites,
  OPERATOR_ID,
  PAIRING,
  PREFIX,
  rows,
  SECOND,
  SHIFT_ID,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxOnPallet,
  palletContext,
  palletStation,
  type PalletStation,
} from "./support/pallets.js";
import {
  fakeRender,
  manualRuntime,
  renderedText,
  resolveContext,
  ZEBRA,
} from "./support/printing.js";

const PALLET_SSCC = buildSscc(PALLET_EXTENSION, PREFIX, 0);

function resolving(at: PalletStation, shell = fakeHardware()) {
  // Ids that never meet again: a test reprints one pallet more than once.
  return {
    ...resolveContext(at.local, manualRuntime(shell.hardware).runtime),
    newId: () => crypto.randomUUID(),
  };
}

/** The station's pallet records for the host, in their order. */
function palletRecords(at: PalletStation) {
  return rows(
    at.db,
    "SELECT kind, payload FROM outbox WHERE kind IN ('pallet_label', 'pallet_exception') ORDER BY seq",
  ).map((row) => ({
    kind: row["kind"],
    data: (JSON.parse(String(row["payload"])) as { data: Record<string, unknown> }).data,
  }));
}

/** Two boxes close a pallet of two; its label is sent once, as the work screen sends it. */
async function closedPallet(
  options: Parameters<typeof palletStation>[0] = {},
): Promise<{ at: PalletStation; palletId: string; job: PrintJob }> {
  const at = await palletStation({ capacity: 2, ...options });
  await closeBoxOnPallet(at, ["A1", "A2"]);
  await closeBoxOnPallet(at, ["B1"]);
  const [row] = rows(at.db, "SELECT id FROM floor_print_jobs WHERE purpose = 'pallet'");
  const prepared = await readPrintJob(at.local, PAIRING, String(row?.["id"]));
  if (prepared === null) throw new Error("the pallet closed without its job");
  const job = await sendLabelJob(resolving(at), prepared);
  return { at, palletId: prepared.subjectId, job };
}

describe("the label of a pallet (plan ПЛ-Ц)", () => {
  it("is checked by the scan of its SSCC, with a `pallet_label` record", async () => {
    const { at, palletId, job } = await closedPallet({ settings: { verifyPrintedLabel: true } });
    expect(job).toMatchObject({ state: "sent", verify: true, purpose: "pallet" });
    const result = await checkLabel(resolving(at), job, `(00)${PALLET_SSCC}`);
    expect(result).toMatchObject({ kind: "verified", job: { state: "verified" } });
    expect(palletRecords(at)).toEqual([
      { kind: "pallet_label", data: { palletId, outcome: "verified", at: expect.any(String) } },
    ]);
  });

  it("is skipped with a `pallet_label` record `skipped`", async () => {
    const { at, palletId, job } = await closedPallet({ settings: { verifyPrintedLabel: true } });
    await skipLabel(resolving(at), job);
    expect(palletRecords(at)).toEqual([
      { kind: "pallet_label", data: { palletId, outcome: "skipped", at: expect.any(String) } },
    ]);
  });

  it("printed again where it may exist writes the pallet's reprint with its reason as it sends", async () => {
    const at = await palletStation({ capacity: 1 });
    await closeBoxOnPallet(at, ["A1"]);
    const [row] = rows(at.db, "SELECT id FROM floor_print_jobs WHERE purpose = 'pallet'");
    const prepared = await readPrintJob(at.local, PAIRING, String(row?.["id"]));
    if (prepared === null) throw new Error("no job");
    const unknown = await sendLabelJob(
      resolving(
        at,
        fakeHardware(async () => ({ sent: false, code: "outcome_unknown" })),
      ),
      prepared,
    );
    expect(unknown).toMatchObject({ state: "unknown" });
    const shell = fakeHardware();
    const again = await printAgain(
      resolving(at, shell),
      unknown,
      { reason: "printer_jam", printer: null },
      at.settings,
      at.pallets.template,
    );
    expect(again).toMatchObject({ state: "sent", attempts: 2 });
    expect(shell.sends.map((send) => send.text)).toEqual([
      renderedText(ZEBRA, PALLET_SSCC, "100x150"),
    ]);
    expect(palletRecords(at)).toEqual([
      {
        kind: "pallet_exception",
        data: {
          exception: "reprint",
          palletId: prepared.subjectId,
          reasonCode: "printer_jam",
          reasonText: null,
          occurredAt: expect.any(String),
        },
      },
    ]);
    expect(rows(at.db, "SELECT kind, pallet_id, reason_code FROM floor_pallet_exceptions")).toEqual(
      [{ kind: "reprint", pallet_id: prepared.subjectId, reason_code: "printer_jam" }],
    );
  });
});

describe("the closed pallets of a shift (plan ПЛ-Ц)", () => {
  it("are the closed ones not taken apart, the last first, with the boxes they hold", async () => {
    const { at, palletId } = await closedPallet();
    await closeBoxOnPallet(at, ["C1"]);
    await closeBoxOnPallet(at, ["D1"]);
    const listed = await readClosedPallets(at.local, PAIRING, at.shift.copy.id);
    expect(listed.map((pallet) => pallet.boxCount)).toEqual([2, 2]);
    expect(listed[1]).toMatchObject({ id: palletId, sscc: PALLET_SSCC });
    expect(listed[0]?.sscc).toBe(buildSscc(PALLET_EXTENSION, PREFIX, 1));
    // An open pallet is no closed one.
    await closeBoxOnPallet(at, ["E1"]);
    await expect(readClosedPallets(at.local, PAIRING, at.shift.copy.id)).resolves.toHaveLength(2);
  });
});

describe("«Расформировать паллету» (plan ПЛ-Ц)", () => {
  it("takes the pallet apart with its reason; its boxes stay closed, with their codes and their pallet", async () => {
    const { at, palletId } = await closedPallet();
    const context = palletContext(at);
    await expect(
      disassemblePallet(context, palletId, { code: "other", text: "  Не тот заказ " }),
    ).resolves.toEqual({ kind: "done", boxes: 2 });
    expect(rows(at.db, "SELECT disassembled_at IS NOT NULL AS apart FROM floor_pallets")).toEqual([
      { apart: 1 },
    ]);
    expect(
      rows(at.db, "SELECT pallet_id, disassembled_at FROM floor_boxes ORDER BY closed_at"),
    ).toEqual([
      { pallet_id: palletId, disassembled_at: null },
      { pallet_id: palletId, disassembled_at: null },
    ]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 3 }]);
    expect(palletRecords(at)).toEqual([
      {
        kind: "pallet_exception",
        data: {
          exception: "disassemble",
          palletId,
          reasonCode: "other",
          reasonText: "Не тот заказ",
          occurredAt: expect.any(String),
        },
      },
    ]);
    await expect(readClosedPallets(at.local, PAIRING, at.shift.copy.id)).resolves.toEqual([]);
    // Taken apart once: a second time is no closed pallet any more.
    await expect(
      disassemblePallet(context, palletId, { code: "wrong_product", text: null }),
    ).rejects.toBeInstanceOf(PalletUnavailableError);
  });

  it("refuses an open pallet, and words with any reason but «Другая причина», writing nothing", async () => {
    const { at, palletId } = await closedPallet();
    await closeBoxOnPallet(at, ["C1"]);
    const [open] = rows(at.db, "SELECT id FROM floor_pallets WHERE closed_at IS NULL");
    const context = palletContext(at);
    await expect(
      disassemblePallet(context, String(open?.["id"]), { code: "wrong_product", text: null }),
    ).rejects.toBeInstanceOf(PalletUnavailableError);
    await expect(
      disassemblePallet(context, palletId, { code: "wrong_product", text: "Не тот товар" }),
    ).rejects.toBeInstanceOf(InvalidReasonError);
    expect(palletRecords(at)).toEqual([]);
  });

  it("takes a pallet apart once when two disassemblies of it race", async () => {
    const { at, palletId } = await closedPallet();
    const held = holdingWrites(at.local);
    held.holdNext();
    const first = disassemblePallet(palletContext({ ...at, local: held.executor }), palletId, {
      code: "wrong_quantity",
      text: null,
    });
    await held.reached();
    await disassemblePallet(palletContext(at), palletId, { code: "wrong_product", text: null });
    held.release();
    await expect(first).resolves.toEqual({ kind: "stale" });
    expect(palletRecords(at).map((record) => record.data["reasonCode"])).toEqual(["wrong_product"]);
  });

  it("is refused by its own transaction while the pallet's label job is open, writing nothing", async () => {
    const { at, palletId } = await closedPallet({ settings: { verifyPrintedLabel: true } });
    const context = palletContext(at);
    await expect(
      disassemblePallet(context, palletId, { code: "wrong_product", text: null }),
    ).rejects.toBeInstanceOf(LabelWaitingError);
    expect(rows(at.db, "SELECT disassembled_at FROM floor_pallets")).toEqual([
      { disassembled_at: null },
    ]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_pallet_exceptions")).toEqual([{ n: 0 }]);
    expect(palletRecords(at)).toEqual([]);
    // Decided, the label no longer holds the pallet.
    at.db.prepare("UPDATE floor_print_jobs SET state = 'skipped' WHERE purpose = 'pallet'").run();
    await expect(
      disassemblePallet(context, palletId, { code: "wrong_product", text: null }),
    ).resolves.toEqual({ kind: "done", boxes: 2 });
  });

  it("writes nothing when the pallet's label job opens between its read and its write", async () => {
    const { at, palletId } = await closedPallet();
    const held = holdingWrites(at.local);
    held.holdNext();
    const apart = disassemblePallet(palletContext({ ...at, local: held.executor }), palletId, {
      code: "wrong_quantity",
      text: null,
    });
    await held.reached();
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'unknown', error_code = 'outcome_unknown' WHERE purpose = 'pallet'",
      )
      .run();
    held.release();
    await expect(apart).rejects.toBeInstanceOf(LabelWaitingError);
    expect(rows(at.db, "SELECT disassembled_at FROM floor_pallets")).toEqual([
      { disassembled_at: null },
    ]);
    expect(palletRecords(at)).toEqual([]);
  });
});

describe("«Перепечатать этикетку паллеты» (plan ПЛ-Ц)", () => {
  it("prints the same label again with the reason, the dates of the pallet's own close, once", async () => {
    const { at, palletId, job } = await closedPallet();
    const shell = fakeHardware();
    const reprinted = await reprintPallet(
      { ...resolving(at, shell), shift: at.shift },
      at.pallets,
      palletId,
      { code: "damaged_label", text: null },
      at.settings,
      fakeRender,
    );
    expect(reprinted).toMatchObject({
      purpose: "pallet",
      subjectId: palletId,
      sscc: PALLET_SSCC,
      state: "sent",
      attempts: 1,
      fields: job.fields,
      templateId: at.pallets.template.id,
      templateRev: 63,
    });
    expect(reprinted.id).not.toBe(job.id);
    expect(shell.sends).toHaveLength(1);
    expect(palletRecords(at)).toEqual([
      {
        kind: "pallet_exception",
        data: {
          exception: "reprint",
          palletId,
          reasonCode: "damaged_label",
          reasonText: null,
          occurredAt: expect.any(String),
        },
      },
    ]);
  });

  it("leaves a label that still waits to its panel, and refuses a pallet taken apart", async () => {
    const { at, palletId } = await closedPallet({ settings: { verifyPrintedLabel: true } });
    const context = { ...resolving(at), shift: at.shift };
    await expect(
      reprintPallet(
        context,
        at.pallets,
        palletId,
        { code: "printer_jam", text: null },
        at.settings,
      ),
    ).rejects.toBeInstanceOf(LabelWaitingError);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'skipped' WHERE purpose = 'pallet'").run();
    await disassemblePallet(palletContext(at), palletId, { code: "wrong_product", text: null });
    await expect(
      reprintPallet(
        context,
        at.pallets,
        palletId,
        { code: "printer_jam", text: null },
        at.settings,
      ),
    ).rejects.toBeInstanceOf(PalletUnavailableError);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ n: 1 }]);
  });
});

/** The `pallet_exception` and `pallet_label` records as stored, with their envelope. */
function palletEnvelopes(at: PalletStation) {
  return rows(
    at.db,
    "SELECT kind, shift_id, payload FROM outbox WHERE kind IN ('pallet_label', 'pallet_exception') " +
      "ORDER BY seq",
  ).map((row) => {
    const record = JSON.parse(String(row["payload"])) as Record<string, unknown>;
    return { kind: row["kind"], column: row["shift_id"], record };
  });
}

/** A closed pallet of another pairing in the same shift, with a box of its own on it. */
function seedForeignPallet(
  at: PalletStation,
  pairing: { hostId: string; deviceId: string },
  id: string,
  digit: string,
): void {
  at.db
    .prepare(
      "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
        "block_id, serial) VALUES (?, ?, ?, ?, '2026-10-08T06:00:00.000Z', " +
        "'2026-10-08T06:59:00.000Z', ?, 'foreign-block', 7)",
    )
    .run(id, pairing.hostId, pairing.deviceId, SHIFT_ID, `1${digit}`.padEnd(18, "0"));
}

const FOREIGN = [
  { hostId: PAIRING.hostId, deviceId: "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f" },
  { hostId: "7a1c3e5f-9b2d-4f60-8a1c-3e5f7a9b1d2c", deviceId: PAIRING.deviceId },
] as const;

describe("the records of a pallet's exceptions (plan ПЛ-Ц)", () => {
  it("carry the shift, the operator, the reason and the one instant of the disassembly in the row, the fact and the pallet", async () => {
    const { at, palletId } = await closedPallet();
    await disassemblePallet(palletContext(at), palletId, { code: "other", text: " Смят угол " });
    const [pallet] = rows(at.db, "SELECT disassembled_at FROM floor_pallets");
    const [row] = rows(
      at.db,
      "SELECT host_id, device_id, shift_id, kind, pallet_id, reason_code, reason_text, " +
        "occurred_at, operator_id FROM floor_pallet_exceptions",
    );
    expect(row).toEqual({
      host_id: PAIRING.hostId,
      device_id: PAIRING.deviceId,
      shift_id: SHIFT_ID,
      kind: "disassemble",
      pallet_id: palletId,
      reason_code: "other",
      reason_text: "Смят угол",
      occurred_at: pallet?.["disassembled_at"],
      operator_id: OPERATOR_ID,
    });
    const [envelope] = palletEnvelopes(at);
    expect(envelope).toMatchObject({
      kind: "pallet_exception",
      column: SHIFT_ID,
      record: {
        kind: "pallet_exception",
        shiftId: SHIFT_ID,
        operatorId: OPERATOR_ID,
        data: {
          exception: "disassemble",
          palletId,
          reasonCode: "other",
          reasonText: "Смят угол",
          occurredAt: pallet?.["disassembled_at"],
        },
      },
    });
    // The record has an id of its own, which keys the host's receipt, not the row's.
    const [stored] = rows(at.db, "SELECT id FROM floor_pallet_exceptions");
    expect(envelope?.record["id"]).toEqual(expect.any(String));
    expect(envelope?.record["id"]).not.toBe(stored?.["id"]);
  });

  it("name the shift and the operator on a reprint and on the label's check", async () => {
    const { at, palletId, job } = await closedPallet({ settings: { verifyPrintedLabel: true } });
    await checkLabel(resolving(at), job, PALLET_SSCC);
    const shell = fakeHardware();
    const reprinted = await reprintPallet(
      { ...resolving(at, shell), shift: at.shift },
      at.pallets,
      palletId,
      { code: "printer_jam", text: null },
      { ...at.settings, verifyPrintedLabel: false },
      fakeRender,
    );
    expect(reprinted.operatorId).toBe(OPERATOR_ID);
    expect(palletEnvelopes(at).map((entry) => entry.record)).toMatchObject([
      { kind: "pallet_label", shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
      { kind: "pallet_exception", shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
    ]);
    expect(
      rows(
        at.db,
        "SELECT host_id, device_id, shift_id, kind, pallet_id, operator_id, occurred_at " +
          "FROM floor_pallet_exceptions",
      ),
    ).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        shift_id: SHIFT_ID,
        kind: "reprint",
        pallet_id: palletId,
        operator_id: OPERATOR_ID,
        occurred_at: reprinted.createdAt,
      },
    ]);
  });

  it("are not made for a mismatching or unreadable scan of the label, and a failed label is skipped with its record", async () => {
    const { at, job } = await closedPallet({ settings: { verifyPrintedLabel: true } });
    const other = buildSscc(PALLET_EXTENSION, PREFIX, 5);
    await expect(checkLabel(resolving(at), job, other)).resolves.toEqual({
      kind: "mismatch",
      sscc: other,
    });
    await expect(checkLabel(resolving(at), job, "not a code")).resolves.toEqual({
      kind: "not_sscc",
    });
    expect(palletRecords(at)).toEqual([]);
    const failed = await closedPallet({ settings: { verifyPrintedLabel: true } });
    failed.at.db
      .prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'")
      .run();
    const stored = await readPrintJob(failed.at.local, PAIRING, failed.job.id);
    if (stored === null) throw new Error("no job");
    await skipLabel(resolving(failed.at), stored);
    expect(palletRecords(failed.at)).toEqual([
      {
        kind: "pallet_label",
        data: { palletId: failed.palletId, outcome: "skipped", at: expect.any(String) },
      },
    ]);
  });

  it("are not made when a failed label is printed again, which needs no reason", async () => {
    const { at, palletId, job } = await closedPallet();
    at.db.prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'").run();
    const stored = await readPrintJob(at.local, PAIRING, job.id);
    if (stored === null) throw new Error("no job");
    const again = await printAgain(
      resolving(at),
      stored,
      { reason: null, printer: null },
      at.settings,
      at.pallets.template,
    );
    expect(again).toMatchObject({ state: "sent", subjectId: palletId });
    expect(palletRecords(at)).toEqual([]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_pallet_exceptions")).toEqual([{ n: 0 }]);
  });
});

describe("the closed pallets of a shift, beyond the first list (plan ПЛ-Ц)", () => {
  it("count the boxes not taken apart, and name the pallet closed last first whatever its serial", async () => {
    const { at, palletId } = await closedPallet();
    await closeBoxOnPallet(at, ["C1"]);
    await closeBoxOnPallet(at, ["D1"]);
    const [first, second] = rows(at.db, "SELECT id FROM floor_pallets ORDER BY serial");
    const [box] = rows(
      at.db,
      "SELECT id FROM floor_boxes WHERE pallet_id = ? ORDER BY closed_at",
      palletId,
    );
    await disassembleBox(palletContext(at), String(box?.["id"]), {
      code: "wrong_product",
      text: null,
    });
    const byClose = async () =>
      (await readClosedPallets(at.local, PAIRING, SHIFT_ID)).map((pallet) => pallet.id);
    expect(await byClose()).toEqual([second?.["id"], first?.["id"]]);
    expect((await readClosedPallets(at.local, PAIRING, SHIFT_ID)).map((p) => p.boxCount)).toEqual([
      2, 1,
    ]);
    // The instant of the close comes before the serial: the first serial closed last is first.
    at.db
      .prepare("UPDATE floor_pallets SET closed_at = '2026-10-09T00:00:00.000Z' WHERE id = ?")
      .run(String(first?.["id"]));
    expect(await byClose()).toEqual([first?.["id"], second?.["id"]]);
    // At one instant, the larger serial is first.
    at.db.prepare("UPDATE floor_pallets SET closed_at = '2026-10-09T00:00:00.000Z'").run();
    expect(await byClose()).toEqual([second?.["id"], first?.["id"]]);
  });

  it("are the pairing's and the shift's own", async () => {
    const { at, palletId } = await closedPallet();
    const other = await enteredShift(at.local, SECOND);
    seedForeignPallet(at, FOREIGN[0], "foreign-pallet-device", "2");
    seedForeignPallet(at, FOREIGN[1], "foreign-pallet-host", "3");
    expect((await readClosedPallets(at.local, PAIRING, SHIFT_ID)).map((p) => p.id)).toEqual([
      palletId,
    ]);
    expect((await readClosedPallets(at.local, FOREIGN[0], SHIFT_ID)).map((p) => p.id)).toEqual([
      "foreign-pallet-device",
    ]);
    expect((await readClosedPallets(at.local, FOREIGN[1], SHIFT_ID)).map((p) => p.id)).toEqual([
      "foreign-pallet-host",
    ]);
    await expect(readClosedPallets(at.local, PAIRING, other.copy.id)).resolves.toEqual([]);
  });
});

describe("«Расформировать паллету», beyond the first list (plan ПЛ-Ц)", () => {
  it("counts only the boxes not taken apart", async () => {
    const { at, palletId } = await closedPallet();
    const [box] = rows(
      at.db,
      "SELECT id FROM floor_boxes WHERE pallet_id = ? ORDER BY closed_at",
      palletId,
    );
    await disassembleBox(palletContext(at), String(box?.["id"]), {
      code: "wrong_product",
      text: null,
    });
    await expect(
      disassemblePallet(palletContext(at), palletId, { code: "wrong_product", text: null }),
    ).resolves.toEqual({ kind: "done", boxes: 1 });
  });

  it("refuses a reason of the other list and words that cannot be kept, writing nothing", async () => {
    const { at, palletId } = await closedPallet();
    const context = palletContext(at);
    for (const reason of [
      // A reprint's reason is no reason of a disassembly.
      { code: "printer_jam" as "other", text: null },
      { code: "other" as const, text: "Я".repeat(201) },
      { code: "other" as const, text: "line\nbreak" },
      { code: "damaged_package" as const, text: "words" },
    ]) {
      await expect(disassemblePallet(context, palletId, reason)).rejects.toBeInstanceOf(
        InvalidReasonError,
      );
    }
    expect(rows(at.db, "SELECT disassembled_at FROM floor_pallets")).toEqual([
      { disassembled_at: null },
    ]);
    expect(palletRecords(at)).toEqual([]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_pallet_exceptions")).toEqual([{ n: 0 }]);
    // Blanks typed as the words of `other` keep none.
    await disassemblePallet(context, palletId, { code: "other", text: "   " });
    expect(rows(at.db, "SELECT reason_code, reason_text FROM floor_pallet_exceptions")).toEqual([
      { reason_code: "other", reason_text: null },
    ]);
  });

  it("refuses the pallet of another shift or of another pairing, whatever its state", async () => {
    const { at, palletId } = await closedPallet();
    const other = await enteredShift(at.local, SECOND);
    seedForeignPallet(at, FOREIGN[0], "foreign-pallet-device", "2");
    seedForeignPallet(at, FOREIGN[1], "foreign-pallet-host", "3");
    const reason = { code: "wrong_product" as const, text: null };
    await expect(
      disassemblePallet(palletContext({ local: at.local, shift: other }), palletId, reason),
    ).rejects.toBeInstanceOf(PalletUnavailableError);
    for (const id of ["foreign-pallet-device", "foreign-pallet-host"]) {
      await expect(disassemblePallet(palletContext(at), id, reason)).rejects.toBeInstanceOf(
        PalletUnavailableError,
      );
    }
    expect(rows(at.db, "SELECT disassembled_at FROM floor_pallets")).toEqual([
      { disassembled_at: null },
      { disassembled_at: null },
      { disassembled_at: null },
    ]);
    expect(palletRecords(at)).toEqual([]);
  });

  it("is stale, writing nothing, for a shift this station has closed", async () => {
    const { at, palletId } = await closedPallet();
    at.db.prepare("UPDATE floor_shifts SET local_state = 'closed'").run();
    await expect(
      disassemblePallet(palletContext(at), palletId, { code: "wrong_product", text: null }),
    ).resolves.toEqual({ kind: "stale" });
    expect(rows(at.db, "SELECT disassembled_at FROM floor_pallets")).toEqual([
      { disassembled_at: null },
    ]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_pallet_exceptions")).toEqual([{ n: 0 }]);
  });

  it("rejects, rather than call it stale, when the write itself fails", async () => {
    const { at, palletId } = await closedPallet();
    await expect(
      disassemblePallet(palletContext({ ...at, local: failingWrites(at.local) }), palletId, {
        code: "wrong_product",
        text: null,
      }),
    ).rejects.toThrow("disk is full");
    expect(rows(at.db, "SELECT disassembled_at FROM floor_pallets")).toEqual([
      { disassembled_at: null },
    ]);
  });

  it("is a comparison of its own statement: it takes apart a closed pallet of the pairing and the shift once", async () => {
    const { at, palletId } = await closedPallet();
    await closeBoxOnPallet(at, ["C1"]);
    const [open] = rows(at.db, "SELECT id FROM floor_pallets WHERE closed_at IS NULL");
    seedForeignPallet(at, FOREIGN[0], "foreign-pallet-device", "2");
    seedForeignPallet(at, FOREIGN[1], "foreign-pallet-host", "3");
    const run = (id: string, pairing = PAIRING, shift = SHIFT_ID): number =>
      Number(
        at.db
          .prepare(DISASSEMBLE_PALLET_SQL)
          .run("2026-10-09T00:00:00.000Z", id, pairing.hostId, pairing.deviceId, shift).changes,
      );
    expect(run(String(open?.["id"]))).toBe(0);
    expect(run(palletId, FOREIGN[0])).toBe(0);
    expect(run(palletId, FOREIGN[1])).toBe(0);
    expect(run(palletId, PAIRING, "another-shift")).toBe(0);
    expect(run("foreign-pallet-device")).toBe(0);
    expect(run(palletId)).toBe(1);
    expect(run(palletId)).toBe(0);
  });
});

describe("«Перепечатать этикетку паллеты», beyond the first list (plan ПЛ-Ц)", () => {
  async function reprint(
    at: PalletStation,
    palletId: string,
    shell = fakeHardware(),
    overrides: Partial<Parameters<typeof reprintPallet>[1]> = {},
    settings = at.settings,
  ) {
    return reprintPallet(
      { ...resolving(at, shell), shift: at.shift },
      { ...at.pallets, ...overrides },
      palletId,
      { code: "damaged_label", text: null },
      settings,
      fakeRender,
    );
  }

  it("writes the new job and its exception at one instant, and keeps the old job as it was", async () => {
    const { at, palletId, job } = await closedPallet();
    const reprinted = await reprint(at, palletId);
    const [exception] = rows(at.db, "SELECT occurred_at FROM floor_pallet_exceptions");
    expect(reprinted.createdAt).toBe(exception?.["occurred_at"]);
    expect(reprinted.operatorId).toBe(OPERATOR_ID);
    expect(reprinted.printer).toMatchObject({ id: "zebra" });
    expect(await readPrintJob(at.local, PAIRING, job.id)).toEqual(job);
  });

  it("copies the pallet's newest job, whatever the clock says, and no other label's", async () => {
    const { at, palletId, job } = await closedPallet();
    const first = await reprint(at, palletId);
    const state = (id: string, state: "sent" | "failed") =>
      at.db
        .prepare("UPDATE floor_print_jobs SET state = ?, error_code = ? WHERE id = ?")
        .run(state, state === "failed" ? "not_sent" : null, id);
    const created = (id: string, createdAt: string) =>
      at.db.prepare("UPDATE floor_print_jobs SET created_at = ? WHERE id = ?").run(createdAt, id);
    // The newest job by insertion waits, though its clock is the earliest: no second reprint.
    state(first.id, "failed");
    created(job.id, "2999-01-01T00:00:00.000Z");
    await expect(reprint(at, palletId)).rejects.toBeInstanceOf(LabelWaitingError);
    // The same, though its clock is the latest.
    created(job.id, "2000-01-01T00:00:00.000Z");
    created(first.id, "2999-01-01T00:00:00.000Z");
    await expect(reprint(at, palletId)).rejects.toBeInstanceOf(LabelWaitingError);
    state(first.id, "sent");
    const second = await reprint(at, palletId);
    expect(second.sscc).toBe(PALLET_SSCC);
    // A box's job of the same subject id, a pallet's job of another pairing, all newer and
    // waiting, and another shift's, newer and done with, are no job of this pallet: each
    // carries another SSCC and is told apart by it, or by waiting.
    const copy = (id: string, purpose: string, device: string, shift: string, sscc: string) =>
      at.db
        .prepare(
          "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, sscc, " +
            "state, verify, template_id, template_rev, fields, printer, bytes_base64, error_code, " +
            "attempts, operator_id, created_at, updated_at) SELECT ?, host_id, ?, ?, ?, subject_id, " +
            "?, ?, 0, template_id, template_rev, fields, printer, bytes_base64, ?, 1, " +
            "operator_id, created_at, updated_at FROM floor_print_jobs WHERE id = ?",
        )
        .run(
          id,
          device,
          shift,
          purpose,
          sscc,
          shift === SHIFT_ID ? "failed" : "sent",
          shift === SHIFT_ID ? "not_sent" : null,
          second.id,
        );
    copy("decoy-box", "box", PAIRING.deviceId, SHIFT_ID, "000000000000000001");
    copy("decoy-device", "pallet", FOREIGN[0].deviceId, SHIFT_ID, "000000000000000002");
    copy("decoy-shift", "pallet", PAIRING.deviceId, "another-shift", "000000000000000003");
    const third = await reprint(at, palletId);
    expect(third.id).not.toBe(second.id);
    expect(third.sscc).toBe(PALLET_SSCC);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE subject_id = ?", palletId),
    ).toEqual([{ n: 7 }]);
  });

  it("refuses a template of another revision or another layout, writing nothing", async () => {
    const { at, palletId } = await closedPallet();
    for (const changed of [
      { ...at.pallets.template, rev: at.pallets.template.rev + 1 },
      { ...at.pallets.template, id: "5b4a39281706f5e4d3c2b1a09f8e7d6c" },
    ]) {
      const shell = fakeHardware();
      const error = await reprint(at, palletId, shell, { template: changed }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PalletTemplateChangedError);
      expect(error).toBeInstanceOf(PalletUnavailableError);
      expect(shell.sends).toEqual([]);
    }
    expect(palletRecords(at)).toEqual([]);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ n: 1 }]);
  });

  it("refuses an open pallet, a pallet without a job and another pairing's or shift's, writing nothing", async () => {
    const { at, palletId } = await closedPallet();
    await closeBoxOnPallet(at, ["C1"]);
    const [open] = rows(at.db, "SELECT id FROM floor_pallets WHERE closed_at IS NULL");
    seedForeignPallet(at, FOREIGN[0], "foreign-pallet-device", "2");
    seedForeignPallet(at, FOREIGN[1], "foreign-pallet-host", "3");
    for (const id of [String(open?.["id"]), "foreign-pallet-device", "foreign-pallet-host"]) {
      await expect(reprint(at, id)).rejects.toBeInstanceOf(PalletUnavailableError);
    }
    const other = await enteredShift(at.local, SECOND);
    await expect(
      reprintPallet(
        { ...resolving(at), shift: other },
        at.pallets,
        palletId,
        { code: "damaged_label", text: null },
        at.settings,
        fakeRender,
      ),
    ).rejects.toBeInstanceOf(PalletUnavailableError);
    at.db.prepare("DELETE FROM floor_print_jobs WHERE purpose = 'pallet'").run();
    await expect(reprint(at, palletId)).rejects.toBeInstanceOf(PalletUnavailableError);
    expect(palletRecords(at)).toEqual([]);
  });

  it("refuses a reason of the other list and words of any reason but `other`, writing nothing", async () => {
    const { at, palletId } = await closedPallet();
    const shell = fakeHardware();
    const run = (reason: Parameters<typeof reprintPallet>[3]) =>
      reprintPallet(
        { ...resolving(at, shell), shift: at.shift },
        at.pallets,
        palletId,
        reason,
        at.settings,
        fakeRender,
      );
    // A disassembly's reason is no reason of a reprint.
    await expect(run({ code: "wrong_product" as "other", text: null })).rejects.toBeInstanceOf(
      InvalidReasonError,
    );
    await expect(run({ code: "printer_jam", text: "words" })).rejects.toBeInstanceOf(
      InvalidReasonError,
    );
    expect(palletRecords(at)).toEqual([]);
    expect(shell.sends).toEqual([]);
    await run({ code: "other", text: " Не видно штрихкода " });
    expect(rows(at.db, "SELECT reason_code, reason_text FROM floor_pallet_exceptions")).toEqual([
      { reason_code: "other", reason_text: "Не видно штрихкода" },
    ]);
  });

  it("writes no record of a pallet taken apart between its read and its write, and sends nothing", async () => {
    const { at, palletId } = await closedPallet();
    const shell = fakeHardware();
    const held = holdingWrites(at.local);
    held.holdNext();
    const reprinting = reprintPallet(
      { ...resolving(at, shell), local: held.executor, shift: at.shift },
      at.pallets,
      palletId,
      { code: "damaged_label", text: null },
      at.settings,
      fakeRender,
    );
    const outcome = reprinting.catch((caught: unknown) => caught);
    await held.reached();
    await disassemblePallet(palletContext(at), palletId, { code: "wrong_product", text: null });
    held.release();
    expect(await outcome).toBeInstanceOf(PalletUnavailableError);
    expect(palletRecords(at).map((record) => record.data["exception"])).toEqual(["disassemble"]);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ n: 1 }]);
    expect(shell.sends).toEqual([]);
  });

  it("prints once when two reprints of one pallet race: the later write is stale", async () => {
    const { at, palletId } = await closedPallet();
    const held = holdingWrites(at.local);
    held.holdNext();
    const slow = fakeHardware();
    const first = reprintPallet(
      { ...resolving(at, slow), local: held.executor, shift: at.shift },
      at.pallets,
      palletId,
      { code: "damaged_label", text: null },
      at.settings,
      fakeRender,
    );
    const outcome = first.catch((caught: unknown) => caught);
    await held.reached();
    const quick = fakeHardware();
    await reprint(at, palletId, quick);
    held.release();
    expect(await outcome).toBeInstanceOf(StaleJobError);
    expect(slow.sends).toEqual([]);
    expect(quick.sends).toHaveLength(1);
    expect(palletRecords(at).map((record) => record.data["exception"])).toEqual(["reprint"]);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ n: 2 }]);
  });

  it("keeps a job `failed`, with its exception, when no printer is assigned to pallets or the label does not render", async () => {
    const { at, palletId } = await closedPallet();
    const shell = fakeHardware();
    const bare = { ...at.settings, assignments: { ...at.settings.assignments, pallet: null } };
    const unassigned = await reprint(at, palletId, shell, {}, bare);
    expect(unassigned).toMatchObject({ state: "failed", errorCode: "printer_unconfigured" });
    expect(shell.sends).toEqual([]);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'skipped', error_code = NULL").run();
    const broken = await reprintPallet(
      { ...resolving(at, shell), shift: at.shift },
      at.pallets,
      palletId,
      { code: "damaged_label", text: null },
      at.settings,
      async () => {
        throw new Error("no canvas");
      },
    );
    expect(broken).toMatchObject({ state: "failed", errorCode: "render_failed" });
    expect(shell.sends).toEqual([]);
    expect(palletRecords(at).map((record) => record.data["exception"])).toEqual([
      "reprint",
      "reprint",
    ]);
  });

  it("renders nothing for a pallet taken apart or never closed", async () => {
    const { at, palletId } = await closedPallet();
    await closeBoxOnPallet(at, ["C1"]);
    const [open] = rows(at.db, "SELECT id FROM floor_pallets WHERE closed_at IS NULL");
    await disassemblePallet(palletContext(at), palletId, { code: "wrong_product", text: null });
    const render = vi.fn(fakeRender);
    for (const id of [palletId, String(open?.["id"])]) {
      await expect(
        reprintPallet(
          { ...resolving(at), shift: at.shift },
          at.pallets,
          id,
          { code: "damaged_label", text: null },
          at.settings,
          render,
        ),
      ).rejects.toBeInstanceOf(PalletUnavailableError);
    }
    expect(render).not.toHaveBeenCalled();
  });

  it("rejects, rather than call it stale, when the write itself fails", async () => {
    const { at, palletId } = await closedPallet();
    const shell = fakeHardware();
    await expect(
      reprintPallet(
        { ...resolving(at, shell), local: failingWrites(at.local), shift: at.shift },
        at.pallets,
        palletId,
        { code: "damaged_label", text: null },
        at.settings,
        fakeRender,
      ),
    ).rejects.toThrow("disk is full");
    expect(shell.sends).toEqual([]);
  });

  it("is two comparisons of its own: the pallet is whole and its newest job is the one read", async () => {
    const { at, palletId, job } = await closedPallet();
    const guard = (sql: string, ...values: string[]): number =>
      Number(at.db.prepare(sql).run(...values).changes);
    const live = (id: string, shift = SHIFT_ID, device = PAIRING.deviceId, host = PAIRING.hostId) =>
      guard(PALLET_LIVE_GUARD_SQL, id, host, device, shift);
    expect(live(palletId)).toBe(1);
    expect(live(palletId, "another-shift")).toBe(0);
    expect(live(palletId, SHIFT_ID, FOREIGN[0].deviceId)).toBe(0);
    expect(live(palletId, SHIFT_ID, PAIRING.deviceId, FOREIGN[1].hostId)).toBe(0);
    await closeBoxOnPallet(at, ["C1"]);
    const [open] = rows(at.db, "SELECT id FROM floor_pallets WHERE closed_at IS NULL");
    expect(live(String(open?.["id"]))).toBe(0);
    const newest = (id: string, subject = palletId, shift = SHIFT_ID): number =>
      guard(
        NEWEST_PALLET_JOB_GUARD_SQL,
        PAIRING.hostId,
        PAIRING.deviceId,
        id,
        PAIRING.hostId,
        PAIRING.deviceId,
        shift,
        subject,
        id,
      );
    expect(newest(job.id)).toBe(1);
    await reprint(at, palletId);
    expect(newest(job.id)).toBe(0);
    // The newest job by insertion is the reprint, and the comparison holds for it alone.
    const [row] = await at.local.query(
      LAST_PALLET_JOB_SQL,
      [PAIRING.hostId, PAIRING.deviceId, SHIFT_ID, palletId],
      z.object({ id: z.string() }),
    );
    expect(row?.id).not.toBe(job.id);
    expect(newest(String(row?.id))).toBe(1);
  });
});

describe("a pallet's label printed again where it may exist (plan ПЛ-Ц)", () => {
  it("is refused as stale, writing nothing, once the pallet is taken apart", async () => {
    const at = await palletStation({ capacity: 1 });
    await closeBoxOnPallet(at, ["A1"]);
    const [row] = rows(at.db, "SELECT id FROM floor_print_jobs WHERE purpose = 'pallet'");
    const prepared = await readPrintJob(at.local, PAIRING, String(row?.["id"]));
    if (prepared === null) throw new Error("no job");
    const unknown = await sendLabelJob(
      resolving(
        at,
        fakeHardware(async () => ({ sent: false, code: "outcome_unknown" })),
      ),
      prepared,
    );
    // The disassembly lands by hand: the transaction of `disassemblePallet` refuses a pallet
    // whose label is open, so this is the case that guard of the reprint is the backstop of.
    at.db
      .prepare("UPDATE floor_pallets SET disassembled_at = ? WHERE id = ?")
      .run(new Date().toISOString(), prepared.subjectId);
    const shell = fakeHardware();
    await expect(
      printAgain(
        resolving(at, shell),
        unknown,
        { reason: "printer_jam", printer: null },
        at.settings,
        at.pallets.template,
      ),
    ).rejects.toBeInstanceOf(StaleJobError);
    expect(shell.sends).toEqual([]);
    expect(await readPrintJob(at.local, PAIRING, unknown.id)).toMatchObject({
      state: "unknown",
      attempts: 1,
    });
    expect(palletRecords(at)).toEqual([]);
  });
});
