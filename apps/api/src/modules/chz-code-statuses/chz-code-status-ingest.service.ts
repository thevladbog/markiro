import { Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { DB } from "../../auth/auth.module";

/**
 * How many rows one pass walks, shared across all three phases below (the
 * `codes` cursor walk, the full sweep, and the `inventory_snapshot_codes`
 * anti-join) -- see `ChzCodeStatusIngestService.run`. It is one budget, not
 * one constant reused per phase: a pass must not be able to hold a worker for
 * a multiple of this bound just because the work happens to come from more
 * than one source.
 *
 * Bounded so the first pass for a tenant with existing history cannot hold a
 * worker for the length of its entire history; it simply takes several
 * passes, oldest first.
 */
export const CHZ_CODE_STATUS_INGEST_LIMIT = 50_000;

/**
 * How often the full anti-join sweep (see `sweepCodes`) is allowed to run per
 * tenant. Once a day: the refresh cadence for a code already in the store is
 * daily (see the status->interval rule), so a code that arrives behind the
 * cursor still joins the store within the same period it would have been
 * refreshed in anyway -- there is nothing to gain from sweeping more often.
 */
export const CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Row count per `INSERT` statement. Drizzle builds one SQL tree out of every
 * row's placeholders, and doing that for `CHZ_CODE_STATUS_INGEST_LIMIT` rows
 * in a single statement overflows the call stack before the query reaches
 * Postgres -- so a full batch is written in chunks instead of one insert.
 */
const INSERT_CHUNK_SIZE = 1_000;

export interface ChzCodeStatusIngestResult {
  inserted: number;
  /** The tenant's `codes` cursor after this pass, or null if it has never advanced. */
  watermark: Date | null;
  /** True only when no source had more rows waiting than this pass's shared budget allowed it to walk. */
  caughtUp: boolean;
}

interface CandidateCode {
  codeHash: string;
  gtin14: string;
}

interface ScannedCodeRow extends CandidateCode {
  scannedAt: Date;
}

interface WalkCodesResult {
  inserted: number;
  watermark: Date | null;
  caughtUp: boolean;
  /** How many rows this phase actually fetched -- what it spent of the pass's shared budget. */
  rowsFetched: number;
}

interface AntiJoinResult {
  inserted: number;
  caughtUp: boolean;
  rowsFetched: number;
}

/**
 * Decides which codes belong in `chz_code_statuses` -- nothing about their ЧЗ
 * facts, which the refresh job (a later task) fills in and this service never
 * touches.
 *
 * Three phases feed the same table per pass, sharing one per-pass row budget
 * (`CHZ_CODE_STATUS_INGEST_LIMIT`, see `run`), keyed on `(tenantId,
 * codeHash)`:
 *  - `codes`, walked forward from a per-tenant cursor on `scanned_at`. That
 *    bound is what lets Postgres prune to the monthly partitions that can
 *    actually contain new rows instead of scanning the whole table. This is
 *    the cheap, steady-state path -- but it is an optimisation, not a
 *    correctness mechanism (see the next bullet and `sweepCodes`'s doc).
 *  - A full anti-join sweep over `codes`, run at most once per tenant per
 *    `CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS`. `codes.scanned_at` is the
 *    Station's own clock, not a commit timestamp, and the station-scans
 *    ingest endpoint accepts anything up to three years in the past (see
 *    `WINDOW_PAST_MS` in `station-scans.service.ts`) because a device's queue
 *    can legitimately carry weeks-to-months of backlog after an outage, a
 *    warehoused spare being redeployed, or repeated dead-RTC reboots. A code
 *    can therefore be committed with a `scanned_at` the cursor has already
 *    passed; the cursor's strict `>` would skip it forever. The sweep is the
 *    backstop that catches it.
 *  - `inventory_snapshot_codes`, walked by a plain anti-join every pass. It
 *    is unpartitioned and does not grow per scan, so no cursor is needed --
 *    and it is the only source for a tenant whose history predates Markiro:
 *    those codes arrived through one ordered export and never appear in
 *    `codes`.
 * All three funnel into `insertStatuses`'s single upsert on the shared key,
 * so a code that arrived through more than one path yields exactly one row --
 * see that method's own doc for the one case it updates rather than leaves
 * alone (a null product group becoming resolvable).
 */
@Injectable()
export class ChzCodeStatusIngestService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Spends the pass's one shared row budget in order: the full sweep if it is
   * due, then the cursor walk, then the snapshot anti-join, passing what
   * remains of the budget to each phase and skipping a phase entirely once
   * the budget hits zero. See the class doc for why three phases exist and
   * `CHZ_CODE_STATUS_INGEST_LIMIT` for why they share one budget rather than
   * each carrying its own.
   *
   * `options.limit` overrides the default budget (`CHZ_CODE_STATUS_INGEST_LIMIT`)
   * for this call. It is not a test-only knob: the budget is a property of the
   * call, not a hidden global, which is the honest shape for something a
   * scheduler drives -- the scheduler is free to call with a smaller budget
   * for a tenant it wants to spend less of a tick on, and tests can construct
   * a budget-exhaustion scenario without seeding tens of thousands of rows.
   *
   * The sweep runs first despite being rare (at most once per day per tenant)
   * because it is the only phase that can find codes that arrived behind the
   * cursor -- a normal occurrence for a Station syncing after an outage. A
   * tenant backfilling from deep history (the case the per-pass limit exists
   * for) can fill the cursor walk's entire budget on consecutive passes,
   * starving the sweep and leaving its correctness backstop inactive during
   * the very backfill it is meant to protect. Giving the sweep first claim on
   * the budget costs the steady state almost nothing, while the cursor walk
   * absorbs what is left. A sweep skipped because the budget ran out is not
   * retried that pass (a skipped sweep leaves `lastFullSweepAt` stale so it
   * is retried the next one), but this order ensures it is not skipped for
   * the duration of a multi-pass backfill.
   *
   * One cost of that ordering, worth knowing rather than tripping over: on a
   * cold start (nothing has ever run for a tenant) the sweep and the cursor
   * walk independently discover largely the same rows in the same pass --
   * the sweep's anti-join has no cursor to narrow it, so it sees the same
   * backlog the walk is about to see too. `insertStatuses`'s upsert makes the
   * overlap a no-op rather than a correctness problem -- its `setWhere` only
   * ever fires when a null group is turning non-null, which cannot be true
   * for a row the sweep and the walk resolve to the same group within one
   * pass -- but it is a real redundant-read cost, and it lands during
   * exactly the backfill the per-pass budget exists to bound.
   *
   * A phase skipped because the budget ran out is conservatively counted as
   * "not caught up": with zero budget left there is no way to check whether
   * it actually had more rows waiting without spending more of the budget
   * than the pass is allowed, so the pass reports itself unfinished rather
   * than guessing.
   */
  async run(tenantId: string, options?: { limit?: number }): Promise<ChzCodeStatusIngestResult> {
    const [cursor] = await this.db
      .select({
        lastScannedAt: schema.chzCodeStatusCursors.lastScannedAt,
        lastFullSweepAt: schema.chzCodeStatusCursors.lastFullSweepAt,
      })
      .from(schema.chzCodeStatusCursors)
      .where(eq(schema.chzCodeStatusCursors.tenantId, tenantId));

    let remaining = options?.limit ?? CHZ_CODE_STATUS_INGEST_LIMIT;

    const sweepIsDue =
      !cursor?.lastFullSweepAt ||
      Date.now() - cursor.lastFullSweepAt.getTime() >= CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS;

    let sweepInserted = 0;
    let sweepCaughtUp = true;
    if (sweepIsDue && remaining > 0) {
      const sweep = await this.sweepCodes(tenantId, remaining);
      sweepInserted = sweep.inserted;
      sweepCaughtUp = sweep.caughtUp;
      remaining = Math.max(0, remaining - sweep.rowsFetched);
      await this.markFullSweepRan(tenantId);
    } else if (sweepIsDue) {
      // Defensive only: the sweep is now the first phase to spend the
      // budget, so `remaining` still equals the pass's full limit here and
      // this branch is unreachable with a positive limit. It stays as a
      // guard against a future reorder (or a caller passing `limit: 0`)
      // rather than to document a live path -- the invariant it states (a
      // sweep skipped for lack of budget leaves `lastFullSweepAt` stale, so
      // it is retried next pass) is what phase order guarantees now, not
      // this branch.
      sweepCaughtUp = false;
    }

    const scanned = await this.walkCodes(tenantId, cursor?.lastScannedAt ?? null, remaining);
    remaining = Math.max(0, remaining - scanned.rowsFetched);

    let exportedInserted = 0;
    // Not `true`: with no budget left the snapshot phase never ran, so the
    // pass has not caught up on it and must not claim otherwise.
    let exportedCaughtUp = false;
    if (remaining > 0) {
      const exported = await this.walkSnapshotCodes(tenantId, remaining);
      exportedInserted = exported.inserted;
      exportedCaughtUp = exported.caughtUp;
    }

    return {
      inserted: scanned.inserted + sweepInserted + exportedInserted,
      watermark: scanned.watermark,
      caughtUp: scanned.caughtUp && sweepCaughtUp && exportedCaughtUp,
    };
  }

  /**
   * Forward range scan on `codes.scanned_at`, ordered and bounded on that
   * same column -- deliberately not on `codeHash` -- so Postgres prunes to
   * the months that can contain new rows.
   *
   * Several `codes` rows can share one `scanned_at`. If a batch fills the
   * fetch limit exactly while every row in it shares one timestamp, there is
   * no way to tell from this batch alone whether more rows at that same
   * instant sit just beyond the cutoff; advancing the cursor to it would let
   * the next pass's strict `>` skip them forever. So the cursor only ever
   * advances to a timestamp the batch can prove is fully accounted for: the
   * batch's last timestamp when the batch did not fill the limit (nothing
   * later than "now" can exist that this pass hasn't already seen), or the
   * latest timestamp strictly before the last row's otherwise. When neither
   * is available -- every fetched row shares one timestamp -- the fetch
   * limit for this pass alone is raised until either the table is genuinely
   * drained or a second, later timestamp appears to cut at. That trades one
   * larger query for guaranteed forward progress, rather than the pass
   * looping forever with nothing to show for it -- and it can therefore spend
   * more than its share of the pass's budget in this one rare case; forward
   * progress on the cursor takes priority over the budget when the two
   * conflict, because a cursor that never advances is a worse failure than
   * one pass running a little long.
   */
  private async walkCodes(
    tenantId: string,
    lastScannedAt: Date | null,
    limit: number,
  ): Promise<WalkCodesResult> {
    let effectiveLimit = limit;
    let rows = await this.fetchCodesBatch(tenantId, lastScannedAt, effectiveLimit);
    // Degenerate case: the batch filled the limit and every row in it shares
    // one `scanned_at`, so there is no timestamp in it a cursor could safely
    // stop at (see the method doc). Raising the limit is the only way to
    // find out whether the table truly ends here or just at the fetch
    // boundary. Skip this if the limit was zero or the batch is empty.
    while (
      rows.length === effectiveLimit &&
      rows.length > 0 &&
      rows[0]!.scannedAt.getTime() === rows[rows.length - 1]!.scannedAt.getTime()
    ) {
      effectiveLimit *= 2;
      rows = await this.fetchCodesBatch(tenantId, lastScannedAt, effectiveLimit);
    }

    const drained = rows.length < effectiveLimit;
    let cursorAdvanceTo: Date | null = null;
    if (rows.length > 0) {
      if (drained) {
        cursorAdvanceTo = rows[rows.length - 1]!.scannedAt;
      } else {
        const lastTimestamp = rows[rows.length - 1]!.scannedAt.getTime();
        for (let index = rows.length - 2; index >= 0; index -= 1) {
          if (rows[index]!.scannedAt.getTime() < lastTimestamp) {
            cursorAdvanceTo = rows[index]!.scannedAt;
            break;
          }
        }
      }
    }

    const inserted = await this.insertStatuses(tenantId, rows);

    if (cursorAdvanceTo) {
      await this.db
        .insert(schema.chzCodeStatusCursors)
        .values({ tenantId, lastScannedAt: cursorAdvanceTo })
        .onConflictDoUpdate({
          target: schema.chzCodeStatusCursors.tenantId,
          set: { lastScannedAt: cursorAdvanceTo, updatedAt: new Date() },
        });
    }

    return {
      inserted,
      watermark: cursorAdvanceTo ?? lastScannedAt,
      caughtUp: drained,
      rowsFetched: rows.length,
    };
  }

  private fetchCodesBatch(
    tenantId: string,
    lastScannedAt: Date | null,
    limit: number,
  ): Promise<ScannedCodeRow[]> {
    const conditions = [eq(schema.codes.tenantId, tenantId)];
    if (lastScannedAt) conditions.push(gt(schema.codes.scannedAt, lastScannedAt));
    return this.db
      .select({
        codeHash: schema.codes.codeHash,
        gtin14: schema.codes.gtin14,
        scannedAt: schema.codes.scannedAt,
      })
      .from(schema.codes)
      .where(and(...conditions))
      .orderBy(asc(schema.codes.scannedAt))
      .limit(limit);
  }

  /**
   * Full anti-join sweep over `codes` for one tenant: every hash with no
   * `chz_code_statuses` row, regardless of `scanned_at`. Unlike `walkCodes`
   * this ignores the cursor entirely, so it is the only phase that can find
   * a code committed with a `scanned_at` behind the cursor -- see the class
   * doc for why that is a normal, expected occurrence rather than an edge
   * case. Run at most once per `CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS` (see
   * `run`) precisely because it cannot prune by `scanned_at` and so scans
   * more broadly than the cursor walk.
   */
  private async sweepCodes(tenantId: string, limit: number): Promise<AntiJoinResult> {
    const rows = await this.db
      .selectDistinctOn([schema.codes.codeHash], {
        codeHash: schema.codes.codeHash,
        gtin14: schema.codes.gtin14,
      })
      .from(schema.codes)
      .leftJoin(
        schema.chzCodeStatuses,
        and(
          eq(schema.chzCodeStatuses.tenantId, schema.codes.tenantId),
          eq(schema.chzCodeStatuses.codeHash, schema.codes.codeHash),
        ),
      )
      .where(and(eq(schema.codes.tenantId, tenantId), isNull(schema.chzCodeStatuses.codeHash)))
      .orderBy(schema.codes.codeHash)
      .limit(limit);

    const inserted = await this.insertStatuses(tenantId, rows);
    return { inserted, caughtUp: rows.length < limit, rowsFetched: rows.length };
  }

  private async markFullSweepRan(tenantId: string): Promise<void> {
    const now = new Date();
    await this.db
      .insert(schema.chzCodeStatusCursors)
      .values({ tenantId, lastFullSweepAt: now })
      .onConflictDoUpdate({
        target: schema.chzCodeStatusCursors.tenantId,
        set: { lastFullSweepAt: now, updatedAt: now },
      });
  }

  /**
   * `inventory_snapshot_codes` is not partitioned and does not grow per
   * scan, so a plain anti-join every pass is affordable and needs no cursor
   * of its own -- unlike `codes`.
   */
  private async walkSnapshotCodes(tenantId: string, limit: number): Promise<AntiJoinResult> {
    const rows = await this.db
      .selectDistinctOn([schema.inventorySnapshotCodes.codeHash], {
        codeHash: schema.inventorySnapshotCodes.codeHash,
        gtin14: schema.inventorySnapshotCodes.gtin14,
      })
      .from(schema.inventorySnapshotCodes)
      .leftJoin(
        schema.chzCodeStatuses,
        and(
          eq(schema.chzCodeStatuses.tenantId, schema.inventorySnapshotCodes.tenantId),
          eq(schema.chzCodeStatuses.codeHash, schema.inventorySnapshotCodes.codeHash),
        ),
      )
      .where(
        and(
          eq(schema.inventorySnapshotCodes.tenantId, tenantId),
          isNull(schema.chzCodeStatuses.codeHash),
        ),
      )
      .orderBy(schema.inventorySnapshotCodes.codeHash)
      .limit(limit);

    const inserted = await this.insertStatuses(tenantId, rows);
    return { inserted, caughtUp: rows.length < limit, rowsFetched: rows.length };
  }

  /**
   * Shared by all three sources: dedupe by `codeHash` (a code scanned twice, or
   * present in more than one export, must yield one row), resolve each
   * distinct GTIN's product group in one query, and insert due-immediately
   * rows -- or, for a row another phase already placed, re-resolve its
   * product group if that is the one thing about it still unresolved.
   *
   * That second case (final review, Finding 1) is why this is
   * `onConflictDoUpdate` rather than `onConflictDoNothing`: a code first seen
   * with no ЧЗ group (the bootstrap this whole feature centres on -- an
   * imported inventory export for a product nobody has grouped yet) would
   * otherwise never be asked about again even after the operator gives its
   * product a group, because `cises/info` takes the group as a query
   * parameter and nothing else in this service ever revisits a row that
   * already exists. `setWhere` keeps the update a strict no-op for every
   * settled row -- one that already has a group, or already carries ЧЗ facts
   * from the refresh service -- by firing only when this row's group is
   * still null and the newly-resolved one is not: neither condition can ever
   * be true again once the group is set, so a row is re-grouped at most
   * once, and refreshing it here only touches the columns ingest owns
   * (group, due date), never the ЧЗ facts columns that belong to
   * `ChzCodeStatusRefreshService`.
   */
  private async insertStatuses(tenantId: string, rows: CandidateCode[]): Promise<number> {
    if (rows.length === 0) return 0;

    const gtinByHash = new Map<string, string>();
    for (const row of rows)
      if (!gtinByHash.has(row.codeHash)) gtinByHash.set(row.codeHash, row.gtin14);

    const gtins = [...new Set(gtinByHash.values())];
    const productRows = await this.db
      .select({ gtin14: schema.products.gtin14, code: schema.products.chzProductGroupCode })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), inArray(schema.products.gtin14, gtins)));
    const groupByGtin = new Map(productRows.map((row) => [row.gtin14, row.code]));

    const nextRefreshAt = new Date();
    const values = [...gtinByHash.entries()].map(([codeHash, gtin14]) => ({
      tenantId,
      codeHash,
      chzProductGroupCode: groupByGtin.get(gtin14) ?? null,
      nextRefreshAt,
    }));

    // Chunked rather than one `INSERT ... VALUES` for the whole batch:
    // drizzle's query builder merges every row's placeholders into one SQL
    // tree, and doing that for a batch at `CHZ_CODE_STATUS_INGEST_LIMIT`
    // overflows the call stack before the query ever reaches Postgres.
    let insertedCount = 0;
    for (let offset = 0; offset < values.length; offset += INSERT_CHUNK_SIZE) {
      const chunk = values.slice(offset, offset + INSERT_CHUNK_SIZE);
      const written = await this.db
        .insert(schema.chzCodeStatuses)
        .values(chunk)
        .onConflictDoUpdate({
          target: [schema.chzCodeStatuses.tenantId, schema.chzCodeStatuses.codeHash],
          set: {
            chzProductGroupCode: sql`excluded.chz_product_group_code`,
            // The same JS-computed instant a fresh insert below gets, not a
            // second `sql\`now()\`` evaluated in Postgres: comparing this
            // column against `Date.now()` afterward (tests, and any caller
            // reasoning about "just became due") must not depend on the
            // Node process's clock agreeing with the database server's.
            nextRefreshAt,
            updatedAt: nextRefreshAt,
          },
          setWhere: sql`${schema.chzCodeStatuses.chzProductGroupCode} is null
                        and excluded.chz_product_group_code is not null`,
        })
        // Postgres's standard insert-vs-update discriminator: `xmax` is 0 for
        // a row this statement inserted fresh, non-zero for one it updated
        // via the conflict branch above. Needed because `onConflictDoUpdate`
        // returns both kinds of row, and re-grouping an already-known code is
        // not "a code newly discovered this pass" -- callers of `run()` read
        // `inserted` to mean exactly that.
        .returning({
          codeHash: schema.chzCodeStatuses.codeHash,
          isNewRow: sql<boolean>`(xmax = 0)`,
        });
      insertedCount += written.filter((row) => row.isNewRow).length;
    }
    return insertedCount;
  }
}
