import { z } from "zod";
import {
  PALLET_REPRINT_V2_PROTOCOL,
  PALLET_PRODUCTION_RESOLUTION_PROTOCOL,
  palletRenderingV2Schema,
  palletRenderingsV2ReceiptSchema,
  palletReprintEventV2Schema,
  palletEventsV2ReceiptSchema,
  palletProductionResolutionSchema,
  palletProductionResolutionsReceiptSchema,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import { StationApiError, type StationClient } from "../api-client.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
async function supports(client: Partial<Pick<StationClient, "get">>, protocol: string) {
  if (!client.get) return false;
  try {
    return z
      .strictObject({ protocols: z.array(z.string()) })
      .parse(await client.get("/station/warehouse-reprint/source-capabilities"))
      .protocols.includes(protocol);
  } catch (e) {
    if (e instanceof StationApiError && e.status === 404) return false;
    throw e;
  }
}
/** V2 snapshots precede their events. Old endpoints never receive V2 records. */
export async function syncWarehousePalletV2(
  exec: SqlExecutor,
  client: Pick<StationClient, "post"> & Partial<Pick<StationClient, "get">>,
  owner: string,
  current: () => boolean,
) {
  if (!current() || !client.get) return 0;
  const [pending] = await exec.all(
    `SELECT 1 FROM warehouse_pallet_renderings WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='pending' UNION SELECT 1 FROM warehouse_pallet_events WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='pending' AND json_extract(value_json,'$.renderingRevision') IS NOT NULL LIMIT 1`,
    [owner, owner],
  );
  if (!pending || !(await supports(client, PALLET_REPRINT_V2_PROTOCOL)) || !current()) return 0;
  let ack = 0;
  const rows = await exec.all<{
    owner: string;
    job_id: string;
    value_json: string;
    event_json: string;
  }>(
    `SELECT r.owner,r.job_id,r.value_json,j.event_json FROM warehouse_pallet_renderings r JOIN warehouse_pallet_jobs j ON j.owner=r.owner AND j.job_id=r.job_id WHERE r.owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND r.receive_status='pending' ORDER BY r.last_tried_at,r.rowid LIMIT 1`,
    [owner],
  );
  for (const row of rows) {
    const rendering = palletRenderingV2Schema.parse(JSON.parse(row.value_json)),
      event = palletReprintEventV2Schema.parse(JSON.parse(row.event_json));
    const receipt = palletRenderingsV2ReceiptSchema.parse(
      await client.post("/station/warehouse-reprint/pallet-renderings-v2", {
        protocol: PALLET_REPRINT_V2_PROTOCOL,
        entries: [{ jobId: row.job_id, operatorId: event.operatorId, rendering }],
      }),
    );
    if (
      receipt.results.length !== 1 ||
      receipt.results[0]?.jobId !== row.job_id ||
      receipt.results[0]?.renderingRevision !== rendering.renderingRevision
    )
      throw new Error("WAREHOUSE_PALLET_RECEIPT_MISMATCH");
    if (!current()) return ack;
    const result = receipt.results[0];
    await exec.run(
      "UPDATE warehouse_pallet_renderings SET receive_status=?,last_tried_at=? WHERE owner=? AND job_id=? AND receive_status='pending'",
      [
        result.status === "retryable" ? "pending" : result.status,
        new Date().toISOString(),
        row.owner,
        row.job_id,
      ],
    );
    if (result.status !== "retryable") ack++;
  }
  const events = await exec.all<{ owner: string; event_id: string; value_json: string }>(
    `SELECT e.owner,e.event_id,e.value_json FROM warehouse_pallet_events e JOIN warehouse_pallet_renderings r ON r.owner=e.owner AND r.job_id=json_extract(e.value_json,'$.jobId') WHERE e.owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND e.receive_status='pending' AND r.receive_status='accepted' AND json_extract(e.value_json,'$.renderingRevision') IS NOT NULL ORDER BY e.last_tried_at,e.rowid LIMIT 100`,
    [owner],
  );
  if (!events.length || !current()) return ack;
  const entries = events.map((r) => palletReprintEventV2Schema.parse(JSON.parse(r.value_json))),
    receipt = palletEventsV2ReceiptSchema.parse(
      await client.post("/station/warehouse-reprint/pallet-events-v2", {
        protocol: PALLET_REPRINT_V2_PROTOCOL,
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
    if (!current()) return ack;
    const result = receipt.results.find((r) => r.eventId === row.event_id);
    if (!result) continue;
    await exec.run(
      "UPDATE warehouse_pallet_events SET receive_status=?,last_tried_at=? WHERE owner=? AND event_id=? AND receive_status='pending'",
      [
        result.status === "retryable" ? "pending" : result.status,
        new Date().toISOString(),
        row.owner,
        row.event_id,
      ],
    );
    if (result.status !== "retryable") ack++;
  }
  return ack;
}
export async function syncPalletProductionResolutions(
  exec: SqlExecutor,
  client: Pick<StationClient, "post"> & Partial<Pick<StationClient, "get">>,
  owner: string,
  current: () => boolean,
) {
  if (!current() || !client.get) return 0;
  const rows = await exec.all<{ owner: string; event_id: string; value_json: string }>(
    `SELECT owner,event_id,value_json FROM warehouse_pallet_production_resolutions WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='pending' ORDER BY last_tried_at,rowid LIMIT 100`,
    [owner],
  );
  if (
    !rows.length ||
    !(await supports(client, PALLET_PRODUCTION_RESOLUTION_PROTOCOL)) ||
    !current()
  )
    return 0;
  const entries = rows.map((r) => palletProductionResolutionSchema.parse(JSON.parse(r.value_json))),
    receipt = palletProductionResolutionsReceiptSchema.parse(
      await client.post("/station/warehouse-reprint/pallet-production-resolutions", {
        protocol: PALLET_PRODUCTION_RESOLUTION_PROTOCOL,
        entries,
      }),
    );
  if (
    receipt.results.length !== entries.length ||
    new Set(receipt.results.map((r) => r.eventId)).size !== entries.length ||
    receipt.results.some((r) => !entries.some((e) => e.eventId === r.eventId))
  )
    throw new Error("WAREHOUSE_PALLET_RECEIPT_MISMATCH");
  let ack = 0;
  for (const row of rows) {
    if (!current()) return ack;
    const result = receipt.results.find((r) => r.eventId === row.event_id);
    if (!result) continue;
    await exec.run(
      "UPDATE warehouse_pallet_production_resolutions SET receive_status=?,last_tried_at=? WHERE owner=? AND event_id=? AND receive_status='pending'",
      [
        result.status === "retryable" ? "pending" : result.status,
        new Date().toISOString(),
        row.owner,
        row.event_id,
      ],
    );
    if (result.status !== "retryable") ack++;
  }
  return ack;
}
