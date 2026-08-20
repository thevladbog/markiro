import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatSsccWithAi } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { upperBoundCondition } from "../../lib/date-range";
import { classifySearchInput } from "./input-classifier";
import type {
  BoxCardDto,
  ClassifySearchResponseDto,
  CodeCardDto,
  CodeHistoryEvent,
  CodeListItemDto,
  CodeStatus,
  ListCodesQueryDto,
  ListCodesResponseDto,
} from "./dto";

const PAGE_SIZE = 50;

/** Tie-break rank for `CodeHistoryEvent.type` when two events share the same `at` -- see `getCodeCard`. */
const EVENT_TYPE_RANK: Record<CodeHistoryEvent["type"], number> = {
  scanned: 0,
  box_added: 1,
  box_displaced: 2,
  box_removed: 3,
  box_disassembled: 4,
  pickup_locked: 5,
  pickup_resolved: 6,
};

interface CodeListRow {
  codeHash: string;
  gtin14: string;
  serial: string;
  productId: string | null;
  productName: string | null;
  status: "free" | "aggregated" | "written_off";
  scannedAt: Date;
  boxId: string | null;
  boxSscc: string | null;
}

@Injectable()
export class CodeSearchService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `exists (...)` fragment for the "aggregated" branch of the derived
   * status: a `box_items` row this code still owns (`displaced_at IS NULL
   * AND removed_at IS NULL`, same predicate `BoxesService.listBoxes` uses
   * for `itemCount`) whose box has not been disassembled.
   */
  private readonly aggregatedSql = sql`exists (
    select 1 from ${schema.boxItems} bi
    join ${schema.boxes} b on b.tenant_id = bi.tenant_id and b.id = bi.box_id
    where bi.tenant_id = ${schema.codeRegistry.tenantId}
      and bi.code_hash = ${schema.codeRegistry.codeHash}
      and bi.displaced_at is null and bi.removed_at is null
      and b.disassembled_at is null)`;

  /**
   * `exists (...)` fragment for the "written_off" branch: an active (not
   * voided) `pickup_order_items` row whose `km_key` this code's own
   * `(gtin14, serial)` reconstructs. `written_off` wins over `aggregated`
   * in the CASE below -- a written-off unit is gone even if its box row
   * was never explicitly disassembled.
   */
  private readonly writtenOffSql = sql`exists (
    select 1 from ${schema.pickupOrderItems} poi
    where poi.tenant_id = ${schema.codes.tenantId}
      and poi.voided = false
      and poi.km_key = '01' || ${schema.codes.gtin14} || '21' || ${schema.codes.serial})`;

  /**
   * Per-row correlated scalar subselects for the code's current box (Task
   * "Registry listing performance", item b): each probes
   * `box_items_tenant_code_idx` (`tenant_id, code_hash`) directly instead of
   * joining a `DISTINCT ON` derived table built over ALL active `box_items`
   * rows for the tenant. Same "at most one row, newest `added_at` wins"
   * semantics and the same non-disassembled/active-row filters as the old
   * derived table. Two separate subqueries (boxId, boxSscc) rather than one
   * LATERAL join -- drizzle-orm has no first-class LATERAL join builder, and
   * a pair of index-driven scalar subselects costs the planner the same one
   * index probe per row either way.
   */
  private readonly currentBoxIdSql = sql<string | null>`(
    select bi.box_id from ${schema.boxItems} bi
    join ${schema.boxes} b on b.tenant_id = bi.tenant_id and b.id = bi.box_id
    where bi.tenant_id = ${schema.codeRegistry.tenantId}
      and bi.code_hash = ${schema.codeRegistry.codeHash}
      and bi.displaced_at is null and bi.removed_at is null
      and b.disassembled_at is null
    order by bi.added_at desc limit 1)`;

  private readonly currentBoxSsccSql = sql<string | null>`(
    select b.sscc from ${schema.boxItems} bi
    join ${schema.boxes} b on b.tenant_id = bi.tenant_id and b.id = bi.box_id
    where bi.tenant_id = ${schema.codeRegistry.tenantId}
      and bi.code_hash = ${schema.codeRegistry.codeHash}
      and bi.displaced_at is null and bi.removed_at is null
      and b.disassembled_at is null
    order by bi.added_at desc limit 1)`;

  /**
   * `classifySearchInput` is pure (SSCC-vs-KM shape only); this is the one
   * place that actually looks the classified value up, tenant-scoped. Two
   * distinct 404 reasons matter to the caller: `unrecognized` (the typed/
   * scanned text was neither an SSCC nor a KM shape -- nothing to look up)
   * vs `not_found` (well-formed, but this tenant has no such box/code).
   */
  async classify(tenantId: string, q: string): Promise<ClassifySearchResponseDto> {
    const classified = classifySearchInput(q);
    if (classified.kind === "unrecognized") {
      throw new NotFoundException({ code: "unrecognized" });
    }
    if (classified.kind === "sscc") {
      const [box] = await this.db
        .select({ id: schema.boxes.id })
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, classified.sscc)));
      if (!box) throw new NotFoundException({ code: "not_found" });
      return { type: "box" as const, boxId: box.id };
    }
    const [code] = await this.db
      .select({ codeHash: schema.codeRegistry.codeHash })
      .from(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          eq(schema.codeRegistry.codeHash, classified.codeHash),
        ),
      );
    if (!code) throw new NotFoundException({ code: "not_found" });
    return { type: "code" as const, codeHash: code.codeHash };
  }

  /**
   * `code_registry` (the owner scan per code, tenant-wide) INNER JOINed to
   * `codes` on ALL THREE of `codes`' primary-key columns -- `tenant_id`,
   * `code_hash`, AND `scanned_at` -- not just `(tenant_id, code_hash)`.
   * `codes` is partitioned by `scanned_at` and can hold MULTIPLE rows per
   * `code_hash` (one per scan claim from different shifts/terminals, see
   * codes.ts); `code_registry.scanned_at` is the timestamp of the row that
   * currently OWNS the code, so joining on all three columns is both what
   * lets Postgres prune to a single partition and what picks out exactly
   * that one owner row instead of every historical claim.
   *
   * `products` is LEFT JOINed on `(tenant_id, gtin14)` -- a scanned GTIN
   * need not be a registered product. The current box is resolved through a
   * `DISTINCT ON (code_hash)` derived table, not a plain LEFT JOIN on
   * `code_hash` alone: a code can have many historical `box_items` rows
   * (displaced/removed ones are never deleted, see boxItems' own schema
   * comment), and "at most one ACTIVE row per code" is an APPLICATION
   * invariant only -- `box_items`' primary key is `(tenant_id, box_id,
   * code_hash)`, which does not itself forbid two different boxes both
   * holding an active row for the same code_hash. `DISTINCT ON (code_hash)
   * ORDER BY code_hash, added_at DESC` makes the "exactly one row per code"
   * guarantee explicit and deterministic in the query itself (newest
   * `added_at` wins if the invariant is ever violated), so this join can
   * never duplicate a `code_registry` row even if that invariant breaks.
   */
  async listCodes(tenantId: string, query: ListCodesQueryDto): Promise<ListCodesResponseDto> {
    const statusSql = sql<string>`case
      when ${this.writtenOffSql} then 'written_off'
      when ${this.aggregatedSql} then 'aggregated'
      else 'free' end`;

    // A date-only `to` (the admin sends `YYYY-MM-DD`) would exclude the whole
    // day it names under a plain `lte` -- switch to an exclusive `lt`
    // against the START OF THE NEXT DAY for that shape only; a `to` that
    // already carries a real time-of-day keeps the inclusive `lte` it always
    // had. See `upperBoundCondition`/`listCodesQuerySchema`.
    const toCondition = upperBoundCondition(schema.codeRegistry.scannedAt, query.to);

    const where = and(
      eq(schema.codeRegistry.tenantId, tenantId),
      query.shiftId ? eq(schema.codeRegistry.shiftId, query.shiftId) : undefined,
      query.from ? gte(schema.codeRegistry.scannedAt, query.from) : undefined,
      toCondition,
      query.productId ? eq(schema.products.id, query.productId) : undefined,
      query.status ? sql`(${statusSql}) = ${query.status}` : undefined,
    );

    const baseQuery = this.db
      .select({
        codeHash: schema.codeRegistry.codeHash,
        gtin14: schema.codes.gtin14,
        serial: schema.codes.serial,
        productId: schema.products.id,
        productName: schema.products.name,
        status: statusSql,
        scannedAt: schema.codeRegistry.scannedAt,
        boxId: this.currentBoxIdSql,
        boxSscc: this.currentBoxSsccSql,
      })
      .from(schema.codeRegistry)
      .innerJoin(
        schema.codes,
        and(
          eq(schema.codes.tenantId, schema.codeRegistry.tenantId),
          eq(schema.codes.codeHash, schema.codeRegistry.codeHash),
          eq(schema.codes.scannedAt, schema.codeRegistry.scannedAt),
        ),
      )
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.codeRegistry.tenantId),
          eq(schema.products.gtin14, schema.codes.gtin14),
        ),
      )
      .where(where);

    // The count only needs `codes` (status derives from it) -- `products`
    // is pulled in only when a filter actually references it (either
    // directly via `productId`, or because `status` is unfiltered and we
    // still don't need `products` for that -- so really: only `productId`
    // ever needs it). Neither `products` nor the old `current_box` derived
    // table are needed here at all otherwise, since `total` never reads
    // their columns.
    let countQuery = this.db
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.codeRegistry)
      .innerJoin(
        schema.codes,
        and(
          eq(schema.codes.tenantId, schema.codeRegistry.tenantId),
          eq(schema.codes.codeHash, schema.codeRegistry.codeHash),
          eq(schema.codes.scannedAt, schema.codeRegistry.scannedAt),
        ),
      )
      .$dynamic();
    if (query.productId) {
      countQuery = countQuery.leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.codeRegistry.tenantId),
          eq(schema.products.gtin14, schema.codes.gtin14),
        ),
      );
    }

    const [rows, countRows] = await Promise.all([
      baseQuery
        .orderBy(sql`${schema.codeRegistry.scannedAt} desc, ${schema.codeRegistry.codeHash}`)
        .limit(PAGE_SIZE)
        .offset((query.page - 1) * PAGE_SIZE) as Promise<CodeListRow[]>,
      countQuery.where(where) as Promise<{ total: number }[]>,
    ]);
    const total = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => this.toDto(row)),
      page: query.page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total,
    };
  }

  /**
   * `GET /code-search/codes/:codeHash`. Reuses `aggregatedSql`/`writtenOffSql`
   * as a single-row variant of `listCodes`' derived status, then assembles
   * the full movement history from several small queries merged and sorted
   * in TS (readable beats one SQL union at card scale -- see the task brief).
   */
  async getCodeCard(tenantId: string, codeHash: string): Promise<CodeCardDto> {
    const statusSql = sql<string>`case
      when ${this.writtenOffSql} then 'written_off'
      when ${this.aggregatedSql} then 'aggregated'
      else 'free' end`;

    const [row] = await this.db
      .select({
        codeHash: schema.codeRegistry.codeHash,
        gtin14: schema.codes.gtin14,
        serial: schema.codes.serial,
        productId: schema.products.id,
        productName: schema.products.name,
        status: statusSql,
      })
      .from(schema.codeRegistry)
      .innerJoin(
        schema.codes,
        and(
          eq(schema.codes.tenantId, schema.codeRegistry.tenantId),
          eq(schema.codes.codeHash, schema.codeRegistry.codeHash),
          eq(schema.codes.scannedAt, schema.codeRegistry.scannedAt),
        ),
      )
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.codeRegistry.tenantId),
          eq(schema.products.gtin14, schema.codes.gtin14),
        ),
      )
      .where(
        and(eq(schema.codeRegistry.tenantId, tenantId), eq(schema.codeRegistry.codeHash, codeHash)),
      );

    if (!row) throw new NotFoundException();

    const [currentBoxRow] = await this.db
      .select({ boxId: schema.boxItems.boxId, boxSscc: schema.boxes.sscc })
      .from(schema.boxItems)
      .innerJoin(
        schema.boxes,
        and(
          eq(schema.boxes.tenantId, schema.boxItems.tenantId),
          eq(schema.boxes.id, schema.boxItems.boxId),
        ),
      )
      .where(
        and(
          eq(schema.boxItems.tenantId, tenantId),
          eq(schema.boxItems.codeHash, codeHash),
          sql`${schema.boxItems.displacedAt} is null`,
          sql`${schema.boxItems.removedAt} is null`,
          sql`${schema.boxes.disassembledAt} is null`,
        ),
      )
      .orderBy(desc(schema.boxItems.addedAt))
      .limit(1);

    const history = await this.buildCodeHistory(tenantId, codeHash);

    return {
      codeHash: row.codeHash,
      gtin14: row.gtin14,
      serial: row.serial,
      productId: row.productId,
      productName: row.productName,
      status: row.status as CodeStatus,
      currentBox: currentBoxRow
        ? {
            id: currentBoxRow.boxId,
            sscc: currentBoxRow.boxSscc === null ? null : formatSsccWithAi(currentBoxRow.boxSscc),
          }
        : null,
      history,
    };
  }

  /**
   * History assembly, brief Step 2: several small queries merged and sorted
   * ascending by `at` in TS.
   */
  private async buildCodeHistory(tenantId: string, codeHash: string): Promise<CodeHistoryEvent[]> {
    const events: CodeHistoryEvent[] = [];

    // 1. `scanned` events -- via `codes`' distinct canonicalRaw values (scan_events
    // stores raw text, not hashes).
    const codeRows = await this.db
      .select({
        canonicalRaw: schema.codes.canonicalRaw,
        gtin14: schema.codes.gtin14,
        serial: schema.codes.serial,
        shiftId: schema.codes.shiftId,
      })
      .from(schema.codes)
      .where(and(eq(schema.codes.tenantId, tenantId), eq(schema.codes.codeHash, codeHash)));

    const raws = [...new Set(codeRows.map((r) => r.canonicalRaw))];
    const shiftIds = [...new Set(codeRows.map((r) => r.shiftId))];
    if (raws.length > 0 && shiftIds.length > 0) {
      // `scan_events.raw` is the ORIGINAL wire text (whatever the scanner
      // sent), while `codes.canonicalRaw` is `canonicalizeKm`'s output --
      // edge whitespace (space/tab) trimmed, then a leading `]d2` AIM
      // symbology-identifier prefix stripped, then trimmed again (see
      // `canonicalizeKm` in packages/domain/src/gs1/km.ts). Comparing
      // `raw` to `canonicalRaw` by plain equality therefore misses every
      // scan whose wire text carried the `]d2` prefix or surrounding
      // whitespace -- this mirrors `canonicalizeKm`'s edge-trim + prefix
      // strip in SQL so the two sides compare like-for-like.
      const normalizedRaw = sql`btrim(regexp_replace(btrim(${schema.scanEvents.raw}, ' ' || chr(9)), '^\]d2', ''), ' ' || chr(9))`;
      const scanRows = await this.db
        .select({
          verdict: schema.scanEvents.verdict,
          shiftId: schema.scanEvents.shiftId,
          terminalId: schema.scanEvents.terminalId,
          operatorId: schema.scanEvents.operatorId,
          scannedAt: schema.scanEvents.scannedAt,
        })
        .from(schema.scanEvents)
        .where(
          and(
            eq(schema.scanEvents.tenantId, tenantId),
            inArray(schema.scanEvents.shiftId, shiftIds),
            inArray(normalizedRaw, raws),
          ),
        );
      for (const r of scanRows) {
        events.push({
          type: "scanned",
          at: r.scannedAt,
          verdict: r.verdict,
          shiftId: r.shiftId,
          terminalId: r.terminalId,
          operatorId: r.operatorId,
        });
      }
    }

    // 2. box_added/box_displaced/box_removed -- all box_items rows for the
    // hash (every box, including displaced/removed ones), joined to boxes.
    const itemRows = await this.db
      .select({
        boxId: schema.boxItems.boxId,
        boxSscc: schema.boxes.sscc,
        addedAt: schema.boxItems.addedAt,
        displacedAt: schema.boxItems.displacedAt,
        removedAt: schema.boxItems.removedAt,
      })
      .from(schema.boxItems)
      .innerJoin(
        schema.boxes,
        and(
          eq(schema.boxes.tenantId, schema.boxItems.tenantId),
          eq(schema.boxes.id, schema.boxItems.boxId),
        ),
      )
      .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.codeHash, codeHash)));

    const boxSsccById = new Map<string, string | null>();
    for (const r of itemRows) {
      const boxSscc = r.boxSscc === null ? null : formatSsccWithAi(r.boxSscc);
      boxSsccById.set(r.boxId, boxSscc);
      events.push({ type: "box_added", at: r.addedAt, boxId: r.boxId, boxSscc });
      if (r.displacedAt)
        events.push({ type: "box_displaced", at: r.displacedAt, boxId: r.boxId, boxSscc });
      if (r.removedAt)
        events.push({ type: "box_removed", at: r.removedAt, boxId: r.boxId, boxSscc });
    }

    // 3. box_disassembled -- box_exceptions (kind='disassemble') for those
    // boxIds, LEFT JOINed to disaggregationDocuments for docNo.
    const boxIds = [...boxSsccById.keys()];
    if (boxIds.length > 0) {
      const excRows = await this.db
        .select({
          boxId: schema.boxExceptions.boxId,
          reason: schema.boxExceptions.reason,
          occurredAt: schema.boxExceptions.occurredAt,
          disaggregationDocumentId: schema.boxExceptions.disaggregationDocumentId,
          disaggregationDocNo: schema.disaggregationDocuments.docNo,
        })
        .from(schema.boxExceptions)
        .leftJoin(
          schema.disaggregationDocuments,
          and(
            eq(schema.disaggregationDocuments.tenantId, schema.boxExceptions.tenantId),
            eq(schema.disaggregationDocuments.id, schema.boxExceptions.disaggregationDocumentId),
          ),
        )
        .where(
          and(
            eq(schema.boxExceptions.tenantId, tenantId),
            eq(schema.boxExceptions.kind, "disassemble"),
            inArray(schema.boxExceptions.boxId, boxIds),
          ),
        );
      for (const r of excRows) {
        events.push({
          type: "box_disassembled",
          at: r.occurredAt,
          boxId: r.boxId,
          boxSscc: boxSsccById.get(r.boxId) ?? null,
          reason: r.reason,
          disaggregationDocumentId: r.disaggregationDocumentId,
          disaggregationDocNo: r.disaggregationDocNo,
        });
      }
    }

    // 4. pickup_locked/pickup_resolved -- pickup_order_items on the
    // reconstructed kmKey for each distinct gtin/serial of the code.
    const kmKeys = [...new Set(codeRows.map((r) => `01${r.gtin14}21${r.serial}`))];
    if (kmKeys.length > 0) {
      const pickupRows = await this.db
        .select({
          orderId: schema.pickupOrderItems.orderId,
          scannedAt: schema.pickupOrderItems.scannedAt,
          orderNo: schema.pickupOrders.orderNo,
          orderStatus: schema.pickupOrders.status,
          resolvedAt: schema.pickupOrders.resolvedAt,
          createdAt: schema.pickupOrders.createdAt,
        })
        .from(schema.pickupOrderItems)
        .innerJoin(
          schema.pickupOrders,
          and(
            eq(schema.pickupOrders.tenantId, schema.pickupOrderItems.tenantId),
            eq(schema.pickupOrders.id, schema.pickupOrderItems.orderId),
          ),
        )
        .where(
          and(
            eq(schema.pickupOrderItems.tenantId, tenantId),
            inArray(schema.pickupOrderItems.kmKey, kmKeys),
          ),
        );
      for (const r of pickupRows) {
        events.push({
          type: "pickup_locked",
          at: r.scannedAt,
          orderId: r.orderId,
          orderNo: r.orderNo,
        });
        if (r.resolvedAt || r.orderStatus === "cancelled") {
          // A cancelled order with no resolvedAt falls back to its
          // createdAt, which precedes the order's own pickup_locked
          // (scannedAt) -- floor the fallback at scannedAt so this event
          // never sorts ahead of the lock it resolves.
          const resolvedAt =
            r.resolvedAt ?? (r.createdAt > r.scannedAt ? r.createdAt : r.scannedAt);
          events.push({
            type: "pickup_resolved",
            at: resolvedAt,
            orderId: r.orderId,
            orderNo: r.orderNo,
            orderStatus: r.orderStatus as "punched" | "writtenoff" | "cancelled",
          });
        }
      }
    }

    // Same-`at` events are tie-broken by a fixed type rank rather than push
    // order, so e.g. `pickup_resolved` never sorts before its own
    // `pickup_locked` even when both land on the exact same instant.
    events.sort(
      (a, b) =>
        a.at.getTime() - b.at.getTime() || EVENT_TYPE_RANK[a.type] - EVENT_TYPE_RANK[b.type],
    );
    return events;
  }

  /**
   * `GET /code-search/boxes/:boxId`. Box (+shift join for productId,
   * products for name), items (LEFT JOIN codes for gtin/serial via a
   * DISTINCT ON dedupe -- `codes` may hold multiple rows per hash), all
   * exceptions (LEFT JOIN disaggregationDocuments), and pickup orders via
   * `pickup_order_boxes` ⋈ `pickup_orders`.
   */
  async getBoxCard(tenantId: string, boxId: string): Promise<BoxCardDto> {
    const [box] = await this.db
      .select({
        id: schema.boxes.id,
        sscc: schema.boxes.sscc,
        shiftId: schema.boxes.shiftId,
        terminalId: schema.boxes.terminalId,
        operatorId: schema.boxes.operatorId,
        openedAt: schema.boxes.openedAt,
        closedAt: schema.boxes.closedAt,
        disassembledAt: schema.boxes.disassembledAt,
        productId: schema.products.id,
        productName: schema.products.name,
      })
      .from(schema.boxes)
      .leftJoin(
        schema.shifts,
        and(
          eq(schema.shifts.tenantId, schema.boxes.tenantId),
          eq(schema.shifts.id, schema.boxes.shiftId),
        ),
      )
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.shifts.tenantId),
          eq(schema.products.id, schema.shifts.productId),
        ),
      )
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.id, boxId)));

    if (!box) throw new NotFoundException();

    const itemRows = await this.db
      .select({
        codeHash: schema.boxItems.codeHash,
        addedAt: schema.boxItems.addedAt,
        displacedAt: schema.boxItems.displacedAt,
        removedAt: schema.boxItems.removedAt,
      })
      .from(schema.boxItems)
      .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)))
      .orderBy(desc(schema.boxItems.addedAt), schema.boxItems.codeHash);

    const codeHashes = [...new Set(itemRows.map((r) => r.codeHash))];
    const codeDetailsByHash = new Map<string, { gtin14: string; serial: string }>();
    if (codeHashes.length > 0) {
      const codeRows = await this.db
        .selectDistinctOn([schema.codes.codeHash], {
          codeHash: schema.codes.codeHash,
          gtin14: schema.codes.gtin14,
          serial: schema.codes.serial,
        })
        .from(schema.codes)
        .where(and(eq(schema.codes.tenantId, tenantId), inArray(schema.codes.codeHash, codeHashes)))
        .orderBy(schema.codes.codeHash, desc(schema.codes.scannedAt));
      for (const r of codeRows)
        codeDetailsByHash.set(r.codeHash, { gtin14: r.gtin14, serial: r.serial });
    }

    const items = itemRows.map((r) => {
      const detail = codeDetailsByHash.get(r.codeHash);
      return {
        codeHash: r.codeHash,
        gtin14: detail?.gtin14 ?? null,
        serial: detail?.serial ?? null,
        addedAt: r.addedAt,
        displacedAt: r.displacedAt,
        removedAt: r.removedAt,
      };
    });

    const exceptionRows = await this.db
      .select({
        kind: schema.boxExceptions.kind,
        reason: schema.boxExceptions.reason,
        occurredAt: schema.boxExceptions.occurredAt,
        operatorId: schema.boxExceptions.operatorId,
        disaggregationDocumentId: schema.boxExceptions.disaggregationDocumentId,
        disaggregationDocNo: schema.disaggregationDocuments.docNo,
      })
      .from(schema.boxExceptions)
      .leftJoin(
        schema.disaggregationDocuments,
        and(
          eq(schema.disaggregationDocuments.tenantId, schema.boxExceptions.tenantId),
          eq(schema.disaggregationDocuments.id, schema.boxExceptions.disaggregationDocumentId),
        ),
      )
      .where(
        and(eq(schema.boxExceptions.tenantId, tenantId), eq(schema.boxExceptions.boxId, boxId)),
      );

    const pickupOrderRows = await this.db
      .select({
        orderId: schema.pickupOrderBoxes.orderId,
        orderNo: schema.pickupOrders.orderNo,
        status: schema.pickupOrders.status,
      })
      .from(schema.pickupOrderBoxes)
      .innerJoin(
        schema.pickupOrders,
        and(
          eq(schema.pickupOrders.tenantId, schema.pickupOrderBoxes.tenantId),
          eq(schema.pickupOrders.id, schema.pickupOrderBoxes.orderId),
        ),
      )
      .where(
        and(
          eq(schema.pickupOrderBoxes.tenantId, tenantId),
          eq(schema.pickupOrderBoxes.boxId, boxId),
        ),
      );

    const status: BoxCardDto["status"] = box.disassembledAt
      ? "disassembled"
      : box.closedAt
        ? "closed"
        : "open";

    return {
      id: box.id,
      sscc: box.sscc === null ? null : formatSsccWithAi(box.sscc),
      status,
      shiftId: box.shiftId,
      productId: box.productId,
      productName: box.productName,
      terminalId: box.terminalId,
      operatorId: box.operatorId,
      openedAt: box.openedAt,
      closedAt: box.closedAt,
      disassembledAt: box.disassembledAt,
      items,
      exceptions: exceptionRows,
      pickupOrders: pickupOrderRows,
    };
  }

  private toDto(row: CodeListRow): CodeListItemDto {
    return {
      codeHash: row.codeHash,
      gtin14: row.gtin14,
      serial: row.serial,
      productId: row.productId,
      productName: row.productName,
      status: row.status,
      scannedAt: row.scannedAt,
      boxId: row.boxId,
      boxSscc: row.boxSscc === null ? null : formatSsccWithAi(row.boxSscc),
    };
  }
}
