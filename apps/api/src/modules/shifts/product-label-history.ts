import { BadRequestException, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  productLabelHistorySchema,
  productLabelEventHistorySchema,
  type ProductLabelHistory,
  type ProductLabelEventHistory,
} from "@markiro/domain";

export const productLabelHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
export const productLabelEventsQuerySchema = z.strictObject({
  afterSequence: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  deviceId: z.uuid().optional(),
});
export type ProductLabelHistoryQuery = z.infer<typeof productLabelHistoryQuerySchema>;
export type ProductLabelEventsQuery = z.infer<typeof productLabelEventsQuerySchema>;
const cursorSchema = z.strictObject({
  acceptedAt: z.iso.datetime(),
  jobId: z.uuid(),
  deviceId: z.uuid(),
});
function cursorOf(raw: string | undefined) {
  if (raw === undefined) return null;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new BadRequestException("Invalid product label history cursor");
  }
}
function assertId(id: string) {
  if (!z.uuid().safeParse(id).success) throw new NotFoundException("Shift not found");
}

export async function readProductLabelHistory(
  db: Db,
  tenantId: string,
  shiftId: string,
  query: ProductLabelHistoryQuery,
): Promise<ProductLabelHistory> {
  assertId(shiftId);
  const cursor = cursorOf(query.cursor);
  return db.transaction(
    async (tx) => {
      const [shift] = await tx
        .select({ id: schema.shifts.id })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));
      if (!shift) throw new NotFoundException("Shift not found");
      const summary = await tx.execute(sql`
   SELECT
    (SELECT count(DISTINCT (event.device_id,event.event->>'attemptId'))::int FROM product_label_events event JOIN product_label_jobs job ON job.tenant_id=event.tenant_id AND job.device_id=event.device_id AND job.job_id=event.job_id WHERE job.tenant_id=${tenantId} AND job.shift_id=${shiftId} AND event.receive_status='accepted' AND event.event->>'kind'='sent') AS "sentAttempts",
    (SELECT count(DISTINCT (event.device_id,event.event->>'attemptId'))::int FROM product_label_events event JOIN product_label_jobs job ON job.tenant_id=event.tenant_id AND job.device_id=event.device_id AND job.job_id=event.job_id WHERE job.tenant_id=${tenantId} AND job.shift_id=${shiftId} AND event.receive_status='accepted' AND event.event->>'kind'='verified') AS "verifiedAttempts",
    (SELECT count(*)::int FROM product_label_jobs job WHERE job.tenant_id=${tenantId} AND job.shift_id=${shiftId} AND job.projection->>'status'<>'completed') AS "unresolvedJobs",
    (SELECT count(DISTINCT (event.device_id,event.event->>'attemptId'))::int FROM product_label_events event JOIN product_label_jobs job ON job.tenant_id=event.tenant_id AND job.device_id=event.device_id AND job.job_id=event.job_id WHERE job.tenant_id=${tenantId} AND job.shift_id=${shiftId} AND event.receive_status='accepted' AND event.event->>'kind'='prepared' AND (event.event->>'attemptNo')::bigint>1) AS "reprintAttempts"
  `);
      const rows = await tx.execute<{
        jobId: string;
        deviceId: string;
        codeSuffix: string;
        acceptedAt: string;
        status: unknown;
        verificationOutcome: unknown;
        attemptNo: number;
        ownershipConflict: boolean;
      }>(sql`
   SELECT job.job_id AS "jobId",job.device_id AS "deviceId",COALESCE(right(code.serial,6),'') AS "codeSuffix",job.accepted_at AS "acceptedAt",
     job.projection->>'status' AS status,job.projection->>'verificationOutcome' AS "verificationOutcome",(job.projection->>'attemptNo')::int AS "attemptNo",
     (EXISTS (SELECT 1 FROM code_conflicts conflict WHERE conflict.tenant_id=job.tenant_id AND conflict.losing_shift_id=job.shift_id AND conflict.losing_terminal_id=job.device_id::text AND conflict.code_hash=job.code_hash AND conflict.losing_scanned_at=job.accepted_at) OR EXISTS (SELECT 1 FROM station_sync_quarantine denied WHERE denied.tenant_id=job.tenant_id AND denied.terminal_id=job.device_id AND denied.shift_id=job.shift_id AND denied.record_kind='product_label_event' AND denied.reason='ownership_conflict' AND denied.payload->>'jobId'=job.job_id::text)) AS "ownershipConflict"
   FROM product_label_jobs job
   LEFT JOIN codes code ON code.tenant_id=job.tenant_id AND code.shift_id=job.shift_id AND code.code_hash=job.code_hash AND code.scanned_at=job.accepted_at
   WHERE job.tenant_id=${tenantId} AND job.shift_id=${shiftId}
   ${cursor ? sql`AND (job.accepted_at,job.job_id,job.device_id)<(${cursor.acceptedAt}::timestamptz,${cursor.jobId}::uuid,${cursor.deviceId}::uuid)` : sql``}
   ORDER BY job.accepted_at DESC,job.job_id DESC,job.device_id DESC LIMIT ${query.limit + 1}
  `);
      const items = rows.rows
        .slice(0, query.limit)
        .map((row) => ({ ...row, acceptedAt: new Date(row.acceptedAt).toISOString() }));
      const last = items.at(-1);
      const nextCursor =
        rows.rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({
                acceptedAt: last.acceptedAt,
                jobId: last.jobId,
                deviceId: last.deviceId,
              }),
            ).toString("base64url")
          : null;
      return productLabelHistorySchema.parse({ summary: summary.rows[0], items, nextCursor });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function readProductLabelEventHistory(
  db: Db,
  tenantId: string,
  shiftId: string,
  jobId: string,
  query: ProductLabelEventsQuery,
): Promise<ProductLabelEventHistory> {
  assertId(shiftId);
  assertId(jobId);
  return db.transaction(
    async (tx) => {
      const jobs = await tx
        .select({ deviceId: schema.productLabelJobs.deviceId })
        .from(schema.productLabelJobs)
        .where(
          and(
            eq(schema.productLabelJobs.tenantId, tenantId),
            eq(schema.productLabelJobs.shiftId, shiftId),
            eq(schema.productLabelJobs.jobId, jobId),
            query.deviceId ? eq(schema.productLabelJobs.deviceId, query.deviceId) : undefined,
          ),
        )
        .limit(2);
      const job = jobs[0];
      if (!job || jobs.length !== 1) throw new NotFoundException("Label job not found");
      const result = await tx.execute<{ event: unknown; sequence: number }>(
        sql`SELECT event,sequence FROM product_label_events WHERE tenant_id=${tenantId} AND device_id=${job.deviceId} AND job_id=${jobId} AND receive_status='accepted' AND sequence>${query.afterSequence} ORDER BY sequence LIMIT ${query.limit + 1}`,
      );
      const rows = result.rows.slice(0, query.limit);
      const last = rows.at(-1);
      return productLabelEventHistorySchema.parse({
        items: rows.map((row) => row.event),
        nextSequence: result.rows.length > query.limit && last ? Number(last.sequence) : null,
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
