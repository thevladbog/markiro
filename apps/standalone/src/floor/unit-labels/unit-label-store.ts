import type {
  ProductLabelAttemptState,
  ReprintReason,
  VerificationOutcome,
  VerificationPolicy,
} from "@markiro/domain";
import { z } from "zod";

import { REPRINT_REASONS, UNIT_LABEL_ERROR_CODES } from "../../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  PRINTER_LANGUAGES,
  PRINTER_MODES,
  type PrinterDpi,
  type PrinterLanguage,
  type PrinterMode,
} from "../setup/workstation-settings.js";

/**
 * The statements of the station's unit label jobs (plan РЕЖ part B,
 * migration `0015`, table `floor_unit_labels`): one row per job, which holds
 * the job's current attempt as the domain's projection does
 * (`ProductLabelProjection`); the attempts themselves travel to the host as
 * `unit_label` facts. Every read here is pinned with its query plan in
 * `test/floor-schema.test.ts` and, with the same text, in
 * `src-tauri/tests/local_db.rs` (`the_unit_label_reads_search_an_index`).
 */

/** The states of a job's current attempt (the domain's `ProductLabelAttemptState`). */
export const UNIT_LABEL_ATTEMPT_STATES = [
  "prepared",
  "sending",
  "sent",
  "failed_before_send",
  "delivery_unknown",
] as const satisfies readonly ProductLabelAttemptState[];

/** The shift's frozen verification policy, kept on the job (the domain's `VerificationPolicy`). */
export const UNIT_LABEL_POLICIES = [
  "none",
  "required",
] as const satisfies readonly VerificationPolicy[];

/** What became of the check of the printed label (the domain's `VerificationOutcome`). */
export const UNIT_LABEL_VERIFICATIONS = [
  "not_required",
  "pending",
  "verified",
  "skipped",
] as const satisfies readonly VerificationOutcome[];

/** The error codes a job's attempt keeps: those of its two error states, as the fact's. */
export const UNIT_LABEL_ATTEMPT_ERROR_CODES = {
  failed_before_send: UNIT_LABEL_ERROR_CODES.failed_before_send,
  delivery_unknown: UNIT_LABEL_ERROR_CODES.delivery_unknown,
} as const;

/**
 * A job not completed (the domain's `productLabelStatus` other than
 * `completed`): its check is pending, or it needs none and its attempt was
 * not sent. Word for word the predicate of the unique index
 * `floor_unit_labels_unresolved` (one such job per pairing, whatever its
 * shift), so a read that names it searches that index.
 */
export const UNRESOLVED_UNIT_LABEL_SQL =
  "(verification = 'pending' OR (verification = 'not_required' AND attempt_state <> 'sent'))";

/** Every column of a job but the label's bytes. */
const COLUMNS =
  "id, shift_id, code_hash, scan_id, attempt_no, attempt_state, verification_policy, " +
  "verification, reason, error_code, print_mode, language, dpi, bytes_digest, payload_digest, " +
  "template_id, template_rev, fields, operator_id, created_at, updated_at";

/** A whole job, its bytes included (a send, a reprint and the recovery need them). */
const JOB_COLUMNS = `SELECT ${COLUMNS}, bytes_base64 FROM floor_unit_labels`;

/**
 * The pairing's one unresolved job, whatever its shift, as the cloud's
 * station has one (`PRODUCT_LABEL_BUSY` across shifts): the next unit waits
 * for it while its check is required, and entering any shift opens it — the
 * caller compares its `shift_id` with the shift entered. Parameters: host id,
 * device id.
 */
export const UNRESOLVED_JOB_SQL = `${JOB_COLUMNS} WHERE host_id = ? AND device_id = ? AND ${UNRESOLVED_UNIT_LABEL_SQL}`;

/** One job by its key; parameters: host id, device id, job id. */
export const JOB_SQL = `${JOB_COLUMNS} WHERE host_id = ? AND device_id = ? AND id = ?`;

/**
 * The shift's jobs for «История этикеток», newest first, without their
 * bytes; parameters: host id, device id, shift id, the most rows.
 */
export const SHIFT_JOBS_SQL =
  `SELECT ${COLUMNS} FROM floor_unit_labels WHERE host_id = ? AND device_id = ? ` +
  "AND shift_id = ? ORDER BY rowid DESC LIMIT ?";

/**
 * The pairing's jobs whose attempt was handed to the printer when the app
 * stopped (`sending` with no live send): the recovery makes each
 * `delivery_unknown` with `interrupted` and sends nothing. Through the
 * partial index `floor_unit_labels_sending`; parameters: host id, device id.
 */
export const SENDING_JOBS_SQL = `${JOB_COLUMNS} WHERE host_id = ? AND device_id = ? AND attempt_state = 'sending'`;

/**
 * A job's step, only from the state it was read in (a stale read changes
 * nothing, `expectedChanges: 1` catches it): the attempt, its state, the
 * check, the reason, the error code and the time; parameters: those six,
 * then host id, device id, job id, and the attempt number, attempt state and
 * check it was read with. Never the bytes nor their print identity
 * (`print_mode`, `language`, `dpi`): a reprint sends the same bytes, and the
 * trigger `floor_unit_labels_fixed` refuses a change of them. Where a send
 * goes is read from the workstation at that moment and compared with the
 * job's identity, not written here.
 */
export const MOVE_JOB_SQL =
  "UPDATE floor_unit_labels SET attempt_no = ?, attempt_state = ?, verification = ?, " +
  "reason = ?, error_code = ?, updated_at = ? WHERE host_id = ? AND device_id = ? " +
  "AND id = ? AND attempt_no = ? AND attempt_state = ? AND verification = ?";

/**
 * A new job, `prepared` at its first attempt, written in the transaction that
 * accepts its unit; parameters as the columns are listed. The job's print
 * identity, bytes, digests, template and fields are fixed from here on
 * (`floor_unit_labels_fixed`).
 */
export const INSERT_JOB_SQL =
  "INSERT INTO floor_unit_labels (id, host_id, device_id, shift_id, code_hash, scan_id, " +
  "attempt_no, attempt_state, verification_policy, verification, reason, error_code, " +
  "print_mode, language, dpi, bytes_base64, bytes_digest, payload_digest, template_id, " +
  "template_rev, fields, operator_id, created_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, 1, 'prepared', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/** A job as the station keeps it (`floor_unit_labels`), its label's bytes included. */
export interface UnitLabelJob {
  id: string;
  shiftId: string;
  /** The code's `kmHash`, without its crypto tail. */
  codeHash: string;
  /** The accepted scan the job is the label of (`floor_scans.id`, the `scan` record's id). */
  scanId: string;
  attemptNo: number;
  attemptState: ProductLabelAttemptState;
  verificationPolicy: VerificationPolicy;
  verification: VerificationOutcome;
  reason: ReprintReason | null;
  errorCode: string | null;
  printMode: PrinterMode;
  /** The printer language of RAW bytes; `null` for a Windows driver's page. */
  language: PrinterLanguage | null;
  dpi: PrinterDpi;
  bytesBase64: string;
  bytesDigest: string;
  payloadDigest: string;
  templateId: string;
  templateRev: number;
  /** The label's fields as rendered: the full code is in `km.code`, and only here. */
  fields: Record<string, string>;
  operatorId: string;
  createdAt: string;
  updatedAt: string;
}

const jobRow = z.object({
  id: z.string(),
  shift_id: z.string(),
  code_hash: z.string(),
  scan_id: z.string(),
  attempt_no: z.number().int().positive(),
  attempt_state: z.enum(UNIT_LABEL_ATTEMPT_STATES),
  verification_policy: z.enum(UNIT_LABEL_POLICIES),
  verification: z.enum(UNIT_LABEL_VERIFICATIONS),
  reason: z.enum(REPRINT_REASONS).nullable(),
  error_code: z.string().nullable(),
  print_mode: z.enum(PRINTER_MODES),
  language: z.enum(PRINTER_LANGUAGES).nullable(),
  dpi: z.union([z.literal(203), z.literal(300)]),
  bytes_digest: z.string(),
  payload_digest: z.string(),
  template_id: z.string(),
  template_rev: z.number().int(),
  fields: z.string(),
  operator_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  bytes_base64: z.string(),
});

const fieldsSchema = z.record(z.string(), z.string());

function toJob(row: z.infer<typeof jobRow>): UnitLabelJob {
  return {
    id: row.id,
    shiftId: row.shift_id,
    codeHash: row.code_hash,
    scanId: row.scan_id,
    attemptNo: row.attempt_no,
    attemptState: row.attempt_state,
    verificationPolicy: row.verification_policy,
    verification: row.verification,
    reason: row.reason,
    errorCode: row.error_code,
    printMode: row.print_mode,
    language: row.language,
    dpi: row.dpi,
    bytesBase64: row.bytes_base64,
    bytesDigest: row.bytes_digest,
    payloadDigest: row.payload_digest,
    templateId: row.template_id,
    templateRev: row.template_rev,
    fields: fieldsSchema.parse(JSON.parse(row.fields)),
    operatorId: row.operator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** One job of the pairing, or `null`. */
export async function readUnitLabelJob(
  local: LocalExecutor,
  pairing: Pairing,
  jobId: string,
): Promise<UnitLabelJob | null> {
  const [row] = await local.query(JOB_SQL, [pairing.hostId, pairing.deviceId, jobId], jobRow);
  return row === undefined ? null : toJob(row);
}

/** The pairing's one unresolved job, whatever its shift, or `null`. */
export async function readUnresolvedUnitLabel(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<UnitLabelJob | null> {
  const [row] = await local.query(UNRESOLVED_JOB_SQL, [pairing.hostId, pairing.deviceId], jobRow);
  return row === undefined ? null : toJob(row);
}

/** The pairing's jobs left in `sending`. */
export async function readSendingUnitLabels(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<UnitLabelJob[]> {
  const rows = await local.query(SENDING_JOBS_SQL, [pairing.hostId, pairing.deviceId], jobRow);
  return rows.map(toJob);
}

/** Where a job's step leaves it: its attempt, the attempt's state, the check, the reason, the error. */
export interface UnitLabelMove {
  attemptNo: number;
  attemptState: ProductLabelAttemptState;
  verification: VerificationOutcome;
  reason: ReprintReason | null;
  errorCode: string | null;
}

/**
 * `MOVE_JOB_SQL` for `job` as it was read: a job moved meanwhile changes no
 * row, and the transaction fails whole (`changes_mismatch`), its record with it.
 */
export function moveJobStatement(
  pairing: Pairing,
  job: Pick<UnitLabelJob, "id" | "attemptNo" | "attemptState" | "verification">,
  move: UnitLabelMove,
  at: string,
): LocalStatement {
  return {
    sql: MOVE_JOB_SQL,
    values: [
      move.attemptNo,
      move.attemptState,
      move.verification,
      move.reason,
      move.errorCode,
      at,
      pairing.hostId,
      pairing.deviceId,
      job.id,
      job.attemptNo,
      job.attemptState,
      job.verification,
    ],
    expectedChanges: 1,
  };
}
