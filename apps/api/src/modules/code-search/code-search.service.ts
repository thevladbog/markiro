import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatSsccWithAi } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { classifySearchInput } from "./input-classifier";
import type {
  ClassifySearchResponseDto,
  CodeListItemDto,
  ListCodesQueryDto,
  ListCodesResponseDto,
} from "./dto";

const PAGE_SIZE = 50;

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
   * need not be a registered product. The current box is resolved with a
   * LEFT JOIN LATERAL rather than a plain LEFT JOIN: a code can have many
   * historical `box_items` rows (displaced/removed ones are never deleted,
   * see boxItems' own schema comment) but at most one ACTIVE one, and the
   * LATERAL's own `WHERE`/`LIMIT 1` keeps that guarantee explicit in the
   * query itself rather than relying on the data never violating it, so no
   * `code_registry` row is ever duplicated by this join.
   */
  async listCodes(tenantId: string, query: ListCodesQueryDto): Promise<ListCodesResponseDto> {
    const statusSql = sql<string>`case
      when ${this.writtenOffSql} then 'written_off'
      when ${this.aggregatedSql} then 'aggregated'
      else 'free' end`;

    const currentBox = this.db
      .select({
        codeHash: schema.boxItems.codeHash,
        boxId: schema.boxItems.boxId,
        boxSscc: schema.boxes.sscc,
      })
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
          sql`${schema.boxItems.displacedAt} is null`,
          sql`${schema.boxItems.removedAt} is null`,
          sql`${schema.boxes.disassembledAt} is null`,
        ),
      )
      .as("current_box");

    const where = and(
      eq(schema.codeRegistry.tenantId, tenantId),
      query.shiftId ? eq(schema.codeRegistry.shiftId, query.shiftId) : undefined,
      query.from ? gte(schema.codeRegistry.scannedAt, query.from) : undefined,
      query.to ? lte(schema.codeRegistry.scannedAt, query.to) : undefined,
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
        boxId: currentBox.boxId,
        boxSscc: currentBox.boxSscc,
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
      .leftJoin(currentBox, eq(currentBox.codeHash, schema.codeRegistry.codeHash))
      .where(where);

    const [rows, countRows] = await Promise.all([
      baseQuery
        .orderBy(sql`${schema.codeRegistry.scannedAt} desc, ${schema.codeRegistry.codeHash}`)
        .limit(PAGE_SIZE)
        .offset((query.page - 1) * PAGE_SIZE) as Promise<CodeListRow[]>,
      this.db
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
        .leftJoin(
          schema.products,
          and(
            eq(schema.products.tenantId, schema.codeRegistry.tenantId),
            eq(schema.products.gtin14, schema.codes.gtin14),
          ),
        )
        .leftJoin(currentBox, eq(currentBox.codeHash, schema.codeRegistry.codeHash))
        .where(where),
    ]);
    const total = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => this.toDto(row)),
      page: query.page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total,
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
