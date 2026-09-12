import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { EntitlementsExecutor } from "../../subscriptions/entitlements.types";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import {
  assertReservationOpen,
  transitionWorkingAssignment,
  workingAssignment,
  type WorkingDeviceActor,
} from "../../subscriptions/working-device-assignments";
import {
  stationDeviceLifecycle,
  type CreateStationDeviceDto,
  type ListStationDevicesResponseDto,
  type StationDeviceDto,
  type StationDeviceKind,
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

  async create(
    tenantId: string,
    dto: CreateStationDeviceDto,
    actor?: WorkingDeviceActor,
  ): Promise<StationDeviceDto> {
    const lineName = await this.lineName(tenantId, dto.lineId);
    const row = await this.db.transaction((tx) =>
      this.entitlements.withQuotaSlot(tx, tenantId, "stations", async () => {
        const [created] = await tx
          .insert(schema.stationDevices)
          .values({
            tenantId,
            name: dto.name,
            lineId: dto.lineId,
            kind: dto.kind ?? "station",
            apiKeyId: null,
          })
          .returning();
        if (created) await transitionWorkingAssignment(tx, created, actor);
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
    actor?: WorkingDeviceActor,
  ): Promise<StationDeviceDto> {
    return this.db.transaction((tx) =>
      this.entitlements.withQuotaLock(tx, tenantId, "stations", async () => {
        const [current] = await tx
          .select()
          .from(schema.stationDevices)
          .where(
            and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)),
          )
          .for("update");
        if (!current) throw new NotFoundException();
        assertReservationOpen(await workingAssignment(tx, tenantId, id));
        const lineName = await this.lineName(
          tenantId,
          dto.lineId === undefined ? current.lineId : dto.lineId,
          tx,
        );
        const set: { name?: string; lineId?: string | null; kind?: StationDeviceKind } = {};
        if (dto.name !== undefined) set.name = dto.name;
        if (dto.lineId !== undefined) set.lineId = dto.lineId;
        if (dto.kind !== undefined && dto.kind !== current.kind) {
          // Recheck after the same lock used by the pairing claim.
          if (current.apiKeyId !== null || current.pairedAt !== null) {
            throw new ConflictException("Device kind is fixed after pairing");
          }
          set.kind = dto.kind;
        }
        if (Object.keys(set).length === 0) return this.toDto({ device: current, lineName });
        const [row] = await tx
          .update(schema.stationDevices)
          .set(set)
          .where(
            and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)),
          )
          .returning();
        if (!row) throw new NotFoundException();
        await transitionWorkingAssignment(tx, row, actor, "observed");
        return this.toDto({ device: row, lineName });
      }),
    );
  }

  /**
   * Invalidates the credential before mutating the durable station record.
   * The api-key statement is deliberately auto-committed: a transaction error
   * must never resurrect a still-authenticating device key.
   */
  async revoke(tenantId: string, id: string, actor?: WorkingDeviceActor): Promise<void> {
    const current = await this.find(tenantId, id);
    if (!current) throw new NotFoundException();

    if (current.device.apiKeyId !== null) {
      await this.db.delete(schema.apikey).where(eq(schema.apikey.id, current.device.apiKeyId));
    }

    // A duplicate successful revoke is an idempotent no-op. Its original
    // timestamp remains the durable security event rather than moving forward.
    if (current.device.apiKeyId === null && current.device.revokedAt !== null) return;

    const deletedKeys = new Set(current.device.apiKeyId === null ? [] : [current.device.apiKeyId]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const nextKey = await this.db.transaction((tx) =>
        this.entitlements.withQuotaLock(tx, tenantId, "stations", async () => {
          const [locked] = await tx
            .select()
            .from(schema.stationDevices)
            .where(
              and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)),
            )
            .for("update");
          if (!locked) throw new NotFoundException();
          // Release this transaction before auto-committing a newly discovered
          // key deletion. Acquiring a second pooled connection while holding the
          // quota lock could starve the pool behind concurrent waiting revokes.
          if (locked.apiKeyId !== null && !deletedKeys.has(locked.apiKeyId)) return locked.apiKeyId;
          assertReservationOpen(await workingAssignment(tx, tenantId, id));
          if (locked.revokedAt !== null) return null;
          const revokedAt = new Date();
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
            .returning();
          if (!revoked) return null;
          await transitionWorkingAssignment(tx, revoked, actor);
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
          return null;
        }),
      );
      if (nextKey === null) return;
      await this.db.delete(schema.apikey).where(eq(schema.apikey.id, nextKey));
      deletedKeys.add(nextKey);
    }
    throw new ConflictException({ code: "station_credential_changed" });
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

  private async lineName(
    tenantId: string,
    lineId: string | null,
    executor: EntitlementsExecutor = this.db,
  ): Promise<string | null> {
    if (lineId === null) return null;
    const [line] = await executor
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
      kind: device.kind as StationDeviceKind,
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
