import { recoverLegacyProductionPalletDeliveries } from "./production-delivery.js";
import { z } from "zod";
import {
  UNIFIED_REPRINT_PROTOCOL,
  palletDataSchema,
  palletDataReceiptSchema,
  PALLET_REPRINT_PROTOCOL,
  PALLET_PRODUCTION_DELIVERY_PROTOCOL,
  palletProductionDeliverySchema,
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
  await recoverLegacyProductionPalletDeliveries(exec, owner);
  if (!isCurrent()) return 0;
  const sources = await exec.all<{
    owner: string;
    sscc: string;
    value_json: string;
    production_delivery_json: string | null;
  }>(
    `SELECT owner,sscc,value_json,production_delivery_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND (receive_status='pending' OR (receive_status='accepted' AND COALESCE(json_extract(production_delivery_json,'$.sequence'),0)>production_delivery_acked_sequence)) AND NOT EXISTS(SELECT 1 FROM outbox) ORDER BY last_tried_at,rowid LIMIT 1`,
    [owner],
  );
  const events = await exec.all<{ owner: string; event_id: string; value_json: string }>(
    `SELECT owner,event_id,value_json FROM warehouse_pallet_events WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='pending' AND json_extract(value_json,'$.renderingRevision') IS NULL ORDER BY last_tried_at,rowid LIMIT 100`,
    [owner],
  );
  if (!sources.length && !events.length) return 0;
  let supportsProductionDelivery: boolean;
  let supportsData: boolean;
  try {
    const caps = z
      .strictObject({ protocols: z.array(z.string()) })
      .parse(await client.get("/station/warehouse-reprint/source-capabilities"));
    if (!caps.protocols.includes(PALLET_REPRINT_PROTOCOL)) return 0;
    supportsProductionDelivery = caps.protocols.includes(PALLET_PRODUCTION_DELIVERY_PROTOCOL);
    supportsData = caps.protocols.includes(UNIFIED_REPRINT_PROTOCOL);
  } catch (error) {
    if (error instanceof StationApiError && error.status === 404) return 0;
    throw error;
  }
  if (!isCurrent()) return 0;
  let acknowledged = 0;
  const dataOnly = sources[0]
    ? z.object({ version: z.number() }).parse(JSON.parse(sources[0].value_json)).version === 3
    : false;
  const supportedSource =
    (!dataOnly || supportsData) &&
    (!sources[0]?.production_delivery_json ||
      supportsProductionDelivery ||
      (dataOnly && supportsData));
  if (sources.length && !supportedSource) {
    await exec.run(
      "UPDATE warehouse_pallet_sources SET last_tried_at=? WHERE owner=? AND sscc=? AND receive_status<>'conflict'",
      [new Date().toISOString(), sources[0]?.owner, sources[0]?.sscc],
    );
  }
  if (sources.length && supportedSource) {
    const entries = sources.map((row) =>
      (dataOnly ? palletDataSchema : palletLabelSourceSchema).parse(JSON.parse(row.value_json)),
    );
    const receipt = (dataOnly ? palletDataReceiptSchema : palletSourcesReceiptSchema).parse(
      await client.post(
        dataOnly
          ? "/station/warehouse-reprint/pallet-data-v3"
          : "/station/warehouse-reprint/pallet-sources",
        {
          protocol: dataOnly ? UNIFIED_REPRINT_PROTOCOL : PALLET_REPRINT_PROTOCOL,
          entries,
          ...(sources[0]?.production_delivery_json
            ? {
                productionDelivery: palletProductionDeliverySchema.parse(
                  JSON.parse(sources[0].production_delivery_json),
                ),
              }
            : {}),
        },
      ),
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
          "UPDATE warehouse_pallet_sources SET last_tried_at=? WHERE owner=? AND sscc=? AND receive_status<>'conflict'",
          [new Date().toISOString(), row.owner, row.sscc],
        );
        continue;
      }
      await exec.run(
        "UPDATE warehouse_pallet_sources SET receive_status=?,production_delivery_acked_sequence=CASE WHEN production_delivery_json IS ? AND ?='accepted' THEN COALESCE(json_extract(production_delivery_json,'$.sequence'),0) ELSE production_delivery_acked_sequence END WHERE owner=? AND sscc=? AND receive_status<>'conflict'",
        [result.status, row.production_delivery_json, result.status, row.owner, row.sscc],
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
    if (!result) continue;
    if (result.status === "retryable") {
      await exec.run(
        "UPDATE warehouse_pallet_events SET last_tried_at=? WHERE owner=? AND event_id=? AND receive_status='pending'",
        [new Date().toISOString(), row.owner, row.event_id],
      );
      continue;
    }
    await exec.run(
      "UPDATE warehouse_pallet_events SET receive_status=? WHERE owner=? AND event_id=? AND receive_status='pending'",
      [result.status, row.owner, row.event_id],
    );
    acknowledged++;
  }
  return acknowledged;
}

/** Large rasters and metadata share acknowledgement-aware closed-history retention. */
export { purgeWarehousePalletHistory as purgeWarehousePalletJobs } from "./history-retention.js";
