import type {
  ProductLabelAttemptState,
  VerificationOutcome,
  VerificationPolicy,
} from "@markiro/domain";

import { UNIT_LABEL_ERROR_CODES } from "../../host/protocol.js";

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
