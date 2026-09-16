import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

const workSchema = z.object({
  shifts: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      owner: z.string().nullable(),
      deviceId: z.string().nullable(),
    }),
  ),
  inventories: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      deviceId: z.string(),
      participantId: z.string(),
      pendingEventCount: z.number().int(),
      openBoxCount: z.number().int(),
      leftAt: z.string().nullable(),
    }),
  ),
  jobs: z.array(
    z.object({
      id: z.string(),
      deviceId: z.string(),
      latestSequence: z.number().int(),
      payloadDigest: z.string(),
      projection: z.unknown(),
    }),
  ),
  nativeEvidence: z.array(z.object({ id: z.string(), deviceId: z.string() })),
  quarantine: z.array(
    z.object({
      id: z.string(),
      deviceId: z.string(),
      batchId: z.string(),
      recordKind: z.string(),
      recordIndex: z.number().int(),
      payloadDigest: z.string(),
    }),
  ),
});

/** One PostgreSQL statement snapshot for work that does not share licensing
 * locks. The observation counts and its fingerprint use these same exact rows.
 * Native receipts are resolved only after finalized productive reconciliation
 * (applied or terminal rejection). Quarantine/not_applied/unknown stays blocking;
 * retained legacy native quarantine has no resolution marker and remains blocked.
 * Terminal inventory receipts may still have late-event quarantine; only its
 * explicit replayed/discarded resolution clears that retained recovery work.
 * Include all credential epochs: credential recovery must not hide pending work. */
export async function readDeviceLicensingWork(tx: SubscriptionTransaction, tenantId: string) {
  const result = await tx.execute(sql`select
    coalesce((select jsonb_agg(x order by x.id,x."deviceId") from (
      select distinct s.id,s.status,s.station_close_owner_device_id as owner,p.device_id as "deviceId"
      from shifts s left join shift_device_participants p on p.tenant_id=s.tenant_id and p.shift_id=s.id
      where s.tenant_id=${tenantId} and s.status<>'closed'
    ) x),'[]'::jsonb) as shifts,
    coalesce((select jsonb_agg(x order by x.id,x."participantId") from (
      select i.id,i.status,p.device_id as "deviceId",p.id as "participantId",p.pending_event_count as "pendingEventCount",p.open_box_count as "openBoxCount",p.left_at as "leftAt"
      from inventories i join inventory_device_participants p on p.tenant_id=i.tenant_id and p.inventory_id=i.id
      where i.tenant_id=${tenantId} and i.status not in ('completed','cancelled')
    ) x),'[]'::jsonb) as inventories,
    coalesce((select jsonb_agg(x order by x."deviceId",x.id) from (
      select job_id as id,device_id as "deviceId",latest_sequence as "latestSequence",payload_digest as "payloadDigest",projection
      from product_label_jobs where tenant_id=${tenantId}
    ) x),'[]'::jsonb) as jobs,
    coalesce((select jsonb_agg(x order by x.id) from (
      select id,terminal_id as "deviceId",batch_id as "batchId",record_kind as "recordKind",record_index as "recordIndex",payload_digest as "payloadDigest"
      from station_sync_quarantine where tenant_id=${tenantId}
    ) x),'[]'::jsonb) as quarantine,
    coalesce((select jsonb_agg(x order by x."deviceId",x.id) from (
      select id,station_device_id as "deviceId"
      from device_grant_ingest_receipts
      where tenant_id=${tenantId} and station_device_id is not null
        and not coalesce(finalized_at is not null
          and final_response->>'outcome' in ('accepted','duplicate')
          and final_response->'reconciliation'->>'status' in ('applied','rejected'), false)
      union all
      select id,station_device_id as "deviceId"
      from device_grant_evidence
      where tenant_id=${tenantId} and station_device_id is not null and disposition='quarantined'
      union all
      select id,device_id as "deviceId"
      from inventory_late_events
      where tenant_id=${tenantId} and resolution='pending'
    ) x),'[]'::jsonb) as "nativeEvidence"`);
  return workSchema.parse(result.rows[0]);
}
