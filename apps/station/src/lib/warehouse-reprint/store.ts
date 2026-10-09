import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { readPrintDestination } from "../print-destinations.js";
import { z } from "zod";
import {
  applyWarehouseReprintEvent,
  warehouseEventSchema,
  productLabelValueDigest,
  productLabelBytesDigest,
  labelTemplateUsesField,
  type WarehouseReprintEvent,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import { parsePrinterProfile } from "../printer-routing.js";
import {
  warehousePreparedInputSchema,
  warehouseSessionSchema,
  type WarehouseJob,
  type WarehouseJobView,
  type WarehousePreparedJobInput,
  type WarehouseSessionInput,
} from "./types.js";

const projectionSchema = z.strictObject({
  jobId: z.uuid(),
  sessionId: z.uuid(),
  latestSequence: z.number().int().positive(),
  attemptId: z.uuid(),
  attemptNo: z.number().int().positive(),
  attemptIds: z.array(z.uuid()),
  state: z.enum([
    "prepared",
    "sending",
    "sent",
    "verified",
    "delivery_unknown",
    "failed_before_send",
  ]),
  bytesDigest: z.string(),
  payloadDigest: z.string(),
  templateDigest: z.string(),
});
function json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("WAREHOUSE_REPRINT_STORAGE_INVALID");
  }
}

export function parseWarehousePreparedInput(value: unknown): WarehousePreparedJobInput {
  const record = z.record(z.string(), z.unknown()).parse(value);
  const { printer, ...body } = record;
  const input = warehousePreparedInputSchema.parse(body);
  const profile = parsePrinterProfile(printer);
  if (
    !profile ||
    profile.dpi === null ||
    profile.language !== input.preparedEvent.language ||
    profile.dpi !== input.preparedEvent.dpi
  )
    throw new Error("WAREHOUSE_REPRINT_PRINTER_INVALID");
  const event = input.preparedEvent;
  if (
    input.jobId !== event.jobId ||
    input.sessionId !== event.sessionId ||
    input.operatorId !== event.operatorId ||
    input.reason !== event.reason ||
    input.source.kind !== event.sourceKind ||
    input.source.identity !== event.identity ||
    input.source.sourceId !== event.sourceId ||
    input.source.revision !== event.sourceRevision ||
    input.source.sourceShiftId !== event.sourceShiftId ||
    !input.template.enabled ||
    input.template.purpose !== (input.source.kind === "box" ? "box" : "product_duplicate") ||
    (input.template.chzProductGroupCodes !== null &&
      (input.source.chzProductGroupCode === null ||
        !input.template.chzProductGroupCodes.includes(input.source.chzProductGroupCode))) ||
    input.source.unavailableFields.some((field) =>
      labelTemplateUsesField(input.template.spec, field),
    ) ||
    input.source.payloadDigest !== event.payloadDigest ||
    input.template.id !== event.templateId ||
    input.template.digest !== event.templateDigest ||
    input.template.revision !== event.templateRevision ||
    input.bytesDigest !== event.bytesDigest ||
    productLabelValueDigest(input.fields) !== productLabelValueDigest(input.source.fields) ||
    input.bytesDigest !==
      productLabelBytesDigest(Uint8Array.from(atob(input.bytesBase64), (c) => c.charCodeAt(0)))
  )
    throw new Error("WAREHOUSE_REPRINT_INPUT_MISMATCH");
  return { ...input, printer: profile };
}

export async function saveWarehouseSession(
  exec: SqlExecutor,
  value: WarehouseSessionInput,
): Promise<void> {
  const session = warehouseSessionSchema.parse(value);
  await exec.run(
    "INSERT INTO warehouse_reprint_sessions(owner,session_id,operator_id,status,session_json) VALUES(?,?,?,?,?) ON CONFLICT(owner,session_id) DO UPDATE SET operator_id=excluded.operator_id,status=excluded.status,session_json=excluded.session_json",
    [session.owner, session.sessionId, session.operatorId, session.status, JSON.stringify(session)],
  );
}
export async function resumeWarehouseSession(exec: SqlExecutor, owner: string) {
  const [row] = await exec.all<{ owner: string; session_json: string; sent_count: number }>(
    `SELECT owner,session_json,sent_count FROM warehouse_reprint_sessions s WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) ORDER BY EXISTS(SELECT 1 FROM warehouse_reprint_jobs j WHERE j.owner=s.owner AND j.session_id=s.session_id AND j.state IN ('prepared','sending','delivery_unknown','failed_before_send')) DESC,rowid DESC LIMIT 1`,
    [owner],
  );
  if (!row) return null;
  const session = warehouseSessionSchema.parse(json(row.session_json));
  if (session.owner !== row.owner) throw new Error("WAREHOUSE_REPRINT_STORAGE_INVALID");
  return { ...session, sentCount: row.sent_count };
}
export async function readWarehouseJob(
  exec: SqlExecutor,
  owner: string,
  jobId: string,
): Promise<WarehouseJob> {
  const [row] = await exec.all<{
    owner: string;
    job_json: string;
    projection_json: string;
    updated_at: string;
    state: string;
    latest_sequence: number;
    attempt_id: string;
  }>(
    `SELECT owner,job_json,projection_json,updated_at,state,latest_sequence,attempt_id FROM warehouse_reprint_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND job_id=?`,
    [owner, jobId],
  );
  if (!row) throw new Error("WAREHOUSE_REPRINT_JOB_MISSING");
  const input = parseWarehousePreparedInput(json(row.job_json));
  const projection = projectionSchema.parse(json(row.projection_json));
  if (
    input.owner !== row.owner ||
    input.jobId !== jobId ||
    projection.jobId !== jobId ||
    projection.sessionId !== input.sessionId ||
    projection.bytesDigest !== input.bytesDigest ||
    projection.payloadDigest !== input.source.payloadDigest ||
    projection.templateDigest !== input.template.digest ||
    projection.state !== row.state ||
    projection.latestSequence !== row.latest_sequence ||
    projection.attemptId !== row.attempt_id
  )
    throw new Error("WAREHOUSE_REPRINT_STORAGE_INVALID");
  const destination = await readPrintDestination(exec, {
    scope: input.owner,
    purpose: input.source.kind === "box" ? "box" : "duplicate",
    jobId,
    attemptId: projection.attemptId,
  });
  if (
    destination &&
    (destination.language !== input.printer.language || destination.dpi !== input.printer.dpi)
  )
    throw new Error("WAREHOUSE_REPRINT_PRINTER_INVALID");
  return { ...input, printer: destination ?? input.printer, projection, updatedAt: row.updated_at };
}
export function warehouseJobView(job: WarehouseJob): WarehouseJobView {
  return {
    jobId: job.jobId,
    attemptId: job.projection.attemptId,
    attemptNo: job.projection.attemptNo,
    state: job.projection.state,
    kind: job.source.kind,
    identity: job.source.kind === "unit" ? job.source.identity.slice(-8) : job.source.identity,
    productName: job.source.productName,
    templateName: job.template.name,
    printerName: job.printer.name,
    repair: job.preparedEvent.repair,
    updatedAt: job.updatedAt,
  };
}
export async function prepareWarehouseJob(
  exec: SqlExecutor,
  value: WarehousePreparedJobInput,
): Promise<"prepared" | "duplicate" | "busy"> {
  const input = parseWarehousePreparedInput(value);
  const projection = applyWarehouseReprintEvent(null, input.preparedEvent);
  try {
    await exec.run(
      "INSERT INTO warehouse_reprint_commands(owner,command_id,job_id,kind,payload_json) VALUES(?,?,?,'prepare',?)",
      [
        input.owner,
        input.preparedEvent.eventId,
        input.jobId,
        JSON.stringify({
          input,
          projection,
          eventDigest: productLabelValueDigest(input.preparedEvent),
        }),
      ],
    );
    return "prepared";
  } catch (error) {
    if (error instanceof Error && error.message.includes("WAREHOUSE_DUPLICATE")) return "duplicate";
    if (error instanceof Error && error.message.includes("WAREHOUSE_BUSY")) return "busy";
    throw error;
  }
}
export async function appendWarehouseEvent(
  exec: SqlExecutor,
  owner: string,
  input: WarehouseReprintEvent,
): Promise<"applied" | "replay"> {
  const event = warehouseEventSchema.parse(input);
  const eventDigest = productLabelValueDigest(event);
  const [previous] = await exec.all<{ digest: string }>(
    `SELECT digest FROM warehouse_reprint_events WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND event_id=?`,
    [owner, event.eventId],
  );
  if (previous) {
    if (previous.digest !== eventDigest) throw new Error("WAREHOUSE_EVENT_REPLAY_MISMATCH");
    return "replay";
  }
  const job = await readWarehouseJob(exec, owner, event.jobId);
  const projection = applyWarehouseReprintEvent(job.projection, event);
  try {
    await exec.run(
      "INSERT INTO warehouse_reprint_commands(owner,command_id,job_id,kind,payload_json) VALUES(?,?,?,'event',?)",
      [
        job.owner,
        event.eventId,
        event.jobId,
        JSON.stringify({
          event,
          projection,
          eventDigest,
          previousSequence: job.projection.latestSequence,
          previousState: job.projection.state,
        }),
      ],
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("WAREHOUSE_STALE_EVENT") ||
        error.message.includes("WAREHOUSE_EVENT_REPLAY_MISMATCH"))
    ) {
      const [saved] = await exec.all<{ digest: string }>(
        `SELECT digest FROM warehouse_reprint_events WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND event_id=?`,
        [owner, event.eventId],
      );
      if (saved?.digest === eventDigest) return "replay";
    }
    throw error;
  }
  return "applied";
}
export async function listWarehouseJobs(
  exec: SqlExecutor,
  owner: string,
  sessionId?: string,
): Promise<WarehouseJob[]> {
  const rows = await exec.all<{ job_id: string }>(
    `SELECT job_id FROM warehouse_reprint_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})` +
      (sessionId === undefined ? "" : " AND session_id=?") +
      " ORDER BY updated_at DESC,job_id DESC",
    sessionId === undefined ? [owner] : [owner, sessionId],
  );
  return Promise.all(rows.map((row) => readWarehouseJob(exec, owner, row.job_id)));
}
