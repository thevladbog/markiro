import { schema } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import type { NationalCatalogImportRepository } from "./national-catalog-import.repository";
import { parseCheckpoint } from "./national-catalog-enumeration";
import { parsePreparationCheckpoint } from "./national-catalog-preparation-state";

/** Bounded independently per record kind. Identity and immutable accepted evidence survive. */
export async function releaseExpiredImportPayloads(
  repository: NationalCatalogImportRepository,
  now: Date,
  limit: number,
): Promise<number> {
  const bound = Math.min(500, Math.max(1, Math.trunc(limit)));
  const candidates = await repository.transaction(async (tx) => {
    const result = await tx.execute<{
      kind: string;
      id: string;
      tenantId: string;
      sessionId: string;
    }>(sql`
      (select 'session' as kind,s.id,s.tenant_id as "tenantId",s.id as "sessionId"
       from national_catalog_import_sessions s where s.expires_at <= ${now.toISOString()}::timestamptz
       and (s.state not in ('expired','cancelled') or s.interval_stack is not null or s.cursor is not null
         or coalesce(jsonb_array_length(s.checkpoint->'work'),0)>0 or coalesce(jsonb_array_length(s.checkpoint->'failures'),0)>0
         or s.checkpoint->>'enqueuePending'='true') order by s.expires_at,s.id limit ${bound})
      union all
      (select 'item',i.id,i.tenant_id,i.session_id from national_catalog_import_items i
       join national_catalog_import_sessions s on s.tenant_id=i.tenant_id and s.id=i.session_id
       where s.expires_at <= ${now.toISOString()}::timestamptz and
       (i.input is not null or i.source is not null or i.name is not null or i.brand is not null or i.raw_status is not null
        or cardinality(i.raw_detailed_statuses)>0 or cardinality(i.status_keys)>0 or i.reason is not null)
       order by s.expires_at,i.id limit ${bound})
      union all
      (select 'preparation',p.id,p.tenant_id,p.session_id from national_catalog_import_preparations p
       join national_catalog_import_sessions s on s.tenant_id=p.tenant_id and s.id=p.session_id
       where s.expires_at <= ${now.toISOString()}::timestamptz and p.request <> '{}'::jsonb
       order by p.expires_at,p.id limit ${bound})
      union all
      (select 'receipt',i.id,i.tenant_id,i.session_id from national_catalog_import_operation_items i
       join national_catalog_import_sessions s on s.tenant_id=i.tenant_id and s.id=i.session_id
       where s.expires_at <= ${now.toISOString()}::timestamptz and i.product_result <> 'applied'
       and (i.image_retry_eligible or i.product_result='pending' or (i.product_result='failed' and i.error_code='infrastructure_failure'))
       order by s.expires_at,i.id limit ${bound})
    `);
    return result.rows;
  });
  for (const candidate of candidates)
    await repository.transaction(async (tx) => {
      const session = await repository.lock(tx, candidate.tenantId, candidate.sessionId);
      if (session.expiresAt > now) return;
      if (candidate.kind === "session") {
        await repository.save(tx, session, {
          state: session.state === "cancelled" ? "cancelled" : "expired",
          intervalStack: null,
          cursor: null,
          checkpoint: {
            ...parseCheckpoint(session.checkpoint),
            work: [],
            failures: [],
            phase: "done",
            state: "done",
            runId: null,
            nextRetryAt: null,
            enqueuePending: false,
          },
        });
      } else if (candidate.kind === "item") {
        const items = schema.nationalCatalogImportItems;
        await tx
          .update(items)
          .set({
            input: null,
            source: null,
            name: null,
            brand: null,
            rawStatus: null,
            rawDetailedStatuses: [],
            statusKeys: [],
            reason: null,
          })
          .where(
            and(
              eq(items.tenantId, candidate.tenantId),
              eq(items.sessionId, session.id),
              eq(items.id, candidate.id),
            ),
          );
      } else if (candidate.kind === "preparation") {
        const preparations = schema.nationalCatalogImportPreparations;
        const [row] = await tx
          .select()
          .from(preparations)
          .where(
            and(eq(preparations.tenantId, candidate.tenantId), eq(preparations.id, candidate.id)),
          )
          .for("update");
        if (!row) return;
        await tx
          .update(preparations)
          .set({
            request: {},
            checkpoint: {
              ...parsePreparationCheckpoint(row.checkpoint),
              work: [],
              completed: [],
              failures: [],
              state: "done",
              reason: null,
              runId: null,
              nextRetryAt: null,
              enqueuePending: false,
            },
            updatedAt: now,
          })
          .where(and(eq(preparations.tenantId, candidate.tenantId), eq(preparations.id, row.id)));
      } else {
        const receipts = schema.nationalCatalogImportOperationItems;
        const operations = schema.nationalCatalogImportOperations;
        const [initial] = await tx
          .select()
          .from(receipts)
          .where(and(eq(receipts.tenantId, candidate.tenantId), eq(receipts.id, candidate.id)));
        if (!initial) return;
        const [operation] = await tx
          .select()
          .from(operations)
          .where(
            and(
              eq(operations.tenantId, candidate.tenantId),
              eq(operations.id, initial.operationId),
            ),
          )
          .for("update");
        const [row] = await tx
          .select()
          .from(receipts)
          .where(and(eq(receipts.tenantId, candidate.tenantId), eq(receipts.id, candidate.id)))
          .for("update");
        if (!row || !operation || row.productResult === "applied") return;
        const unfinished =
          row.productResult === "pending" ||
          (row.productResult === "failed" && row.errorCode === "infrastructure_failure");
        await tx
          .update(receipts)
          .set({
            ...(unfinished
              ? { productResult: "failed" as const, errorCode: "import_session_closed" }
              : {}),
            ...(row.imageResult === "pending"
              ? { imageResult: "failed" as const, imageErrorCode: "product_not_applied" }
              : {}),
            imageRetryEligible: false,
            nextAttemptAt: null,
            nextImageAttemptAt: null,
            updatedAt: now,
          })
          .where(and(eq(receipts.tenantId, candidate.tenantId), eq(receipts.id, row.id)));
        if (unfinished)
          await tx.insert(schema.tenantAuditEvents).values({
            organizationId: candidate.tenantId,
            actorUserId: operation.actorId,
            action: "national_catalog.import.item_failed",
            outcome: "failure",
            targetType: row.productId ? "product" : "national_catalog_import_preview",
            targetId: row.productId ?? row.previewId,
            before: null,
            after: {
              operationId: operation.id,
              previewId: row.previewId,
              result: "failed",
              reason: "import_session_closed",
            },
          });
        const remaining = await tx
          .select()
          .from(receipts)
          .where(
            and(eq(receipts.tenantId, candidate.tenantId), eq(receipts.operationId, operation.id)),
          );
        if (
          operation.state !== "cancelled" &&
          !remaining.some(
            (r) =>
              r.productResult === "pending" ||
              r.nextAttemptAt ||
              (r.productResult === "applied" &&
                (r.imageResult === "pending" || r.nextImageAttemptAt)),
          )
        )
          await tx
            .update(operations)
            .set({ state: "finished", enqueuePending: false, finishedAt: now, updatedAt: now })
            .where(
              and(eq(operations.tenantId, candidate.tenantId), eq(operations.id, operation.id)),
            );
      }
    });
  return candidates.length;
}
