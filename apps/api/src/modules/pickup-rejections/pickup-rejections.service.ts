import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  ListPickupRejectionsQueryDto,
  ListPickupRejectionsResponseDto,
  PickupScanRejectionRowDto,
  ScanRejectionCode,
} from "./dto";

/**
 * Read side of `pickup_scan_rejections`. The WRITES live in
 * `PickupOrdersService`, where the order transaction they must join already
 * is; this service only lists and acknowledges, which is why it can stay a
 * separate module instead of growing that ~1000-line one further.
 */
@Injectable()
export class PickupRejectionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(
    tenantId: string,
    query: ListPickupRejectionsQueryDto,
  ): Promise<ListPickupRejectionsResponseDto> {
    const conditions: SQL[] = [eq(schema.pickupScanRejections.tenantId, tenantId)];
    if (query.kioskId) conditions.push(eq(schema.pickupScanRejections.kioskId, query.kioskId));
    if (query.from)
      conditions.push(
        gte(schema.pickupScanRejections.syncedAt, new Date(`${query.from}T00:00:00.000Z`)),
      );
    if (query.to)
      conditions.push(
        lte(schema.pickupScanRejections.syncedAt, new Date(`${query.to}T23:59:59.999Z`)),
      );
    if (query.state === "open") conditions.push(isNull(schema.pickupScanRejections.acknowledgedAt));
    if (query.state === "acknowledged")
      conditions.push(isNotNull(schema.pickupScanRejections.acknowledgedAt));

    const items = await this.queryRows(conditions);

    // Deliberately NOT filtered by `conditions` -- see the DTO's doc comment.
    const [open] = await this.db
      .select({ value: count() })
      .from(schema.pickupScanRejections)
      .where(
        and(
          eq(schema.pickupScanRejections.tenantId, tenantId),
          isNull(schema.pickupScanRejections.acknowledgedAt),
        ),
      );

    return { items, openCount: open?.value ?? 0 };
  }

  async acknowledge(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<PickupScanRejectionRowDto> {
    const [updated] = await this.db
      .update(schema.pickupScanRejections)
      .set({ acknowledgedAt: new Date(), acknowledgedByUserId: userId })
      .where(
        and(
          eq(schema.pickupScanRejections.tenantId, tenantId),
          eq(schema.pickupScanRejections.id, id),
        ),
      )
      .returning({ id: schema.pickupScanRejections.id });

    if (!updated) throw new NotFoundException();

    const [row] = await this.queryRows([
      eq(schema.pickupScanRejections.tenantId, tenantId),
      eq(schema.pickupScanRejections.id, id),
    ]);
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Newest sync first -- what an admin opening the page wants at the top. */
  private async queryRows(conditions: SQL[]): Promise<PickupScanRejectionRowDto[]> {
    const rows = await this.db
      .select({
        id: schema.pickupScanRejections.id,
        kioskId: schema.pickupScanRejections.kioskId,
        kioskName: schema.kiosks.name,
        employeeId: schema.pickupScanRejections.employeeId,
        employeeName: schema.employees.fullName,
        badgeCode: schema.pickupScanRejections.badgeCode,
        orderId: schema.pickupScanRejections.orderId,
        orderNo: schema.pickupOrders.orderNo,
        deviceSeq: schema.pickupScanRejections.deviceSeq,
        codes: schema.pickupScanRejections.codes,
        scannedAt: schema.pickupScanRejections.scannedAt,
        syncedAt: schema.pickupScanRejections.syncedAt,
        acknowledgedAt: schema.pickupScanRejections.acknowledgedAt,
      })
      .from(schema.pickupScanRejections)
      .leftJoin(schema.kiosks, eq(schema.kiosks.id, schema.pickupScanRejections.kioskId))
      .leftJoin(schema.employees, eq(schema.employees.id, schema.pickupScanRejections.employeeId))
      .leftJoin(
        schema.pickupOrders,
        eq(schema.pickupOrders.id, schema.pickupScanRejections.orderId),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.pickupScanRejections.syncedAt));

    return rows.map((row) => ({
      id: row.id,
      kind: row.employeeId === null ? ("unknown_badge" as const) : ("items_refused" as const),
      kioskId: row.kioskId,
      kioskName: row.kioskName ?? "",
      employeeName: row.employeeName,
      badgeCode: row.badgeCode,
      orderId: row.orderId,
      orderNo: row.orderNo,
      deviceSeq: row.deviceSeq,
      codes: row.codes as ScanRejectionCode[],
      scannedAt: row.scannedAt,
      syncedAt: row.syncedAt,
      acknowledgedAt: row.acknowledgedAt,
    }));
  }
}
