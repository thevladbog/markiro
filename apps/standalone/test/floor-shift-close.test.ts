import type { ShiftCloseReasonCode } from "@markiro/domain";
import { buildSscc } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { closeShift, readCloseSummary } from "../src/floor/close/shift-close.js";
import {
  clearOpenBox,
  disassembleBox,
  reprintBox,
  undoLastCode,
} from "../src/floor/exceptions/box-exceptions.js";
import { readPrintJob, sendLabelJob, StaleJobError } from "../src/floor/print/print-jobs.js";
import { checkLabel, skipLabel } from "../src/floor/print/print-resolution.js";
import { keepEnteredShift, readShiftCopy } from "../src/floor/shifts/shift-copies.js";
import { closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import { LocalDbError } from "../src/local/executor.js";
import {
  ENTERED,
  enteredShift,
  failingWrites,
  holdingWrites,
  km,
  OPERATOR_ID,
  PAIRING,
  PREFIX,
  rows,
  scanContext,
  SHIFT_ID,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxWithLabel,
  FIRST_SSCC,
  fakeRender,
  manualRuntime,
  PRINT_BLOCK,
  printStation,
  resolveContext,
} from "./support/printing.js";

const OTHER_HOST = "6e5d4c3b-2a19-4f8e-9d7c-0b1a2c3d4e5f";
const OTHER_DEVICE = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

/** Two pairings that differ from this station's in ONE of host and device each. */
const FOREIGN = [
  { hostId: OTHER_HOST, deviceId: PAIRING.deviceId },
  { hostId: PAIRING.hostId, deviceId: OTHER_DEVICE },
] as const;

type Station = Awaited<ReturnType<typeof printStation>>;

/** A station whose plan is `planned` units (`null` — none). */
async function station(
  planned: number | null = 1_200,
  settings: Parameters<typeof printStation>[0] = {},
): Promise<Station> {
  const at = await printStation(settings);
  if (planned !== ENTERED.plannedQty) {
    await enteredShift(at.local, { ...ENTERED, plannedQty: planned });
  }
  return at;
}

/** The close's context: the station's clock from 06:15, fresh ids. */
function closer(at: Station, overrides: Partial<ScanContext> = {}): ScanContext {
  return scanContext(at.local, at.shift, { newId: () => crypto.randomUUID(), ...overrides });
}

async function fill(context: ScanContext, serials: readonly string[]): Promise<void> {
  for (const serial of serials) await processScan(context, km(serial));
}

/** A box of three codes closed, and its label sent and taken by the printer. */
async function closedBoxWithLabel(at: Station): Promise<void> {
  const context = resolveContext(at.local, manualRuntime(fakeHardware().hardware).runtime);
  await sendLabelJob(context, await closeBoxWithLabel(at));
}

/** The shift's outbox, oldest first: each record's kind. */
function outboxKinds(at: Station): unknown[] {
  return rows(at.db, "SELECT kind FROM outbox WHERE shift_id = ? ORDER BY seq", SHIFT_ID).map(
    (row) => row["kind"],
  );
}

function localState(at: Station): unknown {
  return rows(at.db, "SELECT local_state FROM floor_shifts WHERE id = ?", SHIFT_ID)[0]?.[
    "local_state"
  ];
}

/**
 * For each pairing of `FOREIGN`, records of the SAME shift id that a read or a
 * write forgetting the host or the device would take as this station's own: a
 * closed box with a code, an open box (with `open` codes counted, empty if 0)
 * and a label that waits.
 */
function seedForeignShift(db: Station["db"], open = 3): void {
  FOREIGN.forEach((owner, index) => {
    const tag = String(index + 1);
    db.prepare(
      "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
        "block_id, serial, item_count, closed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
    ).run(
      `aaaaaaaa-0000-4000-8000-00000000000${tag}`,
      owner.hostId,
      owner.deviceId,
      SHIFT_ID,
      "2026-10-08T05:00:00.000Z",
      "2026-10-08T05:10:00.000Z",
      buildSscc(0, PREFIX, 70 + index),
      PRINT_BLOCK,
      70 + index,
      OPERATOR_ID,
    );
    db.prepare(
      "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, " +
        "scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      owner.hostId,
      owner.deviceId,
      tag.repeat(64),
      SHIFT_ID,
      `aaaaaaaa-0000-4000-8000-00000000000${tag}`,
      `bbbbbbbb-0000-4000-8000-00000000000${tag}`,
      "2026-10-08T05:05:00.000Z",
    );
    db.prepare(
      "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, item_count) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      `cccccccc-0000-4000-8000-00000000000${tag}`,
      owner.hostId,
      owner.deviceId,
      SHIFT_ID,
      "2026-10-08T05:20:00.000Z",
      open,
    );
    db.prepare(
      "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, sscc, " +
        "state, verify, template_id, template_rev, fields, operator_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'box', ?, ?, 'prepared', 0, 'template', 1, '{}', ?, ?, ?)",
    ).run(
      `dddddddd-0000-4000-8000-00000000000${tag}`,
      owner.hostId,
      owner.deviceId,
      SHIFT_ID,
      `aaaaaaaa-0000-4000-8000-00000000000${tag}`,
      buildSscc(0, PREFIX, 70 + index),
      OPERATOR_ID,
      "2026-10-08T05:10:00.000Z",
      "2026-10-08T05:10:00.000Z",
    );
  });
}

/** The foreign pairings' records as `host/device kind id`, so a test sees none lost or changed. */
function foreignRecords(db: Station["db"]): unknown[] {
  return [
    ...rows(
      db,
      "SELECT 'box' AS kind, id, host_id, device_id, item_count AS n FROM floor_boxes " +
        "WHERE host_id <> ? OR device_id <> ? ORDER BY id",
      PAIRING.hostId,
      PAIRING.deviceId,
    ),
    ...rows(
      db,
      "SELECT 'code' AS kind, scan_id AS id, host_id, device_id, 0 AS n FROM floor_codes " +
        "WHERE host_id <> ? OR device_id <> ? ORDER BY scan_id",
      PAIRING.hostId,
      PAIRING.deviceId,
    ),
    ...rows(
      db,
      "SELECT 'job' AS kind, id, host_id, device_id, 0 AS n FROM floor_print_jobs " +
        "WHERE host_id <> ? OR device_id <> ? ORDER BY id",
      PAIRING.hostId,
      PAIRING.deviceId,
    ),
  ];
}

describe("the summary of a shift's close", () => {
  it("counts the codes the station holds and its closed boxes, and says what keeps the shift open", async () => {
    const at = await station(6);
    await closedBoxWithLabel(at);
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["B1", "B2"]);
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toEqual({
      plannedQty: 6,
      actualQty: 5,
      closedBoxes: 1,
      reasonRequired: true,
      blocker: { kind: "open_box", items: 2 },
    });
    await clearOpenBox(context);
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toMatchObject({
      actualQty: 3,
      blocker: null,
    });
  });

  it("is kept open by a label that waits, and not once it is skipped", async () => {
    const at = await station(3);
    const context = resolveContext(
      at.local,
      manualRuntime(fakeHardware(async () => ({ sent: false, code: "not_sent" })).hardware).runtime,
    );
    const failed = await sendLabelJob(context, await closeBoxWithLabel(at));
    const summary = await readCloseSummary(at.local, PAIRING, SHIFT_ID, false);
    expect(summary).toMatchObject({
      actualQty: 3,
      reasonRequired: false,
      blocker: { kind: "label" },
    });
    expect(await closeShift(closer(at), null, [], false)).toEqual({
      kind: "blocked",
      blocker: { kind: "label" },
    });
    await skipLabel(context, failed);
    expect(await closeShift(closer(at), null, [], false)).toMatchObject({
      kind: "closed",
    });
  });
});

describe("the close of a shift on the station", () => {
  it("writes `shift_closed` as the shift's last record, drops the empty open box and marks the shift closing", async () => {
    const at = await station(3);
    await closedBoxWithLabel(at);
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["B1"]);
    await undoLastCode(context);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 1 },
    ]);
    const result = await closeShift(
      scanContext(at.local, at.shift, { newId: () => "00000000-0000-4000-8000-0000000000aa" }),
      null,
      [],
      false,
    );
    const record = {
      plannedQtySnapshot: 3,
      actualQty: 3,
      closedBoxCount: 1,
      reasonCode: null,
      closedAt: "2026-10-08T06:15:00.000Z",
    };
    expect(result).toEqual({ kind: "closed", record });
    expect(outboxKinds(at).at(-1)).toBe("shift_closed");
    const [closed] = rows(at.db, "SELECT payload FROM outbox WHERE kind = 'shift_closed'");
    expect(JSON.parse(String(closed?.["payload"]))).toEqual({
      id: "00000000-0000-4000-8000-0000000000aa",
      kind: "shift_closed",
      shiftId: SHIFT_ID,
      operatorId: OPERATOR_ID,
      data: record,
    });
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 0 },
    ]);
    expect(localState(at)).toBe("closing");
    expect((await readShiftCopy(at.local, PAIRING, SHIFT_ID))?.localState).toBe("closing");
  });

  it("needs one of the six reasons when the plan is not met, and keeps one given without need", async () => {
    const at = await station(4);
    await closedBoxWithLabel(at);
    expect(await closeShift(closer(at), null, [], false)).toEqual({
      kind: "reason_required",
    });
    expect(outboxKinds(at)).not.toContain("shift_closed");
    expect(localState(at)).toBeNull();
    expect(await closeShift(closer(at), "material_shortage", [], false)).toMatchObject({
      kind: "closed",
      record: { plannedQtySnapshot: 4, actualQty: 3, reasonCode: "material_shortage" },
    });

    const met = await station(3);
    await closedBoxWithLabel(met);
    expect(await closeShift(closer(met), "equipment_stop", [], false)).toMatchObject({
      kind: "closed",
      record: { reasonCode: "equipment_stop" },
    });

    const unplanned = await station(null);
    await closedBoxWithLabel(unplanned);
    expect(await closeShift(closer(unplanned), null, [], false)).toMatchObject({
      kind: "closed",
      record: { plannedQtySnapshot: null, actualQty: 3, reasonCode: null },
    });
  });

  it("is kept open by an open box with codes, writing nothing", async () => {
    const at = await station(null);
    await fill(scanContext(at.local, at.shift), ["A1"]);
    expect(await closeShift(closer(at), null, [], false)).toEqual({
      kind: "blocked",
      blocker: { kind: "open_box", items: 1 },
    });
    expect(outboxKinds(at)).toEqual(["scan"]);
    expect(localState(at)).toBeNull();
  });

  it("closes once: a second close finds the shift closed", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    await closeShift(closer(at), null, [], false);
    expect(await closeShift(closer(at), null, [], false)).toEqual({
      kind: "blocked",
      blocker: { kind: "closed" },
    });
    expect(outboxKinds(at).filter((kind) => kind === "shift_closed")).toHaveLength(1);
  });

  it("lets no record of the shift follow its close, whoever tries to write one", async () => {
    const at = await station(null);
    const shell = fakeHardware();
    const print = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const job = await sendLabelJob(print, await closeBoxWithLabel(at));
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    expect(await closeShift(context, null, [], false)).toMatchObject({ kind: "closed" });
    const closedSeq = rows(at.db, "SELECT seq FROM outbox WHERE kind = 'shift_closed'")[0]?.["seq"];
    await expect(processScan(context, km("Z1"))).rejects.toMatchObject({
      code: "changes_mismatch",
    });
    await expect(processScan(context, "not a code")).rejects.toBeInstanceOf(LocalDbError);
    expect(
      await disassembleBox(context, job.subjectId, { code: "wrong_product", text: null }),
    ).toEqual({ kind: "stale" });
    await expect(
      reprintBox(
        { ...print, shift: at.shift },
        job.subjectId,
        { code: "damaged_label", text: null },
        at.settings,
        fakeRender,
      ),
    ).rejects.toBeInstanceOf(StaleJobError);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs")).toEqual([{ n: 1 }]);
    expect(await closeOpenBox(context)).toEqual({ kind: "empty" });
    expect(
      rows(at.db, "SELECT max(seq) AS last FROM outbox WHERE shift_id = ?", SHIFT_ID)[0]?.["last"],
    ).toBe(closedSeq);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
    expect(shell.sends).toHaveLength(1);
    expect(await readPrintJob(at.local, PAIRING, job.id)).toMatchObject({ state: "sent" });
  });

  // The receipt of the shift's close turns the copy from `closing` to `closed`
  // (plan 2a8): the guard is "no `local_state`", not "not `closing`", so a record
  // written after the receipt is refused as much as one written before it.
  it("lets no record of the shift follow its close once the host has answered it either", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const context = closer(at);
    expect(await closeShift(context, null, [], false)).toMatchObject({ kind: "closed" });
    at.db.exec("UPDATE floor_shifts SET local_state = 'closed'");
    expect(localState(at)).toBe("closed");
    const kinds = outboxKinds(at);
    const scans = rows(at.db, "SELECT count(*) AS n FROM floor_scans");
    const writer = closer(at, { newId: () => crypto.randomUUID() });
    await expect(processScan(writer, km("Z2"))).rejects.toMatchObject({
      code: "changes_mismatch",
    });
    expect(outboxKinds(at)).toEqual(kinds);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual(scans);
  });

  // A pairing that differs in the host only (a restored host, plan РК) and one that
  // differs in the device only (an old pairing kept by a forget): each holds a copy
  // of the same shift id, closing, and refuses its own records, never this one's.
  it.each(FOREIGN)(
    "stops the records of the shift this pairing closed, not those of another pairing's copy (%o)",
    async (other) => {
      const at = await station(null);
      await keepEnteredShift(at.local, other, ENTERED, "2026-10-08T06:02:00.000Z", 1);
      at.db
        .prepare(
          "UPDATE floor_shifts SET local_state = 'closing' WHERE host_id = ? AND device_id = ?",
        )
        .run(other.hostId, other.deviceId);
      expect(await processScan(closer(at), km("D1"))).toMatchObject({ kind: "accepted" });
      await expect(
        processScan(closer(at, { pairing: other, newId: () => crypto.randomUUID() }), km("D2")),
      ).rejects.toMatchObject({ code: "changes_mismatch" });
    },
  );

  it("writes nothing when a scan lands between its summary and its write", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
    await held.reached();
    await fill(scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() }), ["C1"]);
    held.release();
    expect(await closing).toEqual({ kind: "stale" });
    expect(localState(at)).toBeNull();
    expect(outboxKinds(at)).not.toContain("shift_closed");
    expect(rows(at.db, "SELECT item_count FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { item_count: 1 },
    ]);
  });

  it("writes nothing when a box is taken apart between its summary and its write", async () => {
    const at = await station(null);
    const shell = fakeHardware();
    const print = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const job = await sendLabelJob(print, await closeBoxWithLabel(at));
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
    await held.reached();
    await disassembleBox(closer(at), job.subjectId, { code: "quality_rejected", text: null });
    held.release();
    // The summary said 3 codes in 1 box; the station holds none now.
    expect(await closing).toEqual({ kind: "stale" });
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toMatchObject({
      actualQty: 0,
      closedBoxes: 0,
      blocker: null,
    });
    expect(outboxKinds(at)).not.toContain("shift_closed");
  });

  it("writes nothing when a label starts to wait between its summary and its write", async () => {
    const at = await station(null);
    const shell = fakeHardware();
    const print = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const job = await sendLabelJob(print, await closeBoxWithLabel(at));
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
    await held.reached();
    shell.holdSends();
    const reprint = reprintBox(
      { ...print, shift: at.shift },
      job.subjectId,
      { code: "unreadable_label", text: null },
      at.settings,
      fakeRender,
    );
    for (let turn = 0; turn < 200 && shell.heldSends() === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(shell.heldSends()).toBe(1);
    held.release();
    expect(await closing).toEqual({ kind: "stale" });
    shell.releaseSend({ sent: true });
    await reprint;
    expect(localState(at)).toBeNull();
  });

  it("writes nothing when a guard of a later plan fails", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const failing = {
      sql: "UPDATE floor_shifts SET local_state = local_state WHERE id = ?",
      values: ["no such shift"],
      expectedChanges: 1,
    };
    expect(await closeShift(closer(at), null, [failing], false)).toEqual({
      kind: "stale",
    });
    expect(outboxKinds(at)).not.toContain("shift_closed");
    expect(localState(at)).toBeNull();
  });
});

describe("the summary reads this station's own records only", () => {
  it("counts nothing of another pairing's copy of the same shift", async () => {
    const at = await station(6);
    await closedBoxWithLabel(at);
    seedForeignShift(at.db);
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toEqual({
      plannedQty: 6,
      actualQty: 3,
      closedBoxes: 1,
      reasonRequired: true,
      blocker: null,
    });
  });

  it("says closed, with nothing counted, for a shift this pairing holds no copy of", async () => {
    const at = await station(6);
    await closedBoxWithLabel(at);
    const nothing = {
      plannedQty: null,
      actualQty: 0,
      closedBoxes: 0,
      reasonRequired: false,
      blocker: { kind: "closed" },
    };
    expect(
      await readCloseSummary(at.local, PAIRING, "11111111-2222-4333-8444-555555555555", false),
    ).toEqual(nothing);
    expect(await readCloseSummary(at.local, FOREIGN[0], SHIFT_ID, false)).toEqual(nothing);
    expect(await readCloseSummary(at.local, FOREIGN[1], SHIFT_ID, false)).toEqual(nothing);
  });

  it("names the blocker in order: closed, then an open box with codes, then a label", async () => {
    const at = await station(null);
    await closeBoxWithLabel(at); // its label waits: the job is prepared, nothing sent
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["B1"]);
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toMatchObject({
      blocker: { kind: "open_box", items: 1 },
    });
    await undoLastCode(context);
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toMatchObject({
      blocker: { kind: "label" },
    });
    await fill(context, ["B2"]);
    for (const state of ["closing", "closed"]) {
      at.db.prepare("UPDATE floor_shifts SET local_state = ?").run(state);
      expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toMatchObject({
        blocker: { kind: "closed" },
      });
    }
  });

  it("is kept open by a label sent and waiting for its check, and not once it is checked", async () => {
    const at = await station(null, { verifyPrintedLabel: true });
    const context = resolveContext(at.local, manualRuntime(fakeHardware().hardware).runtime);
    const sent = await sendLabelJob(context, await closeBoxWithLabel(at));
    expect(sent).toMatchObject({ state: "sent", verify: true });
    expect(await closeShift(closer(at), null, [], false)).toEqual({
      kind: "blocked",
      blocker: { kind: "label" },
    });
    expect(await checkLabel(context, sent, `]C100${FIRST_SSCC}`)).toMatchObject({
      kind: "verified",
    });
    expect(await closeShift(closer(at), null, [], false)).toMatchObject({ kind: "closed" });
  });
});

/** A job of a box of this shift in `state`, written as the printing leaves it. */
function seedJob(db: Station["db"], state: string, verify: 0 | 1): void {
  const bytes = ["sending", "sent", "unknown", "verified"].includes(state);
  db.prepare(
    "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, sscc, " +
      "state, verify, template_id, template_rev, fields, printer, bytes_base64, error_code, " +
      "attempts, operator_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'box', ?, ?, ?, ?, 'template', 1, '{}', ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "dddddddd-1111-4000-8000-000000000001",
    PAIRING.hostId,
    PAIRING.deviceId,
    SHIFT_ID,
    "aaaaaaaa-1111-4000-8000-000000000001",
    buildSscc(0, PREFIX, 71),
    state,
    verify,
    bytes ? "{}" : null,
    bytes ? "Zm9v" : null,
    state === "failed" || state === "unknown" ? "not_sent" : null,
    state === "prepared" ? 0 : 1,
    OPERATOR_ID,
    "2026-10-08T05:10:00.000Z",
    "2026-10-08T05:10:00.000Z",
  );
}

describe("what a label keeps the shift open for", () => {
  const WAITING: [string, 0 | 1][] = [
    ["prepared", 0],
    ["sending", 0],
    ["failed", 0],
    ["unknown", 0],
    ["sent", 1],
  ];
  const SETTLED: [string, 0 | 1][] = [
    ["sent", 0],
    ["verified", 1],
    ["skipped", 0],
  ];

  it.each(WAITING)("keeps it open while a job is %s (check asked: %i)", async (state, verify) => {
    const at = await station(null);
    seedJob(at.db, state, verify);
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toMatchObject({
      blocker: { kind: "label" },
    });
    expect(await closeShift(closer(at), null, [], false)).toEqual({
      kind: "blocked",
      blocker: { kind: "label" },
    });
  });

  it.each(SETTLED)(
    "does not keep it open when a job is %s (check asked: %i)",
    async (state, verify) => {
      const at = await station(null);
      seedJob(at.db, state, verify);
      expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toMatchObject({
        blocker: null,
      });
      expect(await closeShift(closer(at), null, [], false)).toMatchObject({ kind: "closed" });
    },
  );

  it.each(WAITING)(
    "writes nothing when a job turns %s (check asked: %i) between the summary and the write",
    async (state, verify) => {
      const at = await station(null);
      await closedBoxWithLabel(at);
      const held = holdingWrites(at.local);
      held.holdNext();
      const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
      await held.reached();
      seedJob(at.db, state, verify);
      held.release();
      expect(await closing).toEqual({ kind: "stale" });
      expect(localState(at)).toBeNull();
    },
  );
});

describe("the close of a shift, in more detail", () => {
  it("closes a shift with nothing in it, and only this pairing's copy of it", async () => {
    const at = await station(null);
    // The other copies look exactly as this one does: only the pairing tells them apart.
    const same = { ...ENTERED, plannedQty: null };
    await keepEnteredShift(at.local, FOREIGN[0], same, "2026-10-08T06:02:00.000Z", 1);
    await keepEnteredShift(at.local, FOREIGN[1], same, "2026-10-08T06:02:00.000Z", 1);
    expect(await closeShift(closer(at), null, [], false)).toEqual({
      kind: "closed",
      record: {
        plannedQtySnapshot: null,
        actualQty: 0,
        closedBoxCount: 0,
        reasonCode: null,
        closedAt: "2026-10-08T06:15:00.000Z",
      },
    });
    expect(
      rows(at.db, "SELECT host_id, device_id FROM floor_shifts WHERE local_state IS NOT NULL"),
    ).toEqual([{ host_id: PAIRING.hostId, device_id: PAIRING.deviceId }]);
  });

  it("writes nothing when a box that held no code is taken apart between the summary and the write", async () => {
    const at = await station(null);
    at.db
      .prepare(
        "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
          "block_id, serial, item_count, closed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
      )
      .run(
        "eeeeeeee-0000-4000-8000-000000000003",
        PAIRING.hostId,
        PAIRING.deviceId,
        SHIFT_ID,
        "2026-10-08T05:00:00.000Z",
        "2026-10-08T05:10:00.000Z",
        buildSscc(0, PREFIX, 91),
        PRINT_BLOCK,
        91,
        OPERATOR_ID,
      );
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
    await held.reached();
    at.db.prepare("UPDATE floor_boxes SET disassembled_at = '2026-10-08T06:20:00.000Z'").run();
    held.release();
    expect(await closing).toEqual({ kind: "stale" });
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toMatchObject({
      closedBoxes: 0,
    });
  });

  it("is not held up by the records of the shift that are not sent yet, and follows them", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const before = outboxKinds(at);
    expect(await closeShift(closer(at), null, [], false)).toMatchObject({ kind: "closed" });
    expect(outboxKinds(at)).toEqual([...before, "shift_closed"]);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NOT NULL")).toEqual([
      { n: 0 },
    ]);
    const [last] = rows(
      at.db,
      "SELECT created_at, json_extract(payload, '$.data.closedAt') AS closed_at FROM outbox " +
        "WHERE kind = 'shift_closed'",
    );
    expect(last?.["closed_at"]).toBe("2026-10-08T06:15:00.000Z");
    expect(last?.["created_at"]).toBe("2026-10-08T06:15:00.000Z");
  });

  it("asks for a reason when the shift made more than its plan, too", async () => {
    const at = await station(2);
    await closedBoxWithLabel(at);
    expect(await closeShift(closer(at), null, [], false)).toEqual({ kind: "reason_required" });
    expect(await closeShift(closer(at), "planned_quantity_error", [], false)).toMatchObject({
      kind: "closed",
      record: { plannedQtySnapshot: 2, actualQty: 3, reasonCode: "planned_quantity_error" },
    });
  });

  it("takes only one of the domain's six reasons, whatever the plan", async () => {
    const reasons = [
      "production_defect",
      "material_shortage",
      "equipment_stop",
      "production_order_changed",
      "planned_quantity_error",
      "other_production_deviation",
    ] as const;
    const stray = "something_else" as ShiftCloseReasonCode;
    for (const planned of [4, null]) {
      const at = await station(planned);
      await closedBoxWithLabel(at);
      expect(await closeShift(closer(at), stray, [], false)).toEqual({ kind: "reason_required" });
      expect(outboxKinds(at)).not.toContain("shift_closed");
      expect(localState(at)).toBeNull();
    }
    for (const reason of reasons) {
      const at = await station(4);
      await closedBoxWithLabel(at);
      expect(await closeShift(closer(at), reason, [], false)).toMatchObject({
        kind: "closed",
        record: { reasonCode: reason },
      });
    }
  });

  it("finds a second close with the same record id closed, not failing on the id", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const fixed = { newId: () => "00000000-0000-4000-8000-0000000000bb" };
    expect(await closeShift(closer(at, fixed), null, [], false)).toMatchObject({ kind: "closed" });
    expect(await closeShift(closer(at, fixed), null, [], false)).toEqual({
      kind: "blocked",
      blocker: { kind: "closed" },
    });
    expect(outboxKinds(at).filter((kind) => kind === "shift_closed")).toHaveLength(1);
  });

  it("finds a shift closing after a restart closed, and writes no second record", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    await closeShift(closer(at), null, [], false);
    const kept = rows(at.db, "SELECT seq, id, acked_at FROM outbox ORDER BY seq");
    // A new work screen over the same database: the copy says `closing`.
    const restarted = await readCloseSummary(at.local, PAIRING, SHIFT_ID, false);
    expect(restarted.blocker).toEqual({ kind: "closed" });
    expect(await closeShift(closer(at), null, [], false)).toEqual({
      kind: "blocked",
      blocker: { kind: "closed" },
    });
    expect(rows(at.db, "SELECT seq, id, acked_at FROM outbox ORDER BY seq")).toEqual(kept);
  });

  it("closes the copy of this pairing only and keeps another pairing's records of the shift", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    // Another pairing's copy of the same shift, with an empty open box of its own.
    await keepEnteredShift(at.local, FOREIGN[0], ENTERED, "2026-10-08T06:02:00.000Z", 1);
    await keepEnteredShift(at.local, FOREIGN[1], ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedForeignShift(at.db, 0);
    const foreign = foreignRecords(at.db);
    expect(await closeShift(closer(at), null, [], false)).toMatchObject({ kind: "closed" });
    expect(foreignRecords(at.db)).toEqual(foreign);
    expect(
      rows(
        at.db,
        "SELECT host_id, device_id, local_state FROM floor_shifts ORDER BY host_id, device_id",
      ).filter((row) => row["local_state"] !== null),
    ).toEqual([{ host_id: PAIRING.hostId, device_id: PAIRING.deviceId, local_state: "closing" }]);
  });

  it("drops this shift's empty open box and nothing else: no other shift's, no closed box", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["B1"]);
    await undoLastCode(context);
    const another = "99999999-8888-4777-8666-555555555555";
    at.db
      .prepare(
        "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, item_count) " +
          "VALUES (?, ?, ?, ?, ?, 0)",
      )
      .run(
        "eeeeeeee-0000-4000-8000-000000000001",
        PAIRING.hostId,
        PAIRING.deviceId,
        another,
        "2026-10-08T05:20:00.000Z",
      );
    // A box taken apart whose counter reads zero: its SSCC stays used.
    at.db
      .prepare(
        "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
          "block_id, serial, item_count, closed_by, disassembled_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        "eeeeeeee-0000-4000-8000-000000000002",
        PAIRING.hostId,
        PAIRING.deviceId,
        SHIFT_ID,
        "2026-10-08T05:00:00.000Z",
        "2026-10-08T05:10:00.000Z",
        buildSscc(0, PREFIX, 90),
        PRINT_BLOCK,
        90,
        OPERATOR_ID,
        "2026-10-08T05:30:00.000Z",
      );
    expect(await closeShift(closer(at), null, [], false)).toMatchObject({ kind: "closed" });
    expect(rows(at.db, "SELECT id FROM floor_boxes WHERE item_count = 0 ORDER BY id")).toEqual([
      { id: "eeeeeeee-0000-4000-8000-000000000001" },
      { id: "eeeeeeee-0000-4000-8000-000000000002" },
    ]);
  });

  it("does not take another pairing's records for a change of its shift between summary and write", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
    await held.reached();
    seedForeignShift(at.db);
    held.release();
    expect(await closing).toMatchObject({ kind: "closed" });
  });

  it("writes nothing, the empty open box included, when the plan changed between summary and write", async () => {
    const at = await station(3);
    await closedBoxWithLabel(at);
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["B1"]);
    await undoLastCode(context);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
    await held.reached();
    // The host's list moved the plan of the active shift under the close.
    at.db.prepare("UPDATE floor_shifts SET planned_qty = 4 WHERE id = ?").run(SHIFT_ID);
    held.release();
    expect(await closing).toEqual({ kind: "stale" });
    expect(localState(at)).toBeNull();
    expect(outboxKinds(at)).not.toContain("shift_closed");
    expect(rows(at.db, "SELECT item_count FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { item_count: 0 },
    ]);
    // Read again, the plan is not met and a reason is needed: never closed on the old plan.
    expect(await closeShift(closer(at), null, [], false)).toEqual({ kind: "reason_required" });
    expect(await closeShift(closer(at), "material_shortage", [], false)).toMatchObject({
      kind: "closed",
      record: { plannedQtySnapshot: 4, actualQty: 3, reasonCode: "material_shortage" },
    });
  });

  it("writes nothing when a plan appears on a shift that had none between summary and write", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
    await held.reached();
    at.db.prepare("UPDATE floor_shifts SET planned_qty = 9 WHERE id = ?").run(SHIFT_ID);
    held.release();
    expect(await closing).toEqual({ kind: "stale" });
    expect(await closeShift(closer(at), null, [], false)).toEqual({ kind: "reason_required" });
  });

  it("closes on the same counts when a scan and its undo land between the summary and the write", async () => {
    // The counts are the summary: they are as they were, and the empty box the pair left goes.
    const at = await station(null);
    await closedBoxWithLabel(at);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
    await held.reached();
    const meanwhile = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(meanwhile, ["C1"]);
    await undoLastCode(meanwhile);
    held.release();
    expect(await closing).toMatchObject({ kind: "closed", record: { actualQty: 3 } });
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 0 },
    ]);
  });

  it("writes nothing when the open box it found empty holds a code at the write, whatever the counts", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["B1"]);
    await undoLastCode(context);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
    await held.reached();
    // A writer outside the queue: the box's counter moves, the shift's counts do not.
    at.db.prepare("UPDATE floor_boxes SET item_count = 1 WHERE closed_at IS NULL").run();
    held.release();
    expect(await closing).toEqual({ kind: "stale" });
    expect(localState(at)).toBeNull();
    expect(outboxKinds(at)).not.toContain("shift_closed");
  });

  it.each([
    ["a code is taken out of a closed box", -1],
    ["a code is added to a closed box", 1],
  ] as const)(
    "writes nothing when the codes of the shift change under the close alone: %s",
    async (_change, delta) => {
      const at = await station(null);
      await closedBoxWithLabel(at);
      const held = holdingWrites(at.local);
      held.holdNext();
      const closing = closeShift(closer(at, { local: held.executor }), null, [], false);
      await held.reached();
      // A writer outside the queue changes the shift's codes only: its closed boxes
      // stay the same, no box is open and no label waits, so the count of codes is
      // the one guard that sees it (the three codes the summary read become 2 or 4).
      if (delta < 0) {
        at.db
          .prepare("DELETE FROM floor_codes WHERE rowid = (SELECT max(rowid) FROM floor_codes)")
          .run();
      } else {
        at.db
          .prepare(
            "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, " +
              "scanned_at) SELECT host_id, device_id, ?, shift_id, id, ?, ? FROM floor_boxes " +
              "WHERE closed_at IS NOT NULL",
          )
          .run("9".repeat(64), "bbbbbbbb-0000-4000-8000-0000000000ff", "2026-10-08T06:10:00.000Z");
      }
      held.release();
      expect(await closing).toEqual({ kind: "stale" });
      expect(localState(at)).toBeNull();
      expect(outboxKinds(at)).not.toContain("shift_closed");
      expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID, false)).toMatchObject({
        actualQty: 3 + delta,
        closedBoxes: 1,
        blocker: null,
      });
      // Read again, it closes on the codes the station holds now.
      expect(await closeShift(closer(at), null, [], false)).toMatchObject({
        kind: "closed",
        record: { actualQty: 3 + delta, closedBoxCount: 1 },
      });
    },
  );

  it("runs the guards of a later plan before it closes, in the same transaction", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    // A guard that holds only while the shift is still open: it must run before the mark.
    const whileOpen = {
      sql: "UPDATE floor_shifts SET local_state = local_state WHERE id = ? AND local_state IS NULL",
      values: [SHIFT_ID],
      expectedChanges: 1,
    };
    expect(await closeShift(closer(at), null, [whileOpen], false)).toMatchObject({
      kind: "closed",
    });
    expect(localState(at)).toBe("closing");
  });

  it("does not close a shift whose copy this pairing lost", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    at.db.prepare("DELETE FROM floor_shifts WHERE id = ?").run(SHIFT_ID);
    expect(await closeShift(closer(at), null, [], false)).toEqual({
      kind: "blocked",
      blocker: { kind: "closed" },
    });
    expect(outboxKinds(at)).not.toContain("shift_closed");
  });

  it("keeps its answer typed: a failing write is not called stale", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    await expect(
      closeShift(closer(at, { local: failingWrites(at.local) }), null, [], false),
    ).rejects.toMatchObject({ code: "statement_failed" });
    expect(localState(at)).toBeNull();
    expect(outboxKinds(at)).not.toContain("shift_closed");
  });
});
