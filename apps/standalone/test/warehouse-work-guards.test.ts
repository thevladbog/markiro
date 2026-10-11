import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplate,
  buildPalletLabelTemplates,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import { latin1ToBytes, renderLabel } from "../src/floor/print/label-render.js";
import { FAILED_CODES, UNKNOWN_CODES } from "../src/floor/print/print-jobs.js";
import type { PrintRuntime, SendOutcome } from "../src/floor/print/print-runtime.js";
import {
  checkTemplate,
  initialTemplates,
  isChoosable,
  KIND_PURPOSE,
  readOrgDefaults,
  readWarehouseTemplates,
  type WarehouseTemplate,
} from "../src/floor/warehouse/warehouse-templates.js";
import {
  finishSession,
  readJob,
  readOpenJob,
  startSession,
  StaleWarehouseError,
  type WarehouseJob,
  type WarehouseJobState,
  type WarehouseSession,
  type WarehouseTemplates,
} from "../src/floor/warehouse/warehouse-store.js";
import {
  cancelWarehouseJob,
  lookUp,
  MAX_WAREHOUSE_ATTEMPTS,
  prepareWarehouseJob,
  readWarehouseScan,
  recoverWarehouseJob,
  reprintScan,
  sendWarehouseJob,
  sourceFields,
  verifyWarehouseJob,
  WarehouseAttemptsError,
  WarehousePrinterError,
  WarehouseStateError,
  type RenderWarehouseLabel,
  type ScanOutcome,
  type WarehouseContext,
} from "../src/floor/warehouse/warehouse-work.js";
import { HostError } from "../src/host/client.js";
import {
  warehouseRecordSchema,
  type WarehouseLookup,
  type WarehouseLookupResult,
} from "../src/host/protocol.js";
import type { PrintResult } from "../src/hardware/hardware.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { OPERATOR_ID, PAIRING, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRaster, manualRuntime, setUpPrinting, TSC, ZEBRA } from "./support/printing.js";
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
const ZEBRA_TWO = {
  ...ZEBRA,
  id: "zebra-two",
  name: "Zebra на складе",
  target: { kind: "tcp" as const, host: "192.168.1.51", port: 9100 },
};

interface StationOptions {
  operator?: boolean;
  printers?: boolean;
  reason?: WarehouseSession["reason"];
  templates?: WarehouseTemplates;
  render?: RenderWarehouseLabel;
}

/** A station with the copies, printers, an open session and a printer that answers `answers` in turn. */
async function station(options: StationOptions = {}) {
  const { db, executor } = openLocalDb();
  seedWarehouseCopies(db, options.operator === undefined ? {} : { operator: options.operator });
  if (options.printers !== false) {
    await setUpPrinting(executor, {
      printers: [ZEBRA, ZEBRA_TWO, TSC],
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
  }
  const answers: PrintResult[] = [];
  const atSend: Record<string, unknown>[][] = [];
  const shell = fakeHardware(async () => {
    atSend.push(
      rows(
        db,
        "SELECT state, attempts, error_code, bytes_base64 IS NOT NULL AS has_bytes FROM wh_jobs",
      ),
      rows(db, "SELECT count(*) AS n FROM wh_outbox"),
    );
    return answers.shift() ?? { sent: true };
  });
  const { runtime, expire } = manualRuntime(shell.hardware);
  let tick = Date.parse("2026-10-09T07:00:00.000Z");
  let id = 0;
  const context: WarehouseContext = {
    local: executor,
    pairing: PAIRING,
    runtime,
    now: () => new Date((tick += 1000)),
    newId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    render: options.render ?? warehouseRender,
  };
  const session: WarehouseSession = await startSession(executor, PAIRING, {
    id: SESSION,
    reason: options.reason ?? "damaged",
    templates: options.templates ?? {
      unit: UNIT_TEMPLATE,
      box: BOX_TEMPLATE,
      pallet: PALLET_TEMPLATE,
    },
    operatorId: OPERATOR_ID,
    at: "2026-10-09T07:00:00.000Z",
  });
  return { db, local: executor, shell, expire, context, session, answers, atSend };
}
type Station = Awaited<ReturnType<typeof station>>;

const found = (source: typeof BOX_SOURCE | typeof UNIT_SOURCE | typeof PALLET_SOURCE) =>
  vi.fn(async (_lookup: WarehouseLookup): Promise<WarehouseLookupResult> => ({
    status: "found",
    source,
  }));

function scan(at: Station, raw: string, ask = found(BOX_SOURCE), online = true) {
  return reprintScan(at.context, {
    session: at.session,
    raw,
    operatorId: OPERATOR_ID,
    online,
    ask,
  });
}

function printed(outcome: ScanOutcome): WarehouseJob {
  if (outcome.kind !== "printed") throw new Error(`expected printed, got ${outcome.kind}`);
  return outcome.job;
}

function stored(at: Station): Record<string, unknown>[] {
  return rows(at.db, "SELECT payload FROM wh_outbox ORDER BY seq").map(
    (row) => JSON.parse(String(row["payload"])) as Record<string, unknown>,
  );
}

/** The host's rules for a record (host `warehouse.rs` and the Zod mirror), checked on what the station stored. */
function expectHostShape(record: Record<string, unknown>): void {
  const parsed = warehouseRecordSchema.parse(record);
  for (const key of ["repair", "errorCode", "operatorId"])
    expect(Object.keys(record)).toContain(key);
  expect(parsed.attempt).toBeLessThanOrEqual(10_000);
  for (const text of [parsed.subjectId, parsed.identity, parsed.templateId]) {
    expect(text.length).toBeGreaterThanOrEqual(1);
    expect(text.length).toBeLessThanOrEqual(64);
    expect(text).toBe(text.trim());
    expect(text).not.toMatch(/\p{Cc}/u);
  }
  if (parsed.errorCode === null) {
    expect(["sent", "verified", "cancelled"]).toContain(parsed.outcome);
  } else {
    expect(["failed", "unknown"]).toContain(parsed.outcome);
    expect(parsed.errorCode).toMatch(/^[a-z_]{1,64}$/);
  }
  if (parsed.outcome === "failed" || parsed.outcome === "unknown") {
    expect(parsed.errorCode).not.toBeNull();
  }
  expect(new Date(parsed.occurredAt).toISOString()).toBe(parsed.occurredAt);
}

function counts(at: Station, except: (name: string) => boolean): Record<string, number> {
  const tables = rows(at.db, "SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => String(row["name"]))
    .filter((name) => !name.startsWith("sqlite_") && !except(name));
  return Object.fromEntries(
    tables.map((name) => [
      name,
      Number(rows(at.db, `SELECT count(*) AS n FROM "${name}"`)[0]?.["n"]),
    ]),
  );
}

describe("a reprint never makes a new identity (plan СКЛ task 5)", () => {
  it("renders and stores exactly the looked-up unit's code, and the record carries only its hash", async () => {
    const renders: { sscc: string; km: string }[] = [];
    const at = await station({
      render: async (spec, fields, printer, options) => {
        renders.push({ sscc: fields.sscc, km: fields["km.code"] });
        return warehouseRender(spec, fields, printer, options);
      },
    });
    const job = printed(await scan(at, KM, found(UNIT_SOURCE)));
    expect(renders).toEqual([{ sscc: "", km: KM }]);
    expect(job.fields["km.code"]).toBe(KM);
    expect(job.identity).toBe(CODE_HASH);
    const records = stored(at);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ identity: CODE_HASH, subjectId: UNIT_SOURCE.subjectId });
    // The full code stays on this computer, in the job; it is not in a record bound for the host.
    expect(JSON.stringify(records)).not.toContain("Tail");
    expect(JSON.stringify(records)).not.toContain("0104600682");
  });

  it("renders a box and a pallet with the looked-up SSCC and none of their own", async () => {
    const renders: string[] = [];
    const at = await station({
      render: async (spec, fields, printer, options) => {
        renders.push(`${fields.sscc}|${fields["km.code"]}`);
        return warehouseRender(spec, fields, printer, options);
      },
    });
    printed(await scan(at, BOX_SSCC, found(BOX_SOURCE)));
    const pallet = printed(await scan(at, PALLET_SSCC, found(PALLET_SOURCE)));
    expect(renders).toEqual([`${BOX_SSCC}|`, `${PALLET_SSCC}|`]);
    expect(pallet.fields.sscc).toBe(PALLET_SSCC);
    expect(stored(at).map((record) => record["identity"])).toEqual([BOX_SSCC, PALLET_SSCC]);
  });

  it("writes no fact, box, pallet, code, SSCC block or reference row", async () => {
    const at = await station();
    const before = counts(at, (name) => name.startsWith("wh_"));
    printed(await scan(at, KM, found(UNIT_SOURCE)));
    printed(await scan(at, BOX_SSCC, found(BOX_SOURCE)));
    printed(await scan(at, PALLET_SSCC, found(PALLET_SOURCE)));
    expect(counts(at, (name) => name.startsWith("wh_"))).toEqual(before);
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["outbox", "ref_templates"]));
    expect(rows(at.db, "SELECT count(*) AS n FROM wh_jobs")[0]).toEqual({ n: 3 });
  });

  it("takes an answer for another code or SSCC for no answer", async () => {
    const at = await station();
    const other = { ...UNIT_SOURCE, identity: "0".repeat(64) };
    expect(await scan(at, KM, found(other))).toEqual({ kind: "lookup_failed" });
    const boxFor = { ...BOX_SOURCE, identity: PALLET_SSCC, sscc: PALLET_SSCC };
    expect(await scan(at, BOX_SSCC, found(boxFor))).toEqual({ kind: "lookup_failed" });
    expect(at.shell.sends).toHaveLength(0);
    expect(rows(at.db, "SELECT count(*) AS n FROM wh_jobs")[0]).toEqual({ n: 0 });
  });

  it("refuses a record whose stored code or SSCC is not the one it was found by", async () => {
    const at = await station();
    // Same GTIN, another serial with a crypto tail: a different unit under this hash.
    const another = "010460068200001321S000002\u001d93Tail";
    expect(await scan(at, KM, found({ ...UNIT_SOURCE, canonical: another }))).toEqual({
      kind: "refused",
      reason: "incomplete_km",
    });
    expect(await scan(at, BOX_SSCC, found({ ...BOX_SOURCE, sscc: PALLET_SSCC }))).toEqual({
      kind: "refused",
      reason: "incomplete_km",
    });
    const without = { ...BOX_SOURCE };
    delete without.sscc;
    expect(await scan(at, BOX_SSCC, found(without))).toEqual({
      kind: "refused",
      reason: "incomplete_km",
    });
    expect(() => sourceFields({ ...PALLET_SOURCE, sscc: BOX_SSCC })).toThrow();
    expect(at.shell.sends).toHaveLength(0);
    expect(rows(at.db, "SELECT count(*) AS n FROM wh_jobs")[0]).toEqual({ n: 0 });
  });
});

describe("the scan and the host's answer (plan СКЛ task 5)", () => {
  it("reads a code as its hash, an SSCC as itself and an old !1 label as a repaired SSCC", () => {
    expect(readWarehouseScan(KM)).toEqual({ kind: "code", codeHash: CODE_HASH });
    expect(readWarehouseScan(`  ${BOX_SSCC}\n`)).toEqual({
      kind: "sscc",
      sscc: BOX_SSCC,
      repair: null,
    });
    expect(readWarehouseScan(`!100${BOX_SSCC}`)).toEqual({
      kind: "sscc",
      sscc: BOX_SSCC,
      repair: "legacy_tspl_fnc1_literal",
    });
    expect(readWarehouseScan("!100046006820000015001")).toEqual({ kind: "invalid" });
    expect(readWarehouseScan("!100046006820000015007")).toEqual({ kind: "invalid" });
    expect(readWarehouseScan("")).toEqual({ kind: "invalid" });
  });

  it("asks by the code's hash for a code and by the SSCC for an SSCC, nothing else", async () => {
    const ask = vi.fn(async (): Promise<WarehouseLookupResult> => ({ status: "not_found" }));
    await lookUp(ask, { kind: "code", codeHash: CODE_HASH });
    await lookUp(ask, { kind: "sscc", sscc: BOX_SSCC, repair: null });
    expect(ask.mock.calls).toEqual([[{ codeHash: CODE_HASH }], [{ sscc: BOX_SSCC }]]);
  });

  it("hands the shell its own refusals and calls every other failure by what it is", async () => {
    const scanned = { kind: "sscc", sscc: BOX_SSCC, repair: null } as const;
    const failing = (error: unknown) => async (): Promise<WarehouseLookupResult> => {
      throw error;
    };
    const rejected = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "x",
      details: { credential: "device" },
    });
    expect(await lookUp(failing(rejected), scanned)).toEqual({
      kind: "host_error",
      error: rejected,
    });
    const changed = new HostError({
      kind: "transport",
      code: "certificate_mismatch",
      message: "x",
    });
    expect(await lookUp(failing(changed), scanned)).toEqual({ kind: "host_error", error: changed });
    const text = new HostError({ kind: "transport", code: "invalid_response", message: "x" });
    expect(await lookUp(failing(text), scanned)).toEqual({ kind: "lookup_failed" });
    const refused = new HostError({ kind: "api", code: "forbidden", status: 403, message: "x" });
    expect(await lookUp(failing(refused), scanned)).toEqual({ kind: "lookup_failed" });
    const broken = new HostError({ kind: "api", code: "internal", status: 500, message: "x" });
    expect(await lookUp(failing(broken), scanned)).toEqual({ kind: "lookup_failed" });
    expect(await lookUp(failing(new Error("x")), scanned)).toEqual({ kind: "lookup_failed" });
    const timeout = new HostError({ kind: "transport", code: "timeout", message: "x" });
    expect(await lookUp(failing(timeout), scanned)).toEqual({ kind: "offline" });
  });

  it("looks nothing up while a job waits, and answers a printed code before the link", async () => {
    const at = await station({ printers: false });
    const ask = found(BOX_SOURCE);
    const failed = printed(await scan(at, BOX_SSCC, ask));
    expect(failed.state).toBe("failed");
    const other = found(PALLET_SOURCE);
    expect(await scan(at, PALLET_SSCC, other)).toMatchObject({
      kind: "busy",
      job: { id: failed.id },
    });
    expect(other).not.toHaveBeenCalled();
    // The waiting job comes before the link, too.
    expect(await scan(at, PALLET_SSCC, other, false)).toMatchObject({ kind: "busy" });
    await setUpPrinting(at.local, { assignments: { box: "zebra", pallet: null, duplicate: null } });
    await sendWarehouseJob(at.context, failed, { kind: "retry" }, OPERATOR_ID);
    // Printed in this session: answered with no link and no host.
    expect(await scan(at, BOX_SSCC, other, false)).toMatchObject({ kind: "duplicate" });
    expect(await scan(at, PALLET_SSCC, other, false)).toEqual({ kind: "offline" });
    expect(other).not.toHaveBeenCalled();
  });

  it("scans a code again after its job was cancelled", async () => {
    const at = await station({ printers: false });
    const first = printed(await scan(at, BOX_SSCC));
    await cancelWarehouseJob(at.context, first, OPERATOR_ID);
    await setUpPrinting(at.local, { assignments: { box: "zebra", pallet: null, duplicate: null } });
    const second = await scan(at, BOX_SSCC);
    expect(second).toMatchObject({ kind: "printed", job: { state: "sent" } });
    expect(at.shell.sends).toHaveLength(1);
  });

  it("gives a job the session's reason at the time of the scan", async () => {
    const at = await station({ reason: "not_printed" });
    const job = printed(await scan(at, BOX_SSCC));
    expect(job.reason).toBe("not_printed");
    expect(stored(at)[0]).toMatchObject({ reasonCode: "not_printed" });
    // A change of the session's reason is for the next jobs.
    const later = { ...at.session, reason: "lost" as const };
    expect(
      printed(
        await reprintScan(at.context, {
          session: later,
          raw: PALLET_SSCC,
          operatorId: OPERATOR_ID,
          online: true,
          ask: found(PALLET_SOURCE),
        }),
      ).reason,
    ).toBe("lost");
    expect(job.reason).toBe("not_printed");
  });
});

describe("what keeps a job from being made (plan СКЛ task 5)", () => {
  it("refuses an operator the copies do not know yet or no longer", async () => {
    const unready = await station();
    unready.db.prepare("DELETE FROM sync_state").run();
    expect(await scan(unready, BOX_SSCC)).toEqual({ kind: "refused", reason: "operator_denied" });
    const gone = await station();
    gone.db.prepare("DELETE FROM ref_operators").run();
    expect(await scan(gone, BOX_SSCC)).toEqual({ kind: "refused", reason: "operator_denied" });
    for (const at of [unready, gone]) {
      expect(at.shell.sends).toHaveLength(0);
      expect(rows(at.db, "SELECT count(*) AS n FROM wh_jobs")[0]).toEqual({ n: 0 });
    }
  });

  it("puts no other template in the place of the chosen one", async () => {
    const at = await station();
    at.db.prepare("UPDATE ref_templates SET category_codes = '[3]' WHERE id = ?").run(BOX_TEMPLATE);
    expect(await scan(at, BOX_SSCC)).toEqual({ kind: "refused", reason: "template_unfit" });
    at.db.prepare("UPDATE ref_templates SET category_codes = '[8]' WHERE id = ?").run(BOX_TEMPLATE);
    expect(await scan(at, BOX_SSCC)).toMatchObject({ kind: "printed" });
    expect(at.shell.sends).toHaveLength(1);
  });

  it("does not widen a template whose category list does not read", async () => {
    const at = await station();
    at.db
      .prepare("UPDATE ref_templates SET category_codes = 'oops' WHERE id = ?")
      .run(BOX_TEMPLATE);
    expect(await scan(at, BOX_SSCC)).toEqual({ kind: "refused", reason: "template_unavailable" });
    expect(at.shell.sends).toHaveLength(0);
  });

  it("answers busy, not an error, when the one place of the session was taken meanwhile", async () => {
    const at = await station({ printers: false });
    const waiting = printed(await scan(at, BOX_SSCC));
    // The open-job read says «none» once, as if the waiting job had been made right after it.
    let hide = true;
    const racing: LocalExecutor = {
      query: async (sql, params, row) =>
        hide && sql.includes("state IN ('prepared'")
          ? ((hide = false), [])
          : at.local.query(sql, params, row),
      transaction: (statements) => at.local.transaction(statements),
    };
    const outcome = await prepareWarehouseJob(
      { ...at.context, local: racing },
      { session: at.session, source: PALLET_SOURCE, repair: null, operatorId: OPERATOR_ID },
    );
    expect(outcome).toEqual({ kind: "refused", reason: "busy" });
    expect((await readOpenJob(at.local, PAIRING, SESSION))?.id).toBe(waiting.id);
    expect(rows(at.db, "SELECT count(*) AS n FROM wh_jobs")[0]).toEqual({ n: 1 });
  });

  it("lets any other failure of the write through", async () => {
    const at = await station();
    const broken: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: async () => {
        throw new LocalDbError("statement_failed", "disk");
      },
    };
    await expect(
      prepareWarehouseJob(
        { ...at.context, local: broken },
        { session: at.session, source: BOX_SOURCE, repair: null, operatorId: OPERATOR_ID },
      ),
    ).rejects.toMatchObject({ code: "statement_failed" });
  });

  it("does not call a failure that is not the database's busy either", async () => {
    const at = await station({ printers: false });
    printed(await scan(at, BOX_SSCC));
    const broken: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: async () => {
        throw new Error("lost");
      },
    };
    let hide = true;
    const racing: LocalExecutor = {
      ...broken,
      query: async (sql, params, row) =>
        hide && sql.includes("state IN ('prepared'")
          ? ((hide = false), [])
          : at.local.query(sql, params, row),
    };
    await expect(
      prepareWarehouseJob(
        { ...at.context, local: racing },
        { session: at.session, source: PALLET_SOURCE, repair: null, operatorId: OPERATOR_ID },
      ),
    ).rejects.toThrow("lost");
  });

  it("keeps a label that does not render as a failed job, and says so again on a retry", async () => {
    let fail = true;
    const at = await station({
      render: async (spec, fields, printer, options) => {
        if (fail) throw new Error("too wide");
        return warehouseRender(spec, fields, printer, options);
      },
    });
    const job = printed(await scan(at, BOX_SSCC));
    expect(job).toMatchObject({ state: "failed", errorCode: "render_failed", attempts: 0 });
    expect(job.printer).toBeNull();
    expect(job.bytesBase64).toBeNull();
    expect(stored(at)).toEqual([
      expect.objectContaining({ outcome: "failed", errorCode: "render_failed", attempt: 0 }),
    ]);
    await expect(sendWarehouseJob(at.context, job, { kind: "retry" }, OPERATOR_ID)).rejects.toEqual(
      new WarehousePrinterError("render_failed"),
    );
    expect((await readJob(at.local, PAIRING, job.id))?.state).toBe("failed");
    expect(at.shell.sends).toHaveLength(0);
    fail = false;
    expect(await sendWarehouseJob(at.context, job, { kind: "retry" }, OPERATOR_ID)).toMatchObject({
      state: "sent",
      attempts: 1,
    });
  });
});

describe("one send, written before and never repeated by itself (plan СКЛ task 5)", () => {
  it("writes the job as sending, with its bytes and attempt, before the printer sees a byte", async () => {
    const at = await station();
    printed(await scan(at, BOX_SSCC));
    const [jobs, outbox] = at.atSend;
    expect(jobs).toEqual([{ state: "sending", attempts: 1, error_code: null, has_bytes: 1 }]);
    // The attempt's record is written when the attempt ends, not before.
    expect(outbox).toEqual([{ n: 0 }]);
  });

  it("finds a send that was cut by a restart unknown, and a late answer cannot undo it", async () => {
    const at = await station();
    at.shell.holdSends();
    const pending = scan(at, BOX_SSCC);
    await vi.waitFor(() => expect(at.shell.heldSends()).toBe(1));
    // The app starts again: a new runtime holds nothing.
    const restarted: WarehouseContext = {
      ...at.context,
      runtime: manualRuntime(fakeHardware().hardware).runtime,
    };
    const recovered = await recoverWarehouseJob(restarted, SESSION, OPERATOR_ID);
    expect(recovered).toMatchObject({ state: "unknown", errorCode: "interrupted", attempts: 1 });
    expect(
      stored(at).map((record) => [record["outcome"], record["errorCode"], record["attempt"]]),
    ).toEqual([["unknown", "interrupted", 1]]);
    // The old process' send answers late: its write finds the job moved.
    at.shell.releaseSend({ sent: true });
    await expect(pending).rejects.toBeInstanceOf(StaleWarehouseError);
    expect(await readOpenJob(at.local, PAIRING, SESSION)).toMatchObject({ state: "unknown" });
    expect(at.shell.sends).toHaveLength(1);
    expect(stored(at)).toHaveLength(1);
  });

  it("leaves every other job alone when the screen opens", async () => {
    const at = await station({ printers: false });
    expect(await recoverWarehouseJob(at.context, SESSION, OPERATOR_ID)).toBeNull();
    const failed = printed(await scan(at, BOX_SSCC));
    expect(await recoverWarehouseJob(at.context, SESSION, OPERATOR_ID)).toMatchObject({
      id: failed.id,
      state: "failed",
    });
    at.db.prepare("UPDATE wh_jobs SET state = 'cancelled', error_code = NULL").run();
    expect(await recoverWarehouseJob(at.context, SESSION, OPERATOR_ID)).toBeNull();
    expect(stored(at)).toHaveLength(1);
  });

  it("sends nothing by itself when an unknown label waits: every way in is a decision", async () => {
    const at = await station();
    at.answers.push({ sent: false, code: "outcome_unknown" });
    const job = printed(await scan(at, BOX_SSCC));
    expect(job).toMatchObject({ state: "unknown", errorCode: "outcome_unknown" });
    // The same code, another code, a restart's recovery, a retry: none sends.
    expect(await scan(at, BOX_SSCC)).toMatchObject({ kind: "busy", job: { state: "unknown" } });
    expect(await scan(at, PALLET_SSCC, found(PALLET_SOURCE))).toMatchObject({ kind: "busy" });
    expect(await recoverWarehouseJob(at.context, SESSION, OPERATOR_ID)).toMatchObject({
      state: "unknown",
    });
    await expect(
      sendWarehouseJob(at.context, job, { kind: "retry" }, OPERATOR_ID),
    ).rejects.toBeInstanceOf(WarehouseStateError);
    await expect(
      sendWarehouseJob(at.context, job, { kind: "first" }, OPERATOR_ID),
    ).rejects.toBeInstanceOf(WarehouseStateError);
    expect(at.shell.sends).toHaveLength(1);
    expect(
      await finishSession(at.local, PAIRING, SESSION, OPERATOR_ID, "2026-10-09T08:00:00.000Z"),
    ).toBe("busy");
  });

  const NOT_ALLOWED: [string, WarehouseJobState[]][] = [
    ["first", ["sending", "sent", "failed", "unknown", "verified", "cancelled"]],
    ["retry", ["prepared", "sending", "sent", "unknown", "verified", "cancelled"]],
    ["again", ["prepared", "sending", "failed", "cancelled"]],
  ];
  it.each(NOT_ALLOWED)(
    "does not send on a %s from a state that is not its own",
    async (kind, states) => {
      const at = await station();
      const job = printed(await scan(at, BOX_SSCC));
      const intent =
        kind === "again"
          ? ({ kind: "again", reason: "lost" } as const)
          : ({ kind } as { kind: "first" } | { kind: "retry" });
      for (const state of states) {
        await expect(
          sendWarehouseJob(at.context, { ...job, state }, intent, OPERATOR_ID),
        ).rejects.toBeInstanceOf(WarehouseStateError);
      }
      expect(at.shell.sends).toHaveLength(1);
      expect(stored(at)).toHaveLength(1);
    },
  );

  it("sends a prepared job found after a restart only when the operator says so", async () => {
    const at = await station();
    // A job made and stored, never sent (the app stopped between the two).
    const stub: PrintRuntime = { send: vi.fn(), isInFlight: () => false, inFlight: () => [] };
    const made = await prepareWarehouseJob(
      { ...at.context, runtime: stub },
      { session: at.session, source: BOX_SOURCE, repair: null, operatorId: OPERATOR_ID },
    );
    if (made.kind !== "job") throw new Error("job");
    expect(made.job.state).toBe("prepared");
    expect(stub.send).not.toHaveBeenCalled();
    expect(await recoverWarehouseJob(at.context, SESSION, OPERATOR_ID)).toMatchObject({
      state: "prepared",
    });
    expect(at.shell.sends).toHaveLength(0);
    expect(
      await sendWarehouseJob(at.context, made.job, { kind: "first" }, OPERATOR_ID),
    ).toMatchObject({
      state: "sent",
      attempts: 1,
    });
  });

  it("takes a new attempt of a sent label with a reason, from the frozen bytes of the same printer", async () => {
    const renders = vi.fn(warehouseRender);
    const at = await station({ render: renders });
    const job = printed(await scan(at, BOX_SSCC));
    const again = await sendWarehouseJob(
      at.context,
      job,
      { kind: "again", reason: "lost" },
      OPERATOR_ID,
    );
    expect(again).toMatchObject({ state: "sent", attempts: 2, reason: "lost" });
    // The same bytes, the same printer: nothing is drawn again.
    expect(renders).toHaveBeenCalledTimes(1);
    expect(at.shell.sends.map((send) => send.text)).toEqual([
      `^XA zpl 203 58x40 ${BOX_SSCC} native ^XZ`,
      `^XA zpl 203 58x40 ${BOX_SSCC} native ^XZ`,
    ]);
    expect(again.fields).toEqual(job.fields);
    expect(again.identity).toBe(job.identity);
    expect(
      stored(at).map((record) => [record["outcome"], record["attempt"], record["reasonCode"]]),
    ).toEqual([
      ["sent", 1, "damaged"],
      ["sent", 2, "lost"],
    ]);
  });

  it("prints a retry on the printer assigned now, and draws the label again only for another language or resolution", async () => {
    const renders = vi.fn(warehouseRender);
    const at = await station({ render: renders });
    at.answers.push({ sent: false, code: "not_sent" });
    const job = printed(await scan(at, BOX_SSCC));
    expect(job).toMatchObject({ state: "failed", errorCode: "not_sent", attempts: 1 });
    // Another printer of the same language and resolution: the bytes are kept, the target is new.
    await setUpPrinting(at.local, {
      printers: [ZEBRA, ZEBRA_TWO, TSC],
      assignments: { box: "zebra-two", pallet: null, duplicate: null },
    });
    at.answers.push({ sent: false, code: "not_sent" });
    const second = await sendWarehouseJob(at.context, job, { kind: "retry" }, OPERATOR_ID);
    expect(second).toMatchObject({ state: "failed", attempts: 2 });
    expect(renders).toHaveBeenCalledTimes(1);
    expect(at.shell.sends.map((send) => send.target)).toEqual([ZEBRA.target, ZEBRA_TWO.target]);
    // The same language at another resolution: the label is drawn again for it.
    const sharp = {
      ...ZEBRA_TWO,
      id: "zebra-sharp",
      dpi: 300 as const,
      target: { kind: "tcp" as const, host: "192.168.1.52", port: 9100 },
    };
    await setUpPrinting(at.local, {
      printers: [ZEBRA, ZEBRA_TWO, TSC, sharp],
      assignments: { box: "zebra-sharp", pallet: null, duplicate: null },
    });
    const third = await sendWarehouseJob(at.context, second, { kind: "retry" }, OPERATOR_ID);
    expect(third).toMatchObject({ state: "sent", attempts: 3, printer: { id: "zebra-sharp" } });
    expect(renders).toHaveBeenCalledTimes(2);
    expect(at.shell.sends[2]?.text).toBe(`^XA zpl 300 58x40 ${BOX_SSCC} native ^XZ`);
    // Another language: drawn again, too.
    await setUpPrinting(at.local, {
      printers: [ZEBRA, ZEBRA_TWO, TSC, sharp],
      assignments: { box: "tsc", pallet: null, duplicate: null },
    });
    await sendWarehouseJob(at.context, third, { kind: "again", reason: "damaged" }, OPERATOR_ID);
    expect(renders).toHaveBeenCalledTimes(3);
    expect(at.shell.sends[3]).toEqual({
      target: TSC.target,
      text: `^XA tspl 300 58x40 ${BOX_SSCC} native ^XZ`,
    });
  });

  it("says why a retry cannot print: no printer assigned, or a frozen layout that no longer reads", async () => {
    const renders = vi.fn(async () => latin1ToBytes("label"));
    const at = await station({ printers: false, render: renders });
    const job = printed(await scan(at, BOX_SSCC));
    await expect(sendWarehouseJob(at.context, job, { kind: "retry" }, OPERATOR_ID)).rejects.toEqual(
      new WarehousePrinterError("printer_unconfigured"),
    );
    expect(renders).toHaveBeenCalledTimes(0);
    await setUpPrinting(at.local, { assignments: { box: "zebra", pallet: null, duplicate: null } });
    const damaged = { ...job, templateSpec: '{"widthMm": "wide"}' };
    await expect(
      sendWarehouseJob(at.context, damaged, { kind: "retry" }, OPERATOR_ID),
    ).rejects.toEqual(new WarehousePrinterError("render_failed"));
    // Not even tried: the frozen layout is the label.
    expect(renders).toHaveBeenCalledTimes(0);
    expect(at.shell.sends).toHaveLength(0);
    expect((await readJob(at.local, PAIRING, job.id))?.state).toBe("failed");
  });

  it("draws a unit's code as the raster on a retry, too", async () => {
    const renders = vi.fn(warehouseRender);
    const at = await station({ render: renders });
    at.answers.push({ sent: false, code: "not_sent" });
    const job = printed(await scan(at, KM, found(UNIT_SOURCE)));
    await setUpPrinting(at.local, {
      printers: [ZEBRA, TSC],
      assignments: { box: null, pallet: null, duplicate: "zebra" },
    });
    await sendWarehouseJob(at.context, job, { kind: "retry" }, OPERATOR_ID);
    expect(renders.mock.calls.map((call) => call[3])).toEqual([
      { kmDataMatrix: "raster" },
      { kmDataMatrix: "raster" },
    ]);
    // A box, on the other hand, is drawn with the native barcode.
    const box = await station({ render: renders });
    printed(await scan(box, BOX_SSCC));
    expect(renders.mock.calls[2]?.[3]).toEqual({});
  });

  it("does not send past the attempts the host will take a record for", async () => {
    const at = await station();
    const job = printed(await scan(at, BOX_SSCC));
    at.db.prepare("UPDATE wh_jobs SET attempts = ?").run(MAX_WAREHOUSE_ATTEMPTS);
    const full = await readJob(at.local, PAIRING, job.id);
    if (full === null) throw new Error("job");
    await expect(
      sendWarehouseJob(at.context, full, { kind: "again", reason: "lost" }, OPERATOR_ID),
    ).rejects.toBeInstanceOf(WarehouseAttemptsError);
    expect(at.shell.sends).toHaveLength(1);
    expect(stored(at)).toHaveLength(1);
    // The last attempt the host takes is the 10000th.
    at.db.prepare("UPDATE wh_jobs SET attempts = ?").run(MAX_WAREHOUSE_ATTEMPTS - 1);
    const almost = await readJob(at.local, PAIRING, job.id);
    if (almost === null) throw new Error("job");
    const last = await sendWarehouseJob(
      at.context,
      almost,
      { kind: "again", reason: "lost" },
      OPERATOR_ID,
    );
    expect(last.attempts).toBe(MAX_WAREHOUSE_ATTEMPTS);
    expectHostShape(stored(at)[1] ?? {});
  });

  it("does not print with a reason outside the list, and leaves the job as it was", async () => {
    const at = await station();
    const job = printed(await scan(at, BOX_SSCC));
    await expect(
      sendWarehouseJob(at.context, job, { kind: "again", reason: "bored" as never }, OPERATOR_ID),
    ).rejects.toBeInstanceOf(LocalDbError);
    expect(at.shell.sends).toHaveLength(1);
    expect(await readJob(at.local, PAIRING, job.id)).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("will not take two sends of one job at once", async () => {
    const at = await station();
    const job = printed(await scan(at, BOX_SSCC));
    at.shell.holdSends();
    const first = sendWarehouseJob(at.context, job, { kind: "again", reason: "lost" }, OPERATOR_ID);
    await vi.waitFor(() => expect(at.shell.heldSends()).toBe(1));
    // The same stale copy of the job: its state was sent, the row is sending now.
    await expect(
      sendWarehouseJob(at.context, job, { kind: "again", reason: "damaged" }, OPERATOR_ID),
    ).rejects.toBeInstanceOf(StaleWarehouseError);
    at.shell.releaseSend({ sent: true });
    expect(await first).toMatchObject({ state: "sent", attempts: 2, reason: "lost" });
    expect(at.shell.sends).toHaveLength(2);
  });
});

describe("where each answer of the printer leaves a job (plan СКЛ task 5)", () => {
  const OUTCOMES: [string, SendOutcome, WarehouseJobState, string | null][] = [
    ["busy", { kind: "busy" }, "failed", "printer_busy"],
    ["timeout", { kind: "timeout" }, "unknown", "timeout"],
    [
      "a label that may exist",
      { kind: "answered", result: { sent: false, code: "outcome_unknown" } },
      "unknown",
      "outcome_unknown",
    ],
    [
      "nothing sent",
      { kind: "answered", result: { sent: false, code: "not_sent" } },
      "failed",
      "not_sent",
    ],
    [
      "a refused target",
      { kind: "answered", result: { sent: false, code: "invalid_target" } },
      "failed",
      "invalid_target",
    ],
    [
      "bytes the shell refused",
      { kind: "answered", result: { sent: false, code: "invalid_payload" } },
      "failed",
      "invalid_payload",
    ],
    [
      "a printer the shell cannot reach",
      { kind: "answered", result: { sent: false, code: "unsupported" } },
      "failed",
      "unsupported",
    ],
    ["sent", { kind: "answered", result: { sent: true } }, "sent", null],
  ];
  it.each(OUTCOMES)("%s", async (_name, outcome, state, code) => {
    const at = await station();
    const runtime: PrintRuntime = {
      send: vi.fn(async () => outcome),
      isInFlight: () => false,
      inFlight: () => [],
    };
    const job = printed(
      await reprintScan(
        { ...at.context, runtime },
        {
          session: at.session,
          raw: BOX_SSCC,
          operatorId: OPERATOR_ID,
          online: true,
          ask: found(BOX_SOURCE),
        },
      ),
    );
    expect(job).toMatchObject({ state, errorCode: code, attempts: 1 });
    expect(stored(at)).toEqual([
      expect.objectContaining({ outcome: state, errorCode: code, attempt: 1 }),
    ]);
    stored(at).forEach(expectHostShape);
    expect(runtime.send).toHaveBeenCalledTimes(1);
  });

  it("names its error codes with the words the host takes", () => {
    for (const code of [...FAILED_CODES, ...UNKNOWN_CODES]) expect(code).toMatch(/^[a-z_]{1,64}$/);
  });

  it("leaves a record of the shape the host takes for every ending of a label's life", async () => {
    const at = await station({ printers: false });
    const noPrinter = printed(await scan(at, BOX_SSCC));
    await cancelWarehouseJob(at.context, noPrinter, OPERATOR_ID);
    await setUpPrinting(at.local, {
      printers: [ZEBRA, ZEBRA_TWO, TSC],
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
    at.answers.push({ sent: false, code: "not_sent" });
    const failed = printed(await scan(at, `]C1!100${BOX_SSCC}`));
    at.answers.push({ sent: false, code: "outcome_unknown" });
    const unknown = await sendWarehouseJob(at.context, failed, { kind: "retry" }, OPERATOR_ID);
    const sent = await sendWarehouseJob(
      at.context,
      unknown,
      { kind: "again", reason: "lost" },
      OPERATOR_ID,
    );
    const verified = await verifyWarehouseJob(at.context, sent, BOX_SSCC, OPERATOR_ID);
    expect(verified).toMatchObject({ kind: "verified" });
    const records = stored(at);
    expect(
      records.map((record) => [record["outcome"], record["attempt"], record["errorCode"]]),
    ).toEqual([
      ["failed", 0, "printer_unconfigured"],
      ["cancelled", 0, null],
      ["failed", 1, "not_sent"],
      ["unknown", 2, "outcome_unknown"],
      ["sent", 3, null],
      ["verified", 3, null],
    ]);
    records.forEach(expectHostShape);
    // Each record carries the instant the clock gave when its attempt ended, in order.
    const instants = records.map((record) => String(record["occurredAt"]));
    expect(instants.every((instant) => instant.startsWith("2026-10-09T07:"))).toBe(true);
    expect([...instants].sort()).toEqual(instants);
    expect(new Set(instants).size).toBe(instants.length);
    // Every record is its own: a repeated delivery of one is the host's to answer.
    expect(new Set(records.map((record) => record["id"])).size).toBe(records.length);
    expect(records.map((record) => record["repair"])).toEqual([
      null,
      null,
      "legacy_tspl_fnc1_literal",
      "legacy_tspl_fnc1_literal",
      "legacy_tspl_fnc1_literal",
      "legacy_tspl_fnc1_literal",
    ]);
    expect(
      await finishSession(at.local, PAIRING, SESSION, OPERATOR_ID, "2026-10-09T09:00:00.000Z"),
    ).toBe("finished");
  });
});

describe("the check of a label by a scan, and a cancel (plan СКЛ task 5)", () => {
  it("checks a unit by its full code only", async () => {
    const at = await station();
    const job = printed(await scan(at, KM, found(UNIT_SOURCE)));
    const records = () => stored(at).length;
    expect(await verifyWarehouseJob(at.context, job, "hello", OPERATOR_ID)).toEqual({
      kind: "invalid",
    });
    expect(
      await verifyWarehouseJob(
        at.context,
        job,
        "010460068200001321S000002\u001d93Tail",
        OPERATOR_ID,
      ),
    ).toEqual({ kind: "mismatch" });
    // A box's SSCC is not the unit.
    expect(await verifyWarehouseJob(at.context, job, BOX_SSCC, OPERATOR_ID)).toEqual({
      kind: "invalid",
    });
    expect(records()).toBe(1);
    expect(await verifyWarehouseJob(at.context, job, KM, OPERATOR_ID)).toMatchObject({
      kind: "verified",
      job: { state: "verified", attempts: 1 },
    });
    expect(stored(at)[1]).toMatchObject({ outcome: "verified", identity: CODE_HASH });
  });

  it("checks a pallet by its SSCC and leaves a refused scan no trace", async () => {
    const at = await station();
    const job = printed(await scan(at, PALLET_SSCC, found(PALLET_SOURCE)));
    expect(await verifyWarehouseJob(at.context, job, BOX_SSCC, OPERATOR_ID)).toEqual({
      kind: "mismatch",
    });
    expect(await readJob(at.local, PAIRING, job.id)).toMatchObject({ state: "sent" });
    expect(stored(at)).toHaveLength(1);
    expect(await verifyWarehouseJob(at.context, job, PALLET_SSCC, OPERATOR_ID)).toMatchObject({
      kind: "verified",
    });
  });

  it("checks only a label that went out, and cancels only one that never did", async () => {
    const at = await station({ printers: false });
    const failed = printed(await scan(at, BOX_SSCC));
    for (const state of ["prepared", "failed", "sending", "cancelled", "verified"] as const) {
      if (state === "verified") continue;
      await expect(
        verifyWarehouseJob(at.context, { ...failed, state }, BOX_SSCC, OPERATOR_ID),
      ).rejects.toBeInstanceOf(WarehouseStateError);
    }
    for (const state of [
      "prepared",
      "sending",
      "sent",
      "unknown",
      "verified",
      "cancelled",
    ] as const) {
      await expect(
        cancelWarehouseJob(at.context, { ...failed, state }, OPERATOR_ID),
      ).rejects.toBeInstanceOf(WarehouseStateError);
    }
    expect(stored(at)).toHaveLength(1);
    expect(await cancelWarehouseJob(at.context, failed, OPERATOR_ID)).toMatchObject({
      state: "cancelled",
    });
    expect(stored(at)[1]).toMatchObject({ outcome: "cancelled", errorCode: null, attempt: 0 });
  });
});

describe("the templates of the copies (plan СКЛ task 5)", () => {
  const [stockBox] = buildDefaultLabelTemplates();
  const [stockPallet] = buildPalletLabelTemplates();
  if (stockBox === undefined || stockPallet === undefined) throw new Error("stock templates");
  const duplicate = buildDuplicateLabelTemplate();

  function template(
    id: string,
    purpose: WarehouseTemplate["purpose"],
    spec: LabelTemplateSpec | null,
    patch: Partial<WarehouseTemplate> = {},
  ): WarehouseTemplate {
    return {
      id,
      name: id,
      purpose,
      enabled: true,
      chzProductGroupCodes: null,
      rev: 1,
      spec,
      ...patch,
    };
  }
  const withElements = (
    spec: LabelTemplateSpec,
    change: (elements: LabelTemplateSpec["elements"]) => LabelTemplateSpec["elements"],
  ): LabelTemplateSpec => ({ ...spec, elements: change(spec.elements) });
  const usesSscc = (element: LabelTemplateSpec["elements"][number]) =>
    (element.kind === "field" && element.field === "sscc") ||
    (element.kind === "barcode" && element.data === "sscc");

  it("maps each kind to the purpose of its templates", () => {
    expect(KIND_PURPOSE).toEqual({ unit: "product_duplicate", box: "box", pallet: "pallet" });
  });

  it("offers an enabled template of the kind's purpose whose layout reads", () => {
    const box = template("b", "box", stockBox.spec);
    expect(isChoosable(box, "box")).toBe(true);
    expect(isChoosable(box, "pallet")).toBe(false);
    expect(isChoosable(box, "unit")).toBe(false);
    expect(isChoosable({ ...box, enabled: false }, "box")).toBe(false);
    expect(isChoosable({ ...box, spec: null }, "box")).toBe(false);
  });

  it("starts a session with the default, else the only choosable one, else none", () => {
    const a = template("a", "box", stockBox.spec);
    const b = template("b", "box", stockBox.spec);
    const p = template("p", "pallet", stockPallet.spec);
    const d = template("d", "product_duplicate", duplicate);
    const none: WarehouseTemplates = { unit: null, box: null, pallet: null };
    expect(initialTemplates([a, b, p, d], { unit: null, box: "b", pallet: null })).toEqual({
      unit: "d",
      box: "b",
      pallet: "p",
    });
    // Two to choose from and no default: the operator chooses.
    expect(initialTemplates([a, b], none).box).toBeNull();
    // The default is disabled: the only choosable one stands in; with two, none.
    const off = { ...b, enabled: false };
    expect(initialTemplates([a, off], { ...none, box: "b" }).box).toBe("a");
    expect(
      initialTemplates([a, b, { ...template("c", "box", stockBox.spec), enabled: false }], {
        ...none,
        box: "c",
      }).box,
    ).toBeNull();
    // The default names a template of another purpose or an unreadable one.
    expect(initialTemplates([a, p], { ...none, box: "p" }).box).toBe("a");
    expect(initialTemplates([{ ...a, spec: null }], { ...none, box: "a" }).box).toBeNull();
    expect(initialTemplates([], none)).toEqual(none);
  });

  it("checks the chosen template: chosen, there, of the purpose, covering the group, of a fit layout", () => {
    const box = template("b", "box", stockBox.spec);
    const ok = checkTemplate([box], "b", "box", 8);
    expect(ok).toMatchObject({ kind: "ok", template: { id: "b" }, spec: stockBox.spec });
    expect(checkTemplate([box], null, "box", 8)).toEqual({ kind: "no_template" });
    expect(checkTemplate([box], "x", "box", 8)).toEqual({ kind: "template_unavailable" });
    expect(checkTemplate([{ ...box, enabled: false }], "b", "box", 8)).toEqual({
      kind: "template_unavailable",
    });
    expect(checkTemplate([{ ...box, spec: null }], "b", "box", 8)).toEqual({
      kind: "template_unavailable",
    });
    expect(checkTemplate([box], "b", "pallet", 8)).toEqual({ kind: "template_unavailable" });
    const scoped = { ...box, chzProductGroupCodes: [3] };
    expect(checkTemplate([scoped], "b", "box", 8)).toEqual({ kind: "template_unfit" });
    expect(checkTemplate([scoped], "b", "box", null)).toEqual({ kind: "template_unfit" });
    expect(checkTemplate([scoped], "b", "box", 3)).toMatchObject({ kind: "ok" });
    const unit = template("u", "product_duplicate", duplicate, { chzProductGroupCodes: [8] });
    expect(checkTemplate([unit], "u", "unit", 8)).toMatchObject({ kind: "ok" });
    expect(checkTemplate([unit], "u", "unit", 3)).toEqual({ kind: "template_unfit" });
    expect(checkTemplate([unit], "u", "unit", null)).toEqual({ kind: "template_unfit" });
  });

  it("wants a box's or a pallet's layout to carry the SSCC and no unit code", () => {
    const noSscc = withElements(stockBox.spec, (elements) => elements.filter((e) => !usesSscc(e)));
    expect(noSscc.elements.length).toBeGreaterThan(0);
    expect(checkTemplate([template("b", "box", noSscc)], "b", "box", 8)).toEqual({
      kind: "template_unfit",
    });
    const field = stockBox.spec.elements.find((element) => element.kind === "field");
    if (field?.kind !== "field") throw new Error("a field element");
    const withCode = withElements(stockBox.spec, (elements) => [
      ...elements,
      { ...field, field: "km.code" },
    ]);
    expect(checkTemplate([template("b", "box", withCode)], "b", "box", 8)).toEqual({
      kind: "template_unfit",
    });
    const palletNoSscc = withElements(stockPallet.spec, (elements) =>
      elements.filter((e) => !usesSscc(e)),
    );
    expect(checkTemplate([template("p", "pallet", palletNoSscc)], "p", "pallet", 8)).toEqual({
      kind: "template_unfit",
    });
    expect(
      checkTemplate([template("p", "pallet", stockPallet.spec)], "p", "pallet", 8),
    ).toMatchObject({
      kind: "ok",
    });
  });

  it("wants a unit's layout to be a duplicate's, and a box layout is not", () => {
    expect(
      checkTemplate([template("u", "product_duplicate", stockBox.spec)], "u", "unit", 8),
    ).toEqual({
      kind: "template_unfit",
    });
    const withSscc = withElements(duplicate, (elements) => {
      const field = stockBox.spec.elements.find((element) => element.kind === "field");
      if (field?.kind !== "field") throw new Error("a field element");
      return [...elements, { ...field, field: "sscc" }];
    });
    expect(checkTemplate([template("u", "product_duplicate", withSscc)], "u", "unit", 8)).toEqual({
      kind: "template_unfit",
    });
  });

  it("reads the copies: the three purposes by name, the defaults of the organization", async () => {
    const at = await station();
    at.db
      .prepare(
        "INSERT INTO ref_templates (id, name, purpose, enabled, category_codes, stock, spec, rev) " +
          "VALUES ('x1', 'Ярлык', 'product_label', 1, NULL, 0, '{}', 1), " +
          "('x2', 'Битый', 'box', 0, '[3,8]', 0, 'not json', 2)",
      )
      .run();
    const templates = await readWarehouseTemplates(at.local);
    expect(templates.map((t) => t.id)).toEqual([
      "x2",
      UNIT_TEMPLATE,
      BOX_TEMPLATE,
      PALLET_TEMPLATE,
    ]);
    expect(templates[0]).toMatchObject({
      enabled: false,
      chzProductGroupCodes: [3, 8],
      rev: 2,
      spec: null,
    });
    expect(templates[2]).toMatchObject({ enabled: true, chzProductGroupCodes: null, rev: 4 });
    expect(templates[2]?.spec).not.toBeNull();
    expect(await readOrgDefaults(at.local)).toEqual({
      unit: UNIT_TEMPLATE,
      box: BOX_TEMPLATE,
      pallet: PALLET_TEMPLATE,
    });
    at.db.prepare("DELETE FROM ref_org").run();
    expect(await readOrgDefaults(at.local)).toEqual({ unit: null, box: null, pallet: null });
  });
});

describe("the label's fields from the record (plan СКЛ task 5)", () => {
  it("counts a pallet's boxes and units, and a unit as one", () => {
    const pallet = sourceFields(PALLET_SOURCE);
    expect(pallet.sscc).toBe(PALLET_SSCC);
    expect(pallet.qty).toBe("480");
    expect(pallet["qty.boxes"]).toBe("40");
    expect(pallet.date).toBe("08.10.2026");
    const unit = sourceFields(UNIT_SOURCE);
    expect(unit.qty).toBe("1");
    expect(unit.sscc).toBe("");
    expect(unit["km.code"]).toBe(KM);
  });

  it("does not print the code of another product", () => {
    expect(() =>
      sourceFields({
        ...UNIT_SOURCE,
        product: { ...UNIT_SOURCE.product, gtin14: "04600682000020" },
      }),
    ).toThrow();
  });
});

describe("the unit's code drawn for a reprint (plan СКЛ task 5)", () => {
  it.each(["zpl", "tspl"] as const)(
    "draws it as the shared raster on %s only when asked, and as it always was by default",
    async (language) => {
      const spec = buildDuplicateLabelTemplate();
      const fields = sourceFields(UNIT_SOURCE);
      const printer = { language, dpi: 203 } as const;
      const text = async (options?: { kmDataMatrix?: "native" | "raster" }) => {
        const bytes = await renderLabel(spec, fields, printer, fakeRaster, options);
        return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
      };
      const plain = await text();
      expect(await text({ kmDataMatrix: "native" })).toBe(plain);
      const raster = await text({ kmDataMatrix: "raster" });
      expect(raster).not.toBe(plain);
      // The raster is a bitmap of the whole code square, many times the native command.
      expect(raster.length).toBeGreaterThan(plain.length * 5);
    },
  );
});
