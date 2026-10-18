import { z } from "zod";

import type { FactReceipt } from "../host/protocol.js";
import type { LocalExecutor } from "./executor.js";
import { ReceiptMismatchError, type SendResult } from "./facts-sender.js";
import type { Pairing } from "./reference-sync.js";

/** The most records of one batch, as the host takes them. */
export const MAX_WAREHOUSE_BATCH = 100;

/** This pairing's oldest records without a receipt, in the order they were kept. */
export const WAREHOUSE_UNSENT_SQL =
  "SELECT id, payload FROM wh_outbox WHERE host_id = ? AND device_id = ? " +
  "AND acked_at IS NULL ORDER BY seq LIMIT ?";

/**
 * Counts a send of each record of a JSON list before it leaves. The pluses keep
 * the planner on the records' own key (as the facts' sender, `facts-sender.ts`).
 */
export const WAREHOUSE_ATTEMPT_SQL =
  "UPDATE wh_outbox SET attempts = attempts + 1, sent_at = ? WHERE +host_id = ? " +
  "AND +device_id = ? AND id IN (SELECT value FROM json_each(?))";

/** The receipts of a batch (a JSON list of `{ id, outcome, code? }`), on records still waiting. */
export const WAREHOUSE_RECEIPT_SQL =
  "UPDATE wh_outbox SET outcome = r.value ->> 'outcome', outcome_code = r.value ->> " +
  "'code', acked_at = ? FROM json_each(?) AS r WHERE wh_outbox.id = r.value ->> 'id' " +
  "AND +wh_outbox.host_id = ? AND +wh_outbox.device_id = ? AND +wh_outbox.acked_at " +
  "IS NULL";

const unsentRow = z.object({ id: z.string(), payload: z.string() });

/**
 * One batch of the warehouse records to the host (plan СКЛ, decision Р17): up to
 * 100 of this pairing's oldest records without a receipt, sent as kept, each send
 * counted first. The receipts must answer the records — as many, each with its
 * record's id or none, `accepted` or `rejected` — and are written in ONE
 * transaction; otherwise nothing is kept and the same batch goes again. A record
 * with a receipt never goes again; the retention removes it with its session.
 * Records are small (well under 1 KiB), so a batch needs no byte budget.
 */
export async function sendWarehouseBatch(
  local: LocalExecutor,
  pairing: Pairing,
  send: (records: readonly unknown[]) => Promise<FactReceipt[]>,
  now: () => Date,
): Promise<SendResult> {
  const waiting = await local.query(
    WAREHOUSE_UNSENT_SQL,
    [pairing.hostId, pairing.deviceId, MAX_WAREHOUSE_BATCH],
    unsentRow,
  );
  if (waiting.length === 0) return { sent: 0, more: false };
  await local.transaction([
    {
      sql: WAREHOUSE_ATTEMPT_SQL,
      values: [
        now().toISOString(),
        pairing.hostId,
        pairing.deviceId,
        JSON.stringify(waiting.map((row) => row.id)),
      ],
    },
  ]);
  const receipts = await send(waiting.map((row): unknown => JSON.parse(row.payload)));
  if (receipts.length !== waiting.length) {
    throw new ReceiptMismatchError(`${receipts.length} receipts for ${waiting.length} records`);
  }
  const answers = waiting.map((row, index) => {
    const receipt = receipts[index];
    if (
      receipt === undefined ||
      (receipt.id !== null && receipt.id !== row.id) ||
      receipt.outcome === "conflict"
    ) {
      throw new ReceiptMismatchError(`receipt ${index} does not answer its record`);
    }
    return {
      id: row.id,
      outcome: receipt.outcome,
      ...(receipt.code === undefined ? {} : { code: receipt.code }),
    };
  });
  await local.transaction([
    {
      sql: WAREHOUSE_RECEIPT_SQL,
      values: [now().toISOString(), JSON.stringify(answers), pairing.hostId, pairing.deviceId],
    },
  ]);
  return { sent: waiting.length, more: waiting.length === MAX_WAREHOUSE_BATCH };
}
