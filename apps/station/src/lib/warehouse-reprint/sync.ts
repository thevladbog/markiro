import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import {
  warehouseEventSchema,
  warehouseReceiptSchema,
  WAREHOUSE_REPRINT_PROTOCOL,
  productLabelValueDigest,
} from "@markiro/domain";
import type { StationClient } from "../api-client.js";
import type { SqlExecutor } from "../mirror.js";
export async function syncWarehouseEvents(
  exec: SqlExecutor,
  client: Pick<StationClient, "post">,
  owner: string,
  isCurrent: () => boolean,
): Promise<number> {
  const rows = await exec.all<{
    owner: string;
    event_id: string;
    event_json: string;
    digest: string;
  }>(
    `SELECT owner,event_id,event_json,digest FROM warehouse_reprint_events WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='pending'
      AND NOT EXISTS(SELECT 1 FROM outbox)
      AND NOT EXISTS(SELECT 1 FROM product_label_outbox)
      AND NOT EXISTS(SELECT 1 FROM boxes_mirror WHERE closed_at IS NOT NULL AND acked_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM box_exceptions_mirror)
      ORDER BY rowid LIMIT 100`,
    [owner],
  );
  if (!rows.length || !isCurrent()) return 0;
  const events = rows.map((row) => {
    const event = warehouseEventSchema.parse(JSON.parse(row.event_json));
    if (event.eventId !== row.event_id || productLabelValueDigest(event) !== row.digest)
      throw new Error("WAREHOUSE_EVENT_CORRUPT");
    return event;
  });
  const receipt = warehouseReceiptSchema.parse(
    await client.post("/station/warehouse-reprint/event-batches", {
      protocol: WAREHOUSE_REPRINT_PROTOCOL,
      events,
    }),
  );
  const ids = [...receipt.acceptedEventIds, ...receipt.quarantined.map((r) => r.eventId)];
  const expected = new Set(events.map((e) => e.eventId));
  if (
    ids.length !== events.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !expected.has(id))
  )
    throw new Error("WAREHOUSE_RECEIPT_MISMATCH");
  if (!isCurrent()) return 0;
  for (const row of rows) {
    if (!isCurrent()) return 0;
    const rejected = receipt.quarantined.find((q) => q.eventId === row.event_id);
    await exec.run(
      "UPDATE warehouse_reprint_events SET receive_status=?,rejection_code=? WHERE owner=? AND event_id=? AND digest=? AND receive_status='pending'",
      [
        rejected ? "quarantined" : "accepted",
        rejected?.code ?? null,
        row.owner,
        row.event_id,
        row.digest,
      ],
    );
  }
  return rows.length;
}
