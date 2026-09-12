import { randomBytes } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@markiro/db";
import {
  VALIDATION_REPROCESSING_PROTOCOL,
  validationCodeHistorySchema,
  type ValidationCodeHistoryQuery,
} from "@markiro/domain";

const SNAPSHOT_TTL_MS = 60 * 60 * 1000;

/** First page publishes one immutable snapshot; later pages remain stable while production continues. */
export async function loadValidationCodeHistory(
  db: Db,
  tenantId: string,
  deviceId: string,
  shiftId: string,
  query: ValidationCodeHistoryQuery,
) {
  if (!z.uuid().safeParse(shiftId).success) throw new NotFoundException();
  if (!query.snapshot) {
    // Cleanup uses read-committed row arbitration, outside the repeatable-read source snapshot.
    await db.execute(
      sql`delete from validation_history_snapshots where tenant_id = ${tenantId} and snapshot_id in (select snapshot_id from validation_history_snapshots where tenant_id = ${tenantId} and expires_at < ${new Date()} order by expires_at limit 20 for update skip locked)`,
    );
  }
  return db.transaction(
    async (tx) => {
      const [shift] = await tx
        .select({ productId: schema.shifts.productId })
        .from(schema.shifts)
        .innerJoin(
          schema.shiftDeviceParticipants,
          and(
            eq(schema.shiftDeviceParticipants.tenantId, schema.shifts.tenantId),
            eq(schema.shiftDeviceParticipants.shiftId, schema.shifts.id),
            eq(schema.shiftDeviceParticipants.deviceId, deviceId),
          ),
        )
        .where(
          and(
            eq(schema.shifts.tenantId, tenantId),
            eq(schema.shifts.id, shiftId),
            eq(schema.shifts.mode, "validation"),
          ),
        );
      if (!shift) throw new NotFoundException();
      const now = new Date();
      let snapshot: typeof schema.validationHistorySnapshots.$inferSelect;
      if (query.snapshot) {
        const [existing] = await tx
          .select()
          .from(schema.validationHistorySnapshots)
          .where(
            and(
              eq(schema.validationHistorySnapshots.tenantId, tenantId),
              eq(schema.validationHistorySnapshots.snapshotId, query.snapshot),
              eq(schema.validationHistorySnapshots.shiftId, shiftId),
              eq(schema.validationHistorySnapshots.deviceId, deviceId),
              eq(schema.validationHistorySnapshots.productId, shift.productId),
            ),
          );
        if (!existing || existing.expiresAt <= now)
          throw new ConflictException({ code: "VALIDATION_HISTORY_EXPIRED" });
        snapshot = existing;
      } else {
        snapshot = {
          tenantId,
          snapshotId: randomBytes(32).toString("hex"),
          deviceId,
          shiftId,
          productId: shift.productId,
          fetchedAt: now,
          expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS),
        };
        await tx.insert(schema.validationHistorySnapshots).values(snapshot);
        // Postgres copies rows directly from a single MVCC snapshot; application memory stays page bounded.
        await tx.execute(sql`with history as (
        select r.code_hash, 'original'::text as kind, s.id as shift_id, s.status::text as shift_status,
          s.number_month_key, s.number_seq, s.created_from::text, r.scanned_at
        from code_registry r join shifts s on s.tenant_id = r.tenant_id and s.id = r.shift_id
        where r.tenant_id = ${tenantId} and s.product_id = ${shift.productId}
        union all
        select r.code_hash, 'original'::text, s.id, s.status::text,
          s.number_month_key, s.number_seq, s.created_from::text, r.scanned_at
        from validation_code_acceptances r join shifts s on s.tenant_id = r.tenant_id and s.id = r.shift_id
        where r.tenant_id = ${tenantId} and s.id = ${shiftId}
          and not exists (select 1 from code_registry owner where owner.tenant_id = r.tenant_id and owner.code_hash = r.code_hash and owner.shift_id = r.shift_id)
        union all
        select r.code_hash, 'reprocessing'::text, s.id, s.status::text,
          s.number_month_key, s.number_seq, s.created_from::text, r.scanned_at
        from validation_code_reprocessings r join shifts s on s.tenant_id = r.tenant_id and s.id = r.shift_id
        where r.tenant_id = ${tenantId} and s.product_id = ${shift.productId} and (s.status <> 'closed' or s.id = ${shiftId})
      ) insert into validation_history_snapshot_entries (tenant_id, snapshot_id, cursor, code_hash, kind, shift_id, shift_number, shift_status, scanned_at)
      select ${tenantId}, ${snapshot.snapshotId}, code_hash || ':' || kind || ':' || shift_id::text, code_hash, kind, shift_id,
        number_month_key || '-' || lpad(number_seq::text, greatest(3, length(number_seq::text)), '0') || case when created_from = 'station' then '/S' else '' end,
        shift_status, scanned_at from history`);
      }
      const rows = await tx
        .select()
        .from(schema.validationHistorySnapshotEntries)
        .where(
          and(
            eq(schema.validationHistorySnapshotEntries.tenantId, tenantId),
            eq(schema.validationHistorySnapshotEntries.snapshotId, snapshot.snapshotId),
            query.cursor
              ? gt(schema.validationHistorySnapshotEntries.cursor, query.cursor)
              : undefined,
          ),
        )
        .orderBy(schema.validationHistorySnapshotEntries.cursor)
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const complete = rows.length <= query.limit;
      return validationCodeHistorySchema.parse({
        protocol: VALIDATION_REPROCESSING_PROTOCOL,
        shiftId,
        productId: shift.productId,
        snapshot: snapshot.snapshotId,
        fetchedAt: snapshot.fetchedAt.toISOString(),
        expiresAt: snapshot.expiresAt.toISOString(),
        nextCursor: complete ? null : page.at(-1)?.cursor,
        complete,
        items: page.map((row) => ({
          codeHash: row.codeHash,
          kind: row.kind,
          shiftId: row.shiftId,
          shiftStatus: row.shiftStatus,
          shiftNumber: row.shiftNumber,
          scannedAt: row.scannedAt.toISOString(),
        })),
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
