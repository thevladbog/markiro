import { schema, type Db } from "@markiro/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

const base = { tenantId: z.string().min(1), workId: z.uuid(), stepId: z.string().min(1) };
const session = { ...base, sessionId: z.uuid() };
export const catalogJobSchema = z.discriminatedUnion("kind", [
  z.object({ ...session, kind: z.literal("enumerate"), stepId: z.uuid() }).strict(),
  z.object({ ...session, kind: z.literal("prepare"), stepId: z.uuid() }).strict(),
  z
    .object({
      ...session,
      kind: z.literal("candidate"),
      stepId: z.uuid(),
      previewId: z.uuid(),
      candidateId: z.uuid(),
    })
    .strict(),
  z.object({ ...base, kind: z.literal("apply"), stepId: z.literal("product") }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("accepted_image"),
      stepId: z.literal("image"),
      operationId: z.uuid(),
      previewId: z.uuid(),
    })
    .strict(),
  z.object({ ...base, kind: z.literal("refresh"), stepId: z.uuid() }).strict(),
]);
export type CatalogJob = z.infer<typeof catalogJobSchema>;

/** One bounded, serialized claim of dispatch attempts; never acknowledges source intent. */
export class NationalCatalogJobRepository {
  constructor(private readonly db: Db) {}
  async claim(limit = 100): Promise<CatalogJob[]> {
    return this.db.transaction(async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended('national-catalog-dispatch',0)) as locked`,
      );
      if (!lock.rows[0]?.locked) return [];
      const rows = await tx.execute<{ payload: unknown }>(sql`
        with work as (
          select s.tenant_id, 'enumerate' as kind, s.id as work_id, s.checkpoint->>'stepId' as step_id, s.started_at as created_at,
            jsonb_build_object('kind','enumerate','tenantId',s.tenant_id,'workId',s.id,'sessionId',s.id,'stepId',s.checkpoint->>'stepId') as payload,
            true as external
          from national_catalog_import_sessions s
          where s.expires_at > now() and s.state not in ('cancelled','expired') and s.checkpoint->>'enqueuePending'='true'
            and (s.checkpoint->>'nextRetryAt' is null or (s.checkpoint->>'nextRetryAt')::timestamptz <= now())
          union all
          select p.tenant_id,'prepare',p.id,p.checkpoint->>'stepId',p.created_at,
            jsonb_build_object('kind','prepare','tenantId',p.tenant_id,'workId',p.id,'sessionId',p.session_id,'stepId',p.checkpoint->>'stepId'),true
          from national_catalog_import_preparations p join national_catalog_import_sessions s on s.tenant_id=p.tenant_id and s.id=p.session_id
          where s.state not in ('cancelled','expired') and s.expires_at > now() and p.expires_at > now() and p.checkpoint->>'enqueuePending'='true'
            and (p.checkpoint->>'nextRetryAt' is null or (p.checkpoint->>'nextRetryAt')::timestamptz <= now())
          union all
          select i.tenant_id,'candidate',i.id,i.preparation_checkpoint->>'stepId',i.created_at,
            jsonb_build_object('kind','candidate','tenantId',i.tenant_id,'workId',i.id,'sessionId',i.session_id,'previewId',i.preview_id,'candidateId',i.candidate_id,'stepId',i.preparation_checkpoint->>'stepId'),true
          from national_catalog_import_images i join national_catalog_import_sessions s on s.tenant_id=i.tenant_id and s.id=i.session_id
          where s.state not in ('cancelled','expired') and s.expires_at > now() and i.expires_at > now() and i.preparation_checkpoint->>'enqueuePending'='true'
            and (i.preparation_checkpoint->>'nextRetryAt' is null or (i.preparation_checkpoint->>'nextRetryAt')::timestamptz <= now())
          union all
          select o.tenant_id,'apply',o.id,'product',o.created_at,
            jsonb_build_object('kind','apply','tenantId',o.tenant_id,'workId',o.id,'stepId','product'),false
          from national_catalog_import_operations o
          where o.cancelled_at is null and o.enqueue_pending and exists (
            select 1 from national_catalog_import_operation_items i where i.tenant_id=o.tenant_id and i.operation_id=o.id
              and (i.product_result='pending' or (i.product_result='failed' and i.error_code='infrastructure_failure' and i.attempts<4 and i.next_attempt_at<=now())))
          union all
          select i.tenant_id,'accepted_image',i.id,'image',i.created_at,
            jsonb_build_object('kind','accepted_image','tenantId',i.tenant_id,'workId',i.id,'operationId',i.operation_id,'previewId',i.preview_id,'stepId','image'),false
          from national_catalog_import_operation_items i join national_catalog_import_operations o on o.tenant_id=i.tenant_id and o.id=i.operation_id
          where o.cancelled_at is null and o.state<>'cancelled' and i.product_result='applied' and i.image_retry_eligible
            and (i.image_result='pending' or (i.image_result='failed' and i.image_attempts<4 and i.next_image_attempt_at<=now()))
            and (i.next_image_attempt_at is null or i.next_image_attempt_at<=now())
          union all
          select l.tenant_id,'refresh',l.id,l.refresh_checkpoint->>'stepId',l.confirmed_at,
            jsonb_build_object('kind','refresh','tenantId',l.tenant_id,'workId',l.id,'stepId',l.refresh_checkpoint->>'stepId'),true
          from national_catalog_product_links l join products p on p.tenant_id=l.tenant_id and p.id=l.product_id
          where l.closed_at is null and p.archived=false and l.refresh_checkpoint->>'enqueuePending'='true'
            and (l.refresh_checkpoint->>'nextRetryAt' is null or (l.refresh_checkpoint->>'nextRetryAt')::timestamptz<=now())
        ), due as (
          select w.*,coalesce(d.attempted_at,w.created_at) as dispatch_age
          from work w left join national_catalog_import_dispatch_attempts d
            on d.tenant_id=w.tenant_id and d.kind=w.kind and d.work_id=w.work_id and d.step_id=w.step_id
          where not w.external or not exists (select 1 from national_catalog_request_leases l where l.tenant_id=w.tenant_id and l.lease_until>now())
        ), tenants as (
          select due.tenant_id,coalesce((select max(a.attempted_at) from national_catalog_import_dispatch_attempts a where a.tenant_id=due.tenant_id),min(due.created_at)) as last_dispatch from due group by due.tenant_id
        ), ranked as (
          select due.*,tenants.last_dispatch,row_number() over(partition by due.tenant_id order by dispatch_age,created_at,kind,work_id,step_id) as rank
          from due join tenants using(tenant_id)
        ) select payload from ranked order by rank,last_dispatch,tenant_id,dispatch_age,created_at,kind,work_id,step_id limit ${Math.max(1, Math.min(100, limit))}
      `);
      const jobs = rows.rows.map((row) => catalogJobSchema.parse(row.payload));
      if (jobs.length)
        await tx
          .insert(schema.nationalCatalogImportDispatchAttempts)
          .values(
            jobs.map((job) => ({
              kind: job.kind,
              tenantId: job.tenantId,
              workId: job.workId,
              stepId: job.stepId,
              attemptedAt: sql`clock_timestamp()`,
            })),
          )
          .onConflictDoUpdate({
            target: [
              schema.nationalCatalogImportDispatchAttempts.kind,
              schema.nationalCatalogImportDispatchAttempts.tenantId,
              schema.nationalCatalogImportDispatchAttempts.workId,
              schema.nationalCatalogImportDispatchAttempts.stepId,
            ],
            set: { attemptedAt: sql`excluded.attempted_at` },
          });
      return jobs;
    });
  }
}
