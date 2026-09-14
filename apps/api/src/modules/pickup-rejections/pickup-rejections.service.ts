import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  ListPickupRejectionsQueryDto,
  ListPickupRejectionsResponseDto,
  PickupScanRejectionRowDto,
  ScanRejectionCode,
} from "./dto";

type StoredScanRejectionCode = (typeof schema.pickupScanRejections.$inferSelect)["codes"][number];

export function publicScanRejectionCodes(
  codes: readonly StoredScanRejectionCode[],
): ScanRejectionCode[] {
  return codes.filter(
    (code): code is ScanRejectionCode => !("source" in code) || code.source === "box",
  );
}

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
    // A device id is a UUID from one table or the other, so matching either
    // column is unambiguous and spares the caller having to say which kind it
    // is holding.
    if (query.deviceId) {
      const byDevice = or(
        eq(schema.pickupScanRejections.kioskId, query.deviceId),
        eq(schema.pickupScanRejections.stationDeviceId, query.deviceId),
      );
      if (byDevice) conditions.push(byDevice);
    }
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
        sourceKind: schema.pickupScanRejections.sourceKind,
        kioskId: schema.pickupScanRejections.kioskId,
        kioskName: schema.kiosks.name,
        kioskPlace: schema.kiosks.location,
        stationDeviceId: schema.pickupScanRejections.stationDeviceId,
        stationDeviceName: schema.stationDevices.name,
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
      .leftJoin(
        schema.stationDevices,
        and(
          eq(schema.stationDevices.tenantId, schema.pickupScanRejections.tenantId),
          eq(schema.stationDevices.id, schema.pickupScanRejections.stationDeviceId),
        ),
      )
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
      device:
        row.sourceKind === "handheld"
          ? {
              kind: "handheld" as const,
              id: row.stationDeviceId ?? "",
              name: row.stationDeviceName ?? "",
              place: null,
            }
          : {
              kind: "kiosk" as const,
              id: row.kioskId ?? "",
              name: row.kioskName ?? "",
              place: row.kioskPlace,
            },
      employeeName: row.employeeName,
      badgeCode: row.badgeCode,
      orderId: row.orderId,
      orderNo: row.orderNo,
      deviceSeq: row.deviceSeq,
      // Request markers are internal idempotency metadata, not refused scan
      // lines. Never expose them in admin counts or rendering.
      codes: publicScanRejectionCodes(row.codes),
      scannedAt: row.scannedAt,
      syncedAt: row.syncedAt,
      acknowledgedAt: row.acknowledgedAt,
    }));
  }
}
