import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { stationDeviceLifecycle } from "../station-devices/dto";
import type { DeviceDto, DeviceStatus, ListDevicesQueryDto, ListDevicesResponseDto } from "./dto";

const DEVICE_STATUS_ORDER: Readonly<Record<DeviceStatus, number>> = {
  awaiting_pairing: 0,
  offline: 1,
  revoked: 2,
  online: 3,
};

@Injectable()
export class DevicesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * This is intentionally an in-memory merge for the MVP: stations and kiosks
   * retain their own authoritative tables and tenant-scoped query paths.
   * Actionable lifecycle order is awaiting pairing, offline, revoked, online;
   * within a status, name, type, and id use code-unit ascending order.
   */
  async list(tenantId: string, query: ListDevicesQueryDto): Promise<ListDevicesResponseDto> {
    const [stations, kiosks] = await Promise.all([
      this.db
        .select({
          id: schema.stationDevices.id,
          name: schema.stationDevices.name,
          lineId: schema.stationDevices.lineId,
          lineName: schema.lines.name,
          apiKeyId: schema.stationDevices.apiKeyId,
          revokedAt: schema.stationDevices.revokedAt,
          lastSeenAt: schema.stationDevices.lastSeenAt,
        })
        .from(schema.stationDevices)
        .leftJoin(
          schema.lines,
          and(
            eq(schema.lines.tenantId, schema.stationDevices.tenantId),
            eq(schema.lines.id, schema.stationDevices.lineId),
          ),
        )
        .where(eq(schema.stationDevices.tenantId, tenantId)),
      this.db
        .select({
          id: schema.kiosks.id,
          name: schema.kiosks.name,
          location: schema.kiosks.location,
          deviceTokenHash: schema.kiosks.deviceTokenHash,
          kioskStatus: schema.kiosks.status,
          lastSeenAt: schema.kiosks.lastSeenAt,
        })
        .from(schema.kiosks)
        .where(eq(schema.kiosks.tenantId, tenantId)),
    ]);

    const now = new Date();
    const items = [
      ...stations.map((station) => this.stationDto(station, now)),
      ...kiosks.map((kiosk) => this.kioskDto(kiosk, now)),
    ]
      .filter((device) => query.type === undefined || device.type === query.type)
      .filter((device) => query.status === undefined || device.status === query.status)
      .sort(compareDevices);
    const total = items.length;
    const offset = (query.page - 1) * query.pageSize;

    return {
      items: items.slice(offset, offset + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  private stationDto(
    station: {
      id: string;
      name: string;
      lineId: string | null;
      lineName: string | null;
      apiKeyId: string | null;
      revokedAt: Date | null;
      lastSeenAt: Date | null;
    },
    now: Date,
  ): DeviceDto {
    const status = stationDeviceLifecycle(station, now);
    return {
      id: station.id,
      type: "station",
      name: station.name,
      place: { id: station.lineId, name: station.lineName },
      status,
      lastSeenAt: station.lastSeenAt,
      paired: status === "online" || status === "offline",
    };
  }

  private kioskDto(
    kiosk: {
      id: string;
      name: string;
      location: string | null;
      deviceTokenHash: string | null;
      kioskStatus: "active" | "archived";
      lastSeenAt: Date | null;
    },
    now: Date,
  ): DeviceDto {
    // Task 7 removes old hashes on archive. Until then, an archived kiosk is
    // still revoked and unpaired: a retained historical hash is not a live credential.
    const status: DeviceStatus =
      kiosk.kioskStatus === "archived"
        ? "revoked"
        : stationDeviceLifecycle(
            { apiKeyId: kiosk.deviceTokenHash, revokedAt: null, lastSeenAt: kiosk.lastSeenAt },
            now,
          );
    return {
      id: kiosk.id,
      type: "kiosk",
      name: kiosk.name,
      place: { id: null, name: kiosk.location },
      status,
      lastSeenAt: kiosk.lastSeenAt,
      paired: status === "online" || status === "offline",
    };
  }
}

function compareDevices(left: DeviceDto, right: DeviceDto): number {
  const status = DEVICE_STATUS_ORDER[left.status] - DEVICE_STATUS_ORDER[right.status];
  if (status !== 0) return status;
  return (
    compareText(left.name, right.name) ||
    compareText(left.type, right.type) ||
    compareText(left.id, right.id)
  );
}

/** Locale-independent comparison makes pagination stable across API hosts. */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
