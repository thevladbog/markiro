import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensurePartitions, schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { SyncBatchDto, SyncBatchResponseDto } from "./dto";

@Injectable()
export class StationScansService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Applies one batch and records its key in a SINGLE transaction, so a
   * retried batch is a no-op in its entirety. This is the server side of the
   * device's at-least-once delivery: the station resends whenever it did not
   * see an acknowledgement, and correctness rests entirely on this being
   * all-or-nothing.
   */
  async applyBatch(tenantId: string, body: SyncBatchDto): Promise<SyncBatchResponseDto> {
    // Ensure the months this batch actually needs have partitions BEFORE
    // opening the transaction below. Only the scheduled job (JobsModule)
    // proactively maintains current+next month; a device offline across a
    // month boundary, with a dead RTC, or delivering after a database
    // restore can carry a scannedAt outside that window. Without this, the
    // insert below raises SQLSTATE 23514 ("no partition of relation found
    // for row") uncaught -> 500, and the device's drain loop treats every
    // error as retryable, wedging the station's queue forever -- exactly
    // what this slice exists to prevent. Doing it here rather than inside
    // the transaction matters: CREATE TABLE ... PARTITION OF takes an
    // ACCESS EXCLUSIVE lock on the parent, which would otherwise be held for
    // the whole batch insert and block concurrent ingest.
    if (body.items.length > 0) {
      const monthStarts = new Set(
        body.items.map((i) => {
          const d = new Date(i.scannedAt);
          // Do NOT derive this via Date.UTC(d.getUTCFullYear(), ...): Date.UTC
          // applies JS's legacy two-digit-year mapping, silently remapping a
          // raw numeric year of 0-99 into 1900-1999 (Date.UTC(0, 0, 1) =>
          // 1900-01-01, not year 0000). A scannedAt in that range would then
          // ensure the partition for the wrong century while the row inserts
          // with its real year, and Postgres would reject it with SQLSTATE
          // 23514 -- the exact 500 this partition-ahead-of-time fix exists to
          // prevent. setUTCFullYear has no such special case, so start from
          // the epoch (already zeroed to the first instant of the day) and
          // only move year/month/date.
          const monthStart = new Date(0);
          monthStart.setUTCFullYear(d.getUTCFullYear(), d.getUTCMonth(), 1);
          return monthStart.getTime();
        }),
      );
      await ensurePartitions(
        this.db,
        [...monthStarts].map((t) => new Date(t)),
      );
    }

    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .insert(schema.syncBatches)
        .values({ tenantId, batchId: body.batchId })
        .onConflictDoNothing()
        .returning({ batchId: schema.syncBatches.batchId });

      // Someone already applied this batch — almost always this same device
      // retrying after a lost response. Report success so it acknowledges.
      if (claimed.length === 0) return { applied: 0, alreadyApplied: true };
      if (body.items.length === 0) return { applied: 0, alreadyApplied: false };

      const shiftIds = [...new Set(body.items.map((i) => i.shiftId))];
      const owned = await tx
        .select({ id: schema.shifts.id, status: schema.shifts.status })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), inArray(schema.shifts.id, shiftIds)));

      // Tenant scoping is enforced in the statement above; anything missing
      // either does not exist or belongs to another tenant, and the caller
      // must not be able to tell those apart.
      if (owned.length !== shiftIds.length) {
        throw new BadRequestException("Unknown shift in batch");
      }

      const coded = body.items.filter((i) => i.code !== null);
      if (coded.length > 0) {
        await tx
          .insert(schema.codes)
          .values(
            coded.map((i) => ({
              tenantId,
              codeHash: i.code!.codeHash,
              shiftId: i.shiftId,
              gtin14: i.code!.gtin14,
              serial: i.code!.serial,
              scannedAt: new Date(i.scannedAt),
            })),
          )
          .onConflictDoNothing();
      }

      await tx.insert(schema.scanEvents).values(
        body.items.map((i) => ({
          tenantId,
          shiftId: i.shiftId,
          terminalId: i.terminalId,
          raw: i.raw,
          verdict: i.verdict,
          scannedAt: new Date(i.scannedAt),
        })),
      );

      // Stamp only shifts that were already closed, and only the first time:
      // the badge marks the shift, it does not track the latest straggler.
      const closed = owned.filter((s) => s.status === "closed").map((s) => s.id);
      if (closed.length > 0) {
        await tx
          .update(schema.shifts)
          .set({ lateDataAt: sql`now()` })
          .where(
            and(
              eq(schema.shifts.tenantId, tenantId),
              inArray(schema.shifts.id, closed),
              isNull(schema.shifts.lateDataAt),
            ),
          );
      }

      return { applied: body.items.length, alreadyApplied: false };
    });
  }
}
