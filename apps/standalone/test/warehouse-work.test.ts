import { describe, expect, it, vi } from "vitest";

import {
  cancelWarehouseJob,
  recoverWarehouseJob,
  reprintScan,
  sendWarehouseJob,
  sourceFields,
  verifyWarehouseJob,
  WarehousePrinterError,
  type WarehouseContext,
} from "../src/floor/warehouse/warehouse-work.js";
import {
  finishSession,
  readJob,
  startSession,
  type WarehouseSession,
} from "../src/floor/warehouse/warehouse-store.js";
import type { WarehouseLookup, WarehouseLookupResult } from "../src/host/protocol.js";
import { HostError } from "../src/host/client.js";
import { OPERATOR_ID, PAIRING, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { manualRuntime, setUpPrinting } from "./support/printing.js";
import {
  BOX_SOURCE,
  BOX_SSCC,
  BOX_TEMPLATE,
  CODE_HASH,
  KM,
  PALLET_SOURCE,
  PALLET_SSCC,
  PALLET_TEMPLATE,
  seedWarehouseCopies,
  UNIT_SOURCE,
  UNIT_TEMPLATE,
  warehouseRender,
} from "./support/warehouse.js";

const SESSION = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";

/** A station with the copies, the Zebra for boxes and pallets, the TSC for units, and an open session. */
async function station(options: { operator?: boolean; printers?: boolean } = {}) {
  const { db, executor } = openLocalDb();
  seedWarehouseCopies(db, options.operator === undefined ? {} : { operator: options.operator });
  if (options.printers !== false) {
    await setUpPrinting(executor, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
  }
  const shell = fakeHardware();
  const { runtime, expire } = manualRuntime(shell.hardware);
  let tick = Date.parse("2026-10-09T07:00:00.000Z");
  let id = 0;
  const context: WarehouseContext = {
    local: executor,
    pairing: PAIRING,
    runtime,
    now: () => new Date((tick += 1000)),
    newId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    render: warehouseRender,
  };
  const session: WarehouseSession = await startSession(executor, PAIRING, {
    id: SESSION,
    reason: "damaged",
    templates: { unit: UNIT_TEMPLATE, box: BOX_TEMPLATE, pallet: PALLET_TEMPLATE },
    operatorId: OPERATOR_ID,
    at: "2026-10-09T07:00:00.000Z",
  });
  return { db, local: executor, shell, expire, context, session };
}

function answering(result: WarehouseLookupResult) {
  return vi.fn(async (_lookup: WarehouseLookup) => result);
}

function scan(
  at: Awaited<ReturnType<typeof station>>,
  raw: string,
  ask: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>,
  online = true,
) {
  return reprintScan(at.context, {
    session: at.session,
    raw,
    operatorId: OPERATOR_ID,
    online,
    ask,
  });
}

function records(db: Awaited<ReturnType<typeof station>>["db"]): unknown[] {
  return rows(db, "SELECT payload FROM wh_outbox ORDER BY seq").map((row) =>
    JSON.parse(String(row["payload"])),
  );
}

describe("a label printed again from the warehouse (plan СКЛ)", () => {
  it("prints a box of another station found on the host, once, with its frozen fields", async () => {
    const at = await station();
    const ask = answering({ status: "found", source: BOX_SOURCE });
    const outcome = await scan(at, BOX_SSCC, ask);
    expect(ask).toHaveBeenCalledWith({ sscc: BOX_SSCC });
    expect(outcome).toMatchObject({
      kind: "printed",
      repair: null,
      job: { state: "sent", kind: "box", identity: BOX_SSCC, attempts: 1 },
    });
    expect(at.shell.sends.map((send) => send.text)).toEqual([
      `^XA zpl 203 58x40 ${BOX_SSCC} native ^XZ`,
    ]);
    expect(records(at.db)).toEqual([
      expect.objectContaining({
        subjectKind: "box",
        subjectId: BOX_SOURCE.subjectId,
        identity: BOX_SSCC,
        reasonCode: "damaged",
        outcome: "sent",
        errorCode: null,
        attempt: 1,
        operatorId: OPERATOR_ID,
        templateId: BOX_TEMPLATE,
        templateRev: 4,
      }),
    ]);
    // The same code again in the session is not printed by itself.
    const again = await scan(at, BOX_SSCC, ask);
    expect(again).toMatchObject({ kind: "duplicate", job: { state: "sent" } });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(at.shell.sends).toHaveLength(1);
  });

  it("finds the box of an old !1 label under its own SSCC and prints the corrected label", async () => {
    const at = await station();
    const ask = answering({ status: "found", source: BOX_SOURCE });
    const outcome = await scan(at, `]C1!100${BOX_SSCC}`, ask);
    expect(ask).toHaveBeenCalledWith({ sscc: BOX_SSCC });
    expect(outcome).toMatchObject({ kind: "printed", repair: "legacy_tspl_fnc1_literal" });
    expect(records(at.db)).toEqual([
      expect.objectContaining({ repair: "legacy_tspl_fnc1_literal" }),
    ]);
    // The correct form of the same SSCC is the same label in the session.
    expect(await scan(at, BOX_SSCC, ask)).toMatchObject({ kind: "duplicate" });
  });

  it("prints a unit's full code as the GS1 raster on the duplicate printer, and a pallet on its own", async () => {
    const at = await station();
    const unit = await scan(at, KM, answering({ status: "found", source: UNIT_SOURCE }));
    expect(unit).toMatchObject({ kind: "printed", job: { kind: "unit", identity: CODE_HASH } });
    if (unit.kind !== "printed") throw new Error("printed");
    expect(unit.job.fields["km.code"]).toBe(KM);
    expect(unit.job.fields.qty).toBe("1");
    const pallet = await scan(
      at,
      PALLET_SSCC,
      answering({ status: "found", source: PALLET_SOURCE }),
    );
    expect(pallet).toMatchObject({ kind: "printed", job: { kind: "pallet" } });
    expect(at.shell.sends.map((send) => send.text)).toEqual([
      "^XA tspl 300 58x40 km raster ^XZ",
      expect.stringContaining(`${PALLET_SSCC} native`),
    ]);
    expect(at.shell.sends[0]?.target).toEqual({ kind: "serial", port: "COM4", baud: 9600 });
  });

  it("takes the label's dates from the record, not from today", () => {
    const fields = sourceFields(BOX_SOURCE);
    expect(fields.date).toBe("08.10.2026");
    expect(fields.expiry).toBe("17.10.2026");
    expect(fields.qty).toBe("12");
    expect(fields["shift.no"]).toBe("OCT26-003");
    expect(fields["counterparty.name"]).toBe("ООО «Север»");
  });

  it("prints an imported unit and box like a native one, from the imported record's own facts", async () => {
    const imported = {
      imported: true,
      operatorName: null,
      deviceId: "00000000-0000-0000-0000-000000000000",
    };
    const at = await station();
    const unit = await scan(
      at,
      KM,
      answering({ status: "found", source: { ...UNIT_SOURCE, ...imported } }),
    );
    expect(unit).toMatchObject({ kind: "printed", job: { state: "sent", kind: "unit" } });
    const box = await scan(
      at,
      BOX_SSCC,
      answering({ status: "found", source: { ...BOX_SOURCE, ...imported } }),
    );
    expect(box).toMatchObject({ kind: "printed", job: { state: "sent", kind: "box" } });
    // The record names the imported subject as the host found it; nothing else of the job differs.
    expect(records(at.db)).toEqual([
      expect.objectContaining({ subjectKind: "unit", subjectId: UNIT_SOURCE.subjectId }),
      expect.objectContaining({ subjectKind: "box", subjectId: BOX_SOURCE.subjectId }),
    ]);
  });

  it("tells an imported record the label cannot be made of from a plain «not found»", async () => {
    const at = await station();
    for (const reason of [
      "imported_no_shift",
      "imported_no_production_date",
      "imported_product_unknown",
    ] as const) {
      expect(await scan(at, BOX_SSCC, answering({ status: "unavailable", reason }))).toEqual({
        kind: "unavailable",
        reason,
      });
    }
    expect(at.shell.sends).toHaveLength(0);
    expect(records(at.db)).toEqual([]);
  });

  it("says why nothing was printed: offline, not found, unavailable, an old host, a restore", async () => {
    const at = await station();
    const never = vi.fn(async (): Promise<WarehouseLookupResult> => ({ status: "not_found" }));
    expect(await scan(at, BOX_SSCC, never, false)).toEqual({ kind: "offline" });
    expect(never).not.toHaveBeenCalled();
    expect(await scan(at, BOX_SSCC, never)).toEqual({ kind: "not_found" });
    expect(
      await scan(at, BOX_SSCC, answering({ status: "unavailable", reason: "disassembled" })),
    ).toEqual({ kind: "unavailable", reason: "disassembled" });
    const failing = (error: HostError) =>
      vi.fn(async (): Promise<WarehouseLookupResult> => {
        throw error;
      });
    expect(
      await scan(
        at,
        BOX_SSCC,
        failing(new HostError({ kind: "transport", code: "unreachable", message: "x" })),
      ),
    ).toEqual({ kind: "offline" });
    expect(
      await scan(
        at,
        BOX_SSCC,
        failing(new HostError({ kind: "api", code: "not_found", status: 404, message: "x" })),
      ),
    ).toEqual({ kind: "host_outdated" });
    expect(
      await scan(
        at,
        BOX_SSCC,
        failing(new HostError({ kind: "api", code: "restore_pending", status: 503, message: "x" })),
      ),
    ).toEqual({ kind: "restore_pending" });
    expect(await scan(at, "hello", never)).toEqual({ kind: "invalid_scan" });
    expect(await scan(at, `!1!100${BOX_SSCC}`, never)).toEqual({ kind: "invalid_scan" });
    expect(at.shell.sends).toHaveLength(0);
    expect(records(at.db)).toEqual([]);
  });

  it("prints nothing for a code without its crypto tail, a missing template or an operator turned off", async () => {
    const at = await station();
    const bare = { ...UNIT_SOURCE, canonical: "010460068200001321S000001" };
    expect(await scan(at, KM, answering({ status: "found", source: bare }))).toEqual({
      kind: "refused",
      reason: "incomplete_km",
    });
    const noPallet = await station();
    noPallet.db.prepare("UPDATE wh_sessions SET pallet_template_id = NULL").run();
    noPallet.session = {
      ...noPallet.session,
      templates: { ...noPallet.session.templates, pallet: null },
    };
    expect(
      await scan(noPallet, PALLET_SSCC, answering({ status: "found", source: PALLET_SOURCE })),
    ).toEqual({ kind: "refused", reason: "no_template" });
    noPallet.db.prepare("UPDATE ref_templates SET enabled = 0 WHERE id = ?").run(BOX_TEMPLATE);
    expect(
      await scan(noPallet, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE })),
    ).toEqual({ kind: "refused", reason: "template_unavailable" });
    const nobody = await station({ operator: false });
    expect(
      await scan(nobody, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE })),
    ).toEqual({ kind: "refused", reason: "operator_denied" });
    for (const s of [at, noPallet, nobody]) expect(s.shell.sends).toHaveLength(0);
  });

  it("keeps a job with no printer failed, retries it once a printer is set, or cancels it", async () => {
    const at = await station({ printers: false });
    const outcome = await scan(at, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE }));
    expect(outcome).toMatchObject({
      kind: "printed",
      job: { state: "failed", errorCode: "printer_unconfigured", attempts: 0 },
    });
    if (outcome.kind !== "printed") throw new Error("printed");
    // Another code waits: the session takes none while this one is not decided.
    expect(
      await scan(at, PALLET_SSCC, answering({ status: "found", source: PALLET_SOURCE })),
    ).toMatchObject({ kind: "busy" });
    await expect(
      sendWarehouseJob(at.context, outcome.job, { kind: "retry" }, OPERATOR_ID),
    ).rejects.toBeInstanceOf(WarehousePrinterError);
    await setUpPrinting(at.local, { assignments: { box: "zebra", pallet: null, duplicate: null } });
    const sent = await sendWarehouseJob(at.context, outcome.job, { kind: "retry" }, OPERATOR_ID);
    expect(sent).toMatchObject({ state: "sent", attempts: 1 });
    const cancelling = await station({ printers: false });
    const failed = await scan(
      cancelling,
      BOX_SSCC,
      answering({ status: "found", source: BOX_SOURCE }),
    );
    if (failed.kind !== "printed") throw new Error("printed");
    expect(await cancelWarehouseJob(cancelling.context, failed.job, OPERATOR_ID)).toMatchObject({
      state: "cancelled",
    });
    expect(records(cancelling.db).map((record) => (record as { outcome: string }).outcome)).toEqual(
      ["failed", "cancelled"],
    );
    expect(
      await finishSession(
        cancelling.local,
        PAIRING,
        SESSION,
        OPERATOR_ID,
        "2026-10-09T08:00:00.000Z",
      ),
    ).toBe("finished");
  });

  it("never sends an unknown label again by itself: a scan of the new label or a new attempt with a reason", async () => {
    const at = await station();
    at.shell.holdSends();
    const pending = scan(at, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE }));
    await vi.waitFor(() => expect(at.shell.heldSends()).toBe(1));
    at.expire();
    const outcome = await pending;
    expect(outcome).toMatchObject({
      kind: "printed",
      job: { state: "unknown", errorCode: "timeout" },
    });
    if (outcome.kind !== "printed") throw new Error("printed");
    at.shell.releaseSend({ sent: true });
    expect(
      await finishSession(at.local, PAIRING, SESSION, OPERATOR_ID, "2026-10-09T08:00:00.000Z"),
    ).toBe("busy");
    // The old !1 label never checks the corrected one; another SSCC is a mismatch.
    expect(
      await verifyWarehouseJob(at.context, outcome.job, `!100${BOX_SSCC}`, OPERATOR_ID),
    ).toEqual({ kind: "invalid" });
    expect(await verifyWarehouseJob(at.context, outcome.job, PALLET_SSCC, OPERATOR_ID)).toEqual({
      kind: "mismatch",
    });
    const again = await sendWarehouseJob(
      at.context,
      outcome.job,
      { kind: "again", reason: "lost" },
      OPERATOR_ID,
    );
    expect(again).toMatchObject({ state: "sent", attempts: 2, reason: "lost" });
    expect(at.shell.sends).toHaveLength(2);
    expect(await verifyWarehouseJob(at.context, again, BOX_SSCC, OPERATOR_ID)).toMatchObject({
      kind: "verified",
      job: { state: "verified" },
    });
    expect(
      records(at.db).map((record) => {
        const r = record as {
          outcome: string;
          attempt: number;
          reasonCode: string;
          errorCode: string | null;
        };
        return [r.outcome, r.attempt, r.reasonCode, r.errorCode];
      }),
    ).toEqual([
      ["unknown", 1, "damaged", "timeout"],
      ["sent", 2, "lost", null],
      ["verified", 2, "lost", null],
    ]);
  });

  it("finds a send cut by a restart unknown, and leaves one still in flight alone", async () => {
    const at = await station();
    const printed = await scan(at, BOX_SSCC, answering({ status: "found", source: BOX_SOURCE }));
    if (printed.kind !== "printed") throw new Error("printed");
    // As if the app stopped right after writing `sending`.
    at.db.prepare("UPDATE wh_jobs SET state = 'sending' WHERE id = ?").run(printed.job.id);
    const flying: WarehouseContext = {
      ...at.context,
      runtime: { ...at.context.runtime, isInFlight: () => true },
    };
    expect(await recoverWarehouseJob(flying, SESSION, OPERATOR_ID)).toMatchObject({
      state: "sending",
    });
    expect(await recoverWarehouseJob(at.context, SESSION, OPERATOR_ID)).toMatchObject({
      state: "unknown",
      errorCode: "interrupted",
    });
    expect((await readJob(at.local, PAIRING, printed.job.id))?.attempts).toBe(1);
    expect(records(at.db).map((record) => (record as { outcome: string }).outcome)).toEqual([
      "sent",
      "unknown",
    ]);
    // Nothing went to the printer again.
    expect(at.shell.sends).toHaveLength(1);
  });
});
