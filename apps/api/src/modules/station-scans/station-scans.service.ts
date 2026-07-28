import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensurePartitions, schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { resolveOwnership } from "./conflict-resolution";
import type { BatchConflictDto, SyncBatchDto, SyncBatchResponseDto } from "./dto";

/**
 * Upper bound on how many distinct calendar months a single batch's
 * `scannedAt` values may span before `ensurePartitions` runs.
 *
 * The threat this defends against: a batch (up to `items.max(500)`, see
 * `dto.ts`) with ~500 distinct months would call `ensurePartitions` for up
 * to ~1000 partitions (`codes` and `scan_events` each), and
 * `CREATE TABLE ... PARTITION OF` takes an ACCESS EXCLUSIVE lock on the
 * shared parent -- global to every tenant -- so that lock storm would
 * degrade ingest for everyone, not just the batch's own tenant.
 * `ensurePartitions` already skips months whose partition exists, so the
 * cost that matters here is strictly proportional to how many DISTINCT new
 * months one batch can force into existence at once; nothing about defending
 * against that needs a bound anywhere near the number of months a real
 * device could plausibly carry in one batch. 24 caps the worst case at ~48
 * `CREATE TABLE` statements -- real, but nowhere near the ~1000-partition
 * lock storm this exists to prevent.
 *
 * The cap must stay far above any legitimate backlog, not tight around one,
 * because tripping it wedges the station's queue permanently: rejecting a
 * batch here throws before the transaction below, so the batch is retried
 * indefinitely and NEVER applied (see sync.ts's doc comment on the device
 * side for why the drain treats every error, including a 4xx, as retryable
 * rather than dropping data), and the ceiling that same finding pins on the
 * device means the batch cannot even re-split itself smaller -- the queue
 * is stuck until someone edits the device database by hand. A resend of an
 * already-applied over-cap batch is rejected here too, BEFORE the
 * `alreadyApplied` short-circuit below, so even data already safely on the
 * server can wedge the device this way.
 *
 * A single low-volume or standby station can plausibly sit offline across
 * far more than a handful of month boundaries with only a few scans each,
 * and a device with a dead RTC and no NTP can reboot repeatedly while
 * offline, each boot contributing its own distinct (wrong) month -- that is
 * repeated discontinuities, not the one-correction case a tight cap might
 * assume. 24 is chosen to sit far above any such plausible legitimate batch
 * while still bounding the worst case to a few dozen DDL statements, not
 * because 24 distinct months is itself an expected shape.
 */
const MAX_DISTINCT_MONTHS_PER_BATCH = 24;

/**
 * Absolute bound on `scannedAt`, independent of (and in addition to)
 * `MAX_DISTINCT_MONTHS_PER_BATCH` above. The per-batch month cap alone does
 * not bound anything ACROSS requests: a device (or a hostile client holding
 * a valid device key) could send request after request, each staying under
 * the per-batch cap but introducing a handful of NEW distinct months every
 * time, so the total number of months `ensurePartitions` is ever asked to
 * create over the API's lifetime would have no ceiling. Anchoring every
 * accepted `scannedAt` to a window around "now" fixes that: the entire
 * universe of months this endpoint can EVER create partitions for is capped
 * at roughly the window's width, no matter how many requests arrive over the
 * life of the deployment. It also stops a corrupt or hostile `scannedAt`
 * (e.g. a dead RTC reporting a wildly wrong date, or a crafted payload) from
 * reaching the month-start computation at all.
 *
 * The window must sit far above any plausible offline backlog: rejecting a
 * batch wedges that device's queue by design (the drain retries a rejected
 * batch indefinitely rather than ever dropping data -- see sync.ts's doc
 * comment on the device side), so this is a recorded owner decision, not a
 * casual one. A real device's clock can be off by hours from a
 * misconfigured timezone or unsynced NTP, and its queue can legitimately
 * carry weeks-to-months of backlog after an extended outage, a warehoused
 * spare unit being redeployed, or repeated dead-RTC reboots each contributing
 * a wrong month (see MAX_DISTINCT_MONTHS_PER_BATCH's comment). WINDOW_PAST_MS
 * (3 years) is dramatically wider than any such scenario, and also sits
 * comfortably above MAX_DISTINCT_MONTHS_PER_BATCH's 24-month cap so the two
 * bounds stay independently testable rather than one silently subsuming the
 * other. WINDOW_FUTURE_MS (1 day) only needs to absorb ordinary clock skew --
 * a scan legitimately timestamped meaningfully in the future cannot exist.
 */
const WINDOW_PAST_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const WINDOW_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * Rejects the whole batch if ANY item's `scannedAt` falls outside the
 * absolute window above. Pure computation, no DB access -- deliberately the
 * very first thing `applyBatch` does with a non-empty batch, so a corrupt or
 * hostile payload is rejected before even the shift-ownership guard query
 * runs, let alone `ensurePartitions`.
 */
function assertScannedAtWithinWindow(items: SyncBatchDto["items"]): void {
  const now = Date.now();
  for (const item of items) {
    const t = new Date(item.scannedAt).getTime();
    if (!Number.isFinite(t) || t < now - WINDOW_PAST_MS || t > now + WINDOW_FUTURE_MS) {
      throw new BadRequestException(
        "Batch contains a scannedAt outside the acceptable window around now",
      );
    }
  }
}

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
      // Absolute window check FIRST (Finding 2): pure computation, so a
      // corrupt/hostile batch is rejected before any DB access at all.
      assertScannedAtWithinWindow(body.items);

      // Tenant-scoped shift-ownership GUARD, before ensurePartitions
      // (Finding 2): a batch full of nonexistent (or foreign-tenant) shift
      // ids must be rejected without ever triggering the DDL below -- each
      // `CREATE TABLE ... PARTITION OF` takes an ACCESS EXCLUSIVE lock on the
      // shared `codes`/`scan_events` parents, global to every tenant, so
      // letting garbage shift ids reach it degrades ingest for everyone. This
      // is a GUARD, not a replacement for the authoritative tenant-scoped
      // check inside the transaction below, which also covers a shift being
      // reassigned or removed between this check and the insert.
      const shiftIds = [...new Set(body.items.map((i) => i.shiftId))];
      const ownedIds = await this.db
        .select({ id: schema.shifts.id })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), inArray(schema.shifts.id, shiftIds)));
      if (ownedIds.length !== shiftIds.length) {
        throw new BadRequestException("Unknown shift in batch");
      }

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
          // only move year/month/date. (In practice `assertScannedAtWithinWindow`
          // above already rejects any two-digit-year `scannedAt` -- such a
          // value can never fall inside WINDOW_PAST_MS of "now" -- so this is
          // now defense-in-depth rather than the only guard against it.)
          const monthStart = new Date(0);
          monthStart.setUTCFullYear(d.getUTCFullYear(), d.getUTCMonth(), 1);
          return monthStart.getTime();
        }),
      );
      // Reject BEFORE calling ensurePartitions: an over-cap batch must never
      // get even one partition created for it (see MAX_DISTINCT_MONTHS_PER_
      // BATCH's doc comment for why the cap itself is set high enough that
      // this can only fire for a corrupt/hostile timestamp, never a
      // legitimate one).
      if (monthStarts.size > MAX_DISTINCT_MONTHS_PER_BATCH) {
        throw new BadRequestException(
          `Batch spans ${monthStarts.size} distinct months, more than the ${MAX_DISTINCT_MONTHS_PER_BATCH} allowed in one batch`,
        );
      }
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
      if (claimed.length === 0) return { applied: 0, alreadyApplied: true, conflicts: [] };
      if (body.items.length === 0) return { applied: 0, alreadyApplied: false, conflicts: [] };

      const shiftIds = [...new Set(body.items.map((i) => i.shiftId))];
      const owned = await tx
        .select({ id: schema.shifts.id, status: schema.shifts.status })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), inArray(schema.shifts.id, shiftIds)));

      // Tenant scoping is enforced in the statement above; anything missing
      // either does not exist or belongs to another tenant, and the caller
      // must not be able to tell those apart. The guard above already
      // checked this once outside the transaction -- this is the
      // AUTHORITATIVE check, not a replacement for it, since a shift could in
      // principle have been reassigned between the two.
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

      // Ownership is settled last, on the codes this batch actually stored.
      // One statement to read the incumbents, one to claim — never a query
      // per code, and never against the partitioned tables.
      const claimItems = coded.map((i) => ({
        codeHash: i.code!.codeHash,
        shiftId: i.shiftId,
        terminalId: i.terminalId,
        scannedAt: new Date(i.scannedAt),
      }));

      let batchConflicts: BatchConflictDto[] = [];
      if (claimItems.length > 0) {
        const hashes = [...new Set(claimItems.map((c) => c.codeHash))];
        const owners = await tx
          .select({
            codeHash: schema.codeRegistry.codeHash,
            shiftId: schema.codeRegistry.shiftId,
            terminalId: schema.codeRegistry.terminalId,
            scannedAt: schema.codeRegistry.scannedAt,
          })
          .from(schema.codeRegistry)
          .where(
            and(
              eq(schema.codeRegistry.tenantId, tenantId),
              inArray(schema.codeRegistry.codeHash, hashes),
            ),
          );

        const resolution = resolveOwnership(claimItems, owners);

        if (resolution.claims.length > 0) {
          await tx
            .insert(schema.codeRegistry)
            .values(resolution.claims.map((c) => ({ tenantId, ...c })))
            .onConflictDoUpdate({
              target: [schema.codeRegistry.tenantId, schema.codeRegistry.codeHash],
              set: {
                shiftId: sql`excluded.shift_id`,
                terminalId: sql`excluded.terminal_id`,
                scannedAt: sql`excluded.scanned_at`,
                updatedAt: sql`now()`,
              },
              // The rule lives in the statement, not in application ordering:
              // ownership moves only for a strictly earlier scan, so two
              // concurrent batches cannot leave it dependent on who ran first.
              setWhere: sql`excluded.scanned_at < ${schema.codeRegistry.scannedAt}`,
            });
        }

        if (resolution.conflicts.length > 0) {
          await tx.insert(schema.codeConflicts).values(
            resolution.conflicts.map((c) => ({
              tenantId,
              codeHash: c.codeHash,
              losingShiftId: c.losing.shiftId,
              losingTerminalId: c.losing.terminalId,
              losingScannedAt: c.losing.scannedAt,
              winningShiftId: c.winning.shiftId,
              winningTerminalId: c.winning.terminalId,
              winningScannedAt: c.winning.scannedAt,
            })),
          );
        }

        batchConflicts = resolution.lostByThisBatch.map((c) => ({
          codeHash: c.codeHash,
          winningTerminalId: c.winning.terminalId,
          winningScannedAt: c.winning.scannedAt.toISOString(),
        }));
      }

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

      return { applied: body.items.length, alreadyApplied: false, conflicts: batchConflicts };
    });
  }
}
