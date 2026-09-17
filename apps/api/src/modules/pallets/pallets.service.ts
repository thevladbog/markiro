import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatSsccWithAi } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { decodePalletListCursor, encodePalletListCursor } from "./dto";
import type { ListPalletsQueryDto, ListPalletsResponseDto, PalletDto } from "./dto";

interface PalletRow {
  id: string;
  sscc: string | null;
  kind: "production" | "warehouse";
  productId: string | null;
  productName: string | null;
  deviceName: string | null;
  rejectedMembershipCount: number;
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
   *
   * That check is kept for the shift filter ONLY. The list itself is now
   * org-wide (a warehouse pallet has no shift at all and would otherwise be
   * unreachable), so a caller that names no shift gets every pallet of its
   * own tenant rather than a 400.
   *
   * `limit` defaults to 100 for the org-wide list. With `shiftId` given and
   * `limit` omitted, the whole shift is returned unpaged (no `LIMIT`, no
   * `nextCursor`) -- the cabinet's shift-scoped consumer
   * (`apps/admin/src/pages/shifts/pallets-api.ts`) reads only `items` and
   * predates `nextCursor`, so defaulting `limit` there would silently drop
   * rows past the default page. An explicit `cursor` is still honoured in
   * that case.
   */
  async listPallets(tenantId: string, query: ListPalletsQueryDto): Promise<ListPalletsResponseDto> {
    const limit = query.limit ?? (query.shiftId === undefined ? 100 : undefined);

    if (query.shiftId !== undefined) {
      const [shift] = await this.db
        .select({ id: schema.shifts.id })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, query.shiftId)))
        .limit(1);
      if (!shift) throw new NotFoundException({ code: "shift_not_found" });
    }

    /**
     * A warehouse pallet carries its own `product_id` (its homogeneity
     * rule); a production one reaches its product through its shift, exactly
     * as a box does. One expression covers both, and it is what the
     * `productId` filter is compared against -- filtering on
     * `shifts.product_id` alone would silently drop every warehouse pallet.
     */
    const productIdExpr = sql`coalesce(${schema.pallets.productId}, ${schema.shifts.productId})`;
    /**
     * A warehouse pallet names its device by `device_id`; a production one
     * only ever carried the device's own id as `terminal_id` text. The
     * `pallets_warehouse_terminal_check` constraint keeps the two equal for
     * a warehouse pallet, so this coalesce is a widening, not a change of
     * meaning for existing rows.
     */
    const deviceIdExpr = sql`coalesce(${schema.pallets.deviceId}::text, ${schema.pallets.terminalId})`;

    const filters: SQL[] = [eq(schema.pallets.tenantId, tenantId)];
    if (query.shiftId !== undefined) filters.push(eq(schema.pallets.shiftId, query.shiftId));
    if (query.kind !== undefined) filters.push(eq(schema.pallets.kind, query.kind));
    if (query.productId !== undefined) filters.push(sql`${productIdExpr} = ${query.productId}`);
    if (query.deviceId !== undefined) filters.push(sql`${deviceIdExpr} = ${query.deviceId}`);
    if (query.closedFrom !== undefined) {
      filters.push(gte(schema.pallets.closedAt, new Date(query.closedFrom)));
    }
    if (query.closedTo !== undefined) {
      filters.push(lte(schema.pallets.closedAt, new Date(query.closedTo)));
    }

    /**
     * Keyset paging over this list's own order (`closed_at DESC NULLS
     * FIRST, id ASC`): still-open pallets come first as one null block, then
     * every closed one newest first. So a page that ended inside the null
     * block continues with the rest of that block plus everything closed;
     * one that ended on a closed row continues strictly below it. OFFSET
     * would re-walk a tenant's whole history on every page and skip or
     * repeat rows as pallets close underneath it.
     */
    const cursor = query.cursor === undefined ? null : decodePalletListCursor(query.cursor);
    if (cursor !== null) {
      const after =
        cursor.closedAt === null
          ? or(
              and(isNull(schema.pallets.closedAt), gt(schema.pallets.id, cursor.id)),
              isNotNull(schema.pallets.closedAt),
            )
          : and(
              isNotNull(schema.pallets.closedAt),
              or(
                lt(schema.pallets.closedAt, new Date(cursor.closedAt)),
                and(
                  eq(schema.pallets.closedAt, new Date(cursor.closedAt)),
                  gt(schema.pallets.id, cursor.id),
                ),
              ),
            );
      if (after) filters.push(after);
    }

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
     * `contentsChangedAfterClose` is
     * `coalesce(bool_or(boxes.disassembly_received_at >
     * pallets.closure_received_at), false)`. BOTH sides are SERVER-assigned
     * `now()`, and that is the whole point: this flag is the only way a
     * manager learns that a closed, labelled pallet -- which can no longer
     * be corrected -- left the factory a box short, and an ordering is only
     * meaningful between two readings of ONE clock. `boxes.disassembledAt`
     * is as unusable here as `pallets.closedAt` is: both are device
     * timestamps from a station or handheld that may have been offline for a
     * whole shift, with no skew bound anywhere in the ingest. A station clock
     * running behind the server would make a box that genuinely came off
     * after the closure compare as before it, leaving the flag silently
     * false; one running ahead invents the opposite. Neither is detectable
     * afterwards. `bool_or` returns SQL NULL (not false) for an untouched
     * pallet, one with zero member boxes, or one that has not closed yet;
     * `coalesce` turns that into `false` in the statement itself, before
     * Drizzle's row mapper ever sees it (see BoxesService.listBoxes's own
     * comment on `mapResultRow`'s short circuit).
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
    const orderedQuery = this.db
      .select({
        id: schema.pallets.id,
        sscc: schema.pallets.sscc,
        kind: schema.pallets.kind,
        productId: schema.products.id,
        productName: schema.products.name,
        deviceName: schema.stationDevices.name,
        rejectedMembershipCount:
          sql<number>`(select count(*) from ${schema.palletMembershipRejections} r where r.tenant_id = ${schema.pallets.tenantId} and r.pallet_id = ${schema.pallets.id})`.mapWith(
            Number,
          ),
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
          sql<boolean>`coalesce(bool_or(${schema.boxes.disassemblyReceivedAt} > ${schema.pallets.closureReceivedAt}), false)`.mapWith(
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
        schema.shifts,
        and(
          eq(schema.shifts.tenantId, schema.pallets.tenantId),
          eq(schema.shifts.id, schema.pallets.shiftId),
        ),
      )
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.pallets.tenantId),
          sql`${schema.products.id} = ${productIdExpr}`,
        ),
      )
      .leftJoin(
        schema.stationDevices,
        and(
          eq(schema.stationDevices.tenantId, schema.pallets.tenantId),
          sql`${schema.stationDevices.id}::text = ${deviceIdExpr}`,
        ),
      )
      .leftJoin(
        schema.lines,
        and(
          eq(schema.lines.tenantId, schema.stationDevices.tenantId),
          eq(schema.lines.id, schema.stationDevices.lineId),
        ),
      )
      .where(and(...filters))
      .groupBy(
        schema.pallets.id,
        schema.shifts.id,
        schema.products.id,
        schema.stationDevices.id,
        schema.lines.id,
      )
      .orderBy(sql`${schema.pallets.closedAt} desc nulls first`, schema.pallets.id);

    // One row beyond the page, so "is there a next page" is answered without
    // a second count query -- and never advertises an empty next page. When
    // `limit` is undefined (shift-scoped, no limit given), the whole shift
    // is fetched unpaged and there is no next page to detect.
    const rows: PalletRow[] = limit === undefined ? await orderedQuery : await orderedQuery.limit(limit + 1);

    const page = limit === undefined ? rows : rows.slice(0, limit);
    const last = limit !== undefined && rows.length > limit ? page[page.length - 1] : undefined;
    const items = page.map((row) => this.toDto(row));
    return last === undefined
      ? { items }
      : {
          items,
          nextCursor: encodePalletListCursor({
            closedAt: last.closedAt === null ? null : last.closedAt.toISOString(),
            id: last.id,
          }),
        };
  }

  private toDto(row: PalletRow): PalletDto {
    return {
      id: row.id,
      sscc: row.sscc === null ? null : formatSsccWithAi(row.sscc),
      kind: row.kind,
      productId: row.productId,
      productName: row.productName,
      deviceName: row.deviceName,
      rejectedMembershipCount: row.rejectedMembershipCount,
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
