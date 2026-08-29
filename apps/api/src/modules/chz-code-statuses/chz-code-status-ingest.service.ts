import { Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";

import { DB } from "../../auth/auth.module";

/**
 * How many `codes` rows one pass walks. Bounded so the first pass for a tenant
 * with existing history cannot hold a worker for the length of its entire
 * history; it simply takes several passes, oldest first.
 *
 * The `inventory_snapshot_codes` anti-join pass shares this same limit --
 * see `ChzCodeStatusIngestService.run` -- rather than carrying a second,
 * independently-tuned constant.
 */
export const CHZ_CODE_STATUS_INGEST_LIMIT = 50_000;

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
  /** True only when neither source had more rows waiting than this pass walked. */
  caughtUp: boolean;
}

interface CandidateCode {
  codeHash: string;
  gtin14: string;
}

interface ScannedCodeRow extends CandidateCode {
  scannedAt: Date;
}

/**
 * Decides which codes belong in `chz_code_statuses` -- nothing about their ЧЗ
 * facts, which the refresh job (a later task) fills in and this service never
 * touches.
 *
 * Two independent sources feed the same table, keyed on `(tenantId,
 * codeHash)`:
 *  - `codes`, walked forward from a per-tenant cursor on `scanned_at`. That
 *    bound is what lets Postgres prune to the monthly partitions that can
 *    actually contain new rows instead of scanning the whole table.
 *  - `inventory_snapshot_codes`, walked by a plain anti-join every pass. It
 *    is unpartitioned and does not grow per scan, so no cursor is needed --
 *    and it is the only source for a tenant whose history predates Markiro:
 *    those codes arrived through one ordered export and never appear in
 *    `codes`.
 * Both insert with `onConflictDoNothing` on the shared key, so a code that
 * arrived through both yields exactly one row.
 */
@Injectable()
export class ChzCodeStatusIngestService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async run(tenantId: string): Promise<ChzCodeStatusIngestResult> {
    const scanned = await this.walkCodes(tenantId);
    const exported = await this.walkSnapshotCodes(tenantId, CHZ_CODE_STATUS_INGEST_LIMIT);
    return {
      inserted: scanned.inserted + exported.inserted,
      watermark: scanned.watermark,
      caughtUp: scanned.caughtUp && exported.caughtUp,
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
   * looping forever with nothing to show for it.
   */
  private async walkCodes(
    tenantId: string,
  ): Promise<{ inserted: number; watermark: Date | null; caughtUp: boolean }> {
    const [cursor] = await this.db
      .select({ lastScannedAt: schema.chzCodeStatusCursors.lastScannedAt })
      .from(schema.chzCodeStatusCursors)
      .where(eq(schema.chzCodeStatusCursors.tenantId, tenantId));
    const lastScannedAt = cursor?.lastScannedAt ?? null;

    let limit = CHZ_CODE_STATUS_INGEST_LIMIT;
    let rows = await this.fetchCodesBatch(tenantId, lastScannedAt, limit);
    // Degenerate case: the batch filled the limit and every row in it shares
    // one `scanned_at`, so there is no timestamp in it a cursor could safely
    // stop at (see the method doc). Raising the limit is the only way to
    // find out whether the table truly ends here or just at the fetch
    // boundary.
    while (
      rows.length === limit &&
      rows[0]!.scannedAt.getTime() === rows[rows.length - 1]!.scannedAt.getTime()
    ) {
      limit *= 2;
      rows = await this.fetchCodesBatch(tenantId, lastScannedAt, limit);
    }

    const drained = rows.length < limit;
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

    return { inserted, watermark: cursorAdvanceTo ?? lastScannedAt, caughtUp: drained };
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
   * `inventory_snapshot_codes` is not partitioned and does not grow per
   * scan, so a plain anti-join every pass is affordable and needs no cursor
   * of its own -- unlike `codes`.
   */
  private async walkSnapshotCodes(
    tenantId: string,
    limit: number,
  ): Promise<{ inserted: number; caughtUp: boolean }> {
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
    return { inserted, caughtUp: rows.length < limit };
  }

  /**
   * Shared by both sources: dedupe by `codeHash` (a code scanned twice, or
   * present in more than one export, must yield one row), resolve each
   * distinct GTIN's product group in one query, and insert due-immediately
   * rows with `onConflictDoNothing` so a code the other source already
   * placed is left untouched.
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
      const inserted = await this.db
        .insert(schema.chzCodeStatuses)
        .values(chunk)
        .onConflictDoNothing({
          target: [schema.chzCodeStatuses.tenantId, schema.chzCodeStatuses.codeHash],
        })
        .returning({ codeHash: schema.chzCodeStatuses.codeHash });
      insertedCount += inserted.length;
    }
    return insertedCount;
  }
}
