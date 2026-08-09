import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import {
  stationDeviceLifecycle,
  type CreateStationDeviceDto,
  type ListStationDevicesResponseDto,
  type StationDeviceDto,
  type UpdateStationDeviceDto,
} from "./dto";

type StationDeviceRow = typeof schema.stationDevices.$inferSelect;
type StationDeviceWithLine = { device: StationDeviceRow; lineName: string | null };

@Injectable()
export class StationDevicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(tenantId: string): Promise<ListStationDevicesResponseDto> {
    const rows = await this.deviceQuery()
      .where(eq(schema.stationDevices.tenantId, tenantId))
      .orderBy(desc(schema.stationDevices.enrolledAt));
    return { items: rows.map((row) => this.toDto(row)) };
  }

  async create(tenantId: string, dto: CreateStationDeviceDto): Promise<StationDeviceDto> {
    const lineName = await this.lineName(tenantId, dto.lineId);
    const row = await this.db.transaction((tx) =>
      this.entitlements.withQuotaSlot(tx, tenantId, "stations", async () => {
        const [created] = await tx
          .insert(schema.stationDevices)
          .values({ tenantId, name: dto.name, lineId: dto.lineId, apiKeyId: null })
          .returning();
        return created;
      }),
    );
    if (!row) throw new NotFoundException("Station device was not created");
    return this.toDto({ device: row, lineName });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateStationDeviceDto,
  ): Promise<StationDeviceDto> {
    const current = await this.find(tenantId, id);
    if (!current) throw new NotFoundException();

    let lineName = current.lineName;
    if (dto.lineId !== undefined) lineName = await this.lineName(tenantId, dto.lineId);

    const set: { name?: string; lineId?: string | null } = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.lineId !== undefined) set.lineId = dto.lineId;
    if (Object.keys(set).length === 0) return this.toDto(current);

    const [row] = await this.db
      .update(schema.stationDevices)
      .set(set)
      .where(and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)))
      .returning();
    if (!row) throw new NotFoundException();
    return this.toDto({ device: row, lineName });
  }

  /**
   * Invalidates the credential before mutating the durable station record.
   * The api-key statement is deliberately auto-committed: a transaction error
   * must never resurrect a still-authenticating device key.
   */
  async revoke(tenantId: string, id: string): Promise<void> {
    const current = await this.find(tenantId, id);
    if (!current) throw new NotFoundException();

    if (current.device.apiKeyId !== null) {
      await this.db.delete(schema.apikey).where(eq(schema.apikey.id, current.device.apiKeyId));
    }

    // A duplicate successful revoke is an idempotent no-op. Its original
    // timestamp remains the durable security event rather than moving forward.
    if (current.device.apiKeyId === null && current.device.revokedAt !== null) return;

    const revokedAt = new Date();
    await this.db.transaction((tx) =>
      this.entitlements.withQuotaLock(tx, tenantId, "stations", async () => {
        const [revoked] = await tx
          .update(schema.stationDevices)
          .set({ apiKeyId: null, revokedAt })
          .where(
            and(
              eq(schema.stationDevices.tenantId, tenantId),
              eq(schema.stationDevices.id, id),
              isNull(schema.stationDevices.revokedAt),
            ),
          )
          .returning({ id: schema.stationDevices.id });
        if (!revoked) return;
        await tx
          .update(schema.stationPairingCodes)
          .set({ usedAt: revokedAt })
          .where(
            and(
              eq(schema.stationPairingCodes.tenantId, tenantId),
              eq(schema.stationPairingCodes.stationDeviceId, id),
              isNull(schema.stationPairingCodes.usedAt),
            ),
          );
      }),
    );
  }

  private deviceQuery() {
    return this.db
      .select({ device: schema.stationDevices, lineName: schema.lines.name })
      .from(schema.stationDevices)
      .leftJoin(
        schema.lines,
        and(
          eq(schema.lines.tenantId, schema.stationDevices.tenantId),
          eq(schema.lines.id, schema.stationDevices.lineId),
        ),
      );
  }

  private async find(tenantId: string, id: string): Promise<StationDeviceWithLine | undefined> {
    const [row] = await this.deviceQuery().where(
      and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)),
    );
    return row;
  }

  private async lineName(tenantId: string, lineId: string | null): Promise<string | null> {
    if (lineId === null) return null;
    const [line] = await this.db
      .select({ id: schema.lines.id, name: schema.lines.name })
      .from(schema.lines)
      .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, lineId)));
    if (!line) throw new BadRequestException("Unknown line for this organization");
    return line.name;
  }

  private toDto(row: StationDeviceWithLine): StationDeviceDto {
    const { device, lineName } = row;
    return {
      id: device.id,
      name: device.name,
      lineId: device.lineId,
      lineName,
      lifecycle: stationDeviceLifecycle(device),
      pairedAt: device.pairedAt,
      revokedAt: device.revokedAt,
      lastSeenAt: device.lastSeenAt,
      createdAt: device.enrolledAt,
    };
  }
}
