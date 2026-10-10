import { decodeMonoRaster, productLabelPrintFormat } from "@markiro/domain";
import { printerFormat } from "../printer-routing.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { readPrintDestination } from "../print-destinations.js";
import { z } from "zod";
import {
  applyWarehouseReprintEvent,
  warehouseEventSchema,
  warehouseRerenderSchema,
  type WarehouseRerender,
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
  raster: warehouseRerenderSchema.optional(),
});
const replacementSchema = z
  .preprocess(
    (value) => {
      const row = z.record(z.string(), z.unknown()).parse(value);
      const { bytesBase64, ...metadata } = row;
      return { bytesBase64, metadata };
    },
    z.strictObject({
      bytesBase64: z.string().min(1),
      metadata: warehouseRerenderSchema,
    }),
  )
  .transform(({ bytesBase64, metadata }) => ({ ...metadata, bytesBase64 }));

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
    printerFormat(profile) !== productLabelPrintFormat(input.preparedEvent) ||
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
    raster_json: string | null;
    projection_json: string;
    updated_at: string;
    state: string;
    latest_sequence: number;
    attempt_id: string;
  }>(
    `SELECT owner,job_json,raster_json,projection_json,updated_at,state,latest_sequence,attempt_id FROM warehouse_reprint_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND job_id=?`,
    [owner, jobId],
  );
  if (!row) throw new Error("WAREHOUSE_REPRINT_JOB_MISSING");
  const input = parseWarehousePreparedInput(json(row.job_json));
  const projection = projectionSchema.parse(json(row.projection_json));
  const replacement = row.raster_json ? replacementSchema.parse(json(row.raster_json)) : null;
  const currentBytes = replacement ?? input;
  if (replacement) {
    const bytes = Uint8Array.from(atob(replacement.bytesBase64), (c) => c.charCodeAt(0));
    if (
      productLabelBytesDigest(bytes) !== replacement.bytesDigest ||
      (!replacement.language && decodeMonoRaster(bytes).dpi !== replacement.dpi) ||
      projection.raster?.dpi !== replacement.dpi ||
      projection.raster.bytesDigest !== replacement.bytesDigest ||
      projection.raster.language !== replacement.language
    )
      throw new Error("WAREHOUSE_REPRINT_STORAGE_INVALID");
  }
  const currentFormat = replacement
    ? (replacement.language ?? "mono-raster-v1")
    : printerFormat(input.printer);
  const currentDpi = replacement?.dpi ?? input.printer.dpi;
  if (
    input.owner !== row.owner ||
    input.jobId !== jobId ||
    projection.jobId !== jobId ||
    projection.sessionId !== input.sessionId ||
    projection.bytesDigest !== currentBytes.bytesDigest ||
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
    (replacement && !destination) ||
    (destination &&
      (printerFormat(destination) !== currentFormat || destination.dpi !== currentDpi))
  )
    throw new Error("WAREHOUSE_REPRINT_PRINTER_INVALID");
  return {
    ...input,
    bytesBase64: currentBytes.bytesBase64,
    bytesDigest: currentBytes.bytesDigest,
    printer: destination ?? input.printer,
    projection,
    updatedAt: row.updated_at,
  };
}
export function warehouseJobView(job: WarehouseJob): WarehouseJobView {
  return {
    ...(printerFormat(job.printer) === "mono-raster-v1" ? { printScope: job.owner } : {}),
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

/** UI and deduplication read one indexed projection; bytes are verified at print boundaries. */
export async function findWarehouseJobView(
  exec: SqlExecutor,
  owner: string,
  selector: {
    sessionId?: string;
    jobId?: string;
    kind?: "unit" | "box";
    identity?: string;
    unresolvedOnly?: boolean;
  } = {},
): Promise<WarehouseJobView | null> {
  const params: unknown[] = [owner];
  const filters: string[] = [];
  for (const [column, value] of [
    ["session_id", selector.sessionId],
    ["job_id", selector.jobId],
    ["source_kind", selector.kind],
    ["identity", selector.identity],
  ] as const) {
    if (value !== undefined) {
      filters.push(`j.${column}=?`);
      params.push(value);
    }
  }
  if (selector.unresolvedOnly)
    filters.push("j.state IN ('prepared','sending','delivery_unknown','failed_before_send')");
  const [row] = await exec.all<Record<string, unknown>>(
    `WITH candidate AS MATERIALIZED (
      SELECT j.owner,j.job_id FROM warehouse_reprint_jobs j
      WHERE j.owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})${filters.length ? " AND " + filters.join(" AND ") : ""}
      ORDER BY j.state IN ('prepared','sending','delivery_unknown','failed_before_send') DESC,j.updated_at DESC,j.job_id DESC LIMIT 1
    )
    SELECT CASE WHEN COALESCE(json_extract(j.raster_json,'$.language'),json_extract(j.raster_json,'$.printFormat'),CASE WHEN j.raster_json IS NOT NULL THEN 'mono-raster-v1' END,json_extract(j.job_json,'$.preparedEvent.printFormat'))='mono-raster-v1' THEN j.owner END AS printScope,j.job_id AS jobId,j.attempt_id AS attemptId,j.state,j.source_kind AS kind,j.identity,j.updated_at AS updatedAt,
      json_extract(j.projection_json,'$.attemptNo') AS attemptNo,
      json_extract(j.job_json,'$.source.productName') AS productName,
      json_extract(j.job_json,'$.template.name') AS templateName,
      COALESCE((SELECT json_extract(d.profile_json,'$.name') FROM printer_destinations d WHERE d.scope=j.owner
        AND d.job_id=j.job_id AND d.attempt_id=j.attempt_id AND d.purpose=CASE j.source_kind WHEN 'box' THEN 'box' ELSE 'duplicate' END),
        json_extract(j.job_json,'$.printer.name')) AS printerName,
      json_extract(j.job_json,'$.preparedEvent.repair') AS repair,
      j.owner=json_extract(j.job_json,'$.owner') AND j.job_id=json_extract(j.job_json,'$.jobId')
        AND j.session_id=json_extract(j.projection_json,'$.sessionId') AND j.job_id=json_extract(j.projection_json,'$.jobId')
        AND j.state=json_extract(j.projection_json,'$.state') AND j.latest_sequence=json_extract(j.projection_json,'$.latestSequence')
        AND j.attempt_id=json_extract(j.projection_json,'$.attemptId') AND j.source_kind=json_extract(j.job_json,'$.source.kind')
        AND j.identity=json_extract(j.job_json,'$.source.identity') AS consistent
    FROM candidate c JOIN warehouse_reprint_jobs j ON j.owner=c.owner AND j.job_id=c.job_id`,
    params,
  );
  if (!row) return null;
  if (row.consistent !== 1) throw new Error("WAREHOUSE_REPRINT_STORAGE_INVALID");
  const { consistent, ...value } = row;
  void consistent;
  const view = z
    .strictObject({
      printScope: z.string().nullable(),
      jobId: z.uuid(),
      attemptId: z.uuid(),
      attemptNo: z.number().int().positive(),
      state: projectionSchema.shape.state,
      kind: z.enum(["unit", "box"]),
      identity: z.string().min(1),
      updatedAt: z.iso.datetime(),
      productName: z.string().min(1),
      templateName: z.string().min(1),
      printerName: z.string().min(1),
      repair: z.literal("legacy_tspl_fnc1_literal").nullable(),
    })
    .parse(value);
  const { printScope, ...rest } = view;
  return {
    ...rest,
    ...(printScope === null ? {} : { printScope }),
    identity: view.kind === "unit" ? view.identity.slice(-8) : view.identity,
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
  raster?: WarehouseRerender & { bytesBase64: string },
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
  if (event.kind === "reprint_prepared" && event.rerender) {
    if (
      !raster ||
      raster.bytesDigest !== event.rerender.bytesDigest ||
      raster.dpi !== event.rerender.dpi ||
      raster.language !== event.rerender.language
    )
      throw new Error("WAREHOUSE_RASTER_MISSING");
    const bytes = Uint8Array.from(atob(raster.bytesBase64), (c) => c.charCodeAt(0));
    if (
      productLabelBytesDigest(bytes) !== raster.bytesDigest ||
      (!raster.language && decodeMonoRaster(bytes).dpi !== raster.dpi)
    )
      throw new Error("WAREHOUSE_RASTER_INVALID");
  } else if (raster) throw new Error("WAREHOUSE_RASTER_UNEXPECTED");
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
          ...(raster ? { raster } : {}),
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
