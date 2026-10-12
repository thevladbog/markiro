import { z } from "zod";
import {
  PALLET_REPRINT_PROTOCOL,
  palletLabelSourceSchema,
  palletReprintEventSchema,
  palletSourcesReceiptSchema,
  palletEventsReceiptSchema,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import type { StationClient } from "../api-client.js";
import { StationApiError } from "../api-client.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
/** Sources precede events. Only immutable, acknowledged prefixes leave the queue. */
export async function syncWarehousePallets(
  exec: SqlExecutor,
  client: Pick<StationClient, "post"> & Partial<Pick<StationClient, "get">>,
  owner: string,
  isCurrent: () => boolean,
) {
  if (!client.get || !isCurrent()) return 0;
  const sources = await exec.all<{ owner: string; sscc: string; value_json: string }>(
    `SELECT owner,sscc,value_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='pending' AND NOT EXISTS(SELECT 1 FROM outbox) ORDER BY last_tried_at,rowid LIMIT 1`,
    [owner],
  );
  const events = await exec.all<{ owner: string; event_id: string; value_json: string }>(
    `SELECT owner,event_id,value_json FROM warehouse_pallet_events WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='pending' ORDER BY rowid LIMIT 100`,
    [owner],
  );
  if (!sources.length && !events.length) return 0;
  try {
    const caps = z
      .strictObject({ protocols: z.array(z.string()) })
      .parse(await client.get("/station/warehouse-reprint/source-capabilities"));
    if (!caps.protocols.includes(PALLET_REPRINT_PROTOCOL)) return 0;
  } catch (error) {
    if (error instanceof StationApiError && error.status === 404) return 0;
    throw error;
  }
  if (!isCurrent()) return 0;
  let acknowledged = 0;
  if (sources.length) {
    const entries = sources.map((row) => palletLabelSourceSchema.parse(JSON.parse(row.value_json)));
    const receipt = palletSourcesReceiptSchema.parse(
      await client.post("/station/warehouse-reprint/pallet-sources", {
        protocol: PALLET_REPRINT_PROTOCOL,
        entries,
      }),
    );
    if (
      receipt.results.length !== entries.length ||
      receipt.results[0]?.revision !== entries[0]?.revision
    )
      throw new Error("WAREHOUSE_PALLET_RECEIPT_MISMATCH");
    for (const [index, row] of sources.entries()) {
      const result = receipt.results[index];
      if (!isCurrent()) return acknowledged;
      if (!result) continue;
      if (result.status === "retryable") {
        await exec.run(
          "UPDATE warehouse_pallet_sources SET last_tried_at=? WHERE owner=? AND sscc=? AND receive_status='pending'",
          [new Date().toISOString(), row.owner, row.sscc],
        );
        continue;
      }
      await exec.run(
        "UPDATE warehouse_pallet_sources SET receive_status=? WHERE owner=? AND sscc=? AND receive_status='pending'",
        [result.status, row.owner, row.sscc],
      );
      acknowledged++;
    }
  }
  if (!isCurrent() || !events.length) return acknowledged;
  const entries = events.map((row) => palletReprintEventSchema.parse(JSON.parse(row.value_json)));
  const receipt = palletEventsReceiptSchema.parse(
    await client.post("/station/warehouse-reprint/pallet-events", {
      protocol: PALLET_REPRINT_PROTOCOL,
      entries,
    }),
  );
  if (
    receipt.results.length !== entries.length ||
    new Set(receipt.results.map((r) => r.eventId)).size !== entries.length ||
    receipt.results.some((r) => !entries.some((e) => e.eventId === r.eventId))
  )
    throw new Error("WAREHOUSE_PALLET_RECEIPT_MISMATCH");
  for (const row of events) {
    if (!isCurrent()) return acknowledged;
    const result = receipt.results.find((r) => r.eventId === row.event_id);
    if (!result || result.status === "retryable") continue;
    await exec.run(
      "UPDATE warehouse_pallet_events SET receive_status=? WHERE owner=? AND event_id=? AND receive_status='pending'",
      [result.status, row.owner, row.event_id],
    );
    acknowledged++;
  }
  return acknowledged;
}

/** Large rasters may expire only after explicit resolution and complete event acceptance. */
export async function purgeWarehousePalletJobs(exec: SqlExecutor, owner: string, before: string) {
  await exec.run(
    `DELETE FROM warehouse_pallet_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND state IN ('verified','skipped') AND json_extract(event_json,'$.occurredAt')<?
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_events e WHERE e.owner=warehouse_pallet_jobs.owner AND json_extract(e.value_json,'$.jobId')=warehouse_pallet_jobs.job_id AND e.receive_status<>'accepted')
 AND NOT EXISTS(SELECT 1 FROM printer_deliveries d WHERE d.scope=json_array('warehouse-pallet',warehouse_pallet_jobs.owner,warehouse_pallet_jobs.job_id) AND d.resolved_at IS NULL AND d.state IN ('prepared','sending','delivery_unknown'))`,
    [owner, before],
  );
}
