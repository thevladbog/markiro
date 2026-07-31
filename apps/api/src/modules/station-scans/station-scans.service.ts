import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { ensurePartitions, schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import {
  collapseClaims,
  conflictsAgainstOwner,
  displacedIncumbents,
  sameScan,
  type OwnerRow,
} from "./conflict-resolution";
import { displacedHashes, type MembershipRow } from "./box-membership";
import { sortExceptions, type ExceptionDto } from "./box-exceptions";
import { SsccService } from "../sscc/sscc.service";
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
  private readonly logger = new Logger(StationScansService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ssccService: SsccService,
  ) {}

  /**
   * Applies one batch and records its key in a SINGLE transaction, so a
   * retried batch is a no-op in its entirety. This is the server side of the
   * device's at-least-once delivery: the station resends whenever it did not
   * see an acknowledgement, and correctness rests entirely on this being
   * all-or-nothing.
   */
  async applyBatch(
    tenantId: string,
    body: SyncBatchDto,
    authenticatedTerminalId?: string,
  ): Promise<SyncBatchResponseDto> {
    if (body.exceptions.length > 0 && !authenticatedTerminalId) {
      throw new ForbiddenException("Station device authentication required for exceptions");
    }
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

      // Both defaulted so a closure-only batch (no items at all -- see the
      // box-closures loop at the end of this transaction) reaches the final
      // return below without ever entering the `body.items.length > 0`
      // branch: `batchConflicts` stays empty, exactly as it is for any
      // batch that loses no claims of its own.
      let batchConflicts: BatchConflictDto[] = [];

      if (body.items.length > 0) {
        const shiftIds = [...new Set(body.items.map((i) => i.shiftId))];
        const owned = await tx
          .select({ id: schema.shifts.id, status: schema.shifts.status })
          .from(schema.shifts)
          .where(and(eq(schema.shifts.tenantId, tenantId), inArray(schema.shifts.id, shiftIds)));

        // Tenant scoping is enforced in the statement above; anything missing
        // either does not exist or belongs to another tenant, and the caller
        // must not be able to tell those apart. The guard above already
        // checked this once outside the transaction -- this is the
        // AUTHORITATIVE check, not a replacement for it, since a shift could
        // in principle have been reassigned between the two.
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
            // Per scan, not per batch (see dto.ts's comment on this field):
            // a drained batch can span an operator handover.
            operatorId: i.operatorId,
          })),
        );

        // Ownership is decided next, on the codes this batch actually stored
        // -- NOT last: the late-data stamp below still follows it.
        const claimItems = coded.map((i) => ({
          codeHash: i.code!.codeHash,
          shiftId: i.shiftId,
          terminalId: i.terminalId,
          scannedAt: new Date(i.scannedAt),
        }));

        if (claimItems.length > 0) {
          // Sorted here, once, as the single source of truth for lock/claim
          // order: every statement below that inserts or locks more than one
          // code_registry row iterates in THIS order, rather than `Set`
          // insertion order or whatever a query planner happens to choose, so
          // two overlapping batches sharing two-or-more codes -- in either
          // relative arrival order -- acquire those rows in the SAME order and
          // cannot deadlock (Postgres 40P01).
          const hashes = [...new Set(claimItems.map((c) => c.codeHash))].sort();
          const registryColumns = {
            codeHash: schema.codeRegistry.codeHash,
            shiftId: schema.codeRegistry.shiftId,
            terminalId: schema.codeRegistry.terminalId,
            scannedAt: schema.codeRegistry.scannedAt,
          };

          // Postgres refuses an ON CONFLICT DO UPDATE whose VALUES name the
          // same conflict key twice, so the batch must first be collapsed to
          // one row per code (collapseClaims), then ordered to match `hashes`
          // above -- not sorted independently, so the two can never drift.
          const claimsByHash = new Map(collapseClaims(claimItems).map((c) => [c.codeHash, c]));
          const claims = hashes.map((h) => claimsByHash.get(h)!);

          // Precedes the lock-read below with a real write: INSERT ... ON
          // CONFLICT DO NOTHING for every claim. A bare `SELECT ... FOR
          // UPDATE` locks nothing for a row that does not yet exist
          // committed-visible -- Postgres has no gap locking outside
          // SERIALIZABLE -- so two terminals racing on a brand-new code could
          // each see an empty pre-read and each conclude, wrongly, that
          // nothing needs recording. This INSERT closes that gap: it waits on
          // ANY concurrent transaction's speculative insertion of the same
          // (tenant, codeHash) for as long as that transaction runs (Postgres's
          // built-in ON CONFLICT arbitration), so by the time it returns, a
          // COMMITTED row is provably present for every one of this batch's
          // hashes -- either this statement placed it (no prior owner existed
          // at all), or a concurrent transaction's row won the race to create
          // it and is now committed. "Row absent" has become "row present and
          // about to be locked" for the `FOR UPDATE` immediately below.
          //
          // `.returning()` names exactly the hashes THIS statement placed --
          // a genuinely new code, no prior owner -- as opposed to ones ON
          // CONFLICT DO NOTHING left untouched. Folded into `wonHashes` below
          // to make it semantically complete ("every hash this batch now
          // owns"), not because omitting them would change the computed
          // owner: for one of these hashes, `ownerByHash`'s fallback to
          // `priorByHash` reads back this same fresh insert, so the outcome
          // is identical either way.
          const freshlyClaimed = await tx
            .insert(schema.codeRegistry)
            .values(claims.map((c) => ({ tenantId, ...c })))
            .onConflictDoNothing()
            .returning({ codeHash: schema.codeRegistry.codeHash });
          const freshHashes = new Set(freshlyClaimed.map((w) => w.codeHash));

          // Every hash now provably has a committed row (see above), so this
          // locks each one for the rest of the transaction -- used ONLY to
          // attribute a displacement (see displacedIncumbents' doc comment).
          // It is NEVER used to decide who wins: that decision belongs
          // entirely to the upsert's own `setWhere`. Ordered to match
          // `hashes`/`claims` for the same 40P01 reason as above.
          //
          // Cost, stated plainly: this locks up to `items.max(500)` (see
          // dto.ts) PRE-EXISTING code_registry rows and holds every one of
          // them until this transaction commits -- including rows this batch
          // is about to LOSE, which sit locked purely for sharing a batch with
          // a winner.
          const priorIncumbents = await tx
            .select(registryColumns)
            .from(schema.codeRegistry)
            .where(
              and(
                eq(schema.codeRegistry.tenantId, tenantId),
                inArray(schema.codeRegistry.codeHash, hashes),
              ),
            )
            .orderBy(schema.codeRegistry.codeHash)
            .for("update");
          const priorByHash = new Map<string, OwnerRow>(
            priorIncumbents.map((o) => [o.codeHash, o]),
          );

          const won = await tx
            .insert(schema.codeRegistry)
            .values(claims.map((c) => ({ tenantId, ...c })))
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
            })
            .returning({ codeHash: schema.codeRegistry.codeHash });
          const wonHashes = new Set([...freshHashes, ...won.map((w) => w.codeHash)]);

          // The authoritative final owner for every hash, derived entirely
          // from what is already in memory -- deliberately NOT a fresh
          // re-read of code_registry. That re-read (`postOwners`) existed in
          // an earlier version of this code; it is now redundant, because the
          // `FOR UPDATE` above holds every one of these rows locked from that
          // read through to here: for a hash this batch WON (`wonHashes`),
          // either the fresh-insert above or the upsert just wrote this
          // batch's own claim and nothing else could have touched the row
          // since (the lock forbids it); for one it LOST, the same lock means
          // nothing else could have touched `priorByHash`'s value either, and
          // this batch's own upsert deliberately left it unchanged. A separate
          // SELECT here would read back exactly one of these two maps and
          // nothing else -- so build it directly instead of paying another
          // round trip to confirm it.
          const ownerByHash = new Map<string, OwnerRow>(
            hashes.map((h) => [h, wonHashes.has(h) ? claimsByHash.get(h)! : priorByHash.get(h)!]),
          );

          const ownLosses = conflictsAgainstOwner(claimItems, ownerByHash);
          const displaced = displacedIncumbents(claims, wonHashes, priorByHash);
          const allConflicts = [...ownLosses, ...displaced];

          if (allConflicts.length > 0) {
            await tx.insert(schema.codeConflicts).values(
              allConflicts.map((c) => ({
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

          // Every item in `ownLosses` came from claimItems -- i.e. this
          // batch's own scans -- so all of them, and only them, are this
          // batch's own losses; `displaced` names a scan from a batch other
          // than this one and must never be echoed back here.
          batchConflicts = ownLosses.map((c) => ({
            codeHash: c.codeHash,
            winningTerminalId: c.winning.terminalId,
            winningScannedAt: c.winning.scannedAt.toISOString(),
          }));

          // Box membership (Task 10). A boxed item is, by construction,
          // always a coded one -- `boxed` below is a subset of `coded` -- so
          // there is nothing for this section to do whenever `claimItems` (===
          // `coded` in length) is empty, which is exactly the branch this is
          // nested in.
          const boxed = coded.filter((i) => i.boxId !== null);

          // This batch's own box ids -- populated only inside the
          // `boxed.length > 0` branch below. Stays `[]` for a batch that
          // boxed nothing itself (every item `boxId: null`, an ordinary
          // unboxed scan per dto.ts), which is exactly the case the
          // RETROACTIVE block further down (Finding 2) must still run for:
          // an unboxed scan can still WIN ownership and displace an
          // incumbent recorded elsewhere in a box, and `notInArray` on an
          // empty array excludes nothing (verified against this drizzle-orm
          // version's `notInArray` -- see its own comment below), so the
          // retroactive UPDATE correctly considers every one of that
          // incumbent's box items with no this-batch box to exempt.
          let thisBatchBoxIds: string[] = [];

          if (boxed.length > 0) {
            const boxKey = (shiftId: string, terminalId: string | null, boxId: string): string =>
              `${shiftId}|${terminalId ?? ""}|${boxId}`;

            // A box row is created when its FIRST item arrives, not when the
            // closure does (see boxes' schema comment) -- collapsed to one row
            // per (shift, terminal, deviceBoxId) triple, since that triple,
            // not the deviceBoxId string alone, is what boxes_device_box_uq
            // actually keys on.
            const uniqueBoxes = new Map<
              string,
              { shiftId: string; terminalId: string | null; boxId: string }
            >();
            for (const i of boxed) {
              const key = boxKey(i.shiftId, i.terminalId, i.boxId!);
              if (!uniqueBoxes.has(key)) {
                uniqueBoxes.set(key, {
                  shiftId: i.shiftId,
                  terminalId: i.terminalId,
                  boxId: i.boxId!,
                });
              }
            }
            // Sorted by deviceBoxId -- same 40P01 reason as the registry claim
            // above: two overlapping batches touching the same boxes must
            // acquire them in the same order regardless of arrival order.
            const boxRows = [...uniqueBoxes.values()].sort((a, b) =>
              a.boxId.localeCompare(b.boxId),
            );

            await tx
              .insert(schema.boxes)
              .values(
                boxRows.map((b) => ({
                  tenantId,
                  shiftId: b.shiftId,
                  terminalId: b.terminalId,
                  deviceBoxId: b.boxId,
                })),
              )
              .onConflictDoNothing({
                target: [
                  schema.boxes.tenantId,
                  schema.boxes.shiftId,
                  schema.boxes.terminalId,
                  schema.boxes.deviceBoxId,
                ],
              });

            // Resolve every one of this batch's boxes to its server id with a
            // fresh SELECT, rather than trusting the insert's `.returning()`:
            // a box already opened by an earlier batch -- the ordinary case
            // for every item after a box's first -- is exactly the row ON
            // CONFLICT DO NOTHING leaves untouched, and `.returning()` never
            // reports it.
            const deviceBoxIds = [...new Set(boxRows.map((b) => b.boxId))];
            const boxIdRows = await tx
              .select({
                id: schema.boxes.id,
                shiftId: schema.boxes.shiftId,
                terminalId: schema.boxes.terminalId,
                deviceBoxId: schema.boxes.deviceBoxId,
              })
              .from(schema.boxes)
              .where(
                and(
                  eq(schema.boxes.tenantId, tenantId),
                  inArray(schema.boxes.deviceBoxId, deviceBoxIds),
                ),
              );
            const boxIdByKey = new Map<string, string>();
            for (const row of boxIdRows) {
              boxIdByKey.set(boxKey(row.shiftId, row.terminalId, row.deviceBoxId), row.id);
            }

            const preBoxItems = boxed.map((i) => ({
              boxId: boxIdByKey.get(boxKey(i.shiftId, i.terminalId, i.boxId!))!,
              codeHash: i.code!.codeHash,
              addedAt: new Date(i.scannedAt),
              shiftId: i.shiftId,
              terminalId: i.terminalId,
              scannedAt: new Date(i.scannedAt),
            }));

            // Sorted by (boxId, codeHash) -- same 40P01 reason as above -- and
            // A strictly newer rescan into the same box reactivates the
            // existing membership after undo/clear. An exact replay keeps
            // the row untouched, so a stale delivery cannot resurrect it.
            const sortedBoxItems = [...preBoxItems].sort((a, b) =>
              a.boxId === b.boxId
                ? a.codeHash.localeCompare(b.codeHash)
                : a.boxId.localeCompare(b.boxId),
            );
            await tx
              .insert(schema.boxItems)
              .values(
                sortedBoxItems.map((p) => ({
                  tenantId,
                  boxId: p.boxId,
                  codeHash: p.codeHash,
                  addedAt: p.addedAt,
                })),
              )
              .onConflictDoUpdate({
                target: [schema.boxItems.tenantId, schema.boxItems.boxId, schema.boxItems.codeHash],
                set: {
                  addedAt: sql`excluded.added_at`,
                  displacedAt: null,
                  removedAt: null,
                },
                setWhere: sql`excluded.added_at > ${schema.boxItems.addedAt}`,
              });

            // THIS BATCH's own direction: a scan it just recorded might not be
            // the code's owner (06b's rule: the earlier scannedAt wins), in
            // which case this batch's OWN box item must be marked displaced.
            // `ownerByHash` always has an entry for every one of these code
            // hashes (every one came from `coded`, i.e. from `claimItems`);
            // the `!!owner` fallback below is defensive only, and treats "no
            // owner found" as "not the owner" -- the conservative direction,
            // matching "a box may only count what its own scan owns".
            const membershipRows: MembershipRow[] = preBoxItems.map((p) => {
              const owner = ownerByHash.get(p.codeHash);
              const ownerIsThisScan =
                !!owner &&
                sameScan(
                  { shiftId: p.shiftId, terminalId: p.terminalId, scannedAt: p.scannedAt },
                  {
                    shiftId: owner.shiftId,
                    terminalId: owner.terminalId,
                    scannedAt: owner.scannedAt,
                  },
                );
              return { boxId: p.boxId, codeHash: p.codeHash, addedAt: p.addedAt, ownerIsThisScan };
            });
            const toMark = displacedHashes(membershipRows);
            thisBatchBoxIds = [...new Set(preBoxItems.map((p) => p.boxId))];
            if (toMark.length > 0) {
              await tx
                .update(schema.boxItems)
                .set({ displacedAt: sql`now()` })
                .where(
                  and(
                    eq(schema.boxItems.tenantId, tenantId),
                    inArray(schema.boxItems.boxId, thisBatchBoxIds),
                    inArray(schema.boxItems.codeHash, toMark),
                    isNull(schema.boxItems.displacedAt),
                  ),
                );
            }
          }

          // The RETROACTIVE direction (Finding 2): reusing `displaced`
          // (already computed above by `displacedIncumbents`, from EVERY
          // claim in this batch, not just the boxed ones) rather than
          // recomputing it -- when this batch's win displaces an owner
          // already recorded elsewhere, that owner's OWN box item (opened by
          // some earlier batch, never this one) must be marked too.
          //
          // Deliberately hoisted OUT of `if (boxed.length > 0)`: this must
          // run whenever this batch CLAIMED ownership of a code (i.e.
          // whenever `claimItems` was non-empty, the scope this whole
          // section sits in), not only when it ALSO boxed something itself.
          // dto.ts explicitly blesses `boxId: null` as an ordinary unboxed
          // scan -- e.g. one taken at a verification station -- and such a
          // scan can still win the registry claim and displace an
          // incumbent's box item; the old `if (boxed.length > 0)` guard
          // skipped this whole block for exactly that batch, leaving the
          // displaced incumbent's box item live and its box counting an item
          // its own scan no longer owns (the bug this task exists to close).
          //
          // `notInArray` on an empty `thisBatchBoxIds` (a batch that boxed
          // nothing itself) resolves to `true` -- i.e. excludes nothing --
          // verified against this project's drizzle-orm 0.45.2
          // (`notInArray`'s empty-array branch returns `sql\`true\``, the
          // same file's `inArray` returns `sql\`false\`` for the same case),
          // so this correctly considers every one of the incumbent's box
          // items with no this-batch box wrongly exempted from it.
          const retroHashes = [...new Set(displaced.map((d) => d.codeHash))];
          if (retroHashes.length > 0) {
            await tx
              .update(schema.boxItems)
              .set({ displacedAt: sql`now()` })
              .where(
                and(
                  eq(schema.boxItems.tenantId, tenantId),
                  inArray(schema.boxItems.codeHash, retroHashes),
                  isNull(schema.boxItems.displacedAt),
                  notInArray(schema.boxItems.boxId, thisBatchBoxIds),
                ),
              );
          }
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
      }

      // Box closures (Task 10): applied regardless of whether this batch
      // carries any items -- a box can close well after its last item was
      // drained, in a batch of its own (see the DTO's `boxes` field). Matched
      // on all four of `boxes_device_box_uq`'s own columns (Finding 3): a
      // bare (tenant, deviceBoxId) match is not enough to identify one box --
      // that constraint scopes deviceBoxId to (shift, terminal) precisely
      // because the device-local string alone is not unique (two terminals
      // in one tenant both calling a box "b1", or one device reusing "b1"
      // after a shift change). Matching on the string alone would update
      // every row sharing it and write the same sscc to all of them,
      // raising boxes_tenant_sscc_uq's 23505.
      if (body.boxes.length > 0) {
        // Sorted by boxId -- same 40P01 reason as the box upsert above,
        // even though each closure is its own statement rather than one
        // multi-row write: two overlapping batches closing the same boxes
        // must still acquire them in the same order.
        const closures = [...body.boxes].sort((a, b) => a.boxId.localeCompare(b.boxId));
        for (const closure of closures) {
          // `eq(col, null)` compiles to `col = NULL`, which SQL's
          // three-valued logic never treats as true -- an `IS NULL` check is
          // required whenever the closure's own terminalId is null, the same
          // pitfall boxKey's map-based lookup elsewhere in this file sidesteps
          // by never expressing the comparison in SQL at all.
          const terminalCondition =
            closure.terminalId === null
              ? isNull(schema.boxes.terminalId)
              : eq(schema.boxes.terminalId, closure.terminalId);

          // `closedAt IS NULL` is back in the match (a prior wave dropped it
          // wholesale when only the THROW below needed removing -- see the
          // rowCount === 0 branch's own comment for why that throw was the
          // actual bug). The four identity columns alone constrain WHICH box
          // this is, not whether it is still open to write to: a device that
          // loses its local database and restarts its box counter at "b1"
          // inside a still-open shift on the same terminal has its box
          // upsert earlier in this transaction no-op onto the OLD closed
          // row (same four-column identity) -- without this predicate, this
          // UPDATE would then match that already-closed row and silently
          // rewrite its sscc/closedAt/operatorId to the NEW box's values,
          // orphaning the serial actually printed on the physical box.
          // `boxes_tenant_sscc_uq` cannot catch that: it's an in-place
          // UPDATE of one row, not a second row racing the constraint. A
          // genuine REDELIVERY of the SAME closure under a fresh batchId
          // (the device having lost its record of what it already sent) now
          // matches zero rows here too -- it's already closed -- and falls
          // into the rowCount === 0 no-op branch below, which is a correct
          // no-op for that case (box stays closed with the same values it
          // already carries).
          const result = await tx
            .update(schema.boxes)
            .set({
              sscc: closure.sscc,
              closedAt: new Date(closure.closedAt),
              operatorId: closure.operatorId,
              // Server-assigned, at this SAME statement (Finding 7) -- see
              // the column's own doc comment in platform.ts for why
              // `contentsChangedAfterClose` must compare against this, never
              // the client-supplied `closedAt` above.
              closureReceivedAt: sql`now()`,
            })
            .where(
              and(
                eq(schema.boxes.tenantId, tenantId),
                eq(schema.boxes.shiftId, closure.shiftId),
                terminalCondition,
                eq(schema.boxes.deviceBoxId, closure.boxId),
                isNull(schema.boxes.closedAt),
              ),
            );
          const rowCount = result.rowCount ?? 0;

          // `boxes_device_box_uq` (platform.ts) uniquely identifies a box by
          // exactly these four columns, so matching more than one row is a
          // structural invariant violation -- but this check is not actually
          // what would catch it in practice: writing a non-null `sscc` to
          // 2+ rows in ONE UPDATE statement raises `boxes_tenant_sscc_uq`'s
          // 23505 during statement execution, before `rowCount` is ever
          // read, so that constraint violation is the diagnosable signal
          // for this failure mode, not this branch. Kept anyway as defence
          // in depth (e.g. against a future schema change that relaxed
          // boxes_tenant_sscc_uq), even though it is effectively dead code
          // today.
          if (rowCount > 1) {
            throw new Error(
              `Box closure for deviceBoxId ${closure.boxId} (tenant ${tenantId}, shift ` +
                `${closure.shiftId}, terminal ${closure.terminalId ?? "null"}) matched ` +
                `${rowCount} rows, but boxes_device_box_uq guarantees at most 1`,
            );
          }

          // The server's only chance to learn a serial was really used --
          // see SsccService.recordConsumedSerial's doc comment. Passed `tx`
          // so this enlists in the SAME transaction as the closure write
          // above: a rollback of one must roll back the other.
          //
          // Deliberately called BEFORE the `rowCount === 0` branch below,
          // i.e. for EVERY closure this batch carries, matched or not:
          // `recordConsumedSerial` needs nothing from the box row itself --
          // it parses `closure.sscc` and updates `sscc_blocks` directly, by
          // serial range, not by any join to `boxes`. Both inputs that reach
          // `rowCount === 0` (a box closed with zero items, or a shiftId
          // that no longer matches the box's own -- see that branch's
          // comment) are still a case where a PHYSICAL box was closed and a
          // label carrying this serial was printed and applied; only the
          // server's own bookkeeping of the box row failed to line up, not
          // the fact that the serial was consumed. Skipping this call for
          // those cases would silently forget that consumption and reopen
          // exactly the reprint hazard this method exists to close (see its
          // own doc comment): a device that later loses its local database
          // would be handed this same serial back as though unconsumed.
          await this.ssccService.recordConsumedSerial(tenantId, closure.sscc, tx);

          // Late print-verification outcome (Task 13 review, Finding 6): a
          // box is typically acked within seconds of closing -- long before
          // the operator usually resolves the print-verification prompt --
          // so the closure that first lands here usually carries both
          // fields null. This SECOND, narrower write is what lets a LATER
          // delivery of the SAME closure (one issued after the device has
          // since recorded `print_verified_at`/`print_skipped_at` on its own
          // `boxes_mirror` row) still land the outcome, even though the
          // primary UPDATE above deliberately refuses to touch an
          // already-closed row (`isNull(schema.boxes.closedAt)`). That
          // refusal exists to stop a device that reused a deviceBoxId after
          // losing its local database from clobbering an unrelated OLD box's
          // sscc/closedAt/operatorId -- a real risk this write does not
          // share: it is scoped by `sscc` equality IN ADDITION to the same
          // four identity columns, so it can only ever match the box THIS
          // closure's own sscc already names. A reused-id collision (a
          // genuinely different physical box burning a NEW serial) has a
          // different sscc and so matches nothing here, same as it already
          // matches nothing above -- this write introduces no new risk to
          // that case, it just stays a no-op for it. Run unconditionally
          // (not only when the primary UPDATE found no row) so an ordinary,
          // first-time closure that already happens to carry a resolved
          // outcome also gets it written, in the same transaction.
          if (closure.printVerifiedAt !== null || closure.printSkippedAt !== null) {
            await tx
              .update(schema.boxes)
              .set({
                ...(closure.printVerifiedAt !== null
                  ? { printVerifiedAt: new Date(closure.printVerifiedAt) }
                  : {}),
                ...(closure.printSkippedAt !== null
                  ? { printSkippedAt: new Date(closure.printSkippedAt) }
                  : {}),
              })
              .where(
                and(
                  eq(schema.boxes.tenantId, tenantId),
                  eq(schema.boxes.shiftId, closure.shiftId),
                  terminalCondition,
                  eq(schema.boxes.deviceBoxId, closure.boxId),
                  eq(schema.boxes.sscc, closure.sscc),
                ),
              );
          }

          // Zero rows is "nothing [more] to apply to the box row", not an
          // error. Two ordinary inputs land here, neither of them a bug: a
          // closure for a box that was never created at all (a box row is
          // created from its FIRST item, not the closure -- see the
          // box-upsert above -- so a box closed with zero items has no row
          // to match), or a device that reports a different shiftId at
          // close time than the one its box row actually carries (a box
          // spanning a shift boundary) -- plus, now that `closedAt IS NULL`
          // is back in the match, a genuine redelivery of a closure already
          // applied by an earlier batch. Throwing here would render as a
          // 500, and the station retries a non-2xx batch under the SAME
          // batchId forever, wedging that device's queue permanently over
          // an ordinary input -- exactly the failure mode this fix removes.
          // Logged with enough detail to find the box by hand.
          // `recordConsumedSerial` has ALREADY run above regardless (see its
          // own comment for why that is deliberately independent of this
          // rowCount).
          if (rowCount === 0) {
            this.logger.warn(
              `Box closure for deviceBoxId ${closure.boxId} (tenant ${tenantId}, shift ` +
                `${closure.shiftId}, terminal ${closure.terminalId ?? "null"}) matched no box ` +
                `row -- box was never created (closed with zero items), its shiftId no longer ` +
                `matches the box's own, or this closure was already applied by an earlier ` +
                `delivery; skipping as a no-op`,
            );
            continue;
          }
        }
      }

      // Exception facts (undo/clear/disassemble/reprint -- Task 4 wires up
      // "undo", Tasks 5-7 extend the same applyExceptions method with the
      // other three kinds). Applied LAST, after both items and box closures
      // above, so an exception targeting a scan or closure carried in this
      // very same batch always applies to a row that already exists -- the
      // device can never enqueue an exception fact ahead of the scan it
      // corrects, since the fact is only ever created after the operator has
      // already made that scan (see the design spec's "Sync protocol"
      // section).
      if (body.exceptions.length > 0) {
        await this.applyExceptions(
          tx,
          tenantId,
          authenticatedTerminalId!,
          sortExceptions(body.exceptions),
        );
      }

      return { applied: body.items.length, alreadyApplied: false, conflicts: batchConflicts };
    });
  }

  /**
   * Applies undo/clear/disassemble/reprint facts, one at a time in the
   * sorted order the caller already computed (`sortExceptions` -- boxId,
   * then kind, then codeHash, for the same 40P01-avoidance reasoning as
   * every other multi-row loop in this file). Every kind writes its own
   * `box_exceptions` row regardless of whether anything else changed -- a
   * no-op (redelivery, a code already released elsewhere) is still a
   * recorded attempt, matching the pattern the box-closures loop above
   * already established for exactly this class of redelivery/race.
   *
   * "undo" (Task 4), "clear" (Task 5), and "disassemble" (Task 6) are
   * handled today; "reprint" is added by Task 7 as a further branch in this
   * same loop body, not as a rewrite of it.
   *
   * `ex.boxId` is the device-local box id string, exactly like
   * `ScanItemDto.boxId` and the box-closures loop's own `closure.boxId`
   * above -- NOT the server's `boxes.id` UUID. Both `box_items.box_id` and
   * `box_exceptions.box_id` are Postgres `uuid` columns, so it must be
   * resolved to the server id, once per exception, BEFORE any kind-specific
   * branch runs (and before the `clear`/`disassemble` branches Task 5 adds
   * next): see the resolution step below, copied from the box-closures
   * loop's own four-column match.
   *
   * `tx` is loosely typed to the exact operations this method (and
   * `releaseCode`) actually use, same as `SsccService.recordConsumedSerial`
   * and `PickupOrdersService.recordScanRejection`: the transaction callback
   * argument `this.db.transaction(async (tx) => ...)` infers as a
   * `PgTransaction`, which does not structurally satisfy the full `Db` type
   * (it has no `$client`), so a parameter typed as plain `Db` would reject
   * every call site that passes it a transaction handle.
   */
  private async applyExceptions(
    tx: Pick<Db, "select" | "insert" | "update" | "delete">,
    tenantId: string,
    authenticatedTerminalId: string,
    exceptions: ExceptionDto[],
  ): Promise<void> {
    for (const ex of exceptions) {
      // Resolve the device-local `ex.boxId` to the server's `boxes.id`
      // UUID, matching on ALL FOUR of `boxes_device_box_uq`'s own columns --
      // copied from the box-closures loop's `terminalCondition`/WHERE shape
      // above, not a new comparison style: a bare (tenant, deviceBoxId)
      // match is not enough to identify one box (two terminals in one
      // tenant can both call a box "b1", or one device can reuse "b1" after
      // a shift change).
      const terminalCondition = eq(schema.boxes.terminalId, authenticatedTerminalId);
      const [boxRow] = await tx
        .select({ id: schema.boxes.id })
        .from(schema.boxes)
        .where(
          and(
            eq(schema.boxes.tenantId, tenantId),
            eq(schema.boxes.shiftId, ex.shiftId),
            terminalCondition,
            eq(schema.boxes.deviceBoxId, ex.boxId),
          ),
        );

      // Zero rows is "nothing to apply this exception to", not an error --
      // same reasoning as the box-closures loop's own `rowCount === 0`
      // branch above ("Zero rows is..."): a genuinely stale/unknown
      // deviceBoxId, or a race with the box's own first item, is an
      // ordinary input, and throwing here would 500 the whole batch. This
      // file's own retry semantics mean the device resends a failing batch
      // under the SAME batchId forever, so a throw here would wedge that
      // device's queue permanently -- exactly the failure this resolution
      // step exists to prevent. `box_exceptions.box_id` also carries a NOT
      // NULL foreign key onto `boxes(tenant_id, id)` (platform.ts), so an
      // audit row naming an unresolved box could not be written even if
      // this tried -- there is no partial write to make here, only the log.
      if (!boxRow) {
        this.logger.warn(
          `Exception ${ex.kind} for deviceBoxId ${ex.boxId} (tenant ${tenantId}, shift ` +
            `${ex.shiftId}, terminal ${authenticatedTerminalId}) matched no box row -- box was ` +
            `never created, belongs to a different shift/terminal, or is otherwise ` +
            `unresolvable; skipping as a no-op`,
        );
        continue;
      }
      const resolvedBoxId = boxRow.id;

      if (ex.kind === "undo" && ex.codeHash) {
        await this.releaseCode(tx, tenantId, ex.codeHash, ex.shiftId, authenticatedTerminalId);
        await tx
          .update(schema.boxItems)
          .set({ removedAt: sql`now()` })
          .where(
            and(
              eq(schema.boxItems.tenantId, tenantId),
              eq(schema.boxItems.boxId, resolvedBoxId),
              eq(schema.boxItems.codeHash, ex.codeHash),
              isNull(schema.boxItems.displacedAt),
              isNull(schema.boxItems.removedAt),
            ),
          );
      } else if (ex.kind === "clear") {
        // Guarded to a box that is STILL OPEN (`closedAt IS NULL`): "clear"
        // empties a box the operator can keep packing into, never one
        // that's already been closed and labelled -- reaching into a
        // closed box is "disassemble" (Task 6), a distinct kind with its
        // own guard. The resolution step above already confirmed
        // `resolvedBoxId` names a real row for this exception's own
        // (tenantId, shiftId, terminalId, deviceBoxId); this second lookup
        // exists only to read that row's CURRENT `closedAt`, not to
        // re-resolve identity, so it queries by `resolvedBoxId` (the
        // server UUID), never `ex.boxId` again.
        const [openBox] = await tx
          .select({ id: schema.boxes.id })
          .from(schema.boxes)
          .where(
            and(
              eq(schema.boxes.tenantId, tenantId),
              eq(schema.boxes.id, resolvedBoxId),
              isNull(schema.boxes.closedAt),
            ),
          );
        if (openBox) {
          await this.emptyBox(tx, tenantId, resolvedBoxId, ex.shiftId, authenticatedTerminalId);
        }
      } else if (ex.kind === "disassemble") {
        // Guarded to a box that is CLOSED (`closedAt IS NOT NULL`) and not
        // already disassembled (`disassembledAt IS NULL`): "disassemble"
        // reaches into an already-closed, already-labelled box and retires
        // it -- the mirror image of "clear" above, which only ever acts on
        // a box still open for packing. Both predicates are required:
        // `closedAt IS NOT NULL` rules out ever touching a box "clear"
        // should have handled instead, and `disassembledAt IS NULL` stops a
        // redelivered/duplicate "disassemble" (or two independent ones
        // targeting the same box) from re-stamping `disassembledAt` with a
        // fresh `now()` a second time -- releasing the same (already
        // released) items a second time would itself be harmless, but
        // silently overwriting the FIRST disassembly's own timestamp would
        // not be. Scoped by `resolvedBoxId`, matching every other lookup in
        // this method (see the resolution step's own comment) -- not
        // `ex.boxId` again.
        const [closedBox] = await tx
          .select({ id: schema.boxes.id })
          .from(schema.boxes)
          .where(
            and(
              eq(schema.boxes.tenantId, tenantId),
              eq(schema.boxes.id, resolvedBoxId),
              isNotNull(schema.boxes.closedAt),
              isNull(schema.boxes.disassembledAt),
            ),
          );
        if (closedBox) {
          await this.emptyBox(tx, tenantId, resolvedBoxId, ex.shiftId, authenticatedTerminalId);

          // The box's own retirement. `sscc` is deliberately left
          // untouched -- it stays on the row as a historical record of what
          // was printed and applied to the physical box; only
          // `disassembledAt` marks the box itself retired (excluded from
          // "active" listings). The "sscc never reused" guarantee is not
          // enforced by anything here: it lives entirely in
          // `SsccService.allocate`'s counter, which only ever advances
          // forward and never reads `boxes` at all, so a retired box's sscc
          // cannot be handed to a NEW box by construction -- see
          // sscc.e2e.test.ts's "disassemble retires an SSCC for good" test,
          // which locks that existing property down against this new
          // caller.
          await tx
            .update(schema.boxes)
            .set({ disassembledAt: sql`now()` })
            .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.id, resolvedBoxId)));
        }
      }
      // "reprint" writes only the audit row below, added in Task 7. Every
      // branch above (and every one still to come) uses `resolvedBoxId`,
      // never `ex.boxId`.
      await tx.insert(schema.boxExceptions).values({
        tenantId,
        kind: ex.kind,
        boxId: resolvedBoxId,
        codeHash: ex.codeHash,
        shiftId: ex.shiftId,
        terminalId: authenticatedTerminalId,
        operatorId: ex.operatorId,
        reason: ex.reason,
        occurredAt: new Date(ex.occurredAt),
      });
    }
  }

  /** Releases all active memberships without per-code lock-order races. */
  private async emptyBox(
    tx: Pick<Db, "select" | "update" | "delete">,
    tenantId: string,
    resolvedBoxId: string,
    shiftId: string,
    terminalId: string,
  ): Promise<void> {
    const activeHashes = tx
      .select({ codeHash: schema.boxItems.codeHash })
      .from(schema.boxItems)
      .where(
        and(
          eq(schema.boxItems.tenantId, tenantId),
          eq(schema.boxItems.boxId, resolvedBoxId),
          isNull(schema.boxItems.displacedAt),
          isNull(schema.boxItems.removedAt),
        ),
      )
      .orderBy(schema.boxItems.codeHash);
    await tx
      .delete(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          inArray(schema.codeRegistry.codeHash, activeHashes),
          eq(schema.codeRegistry.shiftId, shiftId),
          eq(schema.codeRegistry.terminalId, terminalId),
        ),
      );

    await tx
      .update(schema.boxItems)
      .set({ removedAt: sql`now()` })
      .where(
        and(
          eq(schema.boxItems.tenantId, tenantId),
          eq(schema.boxItems.boxId, resolvedBoxId),
          isNull(schema.boxItems.displacedAt),
          isNull(schema.boxItems.removedAt),
        ),
      );
  }

  /**
   * Releases a code claim, scoped to the EXACT scan that still holds it
   * (tenant + codeHash + shiftId + terminalId). If the code was displaced
   * to another terminal in the meantime (06b), this WHERE matches nothing
   * -- a harmless no-op, since the code was never really this device's to
   * release once displaced (see the design spec's "Releasing a code"
   * section).
   */
  private async releaseCode(
    tx: Pick<Db, "delete">,
    tenantId: string,
    codeHash: string,
    shiftId: string,
    terminalId: string | null,
  ): Promise<void> {
    const terminalCondition =
      terminalId === null
        ? isNull(schema.codeRegistry.terminalId)
        : eq(schema.codeRegistry.terminalId, terminalId);
    await tx
      .delete(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          eq(schema.codeRegistry.codeHash, codeHash),
          eq(schema.codeRegistry.shiftId, shiftId),
          terminalCondition,
        ),
      );
  }
}
