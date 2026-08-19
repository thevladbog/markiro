import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatSsccWithAi } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import type { BoxDto, ListBoxesQueryDto, ListBoxesResponseDto } from "./dto";

interface BoxRow {
  id: string;
  sscc: string | null;
  terminalId: string | null;
  lineName: string | null;
  operatorId: string | null;
  closedAt: Date | null;
  itemCount: number;
  contentsChangedAfterClose: boolean;
  disassembledAt: Date | null;
}

@Injectable()
export class BoxesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * One tenant-scoped query: `boxes` LEFT JOINed to its own `box_items` (also
   * tenant-matched in the join condition, not just the outer `WHERE`) and
   * aggregated per box.
   *
   * `itemCount` is `count(...) filter (where displaced_at is null and
   * removed_at is null)` (Task 7) -- a plain `count(*)` would include a
   * `box_items` row whose ownership was since claimed by a different scan
   * (`displaced_at`) or one an operator exception has since released
   * (`removed_at`, see dto.ts). The LEFT JOIN (rather than an INNER JOIN)
   * means a box with zero matching `box_items` rows still surfaces, with
   * `count()` correctly returning 0 for that group rather than dropping the
   * box entirely.
   *
   * `contentsChangedAfterClose` is `coalesce(bool_or(displaced_at >
   * closure_received_at), false)`. `bool_or` returns SQL NULL, not false, when
   * every row in the group has a null `displaced_at` (an untouched box), when
   * the LEFT JOIN produced no `box_items` row at all, or when the box has not
   * closed yet (`displaced_at > NULL` is NULL in SQL's three-valued logic,
   * never true) -- the `coalesce` turns that NULL into `false` in the
   * statement itself. Drizzle's row mapper (`mapResultRow` in
   * `drizzle-orm/utils`) short-circuits a raw SQL NULL to JS `null`
   * unconditionally, BEFORE ever calling a `.mapWith` decoder, so
   * `.mapWith(Boolean)` alone -- which never actually runs on this column --
   * would leave a genuinely undisplaced or still-open box's flag as `null`,
   * not `false`.
   *
   * Compared against `closureReceivedAt` (server-assigned `now()` at the same
   * ingest statement that sets `closedAt`), NOT the client-supplied
   * `closedAt` itself (CodeRabbit PR33 review, Finding 7): unlike scan items
   * (`assertScannedAtWithinWindow`), a box closure's `closedAt` has no
   * clock-skew bound at all, so comparing a server-assigned `displacedAt`
   * against it directly could report `false` for contents that genuinely
   * changed after the physical close (a fast device clock puts `closedAt` in
   * the future relative to the server), or `true` when they didn't (a slow
   * device clock). `closureReceivedAt` and `displacedAt` are both
   * server-assigned, so they are always measured on the SAME clock.
   *
   * `GROUP BY boxes.id` alone (not every selected `boxes.*` column) is valid
   * Postgres: grouping by a table's primary key lets every other column of
   * that same table be selected ungrouped, since the key already determines
   * the row.
   *
   * Ordered by `closed_at DESC NULLS FIRST` so a still-open box -- the one a
   * manager is most likely to be working right now -- sorts to the top.
   */
  async listBoxes(tenantId: string, query: ListBoxesQueryDto): Promise<ListBoxesResponseDto> {
    const rows: BoxRow[] = await this.db
      .select({
        id: schema.boxes.id,
        sscc: schema.boxes.sscc,
        terminalId: schema.boxes.terminalId,
        lineName: schema.lines.name,
        operatorId: schema.boxes.operatorId,
        closedAt: schema.boxes.closedAt,
        disassembledAt: schema.boxes.disassembledAt,
        itemCount:
          sql<number>`count(${schema.boxItems.codeHash}) filter (where ${schema.boxItems.displacedAt} is null and ${schema.boxItems.removedAt} is null)`.mapWith(
            Number,
          ),
        contentsChangedAfterClose:
          sql<boolean>`coalesce(bool_or(${schema.boxItems.displacedAt} > ${schema.boxes.closureReceivedAt}), false)`.mapWith(
            Boolean,
          ),
      })
      .from(schema.boxes)
      .leftJoin(
        schema.boxItems,
        and(
          eq(schema.boxItems.tenantId, schema.boxes.tenantId),
          eq(schema.boxItems.boxId, schema.boxes.id),
        ),
      )
      .leftJoin(
        schema.stationDevices,
        and(
          eq(schema.stationDevices.tenantId, schema.boxes.tenantId),
          sql`${schema.stationDevices.id}::text = ${schema.boxes.terminalId}`,
        ),
      )
      .leftJoin(
        schema.lines,
        and(
          eq(schema.lines.tenantId, schema.stationDevices.tenantId),
          eq(schema.lines.id, schema.stationDevices.lineId),
        ),
      )
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.shiftId, query.shiftId)))
      .groupBy(schema.boxes.id, schema.stationDevices.id, schema.lines.id)
      .orderBy(sql`${schema.boxes.closedAt} desc nulls first`);

    return { items: rows.map((row) => this.toDto(row)) };
  }

  private toDto(row: BoxRow): BoxDto {
    return {
      id: row.id,
      sscc: row.sscc === null ? null : formatSsccWithAi(row.sscc),
      terminalId: row.terminalId,
      lineName: row.lineName,
      operatorId: row.operatorId,
      itemCount: row.itemCount,
      closedAt: row.closedAt,
      contentsChangedAfterClose: row.contentsChangedAfterClose,
      disassembledAt: row.disassembledAt,
    };
  }
}
