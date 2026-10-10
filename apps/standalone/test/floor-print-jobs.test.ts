import { buildSscc } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import {
  boxLabelStep,
  isOpenJob,
  readOpenJob,
  readPrintJob,
  recoverInterruptedJobs,
  sendLabelJob,
  settleOutcome,
  shiftLabelsSettled,
  StaleJobError,
  UnreadableJobError,
  UnsendableJobError,
  type PrintContext,
  type PrintJob,
} from "../src/floor/print/print-jobs.js";
import type { PrintRuntime } from "../src/floor/print/print-runtime.js";
import { closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import type { LocalExecutor } from "../src/local/executor.js";
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
  seedBlock,
  SHIFT_ID,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import {
  fakeRender,
  flushPromises,
  jobRows,
  manualRuntime,
  renderedBase64,
  renderedText,
  setUpPrinting,
  spyRender,
  TSC,
  ZEBRA,
} from "./support/printing.js";

const BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const SSCC = buildSscc(0, PREFIX, 1500);
const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

async function station() {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor);
  seedBlock(db, { blockId: BLOCK, from: 1500, to: 3499 });
  return { db, local: executor, shift };
}

type Station = Awaited<ReturnType<typeof station>>;

/** Accepts three codes into the open box. */
async function fill(context: ScanContext): Promise<void> {
  for (const serial of ["A1", "A2", "A3"]) await processScan(context, km(serial));
}

/** Closes the open box with its print job, as the work screen does; the job's id is `job-1`. */
async function closeWithLabel(at: Station, local: LocalExecutor = at.local, render = fakeRender) {
  const context = scanContext(local, at.shift);
  await fill(scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() }));
  const step = boxLabelStep({
    local,
    pairing: PAIRING,
    shift: at.shift,
    operatorName: "Анна Кузнецова",
    newId: () => "job-1",
    render,
  });
  return closeOpenBox(context, [step]);
}

function printContext(local: LocalExecutor, runtime: PrintRuntime): PrintContext {
  let tick = Date.parse("2026-10-08T06:30:00.000Z");
  return {
    local,
    pairing: PAIRING,
    runtime,
    now: () => {
      tick += 1_000;
      return new Date(tick);
    },
  };
}

async function job(at: Station, id = "job-1"): Promise<PrintJob> {
  const found = await readPrintJob(at.local, PAIRING, id);
  if (found === null) throw new Error(`no job ${id}`);
  return found;
}

describe("a box's print job", () => {
  it("is written with the close, rendered from the snapshot for the box's printer", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    const render = spyRender();
    const closed = await closeWithLabel(at, at.local, render);
    expect(closed.kind).toBe("closed");
    const box = rows(at.db, "SELECT id, sscc, closed_at FROM floor_boxes")[0];
    expect(jobRows(at.db)).toEqual([
      {
        id: "job-1",
        purpose: "box",
        subject_id: box?.["id"],
        sscc: SSCC,
        state: "prepared",
        verify: 0,
        template_id: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
        template_rev: 62,
        printer: JSON.stringify(ZEBRA),
        bytes_base64: renderedBase64(ZEBRA, SSCC),
        error_code: null,
        attempts: 0,
        operator_id: OPERATOR_ID,
        created_at: box?.["closed_at"],
      },
    ]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0]).toEqual(at.shift.snapshot.boxTemplate.spec);
    expect(render.mock.calls[0]?.[1]).toMatchObject({
      sscc: SSCC,
      qty: "3",
      operator: "Анна Кузнецова",
      "product.printName": "Молоко 3,2%",
    });
    const stored = await job(at);
    expect(stored.fields).toEqual(render.mock.calls[0]?.[1]);
    expect(isOpenJob(stored)).toBe(true);
  });

  it("takes the layout of the snapshot's template revision, not the station's newer copy of it", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    // The office widened the template after the shift opened; the copy has the new revision.
    at.db
      .prepare(
        "INSERT INTO ref_templates (id, name, purpose, enabled, stock, spec, rev) " +
          "VALUES (?, 'Молоко 100×150', 'box', 1, 0, ?, 63)",
      )
      .run(
        "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
        JSON.stringify({
          ...at.shift.snapshot.boxTemplate.spec,
          widthMm: 100,
          heightMm: 150,
        }),
      );
    await closeWithLabel(at);
    expect(jobRows(at.db)[0]).toMatchObject({
      template_rev: 62,
      bytes_base64: renderedBase64(ZEBRA, SSCC, "58x40"),
    });
  });

  it("asks for the label check when the workstation checks labels", async () => {
    const at = await station();
    await setUpPrinting(at.local, { verifyPrintedLabel: true });
    await closeWithLabel(at);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "prepared", verify: 1 });
  });

  it("is failed for want of a printer, and the box closes all the same", async () => {
    const at = await station();
    await setUpPrinting(at.local, {
      assignments: { box: null, pallet: "zebra", duplicate: "tsc" },
    });
    const closed = await closeWithLabel(at);
    expect(closed.kind).toBe("closed");
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "failed",
      error_code: "printer_unconfigured",
      printer: null,
      bytes_base64: null,
    });
  });

  it("is failed when the label does not render, and keeps the printer it was for", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    const closed = await closeWithLabel(at, at.local, async () => {
      throw new Error("RasterTooLargeError");
    });
    expect(closed.kind).toBe("closed");
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "failed",
      error_code: "render_failed",
      printer: JSON.stringify(ZEBRA),
      bytes_base64: null,
    });
  });

  it("never exists for a box that did not close: a failed write leaves neither", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await expect(closeWithLabel(at, failingWrites(at.local))).rejects.toMatchObject({
      code: "statement_failed",
    });
    expect(rows(at.db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    expect(jobRows(at.db)).toEqual([]);
  });

  it("never exists for a close the box's change undid: a stale close writes no job", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeWithLabel(at, held.executor);
    await held.reached();
    // A scan landed in the box between the close's read and its write.
    at.db.prepare("UPDATE floor_boxes SET item_count = item_count + 1").run();
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(jobRows(at.db)).toEqual([]);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_sscc_blocks WHERE next_serial = 1500"),
    ).toEqual([{ n: 1 }]);
  });
});

describe("the send of a print job", () => {
  it("writes sending and the attempt before the bytes go, and sent once the shell took them", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime } = manualRuntime(shell.hardware);
    const sending = sendLabelJob(printContext(at.local, runtime), await job(at));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending", attempts: 1, error_code: null });
    expect(shell.sends).toEqual([{ target: ZEBRA.target, text: renderedText(ZEBRA, SSCC) }]);
    shell.releaseSend({ sent: true });
    await expect(sending).resolves.toMatchObject({ state: "sent", attempts: 1, errorCode: null });
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("ends failed when nothing left this computer, and unknown when a label may exist", async () => {
    const cases = [
      [{ kind: "answered", result: { sent: false, code: "not_sent" } }, "failed", "not_sent"],
      [{ kind: "answered", result: { sent: false, code: "unsupported" } }, "failed", "unsupported"],
      [
        { kind: "answered", result: { sent: false, code: "invalid_target" } },
        "failed",
        "invalid_target",
      ],
      [
        { kind: "answered", result: { sent: false, code: "invalid_payload" } },
        "failed",
        "invalid_payload",
      ],
      [
        { kind: "answered", result: { sent: false, code: "outcome_unknown" } },
        "unknown",
        "outcome_unknown",
      ],
      [{ kind: "timeout" }, "unknown", "timeout"],
      [{ kind: "busy" }, "failed", "printer_busy"],
    ] as const;
    for (const [outcome, state, code] of cases) {
      expect(settleOutcome(outcome)).toEqual({ state, code });
    }
    expect(settleOutcome({ kind: "answered", result: { sent: true } })).toEqual({ state: "sent" });

    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware(async () => ({ sent: false, code: "outcome_unknown" }));
    const { runtime } = manualRuntime(shell.hardware);
    await expect(
      sendLabelJob(printContext(at.local, runtime), await job(at)),
    ).resolves.toMatchObject({ state: "unknown", errorCode: "outcome_unknown", attempts: 1 });
  });

  it("ends unknown, never sent, when the shell does not answer within the limit", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime, expire } = manualRuntime(shell.hardware);
    const sending = sendLabelJob(printContext(at.local, runtime), await job(at));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    expire();
    await expect(sending).resolves.toMatchObject({ state: "unknown", errorCode: "timeout" });
    // The answer that comes late changes nothing.
    shell.releaseSend({ sent: true });
    await flushPromises();
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", error_code: "timeout" });
  });

  it("refuses a job moved on meanwhile, and leaves it as it was moved", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime } = manualRuntime(shell.hardware);
    const sending = sendLabelJob(printContext(at.local, runtime), await job(at));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    at.db
      .prepare("UPDATE floor_print_jobs SET state = 'unknown', error_code = 'interrupted'")
      .run();
    shell.releaseSend({ sent: true });
    await expect(sending).rejects.toBeInstanceOf(StaleJobError);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", error_code: "interrupted" });

    // A stale read is refused before anything is sent.
    const read = await job(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'").run();
    await expect(sendLabelJob(printContext(at.local, runtime), read)).rejects.toBeInstanceOf(
      StaleJobError,
    );
    expect(shell.sends).toHaveLength(1);
  });

  it("refuses a job without bytes and a job that is done with, and sends nothing", async () => {
    const at = await station();
    await setUpPrinting(at.local, { assignments: { box: null, pallet: null, duplicate: null } });
    await closeWithLabel(at);
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    await expect(
      sendLabelJob(printContext(at.local, runtime), await job(at)),
    ).rejects.toBeInstanceOf(UnsendableJobError);
    const done: PrintJob = {
      ...(await job(at)),
      state: "verified",
      bytesBase64: "XlhB",
      printer: TSC,
    };
    await expect(sendLabelJob(printContext(at.local, runtime), done)).rejects.toBeInstanceOf(
      UnsendableJobError,
    );
    expect(shell.sends).toEqual([]);
  });
});

describe("the recovery of interrupted jobs", () => {
  it("reads a job left sending as unknown, and sends nothing by itself", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sending', attempts = 1").run();
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    await expect(recoverInterruptedJobs(printContext(at.local, runtime))).resolves.toBe(1);
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "unknown",
      error_code: "interrupted",
      attempts: 1,
    });
    expect(shell.hardware.printBytes).not.toHaveBeenCalled();
    await expect(recoverInterruptedJobs(printContext(at.local, runtime))).resolves.toBe(0);
  });

  it("leaves a job whose bytes this app's send still holds, and another pairing's jobs", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    at.db
      .prepare(
        "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, " +
          "sscc, state, verify, template_id, template_rev, fields, printer, bytes_base64, " +
          "attempts, operator_id, created_at, updated_at) SELECT 'job-other', host_id, ?, " +
          "shift_id, purpose, 'box-other', sscc, 'sending', verify, template_id, template_rev, " +
          "fields, printer, bytes_base64, 1, operator_id, created_at, updated_at " +
          "FROM floor_print_jobs WHERE id = 'job-1'",
      )
      .run(OTHER_DEVICE);
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime } = manualRuntime(shell.hardware);
    const context = printContext(at.local, runtime);
    const sending = sendLabelJob(context, await job(at));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    await expect(recoverInterruptedJobs(context)).resolves.toBe(0);
    expect(rows(at.db, "SELECT id, state FROM floor_print_jobs ORDER BY id")).toEqual([
      { id: "job-1", state: "sending" },
      { id: "job-other", state: "sending" },
    ]);
    shell.releaseSend({ sent: true });
    await expect(sending).resolves.toMatchObject({ state: "sent" });
  });
});

describe("the open job of a shift", () => {
  it("is the oldest one waiting for the printer or the operator, of this pairing only", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const insert = (
      id: string,
      state: string,
      verify: number,
      createdAt: string,
      device = PAIRING.deviceId,
    ) =>
      at.db
        .prepare(
          "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, " +
            "sscc, state, verify, template_id, template_rev, fields, printer, bytes_base64, " +
            "error_code, attempts, operator_id, created_at, updated_at) SELECT ?, host_id, ?, " +
            "shift_id, purpose, ?, sscc, ?, ?, template_id, template_rev, fields, printer, " +
            "bytes_base64, NULL, 1, operator_id, ?, ? FROM floor_print_jobs WHERE id = 'job-1'",
        )
        .run(id, device, `box-${id}`, state, verify, createdAt, createdAt);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent', attempts = 1").run();
    insert("done-verified", "verified", 1, "2026-10-08T06:00:00.000Z");
    insert("done-sent", "sent", 0, "2026-10-08T06:00:01.000Z");
    insert("other-pairing", "sent", 1, "2026-10-08T06:00:02.000Z", OTHER_DEVICE);
    await expect(readOpenJob(at.local, PAIRING, SHIFT_ID)).resolves.toBeNull();
    insert("awaiting", "sent", 1, "2026-10-08T06:00:04.000Z");
    insert("awaiting-older", "sent", 1, "2026-10-08T06:00:03.000Z");
    await expect(readOpenJob(at.local, PAIRING, SHIFT_ID)).resolves.toMatchObject({
      id: "awaiting-older",
      verify: true,
    });
    await expect(readOpenJob(at.local, PAIRING, "another-shift")).resolves.toBeNull();
  });

  it("keeps the shift's labels unsettled while any job of it waits, even one that cannot be read", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const settled = () => shiftLabelsSettled(at.local, PAIRING, SHIFT_ID);
    for (const [state, verify, code] of [
      ["prepared", 0, null],
      ["sending", 0, null],
      ["failed", 0, "not_sent"],
      ["unknown", 0, "timeout"],
      ["sent", 1, null],
    ] as const) {
      at.db
        .prepare("UPDATE floor_print_jobs SET state = ?, verify = ?, error_code = ?, attempts = ?")
        .run(state, verify, code, state === "prepared" ? 0 : 1);
      await expect(settled(), state).resolves.toBe(false);
    }
    for (const [state, verify] of [
      ["sent", 0],
      ["verified", 1],
      ["skipped", 1],
    ] as const) {
      at.db
        .prepare(
          "UPDATE floor_print_jobs SET state = ?, verify = ?, error_code = NULL, attempts = 1",
        )
        .run(state, verify);
      await expect(settled(), state).resolves.toBe(true);
    }
    // A waiting job of another shift or another pairing is not this shift's.
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent', shift_id = 'another'",
      )
      .run();
    await expect(settled()).resolves.toBe(true);
    at.db
      .prepare("UPDATE floor_print_jobs SET shift_id = ?, device_id = ?")
      .run(SHIFT_ID, OTHER_DEVICE);
    await expect(settled()).resolves.toBe(true);
    // A waiting job whose printer cannot be read still waits.
    at.db
      .prepare('UPDATE floor_print_jobs SET device_id = ?, printer = \'{"id":"zebra"}\'')
      .run(PAIRING.deviceId);
    await expect(settled()).resolves.toBe(false);
  });

  it("refuses a stored job whose printer cannot be read", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    at.db.prepare('UPDATE floor_print_jobs SET printer = \'{"id":"zebra"}\'').run();
    await expect(readOpenJob(at.local, PAIRING, SHIFT_ID)).rejects.toBeInstanceOf(
      UnreadableJobError,
    );
  });
});

const OTHER_HOST = "11111111-1111-4111-8111-111111111111";

/** A second job of the same shift, copied from `job-1` under another subject; `set` then moves it. */
function cloneJob(
  at: Station,
  id: string,
  set: Partial<{
    state: string;
    verify: number;
    error_code: string | null;
    attempts: number;
    host_id: string;
    device_id: string;
    created_at: string;
  }> = {},
): void {
  at.db
    .prepare(
      "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, " +
        "sscc, state, verify, template_id, template_rev, fields, printer, bytes_base64, " +
        "attempts, operator_id, created_at, updated_at) SELECT ?, host_id, device_id, shift_id, " +
        "purpose, ?, sscc, state, verify, template_id, template_rev, fields, printer, " +
        "bytes_base64, attempts, operator_id, created_at, updated_at " +
        "FROM floor_print_jobs WHERE id = 'job-1'",
    )
    .run(id, `box-${id}`);
  for (const [column, value] of Object.entries(set)) {
    at.db.prepare(`UPDATE floor_print_jobs SET ${column} = ? WHERE id = ?`).run(value ?? null, id);
  }
}

describe("the states a send starts from", () => {
  it("sends a first send, a retry and a reprint, each with one attempt more and the same bytes", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    const context = printContext(at.local, runtime);
    const cases = [
      ["prepared", 0, null, 0],
      ["failed", 0, "not_sent", 1],
      ["unknown", 0, "timeout", 1],
      ["sent", 1, null, 1],
    ] as const;
    for (const [state, verify, code, attempts] of cases) {
      at.db
        .prepare("UPDATE floor_print_jobs SET state = ?, verify = ?, error_code = ?, attempts = ?")
        .run(state, verify, code, attempts);
      await expect(sendLabelJob(context, await job(at)), state).resolves.toMatchObject({
        state: "sent",
        errorCode: null,
        attempts: attempts + 1,
      });
    }
    expect(shell.sends).toEqual(
      cases.map(() => ({ target: ZEBRA.target, text: renderedText(ZEBRA, SSCC) })),
    );
  });

  it("refuses a job being sent right now and a job that is done with, and sends nothing", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    const context = printContext(at.local, runtime);
    const cases = [
      ["sending", 0, 1],
      ["verified", 1, 1],
      ["skipped", 1, 1],
    ] as const;
    for (const [state, verify, attempts] of cases) {
      at.db
        .prepare(
          "UPDATE floor_print_jobs SET state = ?, verify = ?, error_code = NULL, attempts = ?",
        )
        .run(state, verify, attempts);
      await expect(sendLabelJob(context, await job(at)), state).rejects.toBeInstanceOf(
        UnsendableJobError,
      );
      expect(jobRows(at.db)[0], state).toMatchObject({ state, attempts });
    }
    expect(shell.sends).toEqual([]);
  });

  it("refuses a job whose label did not render, though it keeps the printer", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at, at.local, async () => {
      throw new Error("RasterTooLargeError");
    });
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    const stored = await job(at);
    expect(stored.printer).toEqual(ZEBRA);
    await expect(sendLabelJob(printContext(at.local, runtime), stored)).rejects.toBeInstanceOf(
      UnsendableJobError,
    );
    expect(shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "failed", attempts: 0 });
  });

  it("stamps the job with the time of each write", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const { runtime } = manualRuntime(fakeHardware().hardware);
    const stored = await job(at);
    expect(stored.updatedAt).toBe(stored.createdAt);
    const sent = await sendLabelJob(printContext(at.local, runtime), stored);
    expect(sent.updatedAt).toBe("2026-10-08T06:30:02.000Z");
  });

  it("carries all the bytes of a label, high ones too", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const all = Array.from({ length: 256 }, (_, code) => String.fromCharCode(code)).join("");
    at.db.prepare("UPDATE floor_print_jobs SET bytes_base64 = ?").run(btoa(all));
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    await sendLabelJob(printContext(at.local, runtime), await job(at));
    expect(shell.sends[0]?.text).toBe(all);
  });
});

describe("the writes of a send", () => {
  it("refuses a read whose attempts are not the stored ones, before anything is sent", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent', attempts = 1",
      )
      .run();
    const read = await job(at);
    // Another send went through and failed again meanwhile.
    at.db.prepare("UPDATE floor_print_jobs SET attempts = 2").run();
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    await expect(sendLabelJob(printContext(at.local, runtime), read)).rejects.toBeInstanceOf(
      StaleJobError,
    );
    expect(shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "failed", attempts: 2 });
  });

  it("does not let the answer of an earlier attempt overwrite a later one", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime } = manualRuntime(shell.hardware);
    const sending = sendLabelJob(printContext(at.local, runtime), await job(at));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    at.db.prepare("UPDATE floor_print_jobs SET attempts = 2").run();
    shell.releaseSend({ sent: true });
    await expect(sending).rejects.toBeInstanceOf(StaleJobError);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending", attempts: 2 });
  });

  it("sends the bytes of another printer and keeps them with the job, and writes its extras with sending", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    const probe = {
      sql: "INSERT INTO workstation_settings (key, value) VALUES ('probe', '1')",
      expectedChanges: 1,
    };
    const sent = await sendLabelJob(printContext(at.local, runtime), await job(at), {
      rebind: { printer: TSC, bytesBase64: renderedBase64(TSC, SSCC) },
      extra: [probe],
    });
    expect(shell.sends).toEqual([{ target: TSC.target, text: renderedText(TSC, SSCC) }]);
    expect(sent).toMatchObject({ state: "sent", printer: TSC });
    expect(jobRows(at.db)[0]).toMatchObject({
      printer: JSON.stringify(TSC),
      bytes_base64: renderedBase64(TSC, SSCC),
    });
    expect(rows(at.db, "SELECT key FROM workstation_settings WHERE key = 'probe'")).toHaveLength(1);
  });

  it("writes none of the extras when the job moved on", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const read = await job(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'").run();
    const { runtime } = manualRuntime(fakeHardware().hardware);
    await expect(
      sendLabelJob(printContext(at.local, runtime), read, {
        extra: [
          {
            sql: "INSERT INTO workstation_settings (key, value) VALUES ('probe', '1')",
            expectedChanges: 1,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(StaleJobError);
    expect(rows(at.db, "SELECT key FROM workstation_settings WHERE key = 'probe'")).toEqual([]);
  });
});

describe("two sends to one printer", () => {
  it("go one after the other, both jobs sending meanwhile and neither taken for interrupted", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    cloneJob(at, "job-2");
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime } = manualRuntime(shell.hardware);
    const context = printContext(at.local, runtime);
    const first = sendLabelJob(context, await job(at, "job-1"));
    const second = sendLabelJob(context, await job(at, "job-2"));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    await flushPromises();
    expect(shell.sends).toHaveLength(1);
    expect(rows(at.db, "SELECT id, state FROM floor_print_jobs ORDER BY id")).toEqual([
      { id: "job-1", state: "sending" },
      { id: "job-2", state: "sending" },
    ]);
    expect(runtime.isInFlight("job-2")).toBe(true);
    await expect(recoverInterruptedJobs(context)).resolves.toBe(0);
    // The release also lets the next send through unheld.
    shell.releaseSend({ sent: true });
    await expect(first).resolves.toMatchObject({ state: "sent" });
    await expect(second).resolves.toMatchObject({ state: "sent" });
    expect(shell.sends).toHaveLength(2);
  });

  it("fail the one that waited out its limit, and never give its bytes to the shell", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    cloneJob(at, "job-2");
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime, expire } = manualRuntime(shell.hardware);
    const context = printContext(at.local, runtime);
    const first = sendLabelJob(context, await job(at, "job-1"));
    const second = sendLabelJob(context, await job(at, "job-2"));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    await flushPromises();
    expire();
    await expect(first).resolves.toMatchObject({ state: "unknown", errorCode: "timeout" });
    await expect(second).resolves.toMatchObject({ state: "failed", errorCode: "printer_busy" });
    shell.releaseSend({ sent: true });
    await flushPromises();
    expect(shell.sends).toHaveLength(1);
    expect(rows(at.db, "SELECT id, state, error_code FROM floor_print_jobs ORDER BY id")).toEqual([
      { id: "job-1", state: "unknown", error_code: "timeout" },
      { id: "job-2", state: "failed", error_code: "printer_busy" },
    ]);
  });
});

describe("a job of another host, and a job damaged", () => {
  it("is not read, not waited for and not recovered by this pairing", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent', verify = 0, attempts = 1").run();
    cloneJob(at, "job-foreign", {
      state: "sending",
      attempts: 1,
      host_id: OTHER_HOST,
      created_at: "2026-10-08T05:00:00.000Z",
    });
    await expect(readPrintJob(at.local, PAIRING, "job-foreign")).resolves.toBeNull();
    await expect(readOpenJob(at.local, PAIRING, SHIFT_ID)).resolves.toBeNull();
    await expect(shiftLabelsSettled(at.local, PAIRING, SHIFT_ID)).resolves.toBe(true);
    const { runtime } = manualRuntime(fakeHardware().hardware);
    await expect(recoverInterruptedJobs(printContext(at.local, runtime))).resolves.toBe(0);
    expect(rows(at.db, "SELECT state FROM floor_print_jobs WHERE id = 'job-foreign'")).toEqual([
      { state: "sending" },
    ]);
  });

  it("refuses a stored job whose fields cannot be read", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    for (const fields of ["[]", '{"sscc":5}', '{"sscc":"1","notAField":"x"}']) {
      at.db.prepare("UPDATE floor_print_jobs SET fields = ?").run(fields);
      await expect(readPrintJob(at.local, PAIRING, "job-1"), fields).rejects.toBeInstanceOf(
        UnreadableJobError,
      );
    }
  });
});

describe("a job that waits", () => {
  it("is the same in code and in SQL for every state", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const cases = [
      ["prepared", 0, null, 0, true],
      ["prepared", 1, null, 0, true],
      ["sending", 0, null, 1, true],
      ["sending", 1, null, 1, true],
      ["failed", 0, "not_sent", 1, true],
      ["failed", 1, "not_sent", 1, true],
      ["unknown", 0, "timeout", 1, true],
      ["unknown", 1, "timeout", 1, true],
      ["sent", 0, null, 1, false],
      ["sent", 1, null, 1, true],
      ["verified", 1, null, 1, false],
      ["skipped", 0, null, 1, false],
      ["skipped", 1, null, 1, false],
    ] as const;
    for (const [state, verify, code, attempts, open] of cases) {
      at.db
        .prepare("UPDATE floor_print_jobs SET state = ?, verify = ?, error_code = ?, attempts = ?")
        .run(state, verify, code, attempts);
      const stored = await job(at);
      expect(isOpenJob(stored), `${state} ${verify}`).toBe(open);
      expect(
        (await readOpenJob(at.local, PAIRING, SHIFT_ID)) !== null,
        `${state} ${verify} in SQL`,
      ).toBe(open);
    }
  });

  it("is made with the workstation's settings of the moment the box closes", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    const context = scanContext(at.local, at.shift);
    await fill(scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() }));
    const step = boxLabelStep({
      local: at.local,
      pairing: PAIRING,
      shift: at.shift,
      operatorName: null,
      newId: () => "job-1",
      render: fakeRender,
    });
    await setUpPrinting(at.local, {
      assignments: { box: "tsc", pallet: null, duplicate: null },
      verifyPrintedLabel: true,
    });
    await closeOpenBox(context, [step]);
    expect(jobRows(at.db)[0]).toMatchObject({
      printer: JSON.stringify(TSC),
      verify: 1,
      bytes_base64: renderedBase64(TSC, SSCC),
    });
  });
});
