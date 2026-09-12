import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import {
  DomainError,
  MAX_PRODUCT_LABEL_EVENTS,
  productLabelEventSchema,
  productLabelReceiptSchema,
  productLabelValueDigest,
  type ProductLabelEvent,
  type ProductLabelReceipt,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";

function invalidReceipt(): never {
  throw new DomainError(
    "PRODUCT_LABEL_RECEIPT_INVALID",
    "The product label receipt does not cover this request",
  );
}
export function validateProductLabelReceipt(
  sentEvents: ProductLabelEvent[],
  input: unknown,
): ProductLabelReceipt {
  const parsed = productLabelReceiptSchema.safeParse(input);
  if (!parsed.success) invalidReceipt();
  const sentIds = new Set(sentEvents.map((event) => event.eventId));
  const acknowledged = [
    ...parsed.data.acceptedEventIds,
    ...parsed.data.quarantined.map((record) => record.eventId),
  ];
  if (
    sentIds.size !== sentEvents.length ||
    acknowledged.length !== sentIds.size ||
    acknowledged.some((id) => !sentIds.has(id))
  )
    invalidReceipt();
  return parsed.data;
}

async function recordReceipts(
  exec: SqlExecutor,
  rows: Array<{ owner: string; eventId: string; eventJson: string; code: string | null }>,
  callerOwnership: string,
): Promise<void> {
  if (rows.length === 0) return;
  const receivedAt = new Date().toISOString();
  await exec.run(
    `INSERT INTO product_label_receipts(credential_ownership,event_id,event_json,outcome,rejection_code,received_at)
    SELECT * FROM (${rows.map(() => "SELECT ? AS credential_ownership,? AS event_id,? AS event_json,? AS outcome,? AS rejection_code,? AS received_at").join(" UNION ALL ")})
    WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})
    ON CONFLICT(credential_ownership,event_id) DO NOTHING`,
    [
      ...rows.flatMap((row) => [
        row.owner,
        row.eventId,
        row.eventJson,
        row.code === null ? "accepted" : "quarantined",
        row.code,
        receivedAt,
      ]),
      callerOwnership,
    ],
  );
}

export async function readPendingProductLabelEvents(
  exec: SqlExecutor,
  credentialOwnership: string,
  limit: number,
  ceiling: number | null,
  scanCeiling?: number,
): Promise<Array<{ id: number; event: ProductLabelEvent }>> {
  const rows = await exec.all<{
    id: number;
    event_id: string;
    job_id: string;
    sequence: number;
    event_json: string;
    credential_ownership: string;
  }>(
    `SELECT pending.credential_ownership,pending.id,event.event_id,event.job_id,event.sequence,event.event_json
     FROM product_label_outbox pending JOIN product_label_events event
       ON event.credential_ownership=pending.credential_ownership AND event.event_id=pending.event_id
     WHERE pending.credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND (? IS NULL OR pending.id<=?)
       ${scanCeiling === undefined ? "" : `AND NOT EXISTS (SELECT 1 FROM outbox scan WHERE scan.shift_id=json_extract(event.event_json,'$.shiftId') AND scan.code_hash=json_extract(event.event_json,'$.codeHash') AND scan.scanned_at=json_extract(event.event_json,'$.acceptedAt') AND scan.verdict='ok' AND scan.id>?)`}
     ORDER BY pending.id LIMIT ?`,
    [
      credentialOwnership,
      ceiling,
      ceiling,
      ...(scanCeiling === undefined ? [] : [scanCeiling]),
      Math.max(1, Math.min(MAX_PRODUCT_LABEL_EVENTS, limit)),
    ],
  );
  const result: Array<{ id: number; event: ProductLabelEvent }> = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.event_json);
    } catch {
      value = null;
    }
    const parsed = productLabelEventSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.eventId !== row.event_id ||
      parsed.data.jobId !== row.job_id ||
      parsed.data.sequence !== row.sequence
    ) {
      await recordReceipts(
        exec,
        [
          {
            owner: row.credential_ownership,
            eventId: row.event_id,
            eventJson: row.event_json,
            code: "storage_invalid",
          },
        ],
        credentialOwnership,
      );
      continue;
    }
    result.push({ id: row.id, event: parsed.data });
  }
  return result;
}

export async function ackProductLabelEvents(
  exec: SqlExecutor,
  credentialOwnership: string,
  sentEvents: ProductLabelEvent[],
  input: ProductLabelReceipt,
): Promise<void> {
  const receipt = validateProductLabelReceipt(sentEvents, input);
  if (sentEvents.length === 0) return;
  const rows = await exec.all<{
    event_id: string;
    event_json: string;
    credential_ownership: string;
  }>(
    `SELECT credential_ownership,event_id,event_json FROM product_label_events WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND event_id IN (${sentEvents.map(() => "?").join(",")})`,
    [credentialOwnership, ...sentEvents.map((event) => event.eventId)],
  );
  const byId = new Map(rows.map((row) => [row.event_id, row]));
  const rejected = new Map(receipt.quarantined.map((record) => [record.eventId, record.code]));
  const acknowledgements = sentEvents.map((event) => {
    const stored = byId.get(event.eventId);
    if (!stored) invalidReceipt();
    const eventJson = stored.event_json;
    let saved: unknown;
    try {
      saved = JSON.parse(eventJson);
    } catch {
      invalidReceipt();
    }
    const parsed = productLabelEventSchema.safeParse(saved);
    if (!parsed.success || productLabelValueDigest(parsed.data) !== productLabelValueDigest(event))
      invalidReceipt();
    return {
      owner: stored.credential_ownership,
      eventId: event.eventId,
      eventJson,
      code: rejected.get(event.eventId) ?? null,
    };
  });
  await recordReceipts(exec, acknowledgements, credentialOwnership);
}

export function productLabelSetSignature(events: ProductLabelEvent[]): string {
  return productLabelValueDigest(events);
}

export async function productLabelPendingStats(
  exec: SqlExecutor,
  owner: string,
): Promise<{ count: number; oldest: string | null }> {
  const [row] = await exec.all<{ count: number; oldest: string | null }>(
    `SELECT COUNT(*) AS count,MIN(queued_at) AS oldest FROM product_label_outbox WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})`,
    [owner],
  );
  return row ?? { count: 0, oldest: null };
}
