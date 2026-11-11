import { z } from "zod";

import type { FactReceipt } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import { ReceiptMismatchError, type SendResult } from "../../local/facts-sender.js";
import type { Pairing } from "../../local/reference-sync.js";

/** A rejected draft or close must be physically reconciled before a later pallet opens on the host. */
export const BLOCKING_ASSEMBLY_RECEIPT =
  "(outcome = 'rejected' OR replay_blocked = 1) AND resolved_at IS NULL " +
  "AND kind IN ('warehouse_pallet_opened', 'warehouse_pallet_closed')";

const waitingRow = z.object({ id: z.string(), payload: z.string(), pallet_id: z.string() });

function waiting(local: LocalExecutor, pairing: Pairing, limit: number) {
  // Limit each send to the first pallet and stop at its close so an unaccepted close
  // cannot cause a label fact or a later pallet to be permanently refused.
  return local.query(
    "WITH blockers AS (SELECT coalesce(priority_seq, seq) AS position, kind, pallet_id, outcome " +
      `FROM pallet_assembly_outbox WHERE host_id = ? AND device_id = ? AND ${BLOCKING_ASSEMBLY_RECEIPT}), ` +
      "pending AS (SELECT seq, coalesce(priority_seq, seq) AS position, id, payload, pallet_id, kind " +
      "FROM pallet_assembly_outbox AS o WHERE host_id = ? AND device_id = ? AND acked_at IS NULL AND (" +
      "coalesce(priority_seq, seq) <= coalesce((SELECT min(position) FROM blockers), 9223372036854775807) " +
      // A pallet already closed locally still needs a close receipt so the office can cancel its label.
      "OR (o.kind = 'warehouse_pallet_closed' AND EXISTS (SELECT 1 FROM blockers b " +
      "WHERE b.position = (SELECT min(position) FROM blockers) AND b.pallet_id = o.pallet_id " +
      "AND b.kind = 'warehouse_pallet_opened' AND b.outcome = 'rejected') " +
      "AND (o.priority_seq IS NOT NULL OR o.replay_blocked = 1 OR NOT EXISTS (SELECT 1 FROM blockers b " +
      "WHERE b.pallet_id = o.pallet_id AND b.kind = 'warehouse_pallet_closed'))))) " +
      "SELECT id, payload, pallet_id FROM pending WHERE pallet_id = (SELECT pallet_id FROM pending ORDER BY position, seq LIMIT 1) " +
      "AND position <= coalesce((SELECT min(position) FROM pending WHERE kind = 'warehouse_pallet_closed'), 9223372036854775807) " +
      "ORDER BY position, seq LIMIT ?",
    [pairing.hostId, pairing.deviceId, pairing.hostId, pairing.deviceId, limit],
    waitingRow,
  );
}

export async function sendPalletAssemblyBatch(
  local: LocalExecutor,
  pairing: Pairing,
  send: (records: readonly unknown[]) => Promise<FactReceipt[]>,
  now: () => Date,
): Promise<SendResult> {
  const rows = await waiting(local, pairing, 100);
  const [first] = rows;
  if (first === undefined) return { sent: 0, more: false };
  const receipts = await send(rows.map((row): unknown => JSON.parse(row.payload)));
  if (receipts.length !== rows.length) {
    throw new ReceiptMismatchError(`${receipts.length} receipts for ${rows.length} pallet events`);
  }
  const results = rows.map((row, index) => {
    const receipt = receipts[index];
    if (
      receipt === undefined ||
      (receipt.id !== null && receipt.id !== row.id) ||
      receipt.outcome === "conflict"
    ) {
      throw new ReceiptMismatchError(`receipt ${index} does not answer its pallet event`);
    }
    return { id: row.id, outcome: receipt.outcome, code: receipt.code, details: receipt.details };
  });
  const accepted = JSON.stringify(
    results.filter((result) => result.outcome === "accepted").map(({ id }) => id),
  );
  const correction =
    "SELECT 1 FROM pallet_assembly_outbox c WHERE c.host_id = ? AND c.device_id = ? " +
    "AND c.pallet_id = ? AND c.replaces_id IS NOT NULL AND c.acked_at IS NULL " +
    "AND c.id IN (SELECT value FROM json_each(?))";
  const time = now().toISOString();
  await local.transaction([
    {
      // Corrections replayed after a restore already resolved their original rejection.
      // Only the first acceptance creates a corrective print job.
      sql:
        "UPDATE pallet_assembly_pallets AS p SET print_state = 'pending', print_reason = NULL, deferred = 1, " +
        "accepted_label = c.correction_label, accepted_members = c.correction_boxes, label_version = label_version + 1 FROM pallet_assembly_outbox c " +
        "WHERE p.host_id = ? AND p.device_id = ? AND p.id = ? AND c.host_id = p.host_id AND c.device_id = p.device_id " +
        "AND c.pallet_id = p.id AND c.replaces_id IS NOT NULL AND c.acked_at IS NULL " +
        "AND c.id IN (SELECT value FROM json_each(?)) " +
        `AND EXISTS (SELECT 1 FROM pallet_assembly_outbox o WHERE o.pallet_id = p.id AND ${BLOCKING_ASSEMBLY_RECEIPT})`,
      values: [pairing.hostId, pairing.deviceId, first.pallet_id, accepted],
    },
    {
      sql:
        "UPDATE pallet_assembly_outbox SET acked_at = ?, outcome = 'rejected', outcome_code = 'label_superseded', " +
        "resolved_at = ? WHERE pallet_id = ? AND host_id = ? AND device_id = ? AND acked_at IS NULL " +
        `AND kind = 'warehouse_pallet_label' AND EXISTS (${correction}) ` +
        `AND EXISTS (SELECT 1 FROM pallet_assembly_outbox o WHERE o.pallet_id = ? AND ${BLOCKING_ASSEMBLY_RECEIPT})`,
      values: [
        time,
        time,
        first.pallet_id,
        pairing.hostId,
        pairing.deviceId,
        pairing.hostId,
        pairing.deviceId,
        first.pallet_id,
        accepted,
        first.pallet_id,
      ],
    },
    {
      sql:
        "UPDATE pallet_assembly_outbox SET resolved_at = ? WHERE host_id = ? AND device_id = ? " +
        `AND pallet_id = ? AND outcome = 'rejected' AND resolved_at IS NULL AND EXISTS (${correction})`,
      values: [
        time,
        pairing.hostId,
        pairing.deviceId,
        first.pallet_id,
        pairing.hostId,
        pairing.deviceId,
        first.pallet_id,
        accepted,
      ],
    },
    {
      sql:
        "UPDATE pallet_assembly_outbox AS o SET acked_at = ?, outcome = r.value ->> 'outcome', " +
        "acknowledged_at = CASE WHEN replay_blocked = 1 THEN NULL ELSE acknowledged_at END, replay_blocked = 0, " +
        "outcome_code = r.value ->> 'code', outcome_details = r.value -> 'details' FROM json_each(?) AS r " +
        "WHERE o.id = r.value ->> 'id' AND o.host_id = ? AND o.device_id = ? AND o.acked_at IS NULL",
      values: [time, JSON.stringify(results), pairing.hostId, pairing.deviceId],
    },
    {
      sql: "UPDATE pallet_assembly_pallets SET revision = revision + 1 WHERE id = ? AND host_id = ? AND device_id = ?",
      values: [first.pallet_id, pairing.hostId, pairing.deviceId],
    },
  ]);
  return { sent: rows.length, more: (await waiting(local, pairing, 1)).length > 0 };
}
