import { z } from "zod";

import { MAX_FACT_BATCH, type FactReceipt } from "../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

/** The host's receipts do not answer the records sent: no receipt is kept, and the batch goes again. */
export class ReceiptMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptMismatchError";
  }
}

const unsentRow = z.object({ id: z.string(), kind: z.string(), payload: z.string() });

/**
 * The most bytes of record JSON one batch carries. The host refuses a body
 * over 2 MiB (axum's default; its extractor answers the length rejection like
 * any malformed body: 400 `validation_failed`), and a refused batch is sent
 * again unchanged, so a batch that is too large would hold back every record
 * behind it for good. A record is at most 16 KiB (`MAX_RECORD_BYTES`), which
 * puts a batch of 100 at about 1.6 MiB: this only cuts a batch of records
 * that no fact makes.
 */
export const MAX_BATCH_BYTES = 1_835_008;

const encoder = new TextEncoder();

/**
 * The records of `rows` from the first to the last that fits `MAX_BATCH_BYTES`
 * together, counted in bytes of UTF-8. The first goes alone, however large;
 * were it over the host's body limit it would be refused with 400 on every
 * send and block the queue, which cannot happen: `outboxStatement` keeps no
 * record over `MAX_RECORD_BYTES` (16 KiB), far below the limit.
 */
function withinBudget<T extends { payload: string }>(rows: readonly T[]): T[] {
  let bytes = 0;
  const kept: T[] = [];
  for (const row of rows) {
    bytes += encoder.encode(row.payload).length;
    if (kept.length > 0 && bytes > MAX_BATCH_BYTES) break;
    kept.push(row);
  }
  return kept;
}

/** What one run of the sender did: how many records got receipts, and whether more wait. */
export interface SendResult {
  sent: number;
  more: boolean;
}

/** The read of a batch: this pairing's oldest records without a receipt, in the order they were kept. */
export const UNSENT_SQL =
  "SELECT id, kind, payload FROM outbox WHERE host_id = ? AND device_id = ? " +
  "AND acked_at IS NULL ORDER BY seq LIMIT ?";

/** Counts a send of each record of `ids` (a JSON array) before it leaves. */
export function attemptStatement(pairing: Pairing, ids: string, sentAt: string): LocalStatement {
  return {
    sql:
      "UPDATE outbox SET attempts = attempts + 1, sent_at = ? " +
      "WHERE host_id = ? AND device_id = ? AND id IN (SELECT value FROM json_each(?))",
    values: [sentAt, pairing.hostId, pairing.deviceId, ids],
  };
}

/**
 * The write of a batch's receipts, as ONE transaction (`answers` is a JSON
 * array of `{ id, kind, outcome, code?, details? }`, one per record sent):
 * the outcome on every record that still waits for its receipt, and the
 * marks a `conflict` of a scan leaves on the scan and on its box (and takes
 * off again once the same record is accepted, plan ОЧ), and the
 * `closed` a receipt of the station's close gives its shift (plan 2a8).
 *
 * The unary pluses on `host_id`, `device_id` and `acked_at` are deliberate
 * (measured on node:sqlite 3.53 with 100,000 records): without them the
 * planner walks the `(host_id, device_id, …)` prefix of
 * `outbox_unsent`, `outbox_settled` (every settled record of the pairing),
 * `floor_scans_shift` and `floor_boxes_shift` — every unsent record, scan
 * and box of the pairing for each batch, 9 s for the outbox's own statement
 * — instead of looking the batch's few records up by their own key, which
 * takes well under a millisecond. The ids are unique across pairings, so the
 * pairing terms only restate what the key already says. The plus on `outcome`
 * of the close's statement is defensive only: with `+host_id` the leftmost
 * column of `outbox_settled` is unusable anyway, and it was not measured alone.
 */
export function receiptStatements(
  pairing: Pairing,
  answers: string,
  ackedAt: string,
): LocalStatement[] {
  const { hostId, deviceId } = pairing;
  return [
    {
      sql:
        "UPDATE outbox SET outcome = r.value ->> 'outcome', outcome_code = r.value ->> 'code', " +
        "outcome_details = r.value -> 'details', acked_at = ? FROM json_each(?) AS r " +
        "WHERE outbox.id = r.value ->> 'id' AND +outbox.host_id = ? AND +outbox.device_id = ? " +
        "AND +outbox.acked_at IS NULL",
      values: [ackedAt, answers, hostId, deviceId],
    },
    {
      sql:
        "UPDATE floor_scans SET conflict = 1 WHERE +host_id = ? AND +device_id = ? AND id IN " +
        "(SELECT value ->> 'id' FROM json_each(?) " +
        "WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'conflict')",
      values: [hostId, deviceId, answers],
    },
    {
      sql:
        "UPDATE floor_boxes SET needs_fix = 1 WHERE +host_id = ? AND +device_id = ? AND id IN " +
        "(SELECT box_id FROM floor_scans WHERE +host_id = ? AND +device_id = ? " +
        "AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) " +
        "WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'conflict'))",
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
    // An accepted scan was answered `conflict` before (a restore sent it again,
    // plan РК-С): its mark goes, and its box's once no scan of it is in conflict.
    {
      sql:
        "UPDATE floor_scans SET conflict = 0 WHERE +host_id = ? AND +device_id = ? AND conflict = 1 " +
        "AND id IN (SELECT value ->> 'id' FROM json_each(?) " +
        "WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')",
      values: [hostId, deviceId, answers],
    },
    {
      sql:
        "UPDATE floor_boxes SET needs_fix = 0 WHERE +host_id = ? AND +device_id = ? AND needs_fix = 1 " +
        "AND id IN (SELECT box_id FROM floor_scans WHERE +host_id = ? AND +device_id = ? " +
        "AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) " +
        "WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')) " +
        "AND NOT EXISTS (SELECT 1 FROM floor_scans c WHERE c.host_id = floor_boxes.host_id " +
        "AND c.device_id = floor_boxes.device_id AND c.shift_id = floor_boxes.shift_id " +
        "AND c.box_id = floor_boxes.id AND c.conflict = 1)",
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
    {
      sql:
        "UPDATE floor_shifts SET local_state = 'closed' WHERE host_id = ? AND device_id = ? " +
        "AND local_state = 'closing' AND id IN (SELECT shift_id FROM outbox " +
        "WHERE +host_id = ? AND +device_id = ? AND kind = 'shift_closed' AND +outcome = 'accepted' " +
        "AND id IN (SELECT value ->> 'id' FROM json_each(?)))",
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
  ];
}

/**
 * One batch of the outbox to the host (stage 2a spec §5.5, decision 11): this
 * pairing's oldest records without a receipt, up to 100, in their order, sent
 * as kept (and within `MAX_BATCH_BYTES`). Each send counts in `attempts`
 * first. The receipts are checked against the records — as many, each with
 * its record's id or none (a record
 * the host could not read, matched by its place) — and applied in ONE
 * transaction through `json_each`: the outcome, its code and details, and
 * the time on every record; a `conflict` of a scan marks the scan and its
 * box for review (`floor_scans.conflict`, `floor_boxes.needs_fix`); an
 * `accepted` of a scan in conflict before clears both (plan ОЧ); an
 * `accepted` `shift_closed` — `alreadyClosed` too, a shift the office closed
 * first — makes this station's close `closed` (plan 2a8); a `rejected`
 * record stays in the outbox with its code, for the queue screen, and a
 * refused close leaves the shift `closing`.
 * A failed send or an answer that does not fit rejects and keeps nothing:
 * the same batch goes again, and the host answers it with the same receipts.
 * The sender never deletes a record (the retention does, 30 days after its
 * shift's accepted close: `src/local/retention.ts`), and one with a receipt
 * never goes again.
 */
export async function sendFactBatch(
  local: LocalExecutor,
  pairing: Pairing,
  send: (records: readonly unknown[]) => Promise<FactReceipt[]>,
  now: () => Date,
): Promise<SendResult> {
  const waiting = await local.query(
    UNSENT_SQL,
    [pairing.hostId, pairing.deviceId, MAX_FACT_BATCH],
    unsentRow,
  );
  if (waiting.length === 0) return { sent: 0, more: false };
  const unsent = withinBudget(waiting);
  await local.transaction([
    attemptStatement(pairing, JSON.stringify(unsent.map((row) => row.id)), now().toISOString()),
  ]);
  const receipts = await send(unsent.map((row): unknown => JSON.parse(row.payload)));
  if (receipts.length !== unsent.length) {
    throw new ReceiptMismatchError(`${receipts.length} receipts for ${unsent.length} records`);
  }
  const applied = unsent.map((row, index) => {
    const receipt = receipts[index];
    if (receipt === undefined || (receipt.id !== null && receipt.id !== row.id)) {
      throw new ReceiptMismatchError(`receipt ${index} names another record`);
    }
    return {
      id: row.id,
      kind: row.kind,
      outcome: receipt.outcome,
      ...(receipt.code === undefined ? {} : { code: receipt.code }),
      ...(receipt.details === undefined ? {} : { details: receipt.details }),
    };
  });
  await local.transaction(receiptStatements(pairing, JSON.stringify(applied), now().toISOString()));
  return {
    sent: unsent.length,
    more: unsent.length < waiting.length || waiting.length === MAX_FACT_BATCH,
  };
}
