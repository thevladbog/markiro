import { readFileSync } from "node:fs";

import {
  applyProductLabelEvent,
  canApplyProductLabelEvent,
  canonicalizeKm,
  duplicatePayloadDigest,
  kmHash,
  productLabelBytesDigest,
  type ProductLabelEvent,
  type ProductLabelProjection,
} from "@markiro/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { base64ToBytes } from "../src/floor/print/print-jobs.js";
import { createPrintRuntime, type PrintRuntime } from "../src/floor/print/print-runtime.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  saveWorkstationSettings,
  type PrinterProfile,
} from "../src/floor/setup/workstation-settings.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import {
  unitLabelRender,
  type RenderUnitLabel,
} from "../src/floor/unit-labels/unit-label-render.js";
import {
  readUnitLabelJob,
  readUnresolvedUnitLabel,
  type UnitLabelJob,
} from "../src/floor/unit-labels/unit-label-store.js";
import {
  canAcceptNext,
  recoverUnitLabels,
  reprintUnitLabel,
  sendUnitLabel,
  skipVerification,
  StaleUnitLabelError,
  unitLabelStatus,
  UnitLabelRefusedError,
  UnitLabelStateError,
  verifyUnitLabel,
  type UnitLabelPrintContext,
} from "../src/floor/unit-labels/unit-label-work.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import type { PrintResult, PrintTarget } from "../src/hardware/hardware.js";
import {
  enteredShiftSchema,
  factRecordSchema,
  type EnteredShift,
  type FactRecord,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import {
  countingIds,
  enteredShift,
  GTIN,
  km,
  OPERATOR_ID,
  PAIRING,
  rows,
  scanContext,
  steppingClock,
  VALIDATION_ENTERED,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRaster, GODEX_DRIVER, manualTimers, TSC, ZEBRA } from "./support/printing.js";

/*
 * The logic of a unit's Data Matrix duplicate on the station (plan РЕЖ, task B5; Р12–Р14): the
 * unit is accepted with its label in one transaction, the label is sent, checked, skipped or
 * printed again, and a send the app lost is recovered — each step one guarded `MOVE_JOB_SQL` with
 * its `unit_label` record. The rules are those of `docs/acceptance/validation-dm-duplicate.md`
 * («Зафиксированное поведение»), and every step is one the domain's machine takes
 * (`applyProductLabelEvent`), the row equal to the domain's projection after it.
 */

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const PRINTING_FIXTURE: EnteredShift = enteredShiftSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../proto/fixtures/device-shift-entered-validation-print.json", testModuleUrl),
      "utf8",
    ),
  ),
);
const OTHER_OPERATOR = "3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f";
const RAW = km("5Yq'Ct;", { tail: "Zf8K" });
const CANONICAL = canonicalizeKm(RAW).raw;
const CODE_HASH = kmHash(canonicalizeKm(RAW));

/** The printing shift with its check `verification` (both the policy and the frozen copy). */
function printing(verification: "none" | "required", id = PRINTING_FIXTURE.id): EnteredShift {
  const frozen = PRINTING_FIXTURE.snapshot.validationPrint;
  if (frozen === undefined || PRINTING_FIXTURE.validationPrint?.mode !== "duplicate_dm") {
    throw new Error("the fixture prints no duplicate");
  }
  return enteredShiftSchema.parse({
    ...PRINTING_FIXTURE,
    id,
    number: id === PRINTING_FIXTURE.id ? PRINTING_FIXTURE.number : "OCT26-007",
    validationPrint: { ...PRINTING_FIXTURE.validationPrint, verification },
    snapshot: { ...PRINTING_FIXTURE.snapshot, validationPrint: { ...frozen, verification } },
  });
}

const SECOND_SHIFT_ID = "7b2e4f6a-9c1d-4e8f-a0b2-c4d6e8f0a1b3";

type PrintBytes = (target: PrintTarget, bytes: Uint8Array) => Promise<PrintResult>;

interface Station {
  db: ReturnType<typeof openLocalDb>["db"];
  local: LocalExecutor;
  shift: WorkShift;
  scan: ScanContext;
  print: UnitLabelPrintContext;
  printBytes: ReturnType<typeof vi.fn<PrintBytes>>;
  render: ReturnType<typeof vi.fn<RenderUnitLabel>>;
  expire: () => void;
  /** The app starts again: a new print runtime over the same database. */
  restart: () => UnitLabelPrintContext;
}

async function assign(local: LocalExecutor, duplicate: PrinterProfile | null): Promise<void> {
  await saveWorkstationSettings(local, {
    ...DEFAULT_WORKSTATION_SETTINGS,
    printers: [ZEBRA, TSC, GODEX_DRIVER],
    assignments: { box: null, pallet: null, duplicate: duplicate?.id ?? null },
  });
}

async function station(
  options: {
    verification?: "none" | "required";
    printer?: PrinterProfile | null;
    entered?: EnteredShift;
    local?: LocalExecutor;
    db?: Station["db"];
  } = {},
): Promise<Station> {
  const opened = options.local === undefined ? openLocalDb() : null;
  const db = options.db ?? opened?.db;
  const local = options.local ?? opened?.executor;
  if (db === undefined || local === undefined) throw new Error("no database");
  const shift = await enteredShift(
    local,
    options.entered ?? printing(options.verification ?? "required"),
  );
  if (options.local === undefined) {
    await assign(local, options.printer === undefined ? ZEBRA : options.printer);
  }
  const clock = steppingClock();
  const ids = countingIds();
  const printBytes = vi.fn<PrintBytes>(async () => ({ sent: true }));
  const timers = manualTimers();
  const runtime: PrintRuntime = createPrintRuntime(printBytes, { startTimer: timers.startTimer });
  // The app's own render with a rasterizer jsdom can run: the label's real bytes.
  const render = vi.fn<RenderUnitLabel>(unitLabelRender(shift, { rasterize: fakeRaster }));
  const scan = scanContext(local, shift, {
    now: clock,
    newId: ids,
    unitLabel: { operatorName: "Анна Кузнецова", render },
  });
  const print: UnitLabelPrintContext = { local, pairing: PAIRING, runtime, now: clock, newId: ids };
  return {
    db,
    local,
    shift,
    scan,
    print,
    printBytes,
    render,
    expire: timers.expire,
    restart: () => ({
      local,
      pairing: PAIRING,
      runtime: createPrintRuntime(printBytes),
      now: clock,
      newId: ids,
    }),
  };
}

function outbox(db: Station["db"]): FactRecord[] {
  return rows(db, "SELECT payload FROM outbox ORDER BY seq").map((row) =>
    factRecordSchema.parse(JSON.parse(String(row["payload"]))),
  );
}

function labelRecords(db: Station["db"]): Extract<FactRecord, { kind: "unit_label" }>[] {
  return outbox(db).flatMap((record) => (record.kind === "unit_label" ? [record] : []));
}

function counts(db: Station["db"]) {
  return {
    scans: rows(db, "SELECT count(*) AS n FROM floor_scans")[0]?.["n"],
    codes: rows(db, "SELECT count(*) AS n FROM floor_codes")[0]?.["n"],
    jobs: rows(db, "SELECT count(*) AS n FROM floor_unit_labels")[0]?.["n"],
    outbox: rows(db, "SELECT count(*) AS n FROM outbox")[0]?.["n"],
  };
}

/** Accepts `raw` as a unit with its label: the job it made. */
async function accept(at: Station, raw = RAW): Promise<UnitLabelJob> {
  const outcome = await processScan(at.scan, raw);
  if (outcome.kind !== "accepted" || outcome.boxId !== null || outcome.label === undefined) {
    throw new Error(`the unit was not accepted with a label: ${JSON.stringify(outcome)}`);
  }
  return outcome.label;
}

async function current(at: Station, job: UnitLabelJob): Promise<UnitLabelJob> {
  const now = await readUnitLabelJob(at.local, PAIRING, job.id);
  if (now === null) throw new Error("the job is gone");
  return now;
}

const ATTEMPT_IDS = (attemptNo: number) =>
  `00000000-0000-4000-a000-${String(attemptNo).padStart(12, "0")}`;
const REVISION = "66666666-6666-4666-8666-666666666666";

/**
 * The domain's events for a job's records, in the outbox's order: the fields the station has
 * (the record's event, attempt, reason, error code and digests, the job's print identity) and
 * fixed values for those the domain needs and the station's fact has not (an attempt id per
 * attempt, the policy revision, the template digest, the acceptance time).
 */
function domainEvents(job: UnitLabelJob, records: readonly FactRecord[]): ProductLabelEvent[] {
  return records
    .flatMap((record, index): ProductLabelEvent[] => {
      if (record.kind !== "unit_label" || record.data.jobId !== job.id) return [];
      const { data } = record;
      const base = {
        eventId: record.id,
        jobId: data.jobId,
        attemptId: ATTEMPT_IDS(data.attemptNo),
        sequence: 0,
        shiftId: record.shiftId,
        codeHash: data.codeHash,
        acceptedAt: "2026-10-08T06:15:00.000Z",
        policyRevision: REVISION,
        templateDigest: "e".repeat(64),
        payloadDigest: data.payloadDigest,
        operatorId: record.operatorId ?? OPERATOR_ID,
        occurredAt: new Date(Date.parse(data.at)).toISOString(),
      };
      void index;
      switch (data.event) {
        case "prepared": {
          const prepared = {
            ...base,
            kind: "prepared" as const,
            attemptNo: data.attemptNo,
            reason: data.reason,
            dpi: job.dpi,
            bytesDigest: data.bytesDigest,
          };
          return [
            job.printMode === "windows_driver"
              ? { ...prepared, printFormat: "mono-raster-v1" as const }
              : { ...prepared, language: job.language ?? "zpl" },
          ];
        }
        case "failed_before_send":
          return [
            {
              ...base,
              kind: "failed_before_send",
              errorCode:
                data.errorCode === "printer_changed" ? "printer_changed" : "printer_unconfigured",
            },
          ];
        case "delivery_unknown":
          return [
            {
              ...base,
              kind: "delivery_unknown",
              errorCode:
                data.errorCode === "interrupted"
                  ? "interrupted"
                  : data.errorCode === "persistence_failed"
                    ? "persistence_failed"
                    : "transport_failed",
            },
          ];
        case "verified":
          return [{ ...base, kind: "verified", scannedPayloadDigest: data.payloadDigest }];
        case "verification_rejected":
          return [
            {
              ...base,
              kind: "verification_rejected",
              reason: data.errorCode === "invalid" ? "invalid" : "mismatch",
            },
          ];
        default:
          return [{ ...base, kind: data.event }];
      }
    })
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}

/** The domain's projection of `job` from its records; throws where the domain refuses one. */
function project(job: UnitLabelJob, records: readonly FactRecord[]): ProductLabelProjection {
  let projection: ProductLabelProjection | null = null;
  for (const event of domainEvents(job, records)) {
    projection = applyProductLabelEvent(projection, event, job.verificationPolicy);
  }
  if (projection === null) throw new Error("no record of the job");
  return projection;
}

/** The row equals the domain's projection of the job's records, step for step. */
async function expectParity(at: Station, job: UnitLabelJob): Promise<UnitLabelJob> {
  const row = await current(at, job);
  const projection = project(row, outbox(at.db));
  expect({
    attemptNo: row.attemptNo,
    attemptState: row.attemptState,
    verification: row.verification,
    status: unitLabelStatus(row),
    bytesDigest: row.bytesDigest,
    payloadDigest: row.payloadDigest,
    codeHash: row.codeHash,
    dpi: row.dpi,
    format: row.printMode === "windows_driver" ? "mono-raster-v1" : row.language,
  }).toEqual({
    attemptNo: projection.attemptNo,
    attemptState: projection.attemptState,
    verification: projection.verificationOutcome,
    status: projection.status,
    bytesDigest: projection.bytesDigest,
    payloadDigest: projection.payloadDigest,
    codeHash: projection.codeHash,
    dpi: projection.dpi,
    format: projection.printFormat ?? projection.language,
  });
  return row;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("accepting a unit with its label", () => {
  it("writes the scan, the code, the job and the two records in ONE transaction, scan first", async () => {
    const at = await station();
    const job = await accept(at);
    expect(job).toMatchObject({
      shiftId: at.shift.copy.id,
      codeHash: CODE_HASH,
      attemptNo: 1,
      attemptState: "prepared",
      verificationPolicy: "required",
      verification: "pending",
      reason: null,
      errorCode: null,
      printMode: "raw",
      language: "zpl",
      dpi: 203,
      templateId: "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e",
      templateRev: 64,
      operatorId: OPERATOR_ID,
    });
    expect(job.fields["km.code"]).toBe(CANONICAL);
    expect(job.bytesDigest).toBe(productLabelBytesDigest(base64ToBytes(job.bytesBase64)));
    expect(job.payloadDigest).toBe(duplicatePayloadDigest(CANONICAL));
    const [scanRow] = rows(db(at), "SELECT id, box_id, verdict, code_hash FROM floor_scans");
    expect(scanRow).toEqual({ id: job.scanId, box_id: null, verdict: "ok", code_hash: CODE_HASH });
    expect(rows(db(at), "SELECT box_id, scan_id FROM floor_codes")).toEqual([
      { box_id: null, scan_id: job.scanId },
    ]);
    const records = outbox(at.db);
    expect(records.map((record) => record.kind)).toEqual(["scan", "unit_label"]);
    expect(records[0]?.id).toBe(job.scanId);
    expect(records[1]).toEqual({
      id: expect.any(String),
      kind: "unit_label",
      shiftId: at.shift.copy.id,
      operatorId: OPERATOR_ID,
      data: {
        jobId: job.id,
        codeHash: CODE_HASH,
        attemptNo: 1,
        event: "prepared",
        reason: null,
        errorCode: null,
        payloadDigest: job.payloadDigest,
        bytesDigest: job.bytesDigest,
        at: job.createdAt,
      },
    });
    await expectParity(at, job);
  });

  it("refuses a code without its crypto tail before anything is written", async () => {
    const at = await station();
    const before = counts(at.db);
    await expect(processScan(at.scan, `]d201${GTIN}21NOTAIL`)).rejects.toMatchObject({
      name: "UnitLabelRefusedError",
      code: "incomplete_km",
    });
    expect(counts(at.db)).toEqual(before);
    expect(at.render).not.toHaveBeenCalled();
  });

  it("refuses every scan while no duplicate printer is assigned, nothing written", async () => {
    const at = await station({ printer: null });
    const before = counts(at.db);
    await expect(processScan(at.scan, RAW)).rejects.toMatchObject({
      code: "printer_unconfigured",
    });
    // Not even a scan that is no code is journalled: the cloud's station takes no scan without
    // its printer.
    await expect(processScan(at.scan, "hello")).rejects.toBeInstanceOf(UnitLabelRefusedError);
    expect(counts(at.db)).toEqual(before);
  });

  it("refuses a unit whose label does not render, nothing written", async () => {
    const at = await station();
    at.render.mockRejectedValueOnce(new Error("raster too large"));
    const before = counts(at.db);
    await expect(processScan(at.scan, RAW)).rejects.toMatchObject({ code: "render_failed" });
    expect(counts(at.db)).toEqual(before);
  });

  it("keeps a duplicate, a wrong product and an unreadable scan journalled as before", async () => {
    const at = await station({ verification: "none" });
    const job = await accept(at);
    await sendUnitLabel(at.print, job, OPERATOR_ID);
    await expect(processScan(at.scan, RAW)).resolves.toMatchObject({
      kind: "duplicate",
      source: "local",
    });
    await expect(processScan(at.scan, "hello")).resolves.toMatchObject({ kind: "invalid" });
    expect(counts(at.db)).toMatchObject({ scans: 3, codes: 1, jobs: 1 });
  });

  it("without a duplicate keeps the plain validation path: no job, no label record", async () => {
    const { db, executor } = openLocalDb();
    const shift = await enteredShift(executor, VALIDATION_ENTERED);
    expect(shift.snapshot.validationPrint).toBeNull();
    const outcome = await processScan(scanContext(executor, shift), RAW);
    expect(outcome).toEqual({
      kind: "accepted",
      boxId: null,
      acceptedCount: 1,
      scannedAt: "2026-10-08T06:15:00.000Z",
    });
    expect(rows(db, "SELECT count(*) AS n FROM floor_unit_labels")).toEqual([{ n: 0 }]);
    expect(outbox(db).map((record) => record.kind)).toEqual(["scan"]);
  });

  it("freezes the label: its bytes are the snapshot's layout, never re-rendered later", async () => {
    const at = await station({ verification: "none" });
    const job = await accept(at);
    expect(at.render).toHaveBeenCalledTimes(1);
    expect(at.render.mock.calls[0]).toEqual([
      at.shift.snapshot.validationPrint?.template.spec,
      job.fields,
      ZEBRA,
    ]);
    const sent = await sendUnitLabel(at.print, job, OPERATOR_ID);
    await reprintUnitLabel(at.print, sent, "damaged", OPERATOR_ID);
    await sendUnitLabel(at.print, await current(at, job), OPERATOR_ID);
    expect(at.render).toHaveBeenCalledTimes(1);
    const sends = at.printBytes.mock.calls.map(([, bytes]) => bytes);
    expect(sends).toEqual([base64ToBytes(job.bytesBase64), base64ToBytes(job.bytesBase64)]);
  });
});

function db(at: Station): Station["db"] {
  return at.db;
}

describe("sending a unit label", () => {
  it("writes sending before the printer has the bytes, then sent", async () => {
    const at = await station();
    const job = await accept(at);
    let seenState: string | undefined;
    at.printBytes.mockImplementationOnce(async () => {
      seenState = (await current(at, job)).attemptState;
      return { sent: true };
    });
    const sent = await sendUnitLabel(at.print, job, OPERATOR_ID);
    expect(seenState).toBe("sending");
    expect(sent).toMatchObject({ attemptState: "sent", verification: "pending" });
    expect(at.printBytes).toHaveBeenCalledWith(ZEBRA.target, base64ToBytes(job.bytesBase64));
    expect(labelRecords(at.db).map((record) => record.data.event)).toEqual([
      "prepared",
      "sending",
      "sent",
    ]);
    await expectParity(at, job);
  });

  it("leaves a send the printer did not confirm in delivery_unknown, never failed", async () => {
    const at = await station();
    const job = await accept(at);
    at.printBytes.mockResolvedValueOnce({ sent: false, code: "not_sent" });
    const unknown = await sendUnitLabel(at.print, job, OPERATOR_ID);
    expect(unknown).toMatchObject({
      attemptState: "delivery_unknown",
      errorCode: "transport_failed",
    });
    await expectParity(at, job);
  });

  it("leaves a send that timed out in delivery_unknown", async () => {
    const at = await station();
    const job = await accept(at);
    at.printBytes.mockImplementationOnce(() => new Promise<PrintResult>(() => undefined));
    const sending = sendUnitLabel(at.print, job, OPERATOR_ID);
    await vi.waitFor(async () => expect((await current(at, job)).attemptState).toBe("sending"));
    at.expire();
    await expect(sending).resolves.toMatchObject({
      attemptState: "delivery_unknown",
      errorCode: "transport_failed",
    });
  });

  it("fails before sending when no printer is assigned now, nothing sent", async () => {
    const at = await station();
    const job = await accept(at);
    await assign(at.local, null);
    await expect(sendUnitLabel(at.print, job, OPERATOR_ID)).resolves.toMatchObject({
      attemptState: "failed_before_send",
      errorCode: "printer_unconfigured",
    });
    expect(at.printBytes).not.toHaveBeenCalled();
    await expectParity(at, job);
  });

  it("fails before sending on another language, resolution or way of printing", async () => {
    // Each differs from the Zebra (ZPL, 203 dpi, RAW) in one thing only.
    const others: PrinterProfile[] = [
      { ...TSC, id: "t203", dpi: 203 },
      { ...ZEBRA, id: "z300", dpi: 300 },
      GODEX_DRIVER,
    ];
    for (const other of others) {
      const at = await station();
      const job = await accept(at);
      await saveWorkstationSettings(at.local, {
        ...DEFAULT_WORKSTATION_SETTINGS,
        printers: [other],
        assignments: { box: null, pallet: null, duplicate: other.id },
      });
      await expect(sendUnitLabel(at.print, job, OPERATOR_ID), other.id).resolves.toMatchObject({
        attemptState: "failed_before_send",
        errorCode: "printer_changed",
      });
      expect(at.printBytes).not.toHaveBeenCalled();
    }
  });

  it("sends a label rendered for the Windows driver through the driver's queue", async () => {
    const at = await station({ printer: GODEX_DRIVER });
    const job = await accept(at);
    expect(job).toMatchObject({ printMode: "windows_driver", language: null, dpi: 203 });
    const records = labelRecords(at.db);
    expect(records).toHaveLength(1);
    // No driver in this runtime: the send is answered `unsupported` and stays unknown.
    await expect(sendUnitLabel(at.print, job, OPERATOR_ID)).resolves.toMatchObject({
      attemptState: "delivery_unknown",
    });
    expect(at.printBytes).not.toHaveBeenCalled();
    await expectParity(at, job);
  });

  it("sends only a prepared attempt: an unknown outcome is never sent again by itself", async () => {
    const at = await station();
    const job = await accept(at);
    at.printBytes.mockResolvedValueOnce({ sent: false, code: "outcome_unknown" });
    const unknown = await sendUnitLabel(at.print, job, OPERATOR_ID);
    await expect(sendUnitLabel(at.print, unknown, OPERATOR_ID)).rejects.toBeInstanceOf(
      UnitLabelStateError,
    );
    expect(at.printBytes).toHaveBeenCalledTimes(1);
  });
});

describe("the next unit", () => {
  it("under a required check waits for the printed label's check, and the scan goes there", async () => {
    const at = await station({ verification: "required" });
    const job = await accept(at);
    const sent = await sendUnitLabel(at.print, job, OPERATOR_ID);
    expect(canAcceptNext(sent, at.shift.copy.id)).toEqual({ kind: "verify", job: sent });
    const before = counts(at.db);
    await expect(processScan(at.scan, km("NEXT1"))).rejects.toMatchObject({
      code: "unresolved",
    });
    expect(counts(at.db)).toEqual(before);
    // The full content of the new label matches, and the check is saved here: the next unit may come.
    const verified = await verifyUnitLabel(at.print, sent, RAW, OPERATOR_ID);
    expect(verified).toMatchObject({ kind: "verified", job: { verification: "verified" } });
    expect(canAcceptNext(verified.job, at.shift.copy.id)).toEqual({ kind: "accept" });
    await expect(readUnresolvedUnitLabel(at.local, PAIRING)).resolves.toBeNull();
    await expect(processScan(at.scan, km("NEXT1"))).resolves.toMatchObject({ kind: "accepted" });
    await expectParity(at, job);
  });

  it("without a required check may come once the send's result is saved, unverified", async () => {
    const at = await station({ verification: "none" });
    const job = await accept(at);
    // Not before: the label is not sent yet.
    expect(canAcceptNext(job, at.shift.copy.id)).toMatchObject({
      kind: "wait",
      status: "prepared",
    });
    await expect(processScan(at.scan, km("NEXT2"))).rejects.toMatchObject({ code: "unresolved" });
    const sent = await sendUnitLabel(at.print, job, OPERATOR_ID);
    expect(sent.verification).toBe("not_required");
    expect(unitLabelStatus(sent)).toBe("completed");
    expect(canAcceptNext(sent, at.shift.copy.id)).toEqual({ kind: "accept" });
    await expect(processScan(at.scan, km("NEXT2"))).resolves.toMatchObject({ kind: "accepted" });
  });

  it("waits for the operator after a failed or unknown send, and an unknown one may be scanned", async () => {
    const at = await station({ verification: "none" });
    const job = await accept(at);
    at.printBytes.mockResolvedValueOnce({ sent: false, code: "outcome_unknown" });
    const unknown = await sendUnitLabel(at.print, job, OPERATOR_ID);
    expect(canAcceptNext(unknown, at.shift.copy.id)).toEqual({ kind: "verify", job: unknown });
    const other = await station({ verification: "none" });
    const failing = await accept(other);
    await assign(other.local, null);
    const failed = await sendUnitLabel(other.print, failing, OPERATOR_ID);
    expect(canAcceptNext(failed, other.shift.copy.id)).toMatchObject({
      kind: "wait",
      status: "attention",
    });
  });

  it("is refused while the station's unresolved label belongs to another shift", async () => {
    const at = await station({ verification: "required" });
    await accept(at);
    const second = await station({
      entered: printing("required", SECOND_SHIFT_ID),
      local: at.local,
      db: at.db,
    });
    const unresolved = await readUnresolvedUnitLabel(at.local, PAIRING);
    expect(canAcceptNext(unresolved, SECOND_SHIFT_ID)).toEqual({
      kind: "another_shift",
      job: unresolved,
    });
    const before = counts(at.db);
    await expect(processScan(second.scan, km("B1"))).rejects.toMatchObject({
      code: "another_shift",
    });
    expect(counts(at.db)).toEqual(before);
  });
});

describe("the check of a printed label", () => {
  it("rejects another code and an unreadable scan, journalled, the job unchanged", async () => {
    const at = await station({ verification: "required" });
    const sent = await sendUnitLabel(at.print, await accept(at), OPERATOR_ID);
    await expect(verifyUnitLabel(at.print, sent, km("OTHER"), OPERATOR_ID)).resolves.toMatchObject({
      kind: "mismatch",
    });
    // The identity without its crypto tail is no match either.
    await expect(
      verifyUnitLabel(at.print, await current(at, sent), `01${GTIN}215Yq'Ct;`, OPERATOR_ID),
    ).resolves.toMatchObject({ kind: "invalid" });
    const after = await expectParity(at, sent);
    expect(after).toMatchObject({ attemptState: "sent", verification: "pending" });
    expect(
      labelRecords(at.db)
        .slice(-2)
        .map((record) => record.data),
    ).toEqual([
      expect.objectContaining({ event: "verification_rejected", errorCode: "mismatch" }),
      expect.objectContaining({ event: "verification_rejected", errorCode: "invalid" }),
    ]);
  });

  it("of an attempt that moved on is stale: nothing is journalled", async () => {
    const at = await station({ verification: "required" });
    const sent = await sendUnitLabel(at.print, await accept(at), OPERATOR_ID);
    await reprintUnitLabel(at.print, sent, "damaged", OPERATOR_ID);
    const before = counts(at.db);
    await expect(verifyUnitLabel(at.print, sent, km("OTHER"), OPERATOR_ID)).rejects.toBeInstanceOf(
      StaleUnitLabelError,
    );
    await expect(verifyUnitLabel(at.print, sent, RAW, OPERATOR_ID)).rejects.toBeInstanceOf(
      StaleUnitLabelError,
    );
    expect(counts(at.db)).toEqual(before);
  });

  it("resolves an unknown outcome under no check by a scan of the label that came out", async () => {
    const at = await station({ verification: "none" });
    const job = await accept(at);
    at.printBytes.mockResolvedValueOnce({ sent: false, code: "outcome_unknown" });
    const unknown = await sendUnitLabel(at.print, job, OPERATOR_ID);
    await expect(verifyUnitLabel(at.print, unknown, RAW, OPERATOR_ID)).resolves.toMatchObject({
      kind: "verified",
      job: { attemptState: "delivery_unknown", verification: "verified" },
    });
    await expectParity(at, job);
  });
});

describe("skipping the check", () => {
  it("after a successful send is saved with the operator and the time, and is no verification", async () => {
    const at = await station({ verification: "required" });
    const sent = await sendUnitLabel(at.print, await accept(at), OPERATOR_ID);
    const skipped = await skipVerification(at.print, sent, OTHER_OPERATOR);
    expect(skipped).toMatchObject({ attemptState: "sent", verification: "skipped" });
    expect(unitLabelStatus(skipped)).toBe("completed");
    const [record] = labelRecords(at.db).slice(-1);
    expect(record).toMatchObject({
      operatorId: OTHER_OPERATOR,
      data: { event: "verification_skipped", at: skipped.updatedAt },
    });
    expect(canAcceptNext(skipped, at.shift.copy.id)).toEqual({ kind: "accept" });
    await expectParity(at, sent);
  });

  it("is refused for an unknown or failed send, for a prepared one and under no check", async () => {
    const unknownAt = await station({ verification: "required" });
    unknownAt.printBytes.mockResolvedValueOnce({ sent: false, code: "outcome_unknown" });
    const unknown = await sendUnitLabel(unknownAt.print, await accept(unknownAt), OPERATOR_ID);
    const failedAt = await station({ verification: "required" });
    const failing = await accept(failedAt);
    await assign(failedAt.local, null);
    const failed = await sendUnitLabel(failedAt.print, failing, OPERATOR_ID);
    const preparedAt = await station({ verification: "required" });
    const prepared = await accept(preparedAt);
    const noneAt = await station({ verification: "none" });
    const none = await sendUnitLabel(noneAt.print, await accept(noneAt), OPERATOR_ID);
    for (const [at, job] of [
      [unknownAt, unknown],
      [failedAt, failed],
      [preparedAt, prepared],
      [noneAt, none],
    ] as const) {
      const before = counts(at.db);
      await expect(skipVerification(at.print, job, OPERATOR_ID)).rejects.toBeInstanceOf(
        UnitLabelStateError,
      );
      expect(counts(at.db)).toEqual(before);
    }
  });
});

describe("printing a unit's label again", () => {
  it("is a new attempt with its reason and operator, the same bytes and date, no new unit", async () => {
    const at = await station({ verification: "required" });
    const job = await accept(at);
    const sent = await sendUnitLabel(at.print, job, OPERATOR_ID);
    const again = await reprintUnitLabel(at.print, sent, "lost", OTHER_OPERATOR);
    expect(again).toMatchObject({
      attemptNo: 2,
      attemptState: "prepared",
      verification: "pending",
      reason: "lost",
      bytesBase64: job.bytesBase64,
      fields: job.fields,
    });
    expect(labelRecords(at.db).slice(-1)[0]).toMatchObject({
      operatorId: OTHER_OPERATOR,
      data: { event: "prepared", attemptNo: 2, reason: "lost", bytesDigest: job.bytesDigest },
    });
    const resent = await sendUnitLabel(at.print, again, OPERATOR_ID);
    expect(resent).toMatchObject({ attemptNo: 2, attemptState: "sent" });
    expect(counts(at.db)).toMatchObject({ scans: 1, codes: 1, jobs: 1 });
    await expectParity(at, job);
  });

  it("is refused while its attempt is prepared or sending, and beside another unresolved job", async () => {
    const at = await station({ verification: "none" });
    const job = await accept(at);
    await expect(reprintUnitLabel(at.print, job, "damaged", OPERATOR_ID)).rejects.toBeInstanceOf(
      UnitLabelStateError,
    );
    const sent = await sendUnitLabel(at.print, job, OPERATOR_ID);
    const next = await accept(at, km("NEXT3"));
    const before = counts(at.db);
    await expect(reprintUnitLabel(at.print, sent, "damaged", OPERATOR_ID)).rejects.toMatchObject({
      name: "UnitLabelRefusedError",
      code: "unresolved",
    });
    expect(counts(at.db)).toEqual(before);
    expect(next.attemptState).toBe("prepared");
  });
});

describe("the recovery at start", () => {
  it("makes a send the app lost delivery_unknown, interrupted, and sends nothing", async () => {
    const at = await station({ verification: "required" });
    const job = await accept(at);
    at.printBytes.mockImplementationOnce(() => new Promise<PrintResult>(() => undefined));
    void sendUnitLabel(at.print, job, OPERATOR_ID).catch(() => undefined);
    await vi.waitFor(async () => expect((await current(at, job)).attemptState).toBe("sending"));
    // While this app run's send still holds the bytes, the job is left alone.
    await expect(recoverUnitLabels(at.print, OPERATOR_ID)).resolves.toEqual([]);
    const restarted = at.restart();
    const calls = at.printBytes.mock.calls.length;
    // Nobody is signed in yet at the start: the record names no operator.
    const [recovered] = await recoverUnitLabels(restarted, null);
    expect(recovered).toMatchObject({
      attemptState: "delivery_unknown",
      errorCode: "interrupted",
    });
    expect(labelRecords(at.db).slice(-1)[0]).toMatchObject({
      operatorId: null,
      data: { event: "delivery_unknown", errorCode: "interrupted" },
    });
    expect(at.printBytes.mock.calls.length).toBe(calls);
    // And an unknown outcome is never sent again by itself.
    await expect(recoverUnitLabels(restarted, null)).resolves.toEqual([]);
    await expect(
      sendUnitLabel(restarted, await current(at, job), OPERATOR_ID),
    ).rejects.toBeInstanceOf(UnitLabelStateError);
    await expectParity(at, job);
  });

  it("keeps a paused or prepared job as it was, and sends a prepared one's saved bytes", async () => {
    const at = await station({ verification: "required" });
    const job = await accept(at);
    const restarted = at.restart();
    await expect(recoverUnitLabels(restarted, null)).resolves.toEqual([]);
    const kept = await readUnresolvedUnitLabel(at.local, PAIRING);
    expect(kept).toEqual(job);
    if (kept === null) throw new Error("the job is gone");
    const sent = await sendUnitLabel(restarted, kept, OPERATOR_ID);
    expect(at.printBytes).toHaveBeenCalledWith(ZEBRA.target, base64ToBytes(job.bytesBase64));
    expect(at.render).toHaveBeenCalledTimes(1);
    // A pause changes nothing: the label still waits for its check after another restart.
    const again = await readUnresolvedUnitLabel(at.local, PAIRING);
    expect(again).toEqual(sent);
    expect(canAcceptNext(again, at.shift.copy.id)).toEqual({ kind: "verify", job: sent });
  });
});

describe("the full code", () => {
  it("never reaches a unit label record nor a log line", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    const at = await station({ verification: "required" });
    const job = await accept(at);
    at.printBytes.mockResolvedValueOnce({ sent: false, code: "outcome_unknown" });
    const unknown = await sendUnitLabel(at.print, job, OPERATOR_ID);
    await verifyUnitLabel(at.print, unknown, km("OTHER"), OPERATOR_ID);
    const again = await reprintUnitLabel(
      at.print,
      await current(at, job),
      "not_printed",
      OPERATOR_ID,
    );
    const sent = await sendUnitLabel(at.print, again, OPERATOR_ID);
    await skipVerification(at.print, sent, OPERATOR_ID);
    const texts = labelRecords(at.db).map((record) => JSON.stringify(record));
    expect(texts.length).toBeGreaterThan(5);
    for (const text of [...texts, ...logged.map((item) => String(item))]) {
      expect(text).not.toContain("5Yq'Ct;");
      expect(text).not.toContain("Zf8K");
      expect(text).not.toContain(JSON.stringify(CANONICAL).slice(1, -1));
    }
  });
});

/*
 * The golden parity of the machine: from every state the station reaches under each policy, each
 * of its actions either moves the job by events the domain applies — the row then equal to the
 * domain's projection — or is refused by the station exactly where the domain refuses its event.
 */
describe("the station's machine against the domain's", () => {
  type Reached =
    "prepared" | "sent" | "delivery_unknown" | "failed_before_send" | "verified" | "skipped";
  type Action = "send" | "verify" | "reject" | "skip" | "reprint";
  const REACHED: Record<"none" | "required", readonly Reached[]> = {
    none: ["prepared", "sent", "delivery_unknown", "failed_before_send", "verified"],
    required: ["prepared", "sent", "delivery_unknown", "failed_before_send", "verified", "skipped"],
  };
  const ACTIONS: readonly Action[] = ["send", "verify", "reject", "skip", "reprint"];

  async function reach(at: Station, state: Reached): Promise<UnitLabelJob> {
    const job = await accept(at);
    if (state === "prepared") return job;
    if (state === "failed_before_send") {
      await assign(at.local, null);
      const failed = await sendUnitLabel(at.print, job, OPERATOR_ID);
      await assign(at.local, ZEBRA);
      return failed;
    }
    const unknown =
      state === "delivery_unknown" || (state === "verified" && job.verificationPolicy === "none");
    if (unknown) at.printBytes.mockResolvedValueOnce({ sent: false, code: "outcome_unknown" });
    const sent = await sendUnitLabel(at.print, job, OPERATOR_ID);
    if (state === "verified") return (await verifyUnitLabel(at.print, sent, RAW, OPERATOR_ID)).job;
    if (state === "skipped") return skipVerification(at.print, sent, OPERATOR_ID);
    return sent;
  }

  /** The domain's event of `action` from `projection`, as the station would record it. */
  function eventOf(
    action: Action,
    projection: ProductLabelProjection,
    last: ProductLabelEvent,
  ): ProductLabelEvent {
    const common = {
      eventId: "99999999-9999-4999-8999-999999999999",
      jobId: last.jobId,
      attemptId: projection.attemptId,
      sequence: projection.latestSequence + 1,
      shiftId: last.shiftId,
      codeHash: last.codeHash,
      acceptedAt: last.acceptedAt,
      policyRevision: last.policyRevision,
      templateDigest: last.templateDigest,
      payloadDigest: last.payloadDigest,
      operatorId: last.operatorId,
      occurredAt: last.occurredAt,
    };
    switch (action) {
      case "send":
        return { ...common, kind: "sending" };
      case "verify":
        return { ...common, kind: "verified", scannedPayloadDigest: projection.payloadDigest };
      case "reject":
        return { ...common, kind: "verification_rejected", reason: "mismatch" };
      case "skip":
        return { ...common, kind: "verification_skipped" };
      case "reprint":
        return {
          ...common,
          kind: "prepared",
          attemptId: ATTEMPT_IDS(projection.attemptNo + 1),
          attemptNo: projection.attemptNo + 1,
          reason: "damaged",
          dpi: projection.dpi,
          bytesDigest: projection.bytesDigest,
          language: projection.language ?? "zpl",
        };
    }
  }

  async function act(at: Station, action: Action, job: UnitLabelJob): Promise<unknown> {
    switch (action) {
      case "send":
        return sendUnitLabel(at.print, job, OPERATOR_ID);
      case "verify":
        return verifyUnitLabel(at.print, job, RAW, OPERATOR_ID);
      case "reject":
        return verifyUnitLabel(at.print, job, km("OTHER"), OPERATOR_ID);
      case "skip":
        return skipVerification(at.print, job, OPERATOR_ID);
      case "reprint":
        return reprintUnitLabel(at.print, job, "damaged", OPERATOR_ID);
    }
  }

  for (const policy of ["none", "required"] as const) {
    for (const state of REACHED[policy]) {
      for (const action of ACTIONS) {
        it(`${policy}: ${action} from ${state}`, async () => {
          const at = await station({ verification: policy });
          const job = await expectParity(at, await reach(at, state));
          expect({ state: job.attemptState, verification: job.verification }).toMatchObject(
            state === "verified" || state === "skipped" ? { verification: state } : { state },
          );
          const events = domainEvents(job, outbox(at.db));
          const last = events[events.length - 1];
          if (last === undefined) throw new Error("no event");
          const projection = project(job, outbox(at.db));
          const domainTakes = canApplyProductLabelEvent(
            projection,
            eventOf(action, projection, last),
          );
          const before = counts(at.db);
          let refused = false;
          try {
            await act(at, action, job);
          } catch (error) {
            if (!(error instanceof UnitLabelStateError)) throw error;
            refused = true;
          }
          expect(refused, "the station refuses exactly where the domain does").toBe(!domainTakes);
          if (refused) expect(counts(at.db)).toEqual(before);
          else await expectParity(at, job);
        });
      }
    }
  }
});
