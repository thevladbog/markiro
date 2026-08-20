import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { LineStatus } from "./dto";

export interface BoxCandidate {
  boxId: string;
  status: Exclude<LineStatus, "duplicate" | "not_found">;
  productId: string | null;
  codeCount: number;
}

/**
 * Resolves each bare-18 SSCC to a box and classifies it, first failure wins:
 * not_closed → shift_open → already_disassembled → written_off → ok.
 * (Spec §2 "Line validation rules"; not_found = absent from the result map,
 * duplicate is a per-document concern the caller owns.)
 * Works on any executor — the caller passes either `db` or a `tx`.
 */
export async function validateBoxCandidates(
  db: Pick<Db, "select" | "selectDistinct">,
  tenantId: string,
  ssccs: string[],
): Promise<Map<string, BoxCandidate>> {
  const result = new Map<string, BoxCandidate>();
  if (ssccs.length === 0) return result;

  const rows = await db
    .select({
      boxId: schema.boxes.id,
      sscc: schema.boxes.sscc,
      closedAt: schema.boxes.closedAt,
      closureReceivedAt: schema.boxes.closureReceivedAt,
      disassembledAt: schema.boxes.disassembledAt,
      shiftStatus: schema.shifts.status,
      productId: schema.shifts.productId,
      codeCount: sql<number>`count(${schema.boxItems.codeHash}) filter (where ${schema.boxItems.displacedAt} is null and ${schema.boxItems.removedAt} is null)`.mapWith(Number),
      // Box referenced by any non-cancelled kiosk order? A correlated EXISTS,
      // not a LEFT JOIN + bool_or: pickup_order_boxes is unique on
      // (tenantId, orderId, boxId), NOT (tenantId, boxId), so a box referenced
      // by 2+ orders (e.g. one cancelled + one live) would fan out the
      // boxItems rows in the SAME grouped query and multiply codeCount by the
      // number of matching order rows. EXISTS never joins into the row set,
      // so it can't affect any other aggregate in this select.
      inActiveOrder: sql<boolean>`exists (
        select 1 from ${schema.pickupOrderBoxes} pob
        join ${schema.pickupOrders} po
          on po.tenant_id = pob.tenant_id and po.id = pob.order_id
        where pob.tenant_id = ${schema.boxes.tenantId}
          and pob.box_id = ${schema.boxes.id}
          and po.status <> 'cancelled')`.mapWith(Boolean),
    })
    .from(schema.boxes)
    .innerJoin(
      schema.shifts,
      and(eq(schema.shifts.tenantId, schema.boxes.tenantId), eq(schema.shifts.id, schema.boxes.shiftId)),
    )
    .leftJoin(
      schema.boxItems,
      and(eq(schema.boxItems.tenantId, schema.boxes.tenantId), eq(schema.boxItems.boxId, schema.boxes.id)),
    )
    .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.sscc, ssccs)))
    .groupBy(schema.boxes.id, schema.shifts.status, schema.shifts.productId);

  // Codes of these boxes locked by item-level pickup orders (kiosk scanned
  // individual bottles, not the box): box_items → codes (for gtin/serial) →
  // pickup_order_items on the reconstructed km_key, voided = false.
  const boxIds = rows.map((r) => r.boxId);
  const lockedBoxIds = new Set<string>();
  if (boxIds.length > 0) {
    const locked = await db
      .selectDistinct({ boxId: schema.boxItems.boxId })
      .from(schema.boxItems)
      .innerJoin(
        schema.codes,
        and(
          eq(schema.codes.tenantId, schema.boxItems.tenantId),
          eq(schema.codes.codeHash, schema.boxItems.codeHash),
        ),
      )
      .innerJoin(
        schema.pickupOrderItems,
        and(
          eq(schema.pickupOrderItems.tenantId, schema.boxItems.tenantId),
          eq(schema.pickupOrderItems.voided, false),
          sql`${schema.pickupOrderItems.kmKey} = '01' || ${schema.codes.gtin14} || '21' || ${schema.codes.serial}`,
        ),
      )
      .where(
        and(
          eq(schema.boxItems.tenantId, tenantId),
          inArray(schema.boxItems.boxId, boxIds),
          isNull(schema.boxItems.displacedAt),
          isNull(schema.boxItems.removedAt),
        ),
      );
    for (const row of locked) lockedBoxIds.add(row.boxId);
  }

  for (const row of rows) {
    if (row.sscc === null) continue;
    let status: BoxCandidate["status"];
    if (row.closedAt === null || row.closureReceivedAt === null) status = "not_closed";
    else if (row.shiftStatus !== "closed") status = "shift_open";
    else if (row.disassembledAt !== null) status = "already_disassembled";
    else if (row.inActiveOrder || lockedBoxIds.has(row.boxId)) status = "written_off";
    else status = "ok";
    result.set(row.sscc, {
      boxId: row.boxId,
      status,
      productId: row.productId,
      codeCount: row.codeCount,
    });
  }
  return result;
}
