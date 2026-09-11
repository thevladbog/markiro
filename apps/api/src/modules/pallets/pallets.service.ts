import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatSsccWithAi } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import type { ListPalletsQueryDto, ListPalletsResponseDto, PalletDto } from "./dto";

interface PalletRow {
  id: string;
  sscc: string | null;
  terminalId: string | null;
  lineName: string | null;
  operatorId: string | null;
  closedAt: Date | null;
  boxCount: number;
  unitCount: number;
  contentsChangedAfterClose: boolean;
  disassembledAt: Date | null;
}

@Injectable()
export class PalletsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Unlike `BoxesService.listBoxes` (which never checks the shift itself), a
   * pallet list 404s when `shiftId` does not resolve inside the caller's own
   * tenant -- whether it belongs to another tenant entirely or does not
   * exist at all. Checked as its own statement, before the aggregate query
   * below, so the 404 is unambiguous rather than indistinguishable from "a
   * real shift with zero pallets".
   */
  async listPallets(tenantId: string, query: ListPalletsQueryDto): Promise<ListPalletsResponseDto> {
    const [shift] = await this.db
      .select({ id: schema.shifts.id })
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, query.shiftId)))
      .limit(1);
    if (!shift) throw new NotFoundException({ code: "shift_not_found" });

    /**
     * One tenant-scoped query: `pallets` LEFT JOINed to its own member
     * `boxes` (Task 9's `boxes.palletId`, also tenant-matched in the join
     * condition) and, through those, to `box_items` -- then aggregated per
     * pallet. Mirrors `BoxesService.listBoxes`'s own shape exactly.
     *
     * The `boxes` join is UNCONDITIONAL: it carries every member box,
     * disassembled or not, because `contentsChangedAfterClose` needs to see
     * a disassembled box to detect the change. `boxCount` and `unitCount`
     * instead each carry their own `filter (where boxes.disassembled_at is
     * null and boxes.closed_at is not null)` -- the `closed_at` half is
     * always true in practice (a box's `palletId` is written in the SAME
     * UPDATE as its own closure, see boxes.palletId's own schema comment),
     * but it is kept so this reads "closed member boxes", not merely
     * "not-yet-disassembled" ones.
     *
     * `unitCount` additionally filters `box_items.displaced_at is null and
     * box_items.removed_at is null`, exactly as `BoxesService`'s own
     * `itemCount` does, because `box_items` rows are never deleted.
     *
     * `contentsChangedAfterClose` is `coalesce(bool_or(boxes.disassembled_at
     * > pallets.closure_received_at), false)`, compared against the
     * PALLET's own server-assigned `closureReceivedAt` -- never the
     * device-supplied `closedAt` -- for the identical clock-skew reason
     * `BoxesService.listBoxes`'s own flag documents. `bool_or` returns SQL
     * NULL (not false) for an untouched pallet, one with zero member boxes,
     * or one that has not closed yet; `coalesce` turns that into `false` in
     * the statement itself, before Drizzle's row mapper ever sees it (see
     * BoxesService.listBoxes's own comment on `mapResultRow`'s short
     * circuit).
     *
     * `GROUP BY pallets.id` alone is valid Postgres for the same reason
     * BoxesService's query groups by `boxes.id` alone: grouping by a
     * table's primary key lets every other column of that same table be
     * selected ungrouped. `stationDevices.id`/`lines.id` join the group for
     * the same reason.
     *
     * Ordered by `closed_at DESC NULLS FIRST`, matching BoxesService: a
     * still-open pallet sorts to the top.
     */
    const rows: PalletRow[] = await this.db
      .select({
        id: schema.pallets.id,
        sscc: schema.pallets.sscc,
        terminalId: schema.pallets.terminalId,
        lineName: schema.lines.name,
        operatorId: schema.pallets.operatorId,
        closedAt: schema.pallets.closedAt,
        disassembledAt: schema.pallets.disassembledAt,
        boxCount:
          sql<number>`count(distinct ${schema.boxes.id}) filter (where ${schema.boxes.disassembledAt} is null and ${schema.boxes.closedAt} is not null)`.mapWith(
            Number,
          ),
        unitCount:
          sql<number>`count(${schema.boxItems.codeHash}) filter (where ${schema.boxes.disassembledAt} is null and ${schema.boxes.closedAt} is not null and ${schema.boxItems.displacedAt} is null and ${schema.boxItems.removedAt} is null)`.mapWith(
            Number,
          ),
        contentsChangedAfterClose:
          sql<boolean>`coalesce(bool_or(${schema.boxes.disassembledAt} > ${schema.pallets.closureReceivedAt}), false)`.mapWith(
            Boolean,
          ),
      })
      .from(schema.pallets)
      .leftJoin(
        schema.boxes,
        and(
          eq(schema.boxes.tenantId, schema.pallets.tenantId),
          eq(schema.boxes.palletId, schema.pallets.id),
        ),
      )
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
          eq(schema.stationDevices.tenantId, schema.pallets.tenantId),
          sql`${schema.stationDevices.id}::text = ${schema.pallets.terminalId}`,
        ),
      )
      .leftJoin(
        schema.lines,
        and(
          eq(schema.lines.tenantId, schema.stationDevices.tenantId),
          eq(schema.lines.id, schema.stationDevices.lineId),
        ),
      )
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.shiftId, query.shiftId)))
      .groupBy(schema.pallets.id, schema.stationDevices.id, schema.lines.id)
      .orderBy(sql`${schema.pallets.closedAt} desc nulls first`);

    return { items: rows.map((row) => this.toDto(row)) };
  }

  private toDto(row: PalletRow): PalletDto {
    return {
      id: row.id,
      sscc: row.sscc === null ? null : formatSsccWithAi(row.sscc),
      terminalId: row.terminalId,
      lineName: row.lineName,
      operatorId: row.operatorId,
      boxCount: row.boxCount,
      unitCount: row.unitCount,
      closedAt: row.closedAt,
      contentsChangedAfterClose: row.contentsChangedAfterClose,
      disassembledAt: row.disassembledAt,
    };
  }
}
