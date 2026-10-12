import { LABEL_FIELDS } from "@markiro/domain";
import { z } from "zod";

import {
  WAREHOUSE_REASONS,
  WAREHOUSE_SUBJECT_KINDS,
  type WAREHOUSE_OUTCOMES,
  type WarehouseRecord,
  type WarehouseSubjectKind,
} from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { LabelFields } from "../print/label-render.js";
import { parsePrinterProfile, type PrinterProfile } from "../setup/workstation-settings.js";

/** Why a label is printed again (plan СКЛ, decision Р9). */
export type WarehouseReason = (typeof WAREHOUSE_REASONS)[number];
/** Where one attempt ended (`markiro_proto::WAREHOUSE_OUTCOMES`). */
export type WarehouseOutcome = (typeof WAREHOUSE_OUTCOMES)[number];
/** A box label of the old TSPL defect (`!1` + SSCC), found by the domain's warehouse scan rule. */
export type WarehouseRepair = "legacy_tspl_fnc1_literal";

/** A reprint job's states (migration `0012`). */
export const WAREHOUSE_JOB_STATES = [
  "prepared",
  "sending",
  "sent",
  "failed",
  "unknown",
  "verified",
  "cancelled",
] as const;
export type WarehouseJobState = (typeof WAREHOUSE_JOB_STATES)[number];

/** A job that waits for the printer or the operator (the index `wh_jobs_open`). */
export const UNRESOLVED_STATES: readonly WarehouseJobState[] = [
  "prepared",
  "sending",
  "failed",
  "unknown",
];

export function isUnresolved(state: WarehouseJobState): boolean {
  return UNRESOLVED_STATES.includes(state);
}

/** The template chosen for each kind of label; `null` — none yet. */
export type WarehouseTemplates = Record<WarehouseSubjectKind, string | null>;

/** A session of reprinting: its reason and templates for the next jobs. */
export interface WarehouseSession {
  id: string;
  reason: WarehouseReason;
  templates: WarehouseTemplates;
  startedBy: string;
  startedAt: string;
}

/** A reprint job as stored. */
export interface WarehouseJob {
  id: string;
  sessionId: string;
  kind: WarehouseSubjectKind;
  subjectId: string;
  identity: string;
  repair: WarehouseRepair | null;
  reason: WarehouseReason;
  state: WarehouseJobState;
  templateId: string;
  templateRev: number;
  /** The template's layout as JSON text, frozen when the job was made. */
  templateSpec: string;
  fields: LabelFields;
  printer: PrinterProfile | null;
  bytesBase64: string | null;
  errorCode: string | null;
  attempts: number;
  operatorId: string;
  createdAt: string;
  updatedAt: string;
}

/** A new job: `prepared` with its bytes, or `failed` with the reason it has none. */
export type NewWarehouseJob = Omit<WarehouseJob, "attempts" | "updatedAt" | "state"> & {
  state: "prepared" | "failed";
};

/** What a move of a job writes besides its time. */
export interface JobMove {
  state: WarehouseJobState;
  errorCode: string | null;
  attempts: number;
  reason: WarehouseReason;
  printer: PrinterProfile | null;
  bytesBase64: string | null;
}

/** The session or the job changed between the read and the write. */
export class StaleWarehouseError extends Error {
  constructor(id: string) {
    super(`warehouse row ${id} changed meanwhile`);
    this.name = "StaleWarehouseError";
  }
}

/** A stored job this build cannot read (a damaged profile or fields). */
export class UnreadableWarehouseJobError extends Error {
  constructor(id: string) {
    super(`warehouse job ${id} cannot be read`);
    this.name = "UnreadableWarehouseJobError";
  }
}

export const OPEN_SESSION_SQL =
  "SELECT id, reason, unit_template_id, box_template_id, pallet_template_id, started_by, " +
  "started_at FROM wh_sessions WHERE host_id = ? AND device_id = ? AND finished_at IS NULL";

const JOB_COLUMNS =
  "SELECT id, session_id, kind, subject_id, identity, repair, reason, state, template_id, " +
  "template_rev, template_spec, fields, printer, bytes_base64, error_code, attempts, " +
  "operator_id, created_at, updated_at FROM wh_jobs";

export const OPEN_JOB_SQL =
  `${JOB_COLUMNS} WHERE host_id = ? AND device_id = ? AND session_id = ? ` +
  "AND state IN ('prepared', 'sending', 'failed', 'unknown')";

export const JOB_BY_IDENTITY_SQL =
  `${JOB_COLUMNS} WHERE host_id = ? AND device_id = ? AND session_id = ? AND identity = ? ` +
  "AND state <> 'cancelled' ORDER BY rowid DESC LIMIT 1";

export const JOB_SQL = `${JOB_COLUMNS} WHERE host_id = ? AND device_id = ? AND id = ?`;

export const SENT_COUNT_SQL =
  "SELECT count(*) AS n FROM wh_jobs WHERE host_id = ? AND device_id = ? " +
  "AND session_id = ? AND state IN ('sent', 'verified')";

export const UNSENT_RECORDS_SQL =
  "SELECT count(*) AS n FROM wh_outbox WHERE host_id = ? AND device_id = ? " +
  "AND acked_at IS NULL";

export const MOVE_JOB_SQL =
  "UPDATE wh_jobs SET state = ?, error_code = ?, attempts = ?, reason = ?, printer = ?, " +
  "bytes_base64 = ?, updated_at = ? WHERE host_id = ? AND device_id = ? AND id = ? " +
  "AND state = ? AND attempts = ?";

export const UPDATE_SESSION_SQL =
  "UPDATE wh_sessions SET reason = ?, unit_template_id = ?, box_template_id = ?, " +
  "pallet_template_id = ?, updated_at = ? WHERE host_id = ? AND device_id = ? AND id = ? " +
  "AND finished_at IS NULL";

export const FINISH_SESSION_SQL =
  "UPDATE wh_sessions SET finished_at = ?, finished_by = ?, updated_at = ? " +
  "WHERE host_id = ? AND device_id = ? AND id = ? AND finished_at IS NULL " +
  "AND NOT EXISTS (SELECT 1 FROM wh_jobs j WHERE j.host_id = wh_sessions.host_id " +
  "AND j.device_id = wh_sessions.device_id AND j.session_id = wh_sessions.id " +
  "AND j.state IN ('prepared', 'sending', 'failed', 'unknown'))";

/** How long a finished session whose records the host all accepted is kept (decision Р18). */
export const WAREHOUSE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const DUE_SESSIONS_SQL =
  "SELECT s.id FROM wh_sessions s WHERE s.host_id = ? AND s.device_id = ? " +
  "AND s.finished_at IS NOT NULL AND s.finished_at <= ? AND NOT EXISTS (SELECT 1 " +
  "FROM wh_outbox o WHERE o.host_id = s.host_id AND o.device_id = s.device_id " +
  "AND o.session_id = s.id AND o.outcome IS NOT 'accepted')";

export const PURGE_SESSION_SQL =
  "DELETE FROM wh_sessions WHERE host_id = ? AND device_id = ? AND id = ? " +
  "AND finished_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wh_outbox o " +
  "WHERE o.host_id = wh_sessions.host_id AND o.device_id = wh_sessions.device_id " +
  "AND o.session_id = wh_sessions.id AND o.outcome IS NOT 'accepted')";

export const PURGE_JOBS_SQL =
  "DELETE FROM wh_jobs WHERE host_id = ? AND device_id = ? AND session_id = ?";

export const PURGE_RECORDS_SQL =
  "DELETE FROM wh_outbox WHERE host_id = ? AND device_id = ? AND session_id = ?";

const sessionRow = z.object({
  id: z.string(),
  reason: z.enum(WAREHOUSE_REASONS),
  unit_template_id: z.string().nullable(),
  box_template_id: z.string().nullable(),
  pallet_template_id: z.string().nullable(),
  started_by: z.string(),
  started_at: z.string(),
});

const jobRow = z.object({
  id: z.string(),
  session_id: z.string(),
  kind: z.enum(WAREHOUSE_SUBJECT_KINDS),
  subject_id: z.string(),
  identity: z.string(),
  repair: z.literal("legacy_tspl_fnc1_literal").nullable(),
  reason: z.enum(WAREHOUSE_REASONS),
  state: z.enum(WAREHOUSE_JOB_STATES),
  template_id: z.string(),
  template_rev: z.number().int(),
  template_spec: z.string(),
  fields: z.string(),
  printer: z.string().nullable(),
  bytes_base64: z.string().nullable(),
  error_code: z.string().nullable(),
  attempts: z.number().int(),
  operator_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const fieldsSchema = z.record(z.enum(LABEL_FIELDS), z.string());
const countRow = z.object({ n: z.number().int().nonnegative() });
const idRow = z.object({ id: z.string() });

function toSession(row: z.infer<typeof sessionRow>): WarehouseSession {
  return {
    id: row.id,
    reason: row.reason,
    templates: {
      unit: row.unit_template_id,
      box: row.box_template_id,
      pallet: row.pallet_template_id,
    },
    startedBy: row.started_by,
    startedAt: row.started_at,
  };
}

function toJob(row: z.infer<typeof jobRow>): WarehouseJob {
  let printer: PrinterProfile | null = null;
  let fields: LabelFields;
  try {
    if (row.printer !== null) {
      printer = parsePrinterProfile(JSON.parse(row.printer));
      if (printer === null) throw new UnreadableWarehouseJobError(row.id);
    }
    fields = fieldsSchema.parse(JSON.parse(row.fields));
  } catch {
    throw new UnreadableWarehouseJobError(row.id);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    subjectId: row.subject_id,
    identity: row.identity,
    repair: row.repair,
    reason: row.reason,
    state: row.state,
    templateId: row.template_id,
    templateRev: row.template_rev,
    templateSpec: row.template_spec,
    fields,
    printer,
    bytesBase64: row.bytes_base64,
    errorCode: row.error_code,
    attempts: row.attempts,
    operatorId: row.operator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The pairing's open session, or `null`. */
export async function readOpenSession(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<WarehouseSession | null> {
  const [row] = await local.query(OPEN_SESSION_SQL, [pairing.hostId, pairing.deviceId], sessionRow);
  return row === undefined ? null : toSession(row);
}

/**
 * Starts a session; when one is open already (another start won the race), that
 * one is the session: one open session per pairing (`wh_sessions_open`).
 */
export async function startSession(
  local: LocalExecutor,
  pairing: Pairing,
  input: {
    id: string;
    reason: WarehouseReason;
    templates: WarehouseTemplates;
    operatorId: string;
    at: string;
  },
): Promise<WarehouseSession> {
  try {
    await local.transaction([
      {
        sql:
          "INSERT INTO wh_sessions (id, host_id, device_id, reason, unit_template_id, " +
          "box_template_id, pallet_template_id, started_by, started_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        values: [
          input.id,
          pairing.hostId,
          pairing.deviceId,
          input.reason,
          input.templates.unit,
          input.templates.box,
          input.templates.pallet,
          input.operatorId,
          input.at,
          input.at,
        ],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (!(error instanceof LocalDbError)) throw error;
    const open = await readOpenSession(local, pairing);
    if (open === null) throw error;
    return open;
  }
  return {
    id: input.id,
    reason: input.reason,
    templates: input.templates,
    startedBy: input.operatorId,
    startedAt: input.at,
  };
}

/** Writes the session's reason and templates for its next jobs; a finished session is stale. */
export async function updateSession(
  local: LocalExecutor,
  pairing: Pairing,
  session: WarehouseSession,
  at: string,
): Promise<void> {
  try {
    await local.transaction([
      {
        sql: UPDATE_SESSION_SQL,
        values: [
          session.reason,
          session.templates.unit,
          session.templates.box,
          session.templates.pallet,
          at,
          pairing.hostId,
          pairing.deviceId,
          session.id,
        ],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleWarehouseError(session.id);
    }
    throw error;
  }
}

/** Finishes the session unless a job of it waits (`busy`); a finished session is never continued. */
export async function finishSession(
  local: LocalExecutor,
  pairing: Pairing,
  sessionId: string,
  operatorId: string,
  at: string,
): Promise<"finished" | "busy"> {
  try {
    await local.transaction([
      {
        sql: FINISH_SESSION_SQL,
        values: [at, operatorId, at, pairing.hostId, pairing.deviceId, sessionId],
        expectedChanges: 1,
      },
    ]);
    return "finished";
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") return "busy";
    throw error;
  }
}

async function oneJob(
  local: LocalExecutor,
  sql: string,
  values: readonly unknown[],
): Promise<WarehouseJob | null> {
  const [row] = await local.query(sql, values, jobRow);
  return row === undefined ? null : toJob(row);
}

/** The session's job that waits for the printer or the operator, or `null`. */
export function readOpenJob(
  local: LocalExecutor,
  pairing: Pairing,
  sessionId: string,
): Promise<WarehouseJob | null> {
  return oneJob(local, OPEN_JOB_SQL, [pairing.hostId, pairing.deviceId, sessionId]);
}

/** The session's newest job of this code or SSCC that was not cancelled, or `null`. */
export function readJobByIdentity(
  local: LocalExecutor,
  pairing: Pairing,
  sessionId: string,
  identity: string,
): Promise<WarehouseJob | null> {
  return oneJob(local, JOB_BY_IDENTITY_SQL, [
    pairing.hostId,
    pairing.deviceId,
    sessionId,
    identity,
  ]);
}

/** The job `id` of the pairing, or `null`. */
export function readJob(
  local: LocalExecutor,
  pairing: Pairing,
  id: string,
): Promise<WarehouseJob | null> {
  return oneJob(local, JOB_SQL, [pairing.hostId, pairing.deviceId, id]);
}

/** How many labels of the session went to a printer (sent or checked). */
export async function countSent(
  local: LocalExecutor,
  pairing: Pairing,
  sessionId: string,
): Promise<number> {
  const [row] = await local.query(
    SENT_COUNT_SQL,
    [pairing.hostId, pairing.deviceId, sessionId],
    countRow,
  );
  return row?.n ?? 0;
}

/** How many records of the pairing wait for the host's receipt. */
export async function countUnsentRecords(local: LocalExecutor, pairing: Pairing): Promise<number> {
  const [row] = await local.query(UNSENT_RECORDS_SQL, [pairing.hostId, pairing.deviceId], countRow);
  return row?.n ?? 0;
}

/** The row of a new job; with `wh_jobs_open` it refuses a second waiting job of the session. */
export function insertJobStatement(pairing: Pairing, job: NewWarehouseJob): LocalStatement {
  return {
    sql:
      "INSERT INTO wh_jobs (host_id, device_id, id, session_id, kind, subject_id, identity, " +
      "repair, reason, state, template_id, template_rev, template_spec, fields, printer, " +
      "bytes_base64, error_code, attempts, operator_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    values: [
      pairing.hostId,
      pairing.deviceId,
      job.id,
      job.sessionId,
      job.kind,
      job.subjectId,
      job.identity,
      job.repair,
      job.reason,
      job.state,
      job.templateId,
      job.templateRev,
      job.templateSpec,
      JSON.stringify(job.fields),
      job.printer === null ? null : JSON.stringify(job.printer),
      job.bytesBase64,
      job.errorCode,
      job.operatorId,
      job.createdAt,
      job.createdAt,
    ],
    expectedChanges: 1,
  };
}

/** A job's move from the state and attempt it was read in; another writer's move fails it. */
export function moveJobStatement(
  pairing: Pairing,
  job: Pick<WarehouseJob, "id" | "state" | "attempts">,
  move: JobMove,
  at: string,
): LocalStatement {
  return {
    sql: MOVE_JOB_SQL,
    values: [
      move.state,
      move.errorCode,
      move.attempts,
      move.reason,
      move.printer === null ? null : JSON.stringify(move.printer),
      move.bytesBase64,
      at,
      pairing.hostId,
      pairing.deviceId,
      job.id,
      job.state,
      job.attempts,
    ],
    expectedChanges: 1,
  };
}

/** The record of one attempt of a job, as the host takes it (`WarehouseRecord`). */
export function warehouseRecord(
  job: Pick<
    WarehouseJob,
    "id" | "sessionId" | "kind" | "subjectId" | "identity" | "repair" | "templateId" | "templateRev"
  >,
  attempt: {
    id: string;
    attempt: number;
    reason: WarehouseReason;
    outcome: WarehouseOutcome;
    errorCode: string | null;
    operatorId: string;
    occurredAt: string;
  },
): WarehouseRecord {
  return {
    id: attempt.id,
    sessionId: job.sessionId,
    jobId: job.id,
    attempt: attempt.attempt,
    subjectKind: job.kind,
    subjectId: job.subjectId,
    identity: job.identity,
    reasonCode: attempt.reason,
    repair: job.repair,
    templateId: job.templateId,
    templateRev: job.templateRev,
    outcome: attempt.outcome,
    errorCode: attempt.errorCode,
    operatorId: attempt.operatorId,
    occurredAt: attempt.occurredAt,
  };
}

/** The record's row in `wh_outbox`, written with the move it records. */
export function recordStatement(
  pairing: Pairing,
  record: WarehouseRecord,
  createdAt: string,
): LocalStatement {
  return {
    sql:
      "INSERT INTO wh_outbox (id, host_id, device_id, session_id, payload, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    values: [
      record.id,
      pairing.hostId,
      pairing.deviceId,
      record.sessionId,
      JSON.stringify(record),
      createdAt,
    ],
    expectedChanges: 1,
  };
}

/**
 * Deletes the pairing's sessions finished 30 days before `now` whose records the
 * host all accepted, with their jobs and records, one session per transaction; a
 * session that took a record meanwhile stays (its delete changes nothing and the
 * batch fails whole). Answers how many went.
 */
export async function purgeWarehouseSessions(
  local: LocalExecutor,
  pairing: Pairing,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - WAREHOUSE_RETENTION_MS).toISOString();
  const { hostId, deviceId } = pairing;
  const due = await local.query(DUE_SESSIONS_SQL, [hostId, deviceId, cutoff], idRow);
  let purged = 0;
  for (const { id } of due) {
    try {
      await local.transaction([
        { sql: PURGE_SESSION_SQL, values: [hostId, deviceId, id], expectedChanges: 1 },
        { sql: PURGE_JOBS_SQL, values: [hostId, deviceId, id] },
        { sql: PURGE_RECORDS_SQL, values: [hostId, deviceId, id] },
      ]);
      purged += 1;
    } catch (error) {
      if (!(error instanceof LocalDbError && error.code === "changes_mismatch")) throw error;
    }
  }
  return purged;
}
